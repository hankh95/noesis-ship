"""
Chat Service -- Send and Receive Messages

This is the main interface for chat functionality.
Supports NATS (fast, real-time) and file-based (fallback) modes.
"""

import asyncio
import json
import os
from pathlib import Path
from typing import Optional, Dict, Any, List
from .models import Message, Conversation

# NATS is optional
try:
    import nats
    from nats.js.api import StreamConfig
    HAS_NATS = True
except ImportError:
    HAS_NATS = False


class Chat:
    """
    Chat service for sending and receiving messages.

    Modes:
        nats: Fast real-time via NATS (0.5ms roundtrip)
        file: File-based persistence (fallback)

    Usage:
        chat = Chat(mode='nats')

        # Send and wait for response
        response = await chat.send_and_wait(
            content="What's the ship status?",
            sender="captain"
        )

        # Just send (no wait)
        await chat.send(content="FYI: meeting at 3pm", sender="captain")
    """

    def __init__(
        self,
        mode: str = "nats",
        nats_url: str = None,
        conversations_dir: Path = None
    ):
        self.mode = mode if (mode == "nats" and HAS_NATS) else "file"
        self.nats_url = nats_url or os.environ.get("NATS_URL", "nats://localhost:4222")
        self.conversations_dir = conversations_dir or Path("conversations/active")

        # NATS connection (lazy initialized)
        self._nc = None
        self._js = None

        # Response queue for wait_for_response
        self._response_queues: Dict[str, asyncio.Queue] = {}

    async def connect(self):
        """Connect to NATS (if using NATS mode)."""
        if self.mode != "nats" or not HAS_NATS:
            return

        if self._nc is not None:
            return  # Already connected

        self._nc = await nats.connect(self.nats_url)
        self._js = self._nc.jetstream()

        # Ensure CHANNELS stream exists
        try:
            await self._js.add_stream(
                name="CHANNELS",
                config=StreamConfig(subjects=["ship.channel.>"])
            )
        except:
            pass  # Stream already exists

    async def disconnect(self):
        """Disconnect from NATS."""
        if self._nc:
            await self._nc.drain()
            await self._nc.close()
            self._nc = None
            self._js = None

    async def send(
        self,
        content: str,
        sender: str = "captain",
        channel: str = "bridge",
        metadata: Dict[str, Any] = None
    ) -> Message:
        """
        Send a message (fire and forget).

        Returns the sent message.
        """
        message = Message(
            sender=sender,
            content=content,
            channel=channel,
            metadata=metadata or {}
        )

        if self.mode == "nats":
            await self._send_nats(message)
        else:
            await self._send_file(message)

        return message

    async def send_and_wait(
        self,
        content: str,
        sender: str = "captain",
        channel: str = "bridge",
        timeout: float = 30.0,
        metadata: Dict[str, Any] = None
    ) -> Optional[Message]:
        """
        Send a message and wait for a response.

        Returns the response message, or None if timeout.
        """
        if self.mode != "nats":
            # File mode doesn't support real-time response
            await self.send(content, sender, channel, metadata)
            return None

        await self.connect()

        message = Message(
            sender=sender,
            content=content,
            channel=channel,
            metadata=metadata or {}
        )

        # Create response queue
        self._response_queues[channel] = asyncio.Queue()

        # Subscribe to channel for responses
        async def response_handler(msg):
            try:
                data = json.loads(msg.data.decode())
                if data.get("sender") != sender:  # Not our own message
                    await self._response_queues[channel].put(Message.from_dict(data))
            except:
                pass

        sub = await self._nc.subscribe(f"ship.channel.{channel}", cb=response_handler)

        try:
            # Send message
            await self._js.publish(f"ship.channel.{channel}", message.to_json())

            # Wait for response
            response = await asyncio.wait_for(
                self._response_queues[channel].get(),
                timeout=timeout
            )
            return response

        except asyncio.TimeoutError:
            return None
        finally:
            await sub.unsubscribe()
            del self._response_queues[channel]

    async def _send_nats(self, message: Message):
        """Send via NATS."""
        await self.connect()
        await self._js.publish(f"ship.channel.{message.channel}", message.to_json())

    async def _send_file(self, message: Message):
        """Send via file (append to conversation file)."""
        self.conversations_dir.mkdir(parents=True, exist_ok=True)
        conv_file = self.conversations_dir / f"{message.channel}.md"

        # Append message
        with open(conv_file, "a") as f:
            f.write(f"\n## {message.time_str} - {message.sender}\n")
            f.write(message.content + "\n")

    async def get_history(
        self,
        channel: str = "bridge",
        limit: int = 50
    ) -> List[Message]:
        """
        Get message history for a channel.

        Note: NATS mode requires the NATS bridge to be running.
        """
        if self.mode == "nats":
            return await self._get_history_nats(channel, limit)
        else:
            return await self._get_history_file(channel, limit)

    async def _get_history_nats(self, channel: str, limit: int) -> List[Message]:
        """Get history via NATS bridge HTTP API."""
        import aiohttp

        bridge_url = os.environ.get("NATS_BRIDGE_URL", "http://localhost:3001")

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{bridge_url}/api/channel/{channel}/history",
                    params={"limit": limit}
                ) as resp:
                    data = await resp.json()
                    return [Message.from_dict(m) for m in data.get("messages", [])]
        except:
            return []

    async def _get_history_file(self, channel: str, limit: int) -> List[Message]:
        """Get history from conversation file."""
        conv_file = self.conversations_dir / f"{channel}.md"

        if not conv_file.exists():
            return []

        # Parse markdown file
        import re
        content = conv_file.read_text()
        messages = []

        pattern = r'^## (\d{1,2}:\d{2}:\d{2}) - (\S+)\s*\n((?:(?!^## ).|\n)*)'
        for match in re.finditer(pattern, content, re.MULTILINE):
            messages.append(Message(
                sender=match.group(2),
                content=match.group(3).strip(),
                channel=channel,
                timestamp=0  # TODO: parse time
            ))

        return messages[-limit:]
