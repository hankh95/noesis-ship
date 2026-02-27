"""
Shared test fixtures for noesis-ship.

Integration fixtures (NATS server, relay, WebSocket client) are session-scoped
and only spin up when a test actually requests them — they won't affect unit tests.

Requires:
    - nats-server binary on PATH (skips gracefully if missing)
    - Node.js on PATH
    - packages/relay/node_modules installed
"""

import asyncio
import json
import os
import shutil
import signal
import socket
import subprocess
import time

import pytest
import websockets


def _free_port() -> int:
    """Find a free TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_port(port: int, host: str = "127.0.0.1", timeout: float = 5.0):
    """Block until a TCP port is accepting connections."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"Port {port} not ready after {timeout}s")


# ---------------------------------------------------------------------------
# Integration fixtures — only instantiated when requested
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def nats_port():
    return _free_port()


@pytest.fixture(scope="session")
def nats_server(nats_port):
    """Start a NATS server on a random port for the test session."""
    nats_bin = shutil.which("nats-server")
    if not nats_bin:
        pytest.skip("nats-server not found on PATH")

    proc = subprocess.Popen(
        [nats_bin, "-p", str(nats_port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        _wait_for_port(nats_port, timeout=5.0)
        yield f"nats://127.0.0.1:{nats_port}"
    finally:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=5)


@pytest.fixture(scope="session")
def relay_ws_port():
    return _free_port()


@pytest.fixture(scope="session")
def relay_server(nats_server, relay_ws_port):
    """Start the relay server pointing at the test NATS."""
    relay_script = os.path.join(
        os.path.dirname(__file__), "..", "packages", "relay", "server.js"
    )
    relay_script = os.path.abspath(relay_script)

    if not os.path.exists(relay_script):
        pytest.skip("packages/relay/server.js not found")

    env = {
        **os.environ,
        "WS_PORT": str(relay_ws_port),
        "NATS_URL": nats_server,
        "MACHINE_NAME": "test-runner",
        "AGENTS": "mini:Mini,m5:M5",
        # Don't start session watcher in tests
        "CLAUDE_SESSION_DIR": "",
    }

    proc = subprocess.Popen(
        ["node", relay_script],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    try:
        _wait_for_port(relay_ws_port, timeout=8.0)
        # Give the relay a moment to subscribe to NATS subjects
        time.sleep(0.5)
        yield f"ws://127.0.0.1:{relay_ws_port}"
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture
async def ws_client(relay_server):
    """Connect a WebSocket client to the relay. Yields (ws, received_messages)."""
    received = []

    ws = await websockets.connect(relay_server)

    async def reader():
        try:
            async for raw in ws:
                received.append(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    task = asyncio.create_task(reader())

    # Wait for the initial status message
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline and not received:
        await asyncio.sleep(0.05)

    yield ws, received

    await ws.close()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


@pytest.fixture
async def nats_client(nats_server):
    """A raw NATS connection for publishing test messages."""
    import nats as nats_lib

    nc = await nats_lib.connect(nats_server)
    yield nc
    await nc.drain()
