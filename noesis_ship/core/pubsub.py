#!/usr/bin/env python3
"""
NATS Pub/Sub Events
====================
Simple broadcast/subscribe pattern for ship-wide events.

Unlike Work Queues (each message to ONE worker), Pub/Sub sends
each message to ALL subscribers.

Use Cases:
1. Ship announcements - "Ship starting", "Phase change", "Alert"
2. Being lifecycle - "Being started", "Being stopped", "Being error"
3. Work updates - "Task completed", "Task failed", "Progress update"
4. System events - "Memory threshold", "Error rate spike"

Subjects (Hierarchical):
- ship.event.startup          - Ship started
- ship.event.shutdown         - Ship stopping
- ship.event.phase.*          - Phase transitions
- beings.event.<id>.started   - Being started
- beings.event.<id>.stopped   - Being stopped
- beings.event.<id>.error     - Being error
- work.event.completed        - Work item completed
- work.event.failed           - Work item failed
- system.event.alert.*        - System alerts

Design:
- Fire-and-forget (no ACK, no persistence)
- Real-time only (no replay)
- Fan-out to all subscribers
- Optional: JetStream-backed for durability
"""

import asyncio
import json
import logging
from datetime import datetime
from typing import Dict, List, Optional, Any, Callable, Awaitable
from dataclasses import dataclass, asdict, field
from enum import Enum

logger = logging.getLogger(__name__)

# Configuration
NATS_URL = "nats://localhost:4222"

# Try to import nats
try:
    import nats
    from nats.aio.msg import Msg
    NATS_AVAILABLE = True
except ImportError:
    NATS_AVAILABLE = False
    logger.warning("NATS not available - pubsub disabled")


class EventType(Enum):
    """Standard event types"""
    # Ship events
    SHIP_STARTED = "ship.event.startup"
    SHIP_STOPPING = "ship.event.shutdown"
    SHIP_PHASE_CHANGE = "ship.event.phase.change"

    # Being events
    BEING_STARTED = "beings.event.{being_id}.started"
    BEING_STOPPED = "beings.event.{being_id}.stopped"
    BEING_ERROR = "beings.event.{being_id}.error"
    BEING_HEARTBEAT = "beings.event.{being_id}.heartbeat"

    # Work events
    WORK_COMPLETED = "work.event.completed"
    WORK_FAILED = "work.event.failed"
    WORK_PROGRESS = "work.event.progress"

    # System events
    SYSTEM_ALERT = "system.event.alert"
    SYSTEM_METRIC = "system.event.metric"


@dataclass
class Event:
    """Standard event structure"""
    event_type: str
    source: str
    payload: Dict[str, Any]
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    correlation_id: str = ""

    def to_json(self) -> bytes:
        return json.dumps(asdict(self)).encode()

    @classmethod
    def from_json(cls, data: bytes) -> "Event":
        d = json.loads(data.decode())
        return cls(**d)


# Type alias for event handlers
EventHandler = Callable[[Event], Awaitable[None]]


class EventPublisher:
    """
    Publish events to NATS subjects.

    Usage:
        pub = EventPublisher()
        await pub.connect()

        # Publish ship event
        await pub.emit(EventType.SHIP_STARTED, {"iteration": 22})

        # Publish being event
        await pub.emit_being("first-mate", EventType.BEING_HEARTBEAT, {"status": "active"})

        # Custom event
        await pub.publish("custom.event.name", {"data": "value"})
    """

    def __init__(self, source_id: str = "unknown"):
        self.source_id = source_id
        self.nc = None
        self._connected = False

    async def connect(self) -> bool:
        """Connect to NATS"""
        if not NATS_AVAILABLE:
            logger.error("NATS not available")
            return False

        try:
            self.nc = await nats.connect(NATS_URL)
            self._connected = True
            logger.info(f"Event publisher connected: {self.source_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to connect: {e}")
            return False

    async def disconnect(self):
        """Disconnect from NATS"""
        if self.nc:
            await self.nc.drain()
        self._connected = False

    async def publish(self, subject: str, payload: Dict[str, Any],
                      correlation_id: str = "") -> bool:
        """Publish an event to a subject"""
        if not self._connected:
            return False

        try:
            event = Event(
                event_type=subject,
                source=self.source_id,
                payload=payload,
                correlation_id=correlation_id,
            )

            await self.nc.publish(subject, event.to_json())
            logger.debug(f"Published event: {subject}")
            return True
        except Exception as e:
            logger.error(f"Failed to publish {subject}: {e}")
            return False

    async def emit(self, event_type: EventType, payload: Dict[str, Any],
                   correlation_id: str = "") -> bool:
        """Emit a standard event type"""
        subject = event_type.value
        return await self.publish(subject, payload, correlation_id)

    async def emit_being(self, being_id: str, event_type: EventType,
                         payload: Dict[str, Any]) -> bool:
        """Emit a being-specific event"""
        subject = event_type.value.format(being_id=being_id)
        return await self.publish(subject, payload)


class EventSubscriber:
    """
    Subscribe to NATS subjects and handle events.

    Usage:
        sub = EventSubscriber("first-mate")
        await sub.connect()

        # Subscribe to specific subject
        await sub.subscribe("ship.event.*", handle_ship_event)

        # Subscribe to all being events
        await sub.subscribe("beings.event.>", handle_being_event)

        # Process events
        await sub.run()  # Blocks
    """

    def __init__(self, subscriber_id: str):
        self.subscriber_id = subscriber_id
        self.nc = None
        self._connected = False
        self._subscriptions: Dict[str, Any] = {}
        self._handlers: Dict[str, List[EventHandler]] = {}
        self._running = False

    async def connect(self) -> bool:
        """Connect to NATS"""
        if not NATS_AVAILABLE:
            logger.error("NATS not available")
            return False

        try:
            self.nc = await nats.connect(NATS_URL)
            self._connected = True
            logger.info(f"Event subscriber connected: {self.subscriber_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to connect: {e}")
            return False

    async def disconnect(self):
        """Disconnect from NATS"""
        self._running = False
        for sub in self._subscriptions.values():
            await sub.unsubscribe()
        if self.nc:
            await self.nc.drain()
        self._connected = False

    async def subscribe(self, subject: str, handler: EventHandler) -> bool:
        """Subscribe to a subject pattern"""
        if not self._connected:
            return False

        try:
            # Add handler to list for this subject
            if subject not in self._handlers:
                self._handlers[subject] = []
            self._handlers[subject].append(handler)

            # Create subscription if not exists
            if subject not in self._subscriptions:
                async def message_handler(msg: Msg):
                    await self._dispatch(subject, msg)

                sub = await self.nc.subscribe(subject, cb=message_handler)
                self._subscriptions[subject] = sub
                logger.info(f"Subscribed to: {subject}")

            return True
        except Exception as e:
            logger.error(f"Failed to subscribe to {subject}: {e}")
            return False

    async def _dispatch(self, subject: str, msg: Msg):
        """Dispatch message to all handlers"""
        try:
            event = Event.from_json(msg.data)

            handlers = self._handlers.get(subject, [])
            for handler in handlers:
                try:
                    await handler(event)
                except Exception as e:
                    logger.error(f"Handler error for {subject}: {e}")
        except Exception as e:
            logger.error(f"Failed to parse event: {e}")

    async def run(self, timeout: float = None):
        """
        Run the event loop.

        Args:
            timeout: Optional timeout in seconds. None = run forever.
        """
        self._running = True
        logger.info(f"Event subscriber running: {self.subscriber_id}")

        if timeout:
            await asyncio.sleep(timeout)
        else:
            while self._running:
                await asyncio.sleep(1)


class ShipEventBus:
    """
    High-level event bus for the ship.

    Combines publisher and subscriber functionality.

    Usage:
        bus = ShipEventBus("first-mate")
        await bus.connect()

        # Subscribe to events
        @bus.on("ship.event.*")
        async def handle_ship(event):
            print(f"Ship event: {event.event_type}")

        # Publish events
        await bus.emit(EventType.SHIP_STARTED, {"iteration": 22})

        # Run in background
        asyncio.create_task(bus.run())
    """

    def __init__(self, bus_id: str):
        self.bus_id = bus_id
        self.publisher = EventPublisher(bus_id)
        self.subscriber = EventSubscriber(bus_id)
        self._pending_subscriptions: List[tuple] = []

    async def connect(self) -> bool:
        """Connect to NATS"""
        pub_ok = await self.publisher.connect()
        sub_ok = await self.subscriber.connect()

        # Register any pending subscriptions
        for subject, handler in self._pending_subscriptions:
            await self.subscriber.subscribe(subject, handler)
        self._pending_subscriptions.clear()

        return pub_ok and sub_ok

    async def disconnect(self):
        """Disconnect from NATS"""
        await self.publisher.disconnect()
        await self.subscriber.disconnect()

    def on(self, subject: str):
        """Decorator to subscribe to a subject"""
        def decorator(handler: EventHandler):
            self._pending_subscriptions.append((subject, handler))
            return handler
        return decorator

    async def subscribe(self, subject: str, handler: EventHandler) -> bool:
        """Subscribe to a subject"""
        return await self.subscriber.subscribe(subject, handler)

    async def emit(self, event_type: EventType, payload: Dict[str, Any],
                   correlation_id: str = "") -> bool:
        """Emit a standard event"""
        return await self.publisher.emit(event_type, payload, correlation_id)

    async def publish(self, subject: str, payload: Dict[str, Any],
                      correlation_id: str = "") -> bool:
        """Publish a custom event"""
        return await self.publisher.publish(subject, payload, correlation_id)

    async def run(self, timeout: float = None):
        """Run the subscriber event loop"""
        await self.subscriber.run(timeout)


# Convenience functions for quick pub/sub
async def publish_event(subject: str, payload: Dict[str, Any],
                        source: str = "unknown") -> bool:
    """Quick one-shot publish"""
    pub = EventPublisher(source)
    if await pub.connect():
        result = await pub.publish(subject, payload)
        await pub.disconnect()
        return result
    return False


async def emit_ship_event(event_type: EventType, payload: Dict[str, Any]) -> bool:
    """Emit a ship-wide event"""
    return await publish_event(event_type.value, payload, "ship")


# CLI for testing
if __name__ == "__main__":
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s"
    )

    parser = argparse.ArgumentParser(description="NATS Pub/Sub Events")
    parser.add_argument("command", choices=["test", "pub", "sub"])
    parser.add_argument("--subject", default="test.event")
    parser.add_argument("--message", default="Hello, World!")
    args = parser.parse_args()

    async def main():
        if args.command == "test":
            print("Testing Pub/Sub...")

            events_received = []

            # Handler to collect events
            async def collect_handler(event: Event):
                events_received.append(event)
                print(f"   Received: {event.event_type} from {event.source}")

            # Create subscriber
            print("\n1. Setting up subscriber...")
            sub = EventSubscriber("test-subscriber")
            if await sub.connect():
                await sub.subscribe("test.event.*", collect_handler)
                print("   Subscriber ready")
            else:
                print("   Failed to connect subscriber")
                return

            # Give subscriber time to be ready
            await asyncio.sleep(0.1)

            # Create publisher
            print("\n2. Publishing events...")
            pub = EventPublisher("test-publisher")
            if await pub.connect():
                await pub.publish("test.event.one", {"message": "First event"})
                await pub.publish("test.event.two", {"message": "Second event"})
                await pub.publish("test.event.three", {"value": 42})
                print("   Published 3 events")
            else:
                print("   Failed to connect publisher")
                await sub.disconnect()
                return

            # Wait for events to be delivered
            await asyncio.sleep(0.5)

            # Check results
            print(f"\n3. Results...")
            print(f"   Events received: {len(events_received)}")

            await pub.disconnect()
            await sub.disconnect()

            if len(events_received) == 3:
                print("\n   All events received!")
            else:
                print(f"\n   Expected 3 events, got {len(events_received)}")

            # Test ShipEventBus
            print("\n4. Testing ShipEventBus...")

            bus_events = []

            async def bus_handler(event: Event):
                bus_events.append(event)

            bus = ShipEventBus("test-bus")
            if await bus.connect():
                await bus.subscribe("ship.event.*", bus_handler)

                # Emit events
                await bus.emit(EventType.SHIP_STARTED, {"iteration": 22})
                await asyncio.sleep(0.1)

                if len(bus_events) == 1:
                    print(f"   ShipEventBus works!")
                else:
                    print(f"   Expected 1 event, got {len(bus_events)}")

                await bus.disconnect()
            else:
                print("   Failed to connect bus")

            print("\nPub/Sub tests completed!")

        elif args.command == "pub":
            pub = EventPublisher("cli")
            if await pub.connect():
                await pub.publish(args.subject, {"message": args.message})
                print(f"Published: {args.subject}")
                await pub.disconnect()

        elif args.command == "sub":
            async def print_handler(event: Event):
                print(f"Event: {event.event_type}")
                print(f"  Source: {event.source}")
                print(f"  Payload: {event.payload}")
                print()

            sub = EventSubscriber("cli")
            if await sub.connect():
                await sub.subscribe(args.subject, print_handler)
                print(f"Listening for: {args.subject}")
                print("Press Ctrl+C to stop...")
                try:
                    await sub.run()
                except KeyboardInterrupt:
                    pass
                finally:
                    await sub.disconnect()

    asyncio.run(main())
