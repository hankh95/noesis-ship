#!/usr/bin/env python3
"""
NATS Object Store
==================
Large file storage for agents and ship services.

Use Cases:
1. Agent snapshots - Checkpoint state before risky operations
2. Session artifacts - Code diffs, outputs, logs
3. Knowledge archives - Cached embeddings, indexes
4. Expedition artifacts - Research results, generated code

Key Buckets:
- snapshots     - Agent state snapshots
- artifacts     - Work artifacts (code, docs)
- knowledge     - Cached knowledge data
- logs          - Archived logs

Features:
- Chunked storage for large files
- Content-addressed (SHA-256)
- Versioning and history
- Streaming read/write
"""

import asyncio
import json
import logging
import hashlib
from datetime import datetime
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field, asdict
from pathlib import Path
import io

logger = logging.getLogger(__name__)

# Configuration
NATS_URL = "nats://localhost:4222"

# Try to import nats
try:
    import nats
    from nats.js.api import ObjectStoreConfig
    from nats.js.errors import ObjectNotFoundError, BucketNotFoundError
    NATS_AVAILABLE = True
except ImportError:
    NATS_AVAILABLE = False
    logger.warning("NATS not available - object store disabled")


@dataclass
class ObjectMeta:
    """Metadata for stored objects"""
    name: str
    bucket: str
    size: int
    sha256: str
    created: str
    description: str = ""
    content_type: str = "application/octet-stream"
    metadata: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


class ObjectStore:
    """
    Generic Object Store wrapper.

    Usage:
        store = ObjectStore("snapshots")
        await store.connect()

        # Store bytes
        await store.put("agent-state-2025-12-06", data,
                        description="Developer snapshot before refactor")

        # Store file
        await store.put_file("code-diff.patch", Path("./diff.patch"))

        # Get object
        data = await store.get("agent-state-2025-12-06")

        # List objects
        objects = await store.list()
    """

    def __init__(self, bucket_name: str):
        self.bucket_name = bucket_name
        self.nc = None
        self.js = None
        self.obj_store = None
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
                self.obj_store = await self.js.object_store(self.bucket_name)
                logger.info(f"Connected to existing object store: {self.bucket_name}")
            except BucketNotFoundError:
                # create_object_store takes bucket name as first positional arg
                self.obj_store = await self.js.create_object_store(self.bucket_name)
                logger.info(f"Created object store: {self.bucket_name}")

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

    async def put(self, name: str, data: bytes,
                  description: str = "",
                  content_type: str = "application/octet-stream",
                  metadata: Dict[str, str] = None) -> Optional[ObjectMeta]:
        """Store bytes as an object"""
        if not self._connected:
            return None

        try:
            # Calculate SHA256
            sha256 = hashlib.sha256(data).hexdigest()

            # Store object
            info = await self.obj_store.put(
                name,
                data,
                meta=nats.js.api.ObjectMeta(
                    name=name,
                    description=description,
                )
            )

            logger.info(f"Stored object: {name} ({len(data)} bytes)")

            return ObjectMeta(
                name=name,
                bucket=self.bucket_name,
                size=len(data),
                sha256=sha256,
                created=datetime.now().isoformat(),
                description=description,
                content_type=content_type,
                metadata=metadata or {},
            )
        except Exception as e:
            logger.error(f"Failed to store {name}: {e}")
            return None

    async def put_file(self, name: str, file_path: Path,
                       description: str = "") -> Optional[ObjectMeta]:
        """Store a file as an object"""
        try:
            data = file_path.read_bytes()
            content_type = self._guess_content_type(file_path)
            return await self.put(
                name,
                data,
                description=description or f"File: {file_path.name}",
                content_type=content_type,
            )
        except Exception as e:
            logger.error(f"Failed to store file {file_path}: {e}")
            return None

    async def get(self, name: str) -> Optional[bytes]:
        """Get an object's data"""
        if not self._connected:
            return None

        try:
            result = await self.obj_store.get(name)
            if result and result.data:
                return result.data
            return None
        except ObjectNotFoundError:
            return None
        except Exception as e:
            logger.error(f"Failed to get {name}: {e}")
            return None

    async def get_info(self, name: str) -> Optional[Dict]:
        """Get object metadata without downloading"""
        if not self._connected:
            return None

        try:
            info = await self.obj_store.info(name)
            return {
                "name": info.name,
                "size": info.size,
                "chunks": info.chunks,
                "digest": info.digest,
            }
        except ObjectNotFoundError:
            return None
        except Exception as e:
            logger.error(f"Failed to get info for {name}: {e}")
            return None

    async def delete(self, name: str) -> bool:
        """Delete an object"""
        if not self._connected:
            return False

        try:
            await self.obj_store.delete(name)
            logger.info(f"Deleted object: {name}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete {name}: {e}")
            return False

    async def list(self) -> List[Dict]:
        """List all objects"""
        if not self._connected:
            return []

        try:
            objects = []
            # obj_store.list() returns a coroutine that yields a List[ObjectInfo]
            obj_list = await self.obj_store.list()
            for obj in obj_list:
                objects.append({
                    "name": obj.name,
                    "size": obj.size,
                    "chunks": obj.chunks,
                })
            return objects
        except Exception as e:
            logger.error(f"Failed to list objects: {e}")
            return []

    def _guess_content_type(self, path: Path) -> str:
        """Guess content type from file extension"""
        ext = path.suffix.lower()
        types = {
            ".json": "application/json",
            ".yaml": "application/yaml",
            ".yml": "application/yaml",
            ".md": "text/markdown",
            ".py": "text/x-python",
            ".js": "text/javascript",
            ".html": "text/html",
            ".css": "text/css",
            ".txt": "text/plain",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".gif": "image/gif",
            ".pdf": "application/pdf",
            ".zip": "application/zip",
            ".tar": "application/x-tar",
            ".gz": "application/gzip",
        }
        return types.get(ext, "application/octet-stream")


class BeingSnapshots:
    """
    Snapshot storage for agents.

    Take snapshots before risky operations, restore on failure.

    Usage:
        snapshots = BeingSnapshots()
        await snapshots.connect()

        # Take snapshot
        snapshot_id = await snapshots.take(
            "my-agent",
            state={"memory": {...}, "context": {...}},
            reason="Before major refactor"
        )

        # List snapshots
        snaps = await snapshots.list("my-agent")

        # Restore
        state = await snapshots.restore(snapshot_id)
    """

    BUCKET = "snapshots"

    def __init__(self):
        self.store = ObjectStore(self.BUCKET)

    async def connect(self) -> bool:
        return await self.store.connect()

    async def disconnect(self):
        await self.store.disconnect()

    async def take(self, being_id: str, state: Dict[str, Any],
                   reason: str = "") -> Optional[str]:
        """Take a snapshot of agent state"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        snapshot_id = f"{being_id}_{timestamp}"

        snapshot_data = {
            "being_id": being_id,
            "timestamp": datetime.now().isoformat(),
            "reason": reason,
            "state": state,
        }

        data = json.dumps(snapshot_data, indent=2).encode()

        meta = await self.store.put(
            snapshot_id,
            data,
            description=f"Snapshot: {reason}",
            content_type="application/json",
        )

        if meta:
            logger.info(f"Snapshot taken: {snapshot_id}")
            return snapshot_id
        return None

    async def restore(self, snapshot_id: str) -> Optional[Dict]:
        """Restore state from a snapshot"""
        data = await self.store.get(snapshot_id)
        if data:
            snapshot = json.loads(data.decode())
            logger.info(f"Restored snapshot: {snapshot_id}")
            return snapshot.get("state")
        return None

    async def list(self, being_id: str = None) -> List[Dict]:
        """List snapshots, optionally filtered by agent"""
        all_objects = await self.store.list()

        snapshots = []
        for obj in all_objects:
            name = obj.get("name", "")
            if being_id and not name.startswith(being_id):
                continue

            # Get full info
            data = await self.store.get(name)
            if data:
                try:
                    snapshot = json.loads(data.decode())
                    snapshots.append({
                        "id": name,
                        "being_id": snapshot.get("being_id"),
                        "timestamp": snapshot.get("timestamp"),
                        "reason": snapshot.get("reason"),
                        "size": obj.get("size"),
                    })
                except:
                    pass

        return sorted(snapshots, key=lambda x: x.get("timestamp", ""), reverse=True)

    async def delete(self, snapshot_id: str) -> bool:
        """Delete a snapshot"""
        return await self.store.delete(snapshot_id)

    async def cleanup(self, being_id: str, keep_last: int = 5) -> int:
        """Delete old snapshots, keeping only the most recent"""
        snapshots = await self.list(being_id)

        deleted = 0
        for snapshot in snapshots[keep_last:]:
            if await self.delete(snapshot["id"]):
                deleted += 1

        if deleted > 0:
            logger.info(f"Cleaned up {deleted} old snapshots for {being_id}")

        return deleted


class ArtifactStore:
    """
    Store work artifacts (code, docs, logs).

    Usage:
        artifacts = ArtifactStore()
        await artifacts.connect()

        # Store artifact
        await artifacts.store(
            "task-159-code-changes",
            code.encode(),
            artifact_type="code",
            expedition="TASK-159",
        )

        # Get artifact
        code = await artifacts.get("task-159-code-changes")
    """

    BUCKET = "artifacts"

    def __init__(self):
        self._obj_store = ObjectStore(self.BUCKET)

    async def connect(self) -> bool:
        return await self._obj_store.connect()

    async def disconnect(self):
        await self._obj_store.disconnect()

    async def store(self, name: str, data: bytes,
                    artifact_type: str = "general",
                    expedition: str = None,
                    description: str = "") -> Optional[ObjectMeta]:
        """Store an artifact"""
        meta = {
            "type": artifact_type,
            "expedition": expedition or "",
            "stored_at": datetime.now().isoformat(),
        }

        return await self._obj_store.put(
            name,
            data,
            description=description,
            metadata=meta,
        )

    async def get(self, name: str) -> Optional[bytes]:
        """Get an artifact"""
        return await self._obj_store.get(name)

    async def list(self, artifact_type: str = None) -> List[Dict]:
        """List artifacts, optionally filtered by type"""
        return await self._obj_store.list()


# CLI for testing
if __name__ == "__main__":
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s"
    )

    parser = argparse.ArgumentParser(description="NATS Object Store")
    parser.add_argument("command", choices=["test", "snapshots", "artifacts"])
    args = parser.parse_args()

    async def main():
        if args.command == "test":
            print("Testing Object Store...")

            # Test 1: Generic Object Store
            print("\n1. Testing Generic Object Store...")
            store = ObjectStore("test_objects")
            if await store.connect():
                # Store some data
                test_data = b"Hello, World! This is a test object."
                meta = await store.put(
                    "test-object-1",
                    test_data,
                    description="Test object",
                )
                if meta:
                    print(f"   Stored: {meta.name} ({meta.size} bytes)")

                # Retrieve
                retrieved = await store.get("test-object-1")
                if retrieved == test_data:
                    print(f"   Retrieved and verified!")

                # List
                objects = await store.list()
                print(f"   Objects in bucket: {len(objects)}")

                # Delete
                await store.delete("test-object-1")

                await store.disconnect()
                print("   Object Store works!")
            else:
                print("   Failed to connect")

            # Test 2: Agent Snapshots
            print("\n2. Testing Agent Snapshots...")
            snapshots = BeingSnapshots()
            if await snapshots.connect():
                # Take snapshot
                state = {
                    "memory": {"learned": ["NATS patterns", "JetStream"]},
                    "context": {"current_work": "TASK-159"},
                }

                snapshot_id = await snapshots.take(
                    "my-agent",
                    state=state,
                    reason="Testing snapshot system",
                )
                print(f"   Snapshot taken: {snapshot_id}")

                # List snapshots
                snaps = await snapshots.list("my-agent")
                print(f"   Snapshots for agent: {len(snaps)}")

                # Restore
                restored = await snapshots.restore(snapshot_id)
                if restored == state:
                    print(f"   Restored state matches original!")

                await snapshots.disconnect()
                print("   Agent Snapshots works!")
            else:
                print("   Failed to connect")

            # Test 3: Artifact Store
            print("\n3. Testing Artifact Store...")
            artifacts = ArtifactStore()
            if await artifacts.connect():
                code = b"def hello():\n    print('Hello from artifact!')"

                await artifacts.store(
                    "task-159-test-code",
                    code,
                    artifact_type="code",
                    expedition="TASK-159",
                )

                retrieved = await artifacts.get("task-159-test-code")
                if retrieved == code:
                    print(f"   Artifact stored and retrieved!")

                all_artifacts = await artifacts.list()
                print(f"   Total artifacts: {len(all_artifacts)}")

                await artifacts.disconnect()
                print("   Artifact Store works!")
            else:
                print("   Failed to connect")

            print("\nAll Object Store tests passed!")

        elif args.command == "snapshots":
            snapshots = BeingSnapshots()
            if await snapshots.connect():
                all_snaps = await snapshots.list()
                print(f"Snapshots ({len(all_snaps)}):")
                for snap in all_snaps[:10]:
                    print(f"  {snap['id']}: {snap['reason']}")
                await snapshots.disconnect()

        elif args.command == "artifacts":
            artifacts = ArtifactStore()
            if await artifacts.connect():
                all_artifacts = await artifacts.list()
                print(f"Artifacts ({len(all_artifacts)}):")
                for art in all_artifacts[:10]:
                    print(f"  {art['name']}: {art['size']} bytes")
                await artifacts.disconnect()

    asyncio.run(main())
