"""
Chat Models -- Clean Data Structures

These models are the source of truth for chat data.
They can be serialized to JSON for NATS or stored as files.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Dict, Any, List
import json
import time


@dataclass
class Message:
    """A single chat message."""

    sender: str
    content: str
    channel: str = "bridge"
    timestamp: float = field(default_factory=time.time)
    message_id: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not self.message_id:
            self.message_id = f"{self.channel}-{int(self.timestamp * 1000000)}"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "sender": self.sender,
            "content": self.content,
            "channel": self.channel,
            "timestamp": self.timestamp,
            "message_id": self.message_id,
            "metadata": self.metadata
        }

    def to_json(self) -> bytes:
        """Convert to JSON bytes for NATS."""
        return json.dumps(self.to_dict()).encode()

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Message":
        """Create from dictionary."""
        return cls(
            sender=data.get("sender", "unknown"),
            content=data.get("content", ""),
            channel=data.get("channel", "bridge"),
            timestamp=data.get("timestamp", time.time()),
            message_id=data.get("message_id", ""),
            metadata=data.get("metadata", {})
        )

    @classmethod
    def from_json(cls, data: bytes) -> "Message":
        """Create from JSON bytes."""
        return cls.from_dict(json.loads(data.decode()))

    @property
    def time_str(self) -> str:
        """Human-readable timestamp."""
        return datetime.fromtimestamp(self.timestamp).strftime("%H:%M:%S")

    @property
    def is_from_captain(self) -> bool:
        """Check if message is from captain."""
        return self.sender.lower() == "captain"

    @property
    def is_from_being(self) -> bool:
        """Check if message is from an agent (not captain or system)."""
        return self.sender.lower() not in ("captain", "system", "unknown")


@dataclass
class Conversation:
    """A collection of messages forming a conversation."""

    conversation_id: str
    channel: str = "bridge"
    topic: str = ""
    participants: List[str] = field(default_factory=list)
    messages: List[Message] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def add_message(self, message: Message):
        """Add a message to the conversation."""
        self.messages.append(message)
        self.updated_at = time.time()

        # Auto-add participants
        if message.sender not in self.participants:
            self.participants.append(message.sender)

    def get_last_message(self) -> Optional[Message]:
        """Get the most recent message."""
        return self.messages[-1] if self.messages else None

    def get_messages_by_sender(self, sender: str) -> List[Message]:
        """Get all messages from a specific sender."""
        return [m for m in self.messages if m.sender == sender]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "conversation_id": self.conversation_id,
            "channel": self.channel,
            "topic": self.topic,
            "participants": self.participants,
            "messages": [m.to_dict() for m in self.messages],
            "created_at": self.created_at,
            "updated_at": self.updated_at
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Conversation":
        """Create from dictionary."""
        conv = cls(
            conversation_id=data.get("conversation_id", ""),
            channel=data.get("channel", "bridge"),
            topic=data.get("topic", ""),
            participants=data.get("participants", []),
            created_at=data.get("created_at", time.time()),
            updated_at=data.get("updated_at", time.time())
        )
        for msg_data in data.get("messages", []):
            conv.messages.append(Message.from_dict(msg_data))
        return conv

    def to_markdown(self) -> str:
        """Convert to markdown format for file storage."""
        lines = [
            "---",
            f"conversation_id: {self.conversation_id}",
            f"channel: {self.channel}",
            f"topic: {self.topic}",
            f"participants: [{', '.join(self.participants)}]",
            f"created_at: {datetime.fromtimestamp(self.created_at).isoformat()}",
            "---",
            ""
        ]

        for msg in self.messages:
            lines.append(f"## {msg.time_str} - {msg.sender}")
            lines.append(msg.content)
            lines.append("")

        return "\n".join(lines)
