"""
NATS Channel Service for Communication

This is the "dumb" channel layer - just a message bus.
Agents handle their own memory, reasoning, and LLM calls internally.

Architecture:
- Subject pattern: ship.channel.<channel_name>
- Messages are JSON with sender, content, timestamp
- JetStream provides persistence and replay
"""

import asyncio
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional, Dict, Any, List
from dataclasses import dataclass, asdict
import nats
from nats.js.api import StreamConfig, ConsumerConfig, DeliverPolicy


@dataclass
class ChannelMessage:
    """A message in a channel"""
    sender: str          # Agent name or "captain"
    content: str         # Message content
    timestamp: float     # Unix timestamp
    channel: str         # Channel name
    message_id: str      # Unique ID
    metadata: Dict[str, Any] = None  # Optional metadata

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "ChannelMessage":
        return cls(**data)

    def to_json(self) -> bytes:
        return json.dumps(self.to_dict()).encode()

    @classmethod
    def from_json(cls, data: bytes) -> "ChannelMessage":
        return cls.from_dict(json.loads(data.decode()))


class NATSChannelService:
    """
    NATS-based channel service for agent communication.

    Channels are just message buses - no logic.
    Agents decide how to respond using their own capabilities.
    """

    def __init__(self, nats_url: str = "nats://localhost:4222"):
        self.nats_url = nats_url
        self.nc: Optional[nats.NATS] = None
        self.js = None  # JetStream context
        self._subscriptions: Dict[str, Any] = {}
        self._message_handlers: Dict[str, Callable] = {}
        self._agent_name: Optional[str] = None

    async def connect(self, agent_name: str = "anonymous"):
        """Connect to NATS server"""
        self._agent_name = agent_name
        self.nc = await nats.connect(self.nats_url)
        self.js = self.nc.jetstream()

        # Ensure the channels stream exists
        try:
            await self.js.add_stream(
                name="CHANNELS",
                config=StreamConfig(
                    subjects=["ship.channel.>"],
                    retention="limits",
                    max_msgs=10000,  # Per channel history
                    max_age=86400 * 30,  # 30 days
                    storage="file",
                )
            )
        except nats.js.errors.BadRequestError:
            # Stream already exists
            pass

        return self

    async def disconnect(self):
        """Disconnect from NATS"""
        if self.nc:
            await self.nc.drain()
            await self.nc.close()

    async def create_channel(self, channel_name: str, metadata: Dict[str, Any] = None):
        """
        Create a new channel.

        Channels are created implicitly when first message is sent,
        but this allows setting metadata.
        """
        # Store channel metadata in a special subject
        channel_meta = {
            "name": channel_name,
            "created_at": time.time(),
            "created_by": self._agent_name,
            "metadata": metadata or {}
        }

        await self.js.publish(
            f"ship.channel.{channel_name}._meta",
            json.dumps(channel_meta).encode()
        )

        return channel_name

    async def send_message(
        self,
        channel: str,
        content: str,
        metadata: Dict[str, Any] = None
    ) -> ChannelMessage:
        """
        Send a message to a channel.

        This is the ONLY thing the channel layer does - deliver messages.
        No reasoning, no memory, no LLM calls.
        """
        msg = ChannelMessage(
            sender=self._agent_name,
            content=content,
            timestamp=time.time(),
            channel=channel,
            message_id=f"{channel}-{time.time_ns()}",
            metadata=metadata
        )

        await self.js.publish(
            f"ship.channel.{channel}",
            msg.to_json()
        )

        return msg

    async def subscribe(
        self,
        channel: str,
        handler: Callable[[ChannelMessage], None],
        replay_history: bool = False
    ):
        """
        Subscribe to a channel.

        The handler is called for each message.
        Agent decides internally how to process/respond.
        """
        subject = f"ship.channel.{channel}"

        # Create a durable consumer for this agent on this channel
        consumer_name = f"{self._agent_name}-{channel}".replace("-", "_")

        deliver_policy = DeliverPolicy.ALL if replay_history else DeliverPolicy.NEW

        try:
            sub = await self.js.subscribe(
                subject,
                durable=consumer_name,
                config=ConsumerConfig(
                    deliver_policy=deliver_policy,
                    ack_policy="explicit"
                )
            )

            self._subscriptions[channel] = sub
            self._message_handlers[channel] = handler

            # Start message handler loop
            asyncio.create_task(self._handle_messages(channel, sub, handler))

        except Exception as e:
            # Fallback to simple subscription
            async def message_callback(msg):
                try:
                    channel_msg = ChannelMessage.from_json(msg.data)
                    await handler(channel_msg)
                except Exception as e:
                    print(f"Error handling message: {e}")

            sub = await self.nc.subscribe(subject, cb=message_callback)
            self._subscriptions[channel] = sub

    async def _handle_messages(self, channel: str, sub, handler: Callable):
        """Internal message handling loop"""
        async for msg in sub.messages:
            try:
                # Skip metadata messages
                if msg.subject.endswith("._meta"):
                    await msg.ack()
                    continue

                channel_msg = ChannelMessage.from_json(msg.data)

                # Don't process own messages
                if channel_msg.sender != self._agent_name:
                    await handler(channel_msg)

                await msg.ack()
            except Exception as e:
                print(f"Error in message handler: {e}")

    async def unsubscribe(self, channel: str):
        """Unsubscribe from a channel"""
        if channel in self._subscriptions:
            await self._subscriptions[channel].unsubscribe()
            del self._subscriptions[channel]
            if channel in self._message_handlers:
                del self._message_handlers[channel]

    async def get_channel_history(
        self,
        channel: str,
        limit: int = 100
    ) -> List[ChannelMessage]:
        """Get recent messages from a channel"""
        messages = []
        subject = f"ship.channel.{channel}"

        try:
            # Create ephemeral consumer to read history
            consumer = await self.js.pull_subscribe(
                subject,
                config=ConsumerConfig(
                    deliver_policy=DeliverPolicy.LAST_PER_SUBJECT,
                    max_deliver=1
                )
            )

            try:
                msgs = await consumer.fetch(limit, timeout=1)
                for msg in msgs:
                    if not msg.subject.endswith("._meta"):
                        messages.append(ChannelMessage.from_json(msg.data))
            except nats.errors.TimeoutError:
                pass

        except Exception as e:
            print(f"Error fetching history: {e}")

        return messages

    async def list_channels(self) -> List[str]:
        """List all available channels"""
        # Get stream info to find subjects
        try:
            stream = await self.js.stream_info("CHANNELS")
            # Extract unique channel names from subjects
            channels = set()
            # This is a simplified version - in production we'd query properly
            return list(channels)
        except Exception:
            return []


# Convenience function for quick testing
async def quick_test():
    """Quick test of NATS channels"""
    import uuid

    # Create two agents
    alice = NATSChannelService()
    await alice.connect("alice")

    bob = NATSChannelService()
    await bob.connect("bob")

    received = []

    async def bob_handler(msg: ChannelMessage):
        print(f"Bob received: {msg.content} from {msg.sender}")
        received.append(msg)
        # Bob responds
        await bob.send_message(msg.channel, f"Got it: {msg.content}")

    async def alice_handler(msg: ChannelMessage):
        print(f"Alice received: {msg.content} from {msg.sender}")
        received.append(msg)

    # Subscribe to test channel
    await bob.subscribe("test-channel", bob_handler)
    await alice.subscribe("test-channel", alice_handler)

    # Give subscriptions time to establish
    await asyncio.sleep(0.1)

    # Alice sends a message
    start = time.time()
    await alice.send_message("test-channel", "Hello Bob!")

    # Wait for response
    await asyncio.sleep(0.5)
    elapsed = (time.time() - start) * 1000

    print(f"\nRound-trip time: {elapsed:.2f}ms")
    print(f"   Messages exchanged: {len(received)}")

    await alice.disconnect()
    await bob.disconnect()


if __name__ == "__main__":
    asyncio.run(quick_test())
