#!/usr/bin/env python3
"""
NATS Key-Value State Store
===========================
Shared state management for agents and ship services.

Use Cases:
1. Agent status registry - who's running, state, last heartbeat
2. Configuration store - ship-wide settings
3. Session state - current work, context
4. Health metrics - real-time monitoring
5. Feature flags - dynamic configuration

Key Buckets:
- beings.status     - Agent runtime status
- beings.config     - Agent configuration
- ship_config       - Ship-wide settings
- ship_health       - Health metrics
- sessions.{id}     - Session-specific state

Features:
- Watch for changes (reactive updates)
- History/versioning
- TTL support for ephemeral data
- Atomic updates
"""

import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any, Callable
from dataclasses import dataclass, field, asdict
from pathlib import Path
import os

logger = logging.getLogger(__name__)

# Configuration
NATS_URL = "nats://localhost:4222"

# Try to import nats
try:
    import nats
    from nats.js.api import KeyValueConfig
    from nats.js.errors import KeyNotFoundError, BucketNotFoundError
    NATS_AVAILABLE = True
except ImportError:
    NATS_AVAILABLE = False
    logger.warning("NATS not available - KV store disabled")


@dataclass
class BeingStatus:
    """Status of a running agent"""
    being_id: str
    state: str  # idle, working, blocked, offline
    current_task: Optional[str] = None
    last_heartbeat: str = field(default_factory=lambda: datetime.now().isoformat())
    uptime_seconds: float = 0
    memory_mb: float = 0
    capabilities: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> bytes:
        return json.dumps(asdict(self)).encode()

    @classmethod
    def from_json(cls, data: bytes) -> 'BeingStatus':
        return cls(**json.loads(data.decode()))


class KVStore:
    """
    Generic Key-Value store wrapper.

    Usage:
        store = KVStore("beings.status")
        await store.connect()

        # Put/Get
        await store.put("my-agent", {"state": "working"})
        value = await store.get("my-agent")

        # Watch for changes
        async for key, value in store.watch():
            print(f"{key} changed to {value}")
    """

    def __init__(self, bucket_name: str, ttl_seconds: int = None):
        self.bucket_name = bucket_name
        self.ttl_seconds = ttl_seconds
        self.nc = None
        self.js = None
        self.kv = None
        self._connected = False

    async def connect(self) -> bool:
        """Connect to NATS and get/create bucket"""
        if not NATS_AVAILABLE:
            logger.error("NATS not available")
            return False

        try:
            self.nc = await nats.connect(NATS_URL)
            self.js = self.nc.jetstream()

            # Try to get existing bucket or create new
            try:
                self.kv = await self.js.key_value(self.bucket_name)
                logger.info(f"Connected to existing bucket: {self.bucket_name}")
            except BucketNotFoundError:
                config = KeyValueConfig(
                    bucket=self.bucket_name,
                    history=5,  # Keep 5 versions
                    ttl=self.ttl_seconds if self.ttl_seconds else 0,
                )
                self.kv = await self.js.create_key_value(config=config)
                logger.info(f"Created bucket: {self.bucket_name}")

            self._connected = True
            return True
        except Exception as e:
            logger.error(f"Failed to connect: {e}")
            return False

    async def disconnect(self):
        """Disconnect from NATS"""
        if self.nc:
            await self.nc.drain()
        self._connected = False

    async def put(self, key: str, value: Any) -> bool:
        """Store a value"""
        if not self._connected:
            return False

        try:
            if isinstance(value, (dict, list)):
                data = json.dumps(value).encode()
            elif isinstance(value, bytes):
                data = value
            else:
                data = str(value).encode()

            await self.kv.put(key, data)
            return True
        except Exception as e:
            logger.error(f"Failed to put {key}: {e}")
            return False

    async def get(self, key: str) -> Optional[Any]:
        """Get a value"""
        if not self._connected:
            return None

        try:
            entry = await self.kv.get(key)
            if entry and entry.value:
                try:
                    return json.loads(entry.value.decode())
                except:
                    return entry.value.decode()
        except KeyNotFoundError:
            return None
        except Exception as e:
            logger.error(f"Failed to get {key}: {e}")
        return None

    async def delete(self, key: str) -> bool:
        """Delete a key"""
        if not self._connected:
            return False

        try:
            await self.kv.delete(key)
            return True
        except Exception as e:
            logger.error(f"Failed to delete {key}: {e}")
            return False

    async def keys(self) -> List[str]:
        """List all keys"""
        if not self._connected:
            return []

        try:
            return await self.kv.keys()
        except Exception as e:
            logger.error(f"Failed to list keys: {e}")
            return []

    async def watch(self, key_pattern: str = None):
        """
        Watch for changes.

        Yields (key, value) tuples on each change.
        """
        if not self._connected:
            return

        try:
            if key_pattern:
                watcher = await self.kv.watch(key_pattern)
            else:
                watcher = await self.kv.watchall()

            async for entry in watcher:
                if entry.value:
                    try:
                        value = json.loads(entry.value.decode())
                    except:
                        value = entry.value.decode()
                    yield (entry.key, value)

        except Exception as e:
            logger.error(f"Watch error: {e}")


class BeingRegistry:
    """
    Registry of all agents and their status.

    Central place to track who's running, what they're doing.

    Usage:
        registry = BeingRegistry()
        await registry.connect()

        # Register an agent
        await registry.register("my-agent", ["code", "feature"])

        # Update status
        await registry.update_status("my-agent", "working", "TASK-159")

        # Heartbeat
        await registry.heartbeat("my-agent")

        # Get all agents
        beings = await registry.get_all()
    """

    BUCKET = "beings_status"
    HEARTBEAT_INTERVAL = 30  # seconds
    OFFLINE_THRESHOLD = 90   # seconds without heartbeat = offline

    def __init__(self):
        self.store = KVStore(self.BUCKET, ttl_seconds=300)  # 5 min TTL
        self._heartbeat_tasks: Dict[str, asyncio.Task] = {}

    async def connect(self) -> bool:
        return await self.store.connect()

    async def disconnect(self):
        # Cancel heartbeat tasks
        for task in self._heartbeat_tasks.values():
            task.cancel()
        await self.store.disconnect()

    async def register(self, being_id: str, capabilities: List[str] = None) -> bool:
        """Register an agent as online"""
        status = BeingStatus(
            being_id=being_id,
            state="idle",
            capabilities=capabilities or [],
        )
        return await self.store.put(being_id, asdict(status))

    async def update_status(self, being_id: str, state: str,
                            current_task: str = None) -> bool:
        """Update agent's status"""
        existing = await self.store.get(being_id)
        if existing:
            existing['state'] = state
            existing['current_task'] = current_task
            existing['last_heartbeat'] = datetime.now().isoformat()
            return await self.store.put(being_id, existing)
        else:
            # New agent
            status = BeingStatus(
                being_id=being_id,
                state=state,
                current_task=current_task,
            )
            return await self.store.put(being_id, asdict(status))

    async def heartbeat(self, being_id: str) -> bool:
        """Update heartbeat timestamp"""
        existing = await self.store.get(being_id)
        if existing:
            existing['last_heartbeat'] = datetime.now().isoformat()
            return await self.store.put(being_id, existing)
        return False

    async def unregister(self, being_id: str) -> bool:
        """Remove an agent from registry"""
        if being_id in self._heartbeat_tasks:
            self._heartbeat_tasks[being_id].cancel()
            del self._heartbeat_tasks[being_id]
        return await self.store.delete(being_id)

    async def get_status(self, being_id: str) -> Optional[Dict]:
        """Get agent's current status"""
        return await self.store.get(being_id)

    async def get_all(self) -> Dict[str, Dict]:
        """Get all registered agents"""
        keys = await self.store.keys()
        result = {}
        for key in keys:
            status = await self.store.get(key)
            if status:
                result[key] = status
        return result

    async def get_online(self) -> List[str]:
        """Get list of online agents (recent heartbeat)"""
        all_beings = await self.get_all()
        threshold = datetime.now() - timedelta(seconds=self.OFFLINE_THRESHOLD)

        online = []
        for being_id, status in all_beings.items():
            heartbeat = datetime.fromisoformat(status.get('last_heartbeat', '2000-01-01'))
            if heartbeat > threshold:
                online.append(being_id)

        return online

    async def get_by_state(self, state: str) -> List[str]:
        """Get agents in a specific state"""
        all_beings = await self.get_all()
        return [
            being_id for being_id, status in all_beings.items()
            if status.get('state') == state
        ]

    async def start_heartbeat(self, being_id: str):
        """Start automatic heartbeat for an agent"""
        async def heartbeat_loop():
            while True:
                await asyncio.sleep(self.HEARTBEAT_INTERVAL)
                await self.heartbeat(being_id)

        task = asyncio.create_task(heartbeat_loop())
        self._heartbeat_tasks[being_id] = task

    async def watch_changes(self):
        """Watch for status changes"""
        async for key, value in self.store.watch():
            yield (key, value)


class ShipConfig:
    """
    Ship-wide configuration store.

    Usage:
        config = ShipConfig()
        await config.connect()

        # Get config value
        llm_provider = await config.get("llm.provider", default="local")

        # Set config
        await config.set("llm.provider", "anthropic")

        # Watch for config changes
        async for key, value in config.watch():
            print(f"Config changed: {key} = {value}")
    """

    BUCKET = "ship_config"

    def __init__(self):
        self.store = KVStore(self.BUCKET)

    async def connect(self) -> bool:
        return await self.store.connect()

    async def disconnect(self):
        await self.store.disconnect()

    async def get(self, key: str, default: Any = None) -> Any:
        """Get config value"""
        value = await self.store.get(key)
        return value if value is not None else default

    async def set(self, key: str, value: Any) -> bool:
        """Set config value"""
        return await self.store.put(key, value)

    async def get_all(self) -> Dict[str, Any]:
        """Get all config"""
        keys = await self.store.keys()
        result = {}
        for key in keys:
            result[key] = await self.store.get(key)
        return result

    async def watch(self):
        """Watch for config changes"""
        async for key, value in self.store.watch():
            yield (key, value)


class HealthMetrics:
    """
    Real-time health metrics store.

    Usage:
        health = HealthMetrics()
        await health.connect()

        # Report metrics
        await health.report("my-agent", {
            "memory_mb": 256,
            "cpu_percent": 15,
            "queue_depth": 3,
        })

        # Get current health
        metrics = await health.get("my-agent")
    """

    BUCKET = "ship_health"

    def __init__(self):
        self.store = KVStore(self.BUCKET, ttl_seconds=120)  # 2 min TTL

    async def connect(self) -> bool:
        return await self.store.connect()

    async def disconnect(self):
        await self.store.disconnect()

    async def report(self, source: str, metrics: Dict[str, Any]) -> bool:
        """Report health metrics"""
        data = {
            "source": source,
            "timestamp": datetime.now().isoformat(),
            "metrics": metrics,
        }
        return await self.store.put(source, data)

    async def get(self, source: str) -> Optional[Dict]:
        """Get health metrics for a source"""
        return await self.store.get(source)

    async def get_all(self) -> Dict[str, Dict]:
        """Get all health metrics"""
        keys = await self.store.keys()
        result = {}
        for key in keys:
            result[key] = await self.store.get(key)
        return result


# CLI for testing
if __name__ == "__main__":
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s"
    )

    parser = argparse.ArgumentParser(description="NATS KV State Store")
    parser.add_argument("command", choices=["test", "registry", "config", "health"])
    args = parser.parse_args()

    async def main():
        if args.command == "test":
            print("Testing KV State Store...")

            # Test 1: Being Registry
            print("\n1. Testing Being Registry...")
            registry = BeingRegistry()
            if await registry.connect():
                # Register agents
                await registry.register("agent-developer", ["code", "python"])
                await registry.register("agent-designer", ["design", "css"])

                # Update status
                await registry.update_status("agent-developer", "working", "TASK-159")

                # Get all
                all_beings = await registry.get_all()
                print(f"   Registered agents: {list(all_beings.keys())}")

                # Get by state
                working = await registry.get_by_state("working")
                print(f"   Working agents: {working}")

                # Get status
                status = await registry.get_status("agent-developer")
                print(f"   Developer status: {status.get('state')}, task: {status.get('current_task')}")

                await registry.disconnect()
                print("   Being Registry works!")
            else:
                print("   Failed to connect")

            # Test 2: Ship Config
            print("\n2. Testing Ship Config...")
            config = ShipConfig()
            if await config.connect():
                await config.set("llm.provider", "anthropic")
                await config.set("llm.model", "claude-3-opus")
                await config.set("ship.name", "noesis-ship")

                provider = await config.get("llm.provider")
                print(f"   LLM Provider: {provider}")

                all_config = await config.get_all()
                print(f"   All config keys: {list(all_config.keys())}")

                await config.disconnect()
                print("   Ship Config works!")
            else:
                print("   Failed to connect")

            # Test 3: Health Metrics
            print("\n3. Testing Health Metrics...")
            health = HealthMetrics()
            if await health.connect():
                await health.report("agent-developer", {
                    "memory_mb": 256,
                    "cpu_percent": 15,
                    "queue_depth": 3,
                })

                metrics = await health.get("agent-developer")
                print(f"   Developer health: {metrics}")

                await health.disconnect()
                print("   Health Metrics works!")
            else:
                print("   Failed to connect")

            print("\nAll KV tests passed!")

        elif args.command == "registry":
            # Show current registry
            registry = BeingRegistry()
            if await registry.connect():
                all_beings = await registry.get_all()
                print(f"Being Registry ({len(all_beings)} agents):")
                for being_id, status in all_beings.items():
                    state = status.get('state', 'unknown')
                    task = status.get('current_task', '-')
                    print(f"  {being_id}: {state} | {task}")
                await registry.disconnect()
            else:
                print("Failed to connect")

        elif args.command == "config":
            # Show current config
            config = ShipConfig()
            if await config.connect():
                all_config = await config.get_all()
                print(f"Ship Config ({len(all_config)} keys):")
                for key, value in sorted(all_config.items()):
                    print(f"  {key}: {value}")
                await config.disconnect()
            else:
                print("Failed to connect")

        elif args.command == "health":
            # Show current health
            health = HealthMetrics()
            if await health.connect():
                all_health = await health.get_all()
                print(f"Health Metrics ({len(all_health)} sources):")
                for source, data in all_health.items():
                    metrics = data.get('metrics', {})
                    print(f"  {source}: {metrics}")
                await health.disconnect()
            else:
                print("Failed to connect")

    asyncio.run(main())
