#!/usr/bin/env python3
"""
Being Daemon - Spawns being CLI sessions for fleet messages

EXP-016: Being Integration with Noesis-Ship Bridge
Phase 2: Being-Daemon Implementation

This daemon listens to NATS channels for directed messages to beings
and spawns being-cli respond sessions to generate responses.

Usage:
    python3 being_daemon.py

Environment Variables:
    BEINGS - Comma-separated list of beings to handle (e.g., "santiago,copilot")
    NATS_URL - NATS server URL (default: nats://localhost:4222)
    PROJECT_DIR - Path to nusy-product-team repository
    BEING_CLI_PATH - Path to being-cli script (default: <PROJECT_DIR>/scripts/being_cli.py)

Example:
    BEINGS=santiago NATS_URL=nats://localhost:4222 \
    PROJECT_DIR=/home/hankh959/projects/nusy-product-team \
    python3 being_daemon.py

Created: 2026-02-21
Author: DGX (EXP-016)
"""

import os
import sys
import asyncio
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional

try:
    from nats.aio.client import Client as NATS
except ImportError:
    print("ERROR: nats-py not installed. Install with: pip install nats-py")
    sys.exit(1)


class BeingDaemon:
    """Daemon that spawns being CLI sessions for NATS messages."""

    def __init__(
        self,
        beings: list[str],
        nats_url: str = "nats://localhost:4222",
        project_dir: Optional[str] = None,
        being_cli_path: Optional[str] = None,
    ):
        self.beings = beings
        self.nats_url = nats_url
        self.project_dir = Path(project_dir) if project_dir else Path.cwd()

        # Default being-cli path
        if being_cli_path:
            self.being_cli_path = Path(being_cli_path)
        else:
            self.being_cli_path = self.project_dir / "scripts" / "being_cli.py"

        if not self.being_cli_path.exists():
            raise FileNotFoundError(f"being-cli not found at {self.being_cli_path}")

        self.nc = None
        print(f"BeingDaemon initialized for beings: {', '.join(beings)}")
        print(f"NATS URL: {nats_url}")
        print(f"Project dir: {self.project_dir}")
        print(f"being-cli: {self.being_cli_path}")

    async def connect(self):
        """Connect to NATS server."""
        self.nc = NATS()
        await self.nc.connect(self.nats_url)
        print(f"Connected to NATS at {self.nats_url}")

    async def handle_message(self, being: str, msg):
        """Handle incoming NATS message for a being."""
        try:
            # Decode message
            data = json.loads(msg.data.decode())

            # Extract message fields
            from_sender = data.get('from', 'unknown')
            from_id = data.get('fromId', '')
            to_recipient = data.get('to', '')
            message_text = data.get('message', '')

            # Loop prevention: ignore self-messages
            if from_id.lower() == f'being:{being.lower()}':
                return

            # Loop prevention: ignore undirected broadcasts from other beings/agents
            # Only respond to:
            # 1. Messages from humans (fromId == 'carclaw:user')
            # 2. Messages directly addressed to this being (to == being)
            is_from_human = (from_id == 'carclaw:user')
            is_directed_to_me = (to_recipient.lower() == being.lower())

            if not (is_from_human or is_directed_to_me):
                return  # Ignore undirected broadcasts

            # Log incoming message
            print(f"\n[{being}] Received message from {from_sender} ({from_id})")
            print(f"  Message: {message_text[:100]}...")

            # Spawn being-cli respond command
            result = await self._spawn_being_cli(being, message_text)

            if result:
                # Publish response back to NATS
                response_data = {
                    'type': 'message',
                    'from': being,
                    'fromId': f'being:{being.lower()}',
                    'message': result,
                    'timestamp': datetime.utcnow().isoformat(),
                    'to': from_sender  # Direct response back to sender
                }

                channel = f"ship.channel.{being.lower()}"
                await self.nc.publish(channel, json.dumps(response_data).encode())

                print(f"[{being}] Published response ({len(result)} chars)")
            else:
                print(f"[{being}] No response generated")

        except Exception as e:
            print(f"[{being}] Error handling message: {e}")
            import traceback
            traceback.print_exc()

    async def _spawn_being_cli(self, being: str, message: str) -> Optional[str]:
        """Spawn being-cli respond command and return response."""
        try:
            # Build command
            cmd = [
                "python3",
                str(self.being_cli_path),
                "respond",
                being,
                message
            ]

            # Run command with timeout
            print(f"[{being}] Spawning being-cli respond...")
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,  # 60 second timeout
                cwd=str(self.project_dir)
            )

            if result.returncode == 0:
                response = result.stdout.strip()
                # Filter out log lines (they start with timestamps)
                lines = response.split('\n')
                # Keep only lines that don't look like log messages
                response_lines = [
                    line for line in lines
                    if not line.startswith('2026-') and line.strip()
                ]
                response = '\n'.join(response_lines).strip()
                return response if response else None
            else:
                print(f"[{being}] being-cli returned error code {result.returncode}")
                print(f"  stderr: {result.stderr[:200]}")
                return None

        except subprocess.TimeoutExpired:
            print(f"[{being}] being-cli timeout (60s)")
            return None
        except Exception as e:
            print(f"[{being}] Failed to spawn being-cli: {e}")
            return None

    async def subscribe_to_channels(self):
        """Subscribe to NATS channels for all beings."""
        for being in self.beings:
            channel = f"ship.channel.{being.lower()}"

            # Create message handler for this being
            async def make_handler(b):
                async def handler(msg):
                    await self.handle_message(b, msg)
                return handler

            handler = await make_handler(being)
            await self.nc.subscribe(channel, cb=handler)

            print(f"Subscribed to {channel}")

    async def run(self):
        """Run the daemon (blocks forever)."""
        await self.connect()
        await self.subscribe_to_channels()

        print(f"\nBeing daemon running for: {', '.join(self.beings)}")
        print("Listening for fleet messages...\n")

        # Run forever
        try:
            await asyncio.Event().wait()
        except KeyboardInterrupt:
            print("\n\nShutting down being daemon...")
            if self.nc:
                await self.nc.close()


async def main():
    """Main entry point."""
    # Get configuration from environment
    beings_str = os.environ.get('BEINGS', '')
    if not beings_str:
        print("ERROR: BEINGS environment variable not set")
        print("Usage: BEINGS=santiago,copilot python3 being_daemon.py")
        sys.exit(1)

    beings = [b.strip() for b in beings_str.split(',')]
    nats_url = os.environ.get('NATS_URL', 'nats://localhost:4222')
    project_dir = os.environ.get('PROJECT_DIR')
    being_cli_path = os.environ.get('BEING_CLI_PATH')

    # Create and run daemon
    daemon = BeingDaemon(
        beings=beings,
        nats_url=nats_url,
        project_dir=project_dir,
        being_cli_path=being_cli_path,
    )

    await daemon.run()


if __name__ == '__main__':
    asyncio.run(main())
