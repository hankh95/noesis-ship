"""Step definitions for relay_forwarding.feature (integration tests).

These tests require a running NATS server and relay — they use the
session-scoped fixtures from tests/conftest.py.

Uses a threaded WebSocket reader because pytest-bdd steps are synchronous,
so we can't use asyncio.sleep() to yield to an async WS reader task.
"""

import asyncio
import json
import threading
import time

import pytest
import websockets.sync.client as ws_sync
from pytest_bdd import scenarios, given, when, then, parsers

pytestmark = pytest.mark.integration

scenarios("../features/relay_forwarding.feature")


# ── Given steps ──────────────────────────────────────────────────────────────

@given("a running NATS server and relay", target_fixture="infra")
def running_infra(nats_server, relay_server):
    """Provided by session-scoped fixtures."""
    return {"nats_url": nats_server, "relay_url": relay_server}


@given("a WebSocket client connected to the relay", target_fixture="ws_ctx")
def ws_connected(relay_server):
    """Connect a synchronous WebSocket client with a background reader thread."""
    received = []
    ws = ws_sync.connect(relay_server)

    def reader():
        try:
            while True:
                raw = ws.recv(timeout=5)
                received.append(json.loads(raw))
        except Exception:
            pass

    t = threading.Thread(target=reader, daemon=True)
    t.start()

    # Wait for the initial status message
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline and not received:
        time.sleep(0.05)

    return {"ws": ws, "received": received}


# ── When steps ───────────────────────────────────────────────────────────────

@when(
    parsers.parse(
        'a fleet alert is published to NATS with alertType "{alert_type}" and pr {pr:d}'
    ),
)
def publish_fleet_alert(nats_client, alert_type, pr):
    loop = asyncio.get_event_loop()
    loop.run_until_complete(_publish_nats(
        nats_client, "ship.fleet.alert", {
            "type": "fleet_alert",
            "alertType": alert_type,
            "pr": pr,
            "timestamp": "2026-02-26T00:00:00Z",
        }
    ))


@when(
    parsers.parse(
        'a channel message is published to NATS on "{subject}" saying "{text}"'
    ),
)
def publish_channel_message(nats_client, subject, text):
    loop = asyncio.get_event_loop()
    loop.run_until_complete(_publish_nats(
        nats_client, subject, {
            "type": "message",
            "group": "fleet",
            "from": "TestBot",
            "fromId": "agent:testbot",
            "message": text,
            "timestamp": "2026-02-26T00:00:00Z",
        }
    ))


@when(
    parsers.parse('a kanban event is published to NATS for item "{item_id}"'),
)
def publish_kanban_event(nats_client, item_id):
    loop = asyncio.get_event_loop()
    loop.run_until_complete(_publish_nats(
        nats_client, "ship.kanban.moved", {
            "type": "kanban_event",
            "event": "moved",
            "item": {"id": item_id, "title": "BDD Test", "status": "done"},
            "repo": "noesis-ship",
            "timestamp": "2026-02-26T00:00:00Z",
        }
    ))


async def _publish_nats(nc, subject, payload):
    await nc.publish(subject, json.dumps(payload).encode())
    await nc.flush()


# ── Then steps ───────────────────────────────────────────────────────────────

@then(
    parsers.parse('the WebSocket client should receive a message with type "{msg_type}"'),
)
def ws_receives_type(ws_ctx, msg_type):
    received = ws_ctx["received"]

    # Poll — the threaded reader fills `received` in the background
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        matches = [m for m in received if m.get("type") == msg_type]
        if matches:
            ws_ctx["last_match"] = matches[-1]
            return
        time.sleep(0.05)

    matches = [m for m in received if m.get("type") == msg_type]
    assert matches, f"Expected message with type '{msg_type}', got: {received}"
    ws_ctx["last_match"] = matches[-1]


@then(parsers.parse('the received message should have alertType "{expected}"'))
def check_received_alert_type(ws_ctx, expected):
    assert ws_ctx["last_match"]["alertType"] == expected


@then(parsers.parse('the received message should have message "{expected}"'))
def check_received_message(ws_ctx, expected):
    assert ws_ctx["last_match"]["message"] == expected


@then(parsers.parse('the received message should have item id "{expected}"'))
def check_received_item_id(ws_ctx, expected):
    assert ws_ctx["last_match"]["item"]["id"] == expected
