"""
End-to-end integration tests: NATS → Relay → WebSocket client.

These tests verify that messages published to NATS subjects are forwarded
by the relay to connected WebSocket clients.
"""

import asyncio
import json
import time

import pytest

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_fleet_alert_flows_to_ws(ws_client, nats_client):
    """Publish a fleet alert to NATS → relay forwards to WebSocket client."""
    ws, received = ws_client

    alert = {
        "type": "fleet_alert",
        "alertType": "pr_created",
        "pr": 999,
        "exp": "EXP-TEST",
        "agent": "TestAgent",
        "timestamp": "2026-02-26T00:00:00Z",
    }

    await nats_client.publish(
        "ship.fleet.alert",
        json.dumps(alert).encode(),
    )
    await nats_client.flush()

    # Wait for the message to arrive via WebSocket
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        fleet_msgs = [m for m in received if m.get("type") == "fleet_alert"]
        if fleet_msgs:
            break
        await asyncio.sleep(0.05)

    fleet_msgs = [m for m in received if m.get("type") == "fleet_alert"]
    assert len(fleet_msgs) >= 1, f"Expected fleet alert, got: {received}"
    msg = fleet_msgs[0]
    assert msg["alertType"] == "pr_created"
    assert msg["pr"] == 999
    assert msg["agent"] == "TestAgent"


@pytest.mark.asyncio
async def test_channel_message_flows_to_ws(ws_client, nats_client):
    """Publish a channel message to NATS → relay forwards to WebSocket client."""
    ws, received = ws_client

    message = {
        "type": "message",
        "group": "fleet",
        "from": "M5",
        "fromId": "agent:m5",
        "message": "integration test hello",
        "timestamp": "2026-02-26T00:00:00Z",
    }

    await nats_client.publish(
        "ship.channel.fleet",
        json.dumps(message).encode(),
    )
    await nats_client.flush()

    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        chat_msgs = [
            m for m in received
            if m.get("type") == "message" and m.get("message") == "integration test hello"
        ]
        if chat_msgs:
            break
        await asyncio.sleep(0.05)

    chat_msgs = [
        m for m in received
        if m.get("type") == "message" and m.get("message") == "integration test hello"
    ]
    assert len(chat_msgs) >= 1, f"Expected channel message, got: {received}"
    assert chat_msgs[0]["from"] == "M5"
    assert chat_msgs[0]["group"] == "fleet"


@pytest.mark.asyncio
async def test_kanban_event_flows_to_ws(ws_client, nats_client):
    """Publish a kanban event to NATS → relay forwards to WebSocket client."""
    ws, received = ws_client

    event = {
        "type": "kanban_event",
        "event": "moved",
        "item": {"id": "EXP-999", "title": "Test", "status": "done"},
        "repo": "noesis-ship",
        "timestamp": "2026-02-26T00:00:00Z",
    }

    await nats_client.publish(
        "ship.kanban.moved",
        json.dumps(event).encode(),
    )
    await nats_client.flush()

    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        kb_msgs = [m for m in received if m.get("type") == "kanban_event"]
        if kb_msgs:
            break
        await asyncio.sleep(0.05)

    kb_msgs = [m for m in received if m.get("type") == "kanban_event"]
    assert len(kb_msgs) >= 1, f"Expected kanban event, got: {received}"
    assert kb_msgs[0]["item"]["id"] == "EXP-999"
    assert kb_msgs[0]["event"] == "moved"


@pytest.mark.asyncio
async def test_python_eventbus_fleet_alert_to_ws(
    ws_client, nats_server, nats_client
):
    """Use Python FleetAlerts class → NATS → relay → WebSocket client."""
    from noesis_ship.core.event_bus import EventBus, FleetAlerts

    ws, received = ws_client

    # Create a dedicated EventBus pointed at the test NATS
    bus = EventBus(nats_url=nats_server)
    connected = await bus.connect()
    assert connected, "EventBus failed to connect to test NATS"

    try:
        # Publish a fleet alert using the Python convenience method
        alert = {
            "type": "fleet_alert",
            "alertType": "ci_failed",
            "timestamp": "2026-02-26T00:00:00Z",
            "pr": 888,
            "exp": "EXP-E2E",
            "details": "lint failed",
        }
        import json as json_mod
        await bus.nc.publish(
            FleetAlerts.SUBJECT,
            json_mod.dumps(alert).encode(),
        )
        await bus.nc.flush()

        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            fleet_msgs = [
                m for m in received
                if m.get("type") == "fleet_alert" and m.get("alertType") == "ci_failed"
            ]
            if fleet_msgs:
                break
            await asyncio.sleep(0.05)

        fleet_msgs = [
            m for m in received
            if m.get("type") == "fleet_alert" and m.get("alertType") == "ci_failed"
        ]
        assert len(fleet_msgs) >= 1, f"Expected ci_failed alert, got: {received}"
        assert fleet_msgs[0]["pr"] == 888
        assert fleet_msgs[0]["exp"] == "EXP-E2E"
    finally:
        await bus.disconnect()
