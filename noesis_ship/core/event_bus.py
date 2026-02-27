#!/usr/bin/env python3
"""
Noesis Ship Event Bus - NATS-based Event Publishing

The nervous system of the ship. All significant actions emit events here,
enabling real-time dashboards, observability, and work distribution.

Event Subjects:
    ship.events.{category}.{action}
    ship.events.{category}.{action}.{entity_id}

Categories:
    runner      - Ship runner lifecycle
    being       - Being activity
    kanban      - Kanban state changes
    expedition  - Expedition lifecycle
    chat        - Chat messages
    health      - Health checks, errors
"""

import json
import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Callable, List
from dataclasses import dataclass, asdict
import uuid

logger = logging.getLogger(__name__)


@dataclass
class ShipEvent:
    """Standard event envelope for all ship events"""
    event_type: str
    timestamp: str
    source: str
    payload: Dict[str, Any]
    correlation_id: Optional[str] = None
    version: str = "1.0"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict())

    @classmethod
    def create(cls, event_type: str, source: str, payload: Dict[str, Any],
               correlation_id: Optional[str] = None) -> "ShipEvent":
        return cls(
            event_type=event_type,
            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            source=source,
            payload=payload,
            correlation_id=correlation_id or str(uuid.uuid4())[:8]
        )


class EventBus:
    """
    NATS-based event bus for ship-wide event publishing and subscription.

    Usage:
        bus = EventBus()
        await bus.connect()

        # Publish
        await bus.emit("kanban.item-moved", "kanban-service", {
            "item_id": "EXP-158",
            "from_column": "ready",
            "to_column": "in_progress"
        })

        # Subscribe
        await bus.subscribe("kanban.*", my_handler)
    """

    def __init__(self, nats_url: str = "nats://localhost:4222"):
        self.nats_url = nats_url
        self.nc = None  # NATS connection
        self.js = None  # JetStream context
        self._connected = False
        self._subscriptions = []
        self._local_handlers: Dict[str, list] = {}  # For fallback when NATS down

    async def connect(self) -> bool:
        """Connect to NATS server and ensure SHIP_EVENTS stream exists"""
        try:
            import nats
            from nats.js.api import StreamConfig

            self.nc = await nats.connect(self.nats_url)
            self.js = self.nc.jetstream()

            # Ensure SHIP_EVENTS stream exists for event persistence
            try:
                await self.js.add_stream(
                    config=StreamConfig(
                        name="SHIP_EVENTS",
                        subjects=["ship.events.>"],
                        retention="limits",
                        max_age=86400,  # 24 hours retention
                        storage="file",
                        max_msgs=100000,
                        description="Ship-wide event bus for real-time updates and replay"
                    )
                )
                logger.info("Created SHIP_EVENTS JetStream stream")
            except Exception as stream_err:
                # Stream likely already exists
                if "already in use" in str(stream_err).lower():
                    logger.debug("SHIP_EVENTS stream already exists")
                else:
                    logger.debug(f"Stream setup note: {stream_err}")

            self._connected = True
            logger.info(f"EventBus connected to {self.nats_url}")
            return True
        except Exception as e:
            logger.warning(f"EventBus failed to connect to NATS: {e}")
            self._connected = False
            return False

    async def disconnect(self):
        """Disconnect from NATS"""
        if self.nc and self._connected:
            await self.nc.drain()
            self._connected = False
            logger.info("EventBus disconnected")

    @property
    def is_connected(self) -> bool:
        return self._connected and self.nc is not None

    async def emit(self, event_type: str, source: str, payload: Dict[str, Any],
                   correlation_id: Optional[str] = None) -> bool:
        """
        Emit an event to the bus.

        Args:
            event_type: Event type without prefix (e.g., "kanban.item-moved")
            source: Who emitted the event (e.g., "kanban-service")
            payload: Event-specific data
            correlation_id: Optional correlation ID for tracing

        Returns:
            True if published successfully, False otherwise
        """
        event = ShipEvent.create(
            event_type=f"ship.events.{event_type}",
            source=source,
            payload=payload,
            correlation_id=correlation_id
        )

        subject = f"ship.events.{event_type}"

        if self.is_connected:
            try:
                await self.nc.publish(subject, event.to_json().encode())
                logger.debug(f"Event emitted: {subject}")
                return True
            except Exception as e:
                logger.error(f"Failed to emit event {subject}: {e}")
                # Fall through to local handling

        # Fallback: log locally and notify local handlers
        logger.info(f"Event (local): {event.event_type} - {payload}")
        await self._notify_local_handlers(event_type, event)
        return False

    async def subscribe(self, pattern: str, handler: Callable[[ShipEvent], Any]) -> bool:
        """
        Subscribe to events matching a pattern.

        Args:
            pattern: Subject pattern (e.g., "kanban.*" or ">")
            handler: Async function to handle events

        Returns:
            True if subscribed successfully
        """
        full_pattern = f"ship.events.{pattern}"

        if self.is_connected:
            try:
                async def wrapper(msg):
                    try:
                        data = json.loads(msg.data.decode())
                        event = ShipEvent(**data)
                        await handler(event)
                    except Exception as e:
                        logger.error(f"Error handling event: {e}")

                sub = await self.nc.subscribe(full_pattern, cb=wrapper)
                self._subscriptions.append(sub)
                logger.info(f"Subscribed to: {full_pattern}")
                return True
            except Exception as e:
                logger.error(f"Failed to subscribe to {full_pattern}: {e}")

        # Fallback: register local handler
        if pattern not in self._local_handlers:
            self._local_handlers[pattern] = []
        self._local_handlers[pattern].append(handler)
        logger.info(f"Registered local handler for: {pattern}")
        return True

    async def _notify_local_handlers(self, event_type: str, event: ShipEvent):
        """Notify local handlers when NATS is unavailable"""
        for pattern, handlers in self._local_handlers.items():
            if self._matches_pattern(event_type, pattern):
                for handler in handlers:
                    try:
                        await handler(event)
                    except Exception as e:
                        logger.error(f"Local handler error: {e}")

    def _matches_pattern(self, subject: str, pattern: str) -> bool:
        """Check if subject matches NATS-style pattern"""
        if pattern == ">":
            return True
        if pattern.endswith(".*"):
            prefix = pattern[:-2]
            return subject.startswith(prefix)
        if pattern.endswith(".>"):
            prefix = pattern[:-2]
            return subject.startswith(prefix)
        return subject == pattern


# Singleton instance
_event_bus: Optional[EventBus] = None


def get_event_bus() -> EventBus:
    """Get the global event bus instance"""
    global _event_bus
    if _event_bus is None:
        _event_bus = EventBus()
    return _event_bus


async def emit_event(event_type: str, source: str, payload: Dict[str, Any],
                     correlation_id: Optional[str] = None) -> bool:
    """
    Convenience function to emit an event.

    Automatically connects if not already connected.
    """
    bus = get_event_bus()
    if not bus.is_connected:
        await bus.connect()
    return await bus.emit(event_type, source, payload, correlation_id)


# Pre-defined event types for type safety
class EventTypes:
    """Standard event types for the ship"""

    # Runner events
    RUNNER_HEARTBEAT = "runner.heartbeat"
    RUNNER_WORK_STARTED = "runner.work-started"
    RUNNER_WORK_COMPLETED = "runner.work-completed"
    RUNNER_ITERATION = "runner.iteration"
    RUNNER_ERROR = "runner.error"

    # Kanban events
    KANBAN_ITEM_MOVED = "kanban.item-moved"
    KANBAN_ITEM_ASSIGNED = "kanban.item-assigned"
    KANBAN_ITEM_CREATED = "kanban.item-created"
    KANBAN_ITEM_UPDATED = "kanban.item-updated"

    # Being events
    BEING_THINKING = "being.thinking"
    BEING_RESPONDED = "being.responded"
    BEING_ERROR = "being.error"
    BEING_IDLE = "being.idle"

    # Expedition events
    EXPEDITION_STARTED = "expedition.started"
    EXPEDITION_COMPLETED = "expedition.completed"
    EXPEDITION_LHT_PROVEN = "expedition.lht-proven"

    # Health events
    HEALTH_CHECK = "health.check"
    HEALTH_ERROR = "health.error"

    # Voyage events
    VOYAGE_COMMISSIONED = "voyage.commissioned"
    VOYAGE_CARGO_LOADED = "voyage.cargo-loaded"
    VOYAGE_CREW_ASSIGNED = "voyage.crew-assigned"
    VOYAGE_SAILED = "voyage.sailed"
    VOYAGE_COMPLETED = "voyage.completed"
    VOYAGE_ARCHIVED = "voyage.archived"

    # Cargo-hold events (client project operations)
    CARGO_REPO_CLONED = "cargo.repo-cloned"
    CARGO_REPO_INDEXED = "cargo.repo-indexed"
    CARGO_TOOL_LINKED = "cargo.tool-linked"
    CARGO_SECRET_ADDED = "cargo.secret-added"
    CARGO_SECRET_ROTATED = "cargo.secret-rotated"
    CARGO_WRITE_ATTEMPTED = "cargo.write-attempted"
    CARGO_WRITE_BLOCKED = "cargo.write-blocked"
    CARGO_ASSET_ADDED = "cargo.asset-added"
    CARGO_WIKI_UPDATED = "cargo.wiki-updated"
    CARGO_MANIFEST_UPDATED = "cargo.manifest-updated"

    # LLM events (summary only, not full exchange)
    LLM_CALL_COMPLETED = "llm.call-completed"

    # Fleet alert events (published to ship.fleet.alert, not JetStream)
    FLEET_PR_CREATED = "fleet.pr-created"
    FLEET_PR_REVIEWED = "fleet.pr-reviewed"
    FLEET_CI_FAILED = "fleet.ci-failed"
    FLEET_AGENT_STUCK = "fleet.agent-stuck"
    FLEET_AGENT_CRASH = "fleet.agent-crash"
    FLEET_ACF_DELTA = "fleet.acf-delta"
    FLEET_ACF_REGRESSION = "fleet.acf-regression"


# Convenience emitters for common events
class KanbanEvents:
    """Emit kanban-specific events"""

    @staticmethod
    async def item_moved(item_id: str, from_column: str, to_column: str,
                         moved_by: str, reason: Optional[str] = None,
                         item_title: Optional[str] = None) -> bool:
        return await emit_event(
            EventTypes.KANBAN_ITEM_MOVED,
            "kanban-service",
            {
                "item_id": item_id,
                "from_column": from_column,
                "to_column": to_column,
                "moved_by": moved_by,
                "reason": reason,
                "title": item_title
            }
        )

    @staticmethod
    async def item_assigned(item_id: str, assignee: str,
                            previous_assignee: Optional[str] = None,
                            item_title: Optional[str] = None) -> bool:
        return await emit_event(
            EventTypes.KANBAN_ITEM_ASSIGNED,
            "kanban-service",
            {
                "item_id": item_id,
                "assignee": assignee,
                "previous_assignee": previous_assignee,
                "title": item_title
            }
        )

    @staticmethod
    async def item_created(item_id: str, title: str, item_type: str,
                           column: str, assignee: Optional[str] = None) -> bool:
        return await emit_event(
            EventTypes.KANBAN_ITEM_CREATED,
            "kanban-service",
            {
                "item_id": item_id,
                "title": title,
                "item_type": item_type,
                "column": column,
                "assignee": assignee
            }
        )


class RunnerEvents:
    """Emit runner-specific events"""

    @staticmethod
    async def heartbeat(iteration: int, beings_active: int = 0,
                        work_items_pending: int = 0) -> bool:
        return await emit_event(
            EventTypes.RUNNER_HEARTBEAT,
            "ship-runner",
            {
                "iteration": iteration,
                "beings_active": beings_active,
                "work_items_pending": work_items_pending
            }
        )

    @staticmethod
    async def work_started(item_id: str, being_id: str,
                           item_title: Optional[str] = None) -> bool:
        return await emit_event(
            EventTypes.RUNNER_WORK_STARTED,
            "ship-runner",
            {
                "item_id": item_id,
                "being_id": being_id,
                "title": item_title
            }
        )

    @staticmethod
    async def work_completed(item_id: str, being_id: str, success: bool,
                             duration_seconds: float = 0,
                             error: Optional[str] = None) -> bool:
        return await emit_event(
            EventTypes.RUNNER_WORK_COMPLETED,
            "ship-runner",
            {
                "item_id": item_id,
                "being_id": being_id,
                "success": success,
                "duration_seconds": duration_seconds,
                "error": error
            }
        )


class BeingEvents:
    """Emit being-specific events"""

    @staticmethod
    async def thinking(being_id: str, context: Optional[str] = None) -> bool:
        return await emit_event(
            f"being.{being_id}.thinking",
            being_id,
            {"context": context}
        )

    @staticmethod
    async def responded(being_id: str, response_time_ms: float,
                        reasoning_type: Optional[str] = None) -> bool:
        return await emit_event(
            f"being.{being_id}.responded",
            being_id,
            {
                "response_time_ms": response_time_ms,
                "reasoning_type": reasoning_type
            }
        )

    @staticmethod
    async def error(being_id: str, error_message: str,
                    context: Optional[str] = None) -> bool:
        return await emit_event(
            f"being.{being_id}.error",
            being_id,
            {
                "error": error_message,
                "context": context
            }
        )


class BeingSubscriber:
    """
    Helper for beings to subscribe to relevant events.

    Usage:
        subscriber = BeingSubscriber("my-agent")
        await subscriber.start()

        # Define handlers
        async def on_assignment(event):
            print(f"Got assigned: {event.payload}")

        await subscriber.on_kanban_assigned(on_assignment)
    """

    def __init__(self, being_id: str):
        self.being_id = being_id
        self.bus = get_event_bus()
        self._running = False
        self._handlers: Dict[str, List[Callable]] = {
            "kanban_assigned": [],
            "kanban_moved": [],
            "runner_work": [],
        }

    async def start(self) -> bool:
        """Connect to event bus and start listening"""
        connected = await self.bus.connect()
        if connected:
            self._running = True
            # Subscribe to relevant patterns
            await self._setup_subscriptions()
        return connected

    async def stop(self):
        """Stop listening to events"""
        self._running = False
        # Note: bus stays connected (singleton)

    async def _setup_subscriptions(self):
        """Set up NATS subscriptions for this being"""

        # Subscribe to kanban assignments for this being
        await self.bus.subscribe(
            f"kanban.item-assigned.{self.being_id}",
            self._handle_kanban_assigned
        )

        # Subscribe to all kanban moves (being can filter)
        await self.bus.subscribe(
            "kanban.item-moved",
            self._handle_kanban_moved
        )

        # Subscribe to runner events about this being's work
        await self.bus.subscribe(
            "runner.>",
            self._handle_runner_event
        )

        logger.info(f"BeingSubscriber started for {self.being_id}")

    async def _handle_kanban_assigned(self, event: ShipEvent):
        """Handle kanban assignment events"""
        # Only handle if assigned to this being
        assignee = event.payload.get("assignee", "")
        if assignee == self.being_id:
            for handler in self._handlers["kanban_assigned"]:
                try:
                    await handler(event)
                except Exception as e:
                    logger.error(f"Handler error: {e}")

    async def _handle_kanban_moved(self, event: ShipEvent):
        """Handle kanban move events"""
        for handler in self._handlers["kanban_moved"]:
            try:
                await handler(event)
            except Exception as e:
                logger.error(f"Handler error: {e}")

    async def _handle_runner_event(self, event: ShipEvent):
        """Handle runner events"""
        # Only handle if about this being's work
        being_id = event.payload.get("being_id", "")
        if being_id == self.being_id:
            for handler in self._handlers["runner_work"]:
                try:
                    await handler(event)
                except Exception as e:
                    logger.error(f"Handler error: {e}")

    def on_kanban_assigned(self, handler: Callable[[ShipEvent], Any]):
        """Register handler for when work is assigned to this being"""
        self._handlers["kanban_assigned"].append(handler)
        return handler  # Allow use as decorator

    def on_kanban_moved(self, handler: Callable[[ShipEvent], Any]):
        """Register handler for kanban item moves"""
        self._handlers["kanban_moved"].append(handler)
        return handler

    def on_work_event(self, handler: Callable[[ShipEvent], Any]):
        """Register handler for runner work events about this being"""
        self._handlers["runner_work"].append(handler)
        return handler


class VoyageEvents:
    """Emit voyage lifecycle events"""

    @staticmethod
    async def commissioned(voyage_id: str, voyage_name: str,
                          client: Optional[str] = None) -> bool:
        return await emit_event(
            EventTypes.VOYAGE_COMMISSIONED,
            "voyage-manager",
            {
                "voyage_id": voyage_id,
                "voyage_name": voyage_name,
                "client": client
            }
        )

    @staticmethod
    async def cargo_loaded(voyage_id: str, repo_path: str) -> bool:
        return await emit_event(
            EventTypes.VOYAGE_CARGO_LOADED,
            "voyage-manager",
            {
                "voyage_id": voyage_id,
                "repo_path": repo_path
            }
        )

    @staticmethod
    async def crew_assigned(voyage_id: str, crew: List[str]) -> bool:
        return await emit_event(
            EventTypes.VOYAGE_CREW_ASSIGNED,
            "voyage-manager",
            {
                "voyage_id": voyage_id,
                "crew": crew
            }
        )

    @staticmethod
    async def sailed(voyage_id: str) -> bool:
        return await emit_event(
            EventTypes.VOYAGE_SAILED,
            "voyage-manager",
            {"voyage_id": voyage_id}
        )

    @staticmethod
    async def completed(voyage_id: str, success: bool,
                       summary: Optional[str] = None) -> bool:
        return await emit_event(
            EventTypes.VOYAGE_COMPLETED,
            "voyage-manager",
            {
                "voyage_id": voyage_id,
                "success": success,
                "summary": summary
            }
        )


class CargoEvents:
    """Emit cargo-hold events (client project operations)"""

    @staticmethod
    async def repo_cloned(voyage_id: str, repo_url: str,
                         repo_path: str) -> bool:
        return await emit_event(
            EventTypes.CARGO_REPO_CLONED,
            "cargo-guard",
            {
                "voyage_id": voyage_id,
                "repo_url": repo_url,
                "repo_path": repo_path
            }
        )

    @staticmethod
    async def repo_indexed(voyage_id: str, repo_path: str,
                          files_indexed: int) -> bool:
        return await emit_event(
            EventTypes.CARGO_REPO_INDEXED,
            "compass",
            {
                "voyage_id": voyage_id,
                "repo_path": repo_path,
                "files_indexed": files_indexed
            }
        )

    @staticmethod
    async def tool_linked(voyage_id: str, tool_name: str,
                         tool_type: str) -> bool:
        return await emit_event(
            EventTypes.CARGO_TOOL_LINKED,
            "mcp-manager",
            {
                "voyage_id": voyage_id,
                "tool_name": tool_name,
                "tool_type": tool_type
            }
        )

    @staticmethod
    async def write_attempted(voyage_id: str, being_id: str,
                             file_path: str, allowed: bool) -> bool:
        return await emit_event(
            EventTypes.CARGO_WRITE_ATTEMPTED,
            "cargo-guard",
            {
                "voyage_id": voyage_id,
                "being_id": being_id,
                "file_path": file_path,
                "allowed": allowed
            }
        )

    @staticmethod
    async def write_blocked(voyage_id: str, being_id: str,
                           file_path: str, reason: str) -> bool:
        return await emit_event(
            EventTypes.CARGO_WRITE_BLOCKED,
            "cargo-guard",
            {
                "voyage_id": voyage_id,
                "being_id": being_id,
                "file_path": file_path,
                "reason": reason
            }
        )


class LLMEvents:
    """Emit LLM call summary events (NOT full exchange)"""

    @staticmethod
    async def call_completed(being_id: str, provider: str,
                            model: str, tokens_in: int,
                            tokens_out: int, success: bool,
                            duration_ms: float) -> bool:
        return await emit_event(
            EventTypes.LLM_CALL_COMPLETED,
            being_id,
            {
                "being_id": being_id,
                "provider": provider,
                "model": model,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "success": success,
                "duration_ms": duration_ms
            }
        )


class FleetAlerts:
    """
    Publish fleet alerts to ship.fleet.alert NATS subject.

    Unlike other emitters that use JetStream (ship.events.*), fleet alerts
    publish to ship.fleet.alert via raw NATS so the relay can forward them
    to WebSocket clients (Command Deck) immediately.

    Usage:
        await FleetAlerts.pr_created(pr=175, exp="EXP-994", agent="Mini")
        await FleetAlerts.ci_failed(pr=175, exp="EXP-994")
        await FleetAlerts.agent_stuck(agent="DGX", exp="EXP-994",
                                      session="exp-994", idle_minutes=18)
    """

    SUBJECT = "ship.fleet.alert"

    @staticmethod
    async def _publish(alert_type: str, payload: Dict[str, Any]) -> bool:
        """Publish a fleet alert to ship.fleet.alert via raw NATS."""
        bus = get_event_bus()
        if not bus.is_connected:
            await bus.connect()

        alert = {
            "type": "fleet_alert",
            "alertType": alert_type,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            **payload,
        }

        if bus.nc:
            try:
                await bus.nc.publish(
                    FleetAlerts.SUBJECT,
                    json.dumps(alert).encode()
                )
                logger.info(f"Fleet alert published: {alert_type}")
                return True
            except Exception as e:
                logger.error(f"Fleet alert (publish failed): {alert_type}: {e}")
                return False

        logger.info(f"Fleet alert (not connected): {alert_type} - {payload}")
        return False

    @staticmethod
    async def pr_created(pr: int, exp: str, agent: str) -> bool:
        """Alert: agent created a PR."""
        return await FleetAlerts._publish("pr_created", {
            "pr": pr, "exp": exp, "agent": agent,
        })

    @staticmethod
    async def pr_reviewed(pr: int, reviewer: str, passed: bool) -> bool:
        """Alert: reviewer posted a review."""
        return await FleetAlerts._publish("pr_reviewed", {
            "pr": pr, "reviewer": reviewer, "passed": passed,
        })

    @staticmethod
    async def ci_failed(pr: int, exp: str,
                        details: Optional[str] = None) -> bool:
        """Alert: CI red on PR branch."""
        return await FleetAlerts._publish("ci_failed", {
            "pr": pr, "exp": exp, "details": details,
        })

    @staticmethod
    async def agent_stuck(agent: str, exp: str, session: str,
                          idle_minutes: int) -> bool:
        """Alert: agent tmux session idle for too long."""
        return await FleetAlerts._publish("agent_stuck", {
            "agent": agent, "exp": exp, "session": session,
            "idle_minutes": idle_minutes,
        })

    @staticmethod
    async def agent_crash(agent: str, exp: str, session: str,
                          exit_code: int) -> bool:
        """Alert: agent tmux session exited with non-zero code."""
        return await FleetAlerts._publish("agent_crash", {
            "agent": agent, "exp": exp, "session": session,
            "exit_code": exit_code,
        })

    @staticmethod
    async def acf_delta(pr: int, exp: str, delta: float,
                        being: str) -> bool:
        """Alert: ACF measurement complete."""
        return await FleetAlerts._publish("acf_delta", {
            "pr": pr, "exp": exp, "delta": delta, "being": being,
        })

    @staticmethod
    async def acf_regression(pr: int, exp: str, delta: float,
                             being: str) -> bool:
        """Alert: negative ACF delta (red flag). Delta should be negative."""
        if delta >= 0:
            logger.warning(
                f"acf_regression called with non-negative delta={delta}, "
                "routing to acf_delta instead"
            )
            return await FleetAlerts.acf_delta(
                pr=pr, exp=exp, delta=delta, being=being
            )
        return await FleetAlerts._publish("acf_regression", {
            "pr": pr, "exp": exp, "delta": delta, "being": being,
        })


if __name__ == "__main__":
    # Simple test
    async def test():
        bus = get_event_bus()
        connected = await bus.connect()
        print(f"Connected: {connected}")

        # Emit test event
        await KanbanEvents.item_moved(
            item_id="TEST-001",
            from_column="ready",
            to_column="in_progress",
            moved_by="test-script",
            item_title="Test Item"
        )

        await bus.disconnect()

    asyncio.run(test())
