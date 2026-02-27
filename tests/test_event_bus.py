"""Tests for the EventBus (local fallback mode — no NATS required)."""

import asyncio
from unittest.mock import patch, AsyncMock
import pytest
from noesis_ship.core.event_bus import (
    EventBus,
    ShipEvent,
    EventTypes,
    KanbanEvents,
    RunnerEvents,
    BeingEvents,
    FleetAlerts,
)


class TestShipEvent:
    """Test ShipEvent data class."""

    def test_create_event(self):
        event = ShipEvent.create(
            event_type="test.event",
            source="test-suite",
            payload={"key": "value"},
        )
        assert event.event_type == "test.event"
        assert event.source == "test-suite"
        assert event.payload == {"key": "value"}
        assert event.version == "1.0"
        assert event.timestamp.endswith("Z")
        assert event.correlation_id is not None

    def test_event_to_json(self):
        event = ShipEvent.create(
            event_type="test.json",
            source="test-suite",
            payload={"count": 42},
        )
        json_str = event.to_json()
        assert '"event_type": "test.json"' in json_str
        assert '"count": 42' in json_str

    def test_event_to_dict(self):
        event = ShipEvent.create(
            event_type="test.dict",
            source="test-suite",
            payload={},
        )
        d = event.to_dict()
        assert isinstance(d, dict)
        assert d["event_type"] == "test.dict"
        assert d["source"] == "test-suite"

    def test_custom_correlation_id(self):
        event = ShipEvent.create(
            event_type="test.corr",
            source="test-suite",
            payload={},
            correlation_id="my-trace-123",
        )
        assert event.correlation_id == "my-trace-123"


class TestEventBusLocal:
    """Test EventBus in local fallback mode (no NATS connection)."""

    @pytest.fixture
    def bus(self):
        return EventBus(nats_url="nats://localhost:4222")

    def test_not_connected_initially(self, bus):
        assert not bus.is_connected

    @pytest.mark.asyncio
    async def test_emit_without_connection(self, bus):
        """Events should still work locally when NATS is unavailable."""
        result = await bus.emit(
            "test.local",
            "test-suite",
            {"message": "hello"},
        )
        # Returns False because NATS is not connected
        assert result is False

    @pytest.mark.asyncio
    async def test_local_handler_receives_events(self, bus):
        """Local handlers should receive events when NATS is down."""
        received = []

        async def handler(event: ShipEvent):
            received.append(event)

        await bus.subscribe("test.*", handler)

        await bus.emit("test.local", "test-suite", {"msg": "hello"})

        assert len(received) == 1
        assert received[0].payload == {"msg": "hello"}

    @pytest.mark.asyncio
    async def test_pattern_matching_wildcard(self, bus):
        """Wildcard patterns should match appropriately."""
        received = []

        async def handler(event: ShipEvent):
            received.append(event)

        await bus.subscribe("kanban.*", handler)

        await bus.emit("kanban.item-moved", "test", {"item": "T-1"})
        await bus.emit("kanban.item-created", "test", {"item": "T-2"})
        await bus.emit("runner.heartbeat", "test", {})  # Should NOT match

        assert len(received) == 2

    @pytest.mark.asyncio
    async def test_pattern_matching_all(self, bus):
        """The '>' pattern should match everything."""
        received = []

        async def handler(event: ShipEvent):
            received.append(event)

        await bus.subscribe(">", handler)

        await bus.emit("kanban.item-moved", "test", {})
        await bus.emit("runner.heartbeat", "test", {})
        await bus.emit("being.thinking", "test", {})

        assert len(received) == 3

    @pytest.mark.asyncio
    async def test_pattern_matching_exact(self, bus):
        """Exact patterns should only match exact subjects."""
        received = []

        async def handler(event: ShipEvent):
            received.append(event)

        await bus.subscribe("kanban.item-moved", handler)

        await bus.emit("kanban.item-moved", "test", {"match": True})
        await bus.emit("kanban.item-created", "test", {"match": False})

        assert len(received) == 1
        assert received[0].payload["match"] is True


class TestEventTypes:
    """Test that EventTypes constants are defined."""

    def test_kanban_events(self):
        assert EventTypes.KANBAN_ITEM_MOVED == "kanban.item-moved"
        assert EventTypes.KANBAN_ITEM_ASSIGNED == "kanban.item-assigned"
        assert EventTypes.KANBAN_ITEM_CREATED == "kanban.item-created"

    def test_runner_events(self):
        assert EventTypes.RUNNER_HEARTBEAT == "runner.heartbeat"
        assert EventTypes.RUNNER_WORK_STARTED == "runner.work-started"
        assert EventTypes.RUNNER_WORK_COMPLETED == "runner.work-completed"

    def test_being_events(self):
        assert EventTypes.BEING_THINKING == "being.thinking"
        assert EventTypes.BEING_RESPONDED == "being.responded"
        assert EventTypes.BEING_ERROR == "being.error"

    def test_voyage_events(self):
        assert EventTypes.VOYAGE_COMMISSIONED == "voyage.commissioned"
        assert EventTypes.VOYAGE_SAILED == "voyage.sailed"
        assert EventTypes.VOYAGE_COMPLETED == "voyage.completed"


class TestPatternMatching:
    """Test the _matches_pattern helper."""

    def test_exact_match(self):
        bus = EventBus()
        assert bus._matches_pattern("kanban.item-moved", "kanban.item-moved")
        assert not bus._matches_pattern("kanban.item-moved", "kanban.item-created")

    def test_wildcard_star(self):
        bus = EventBus()
        assert bus._matches_pattern("kanban.item-moved", "kanban.*")
        assert bus._matches_pattern("kanban.anything", "kanban.*")
        assert not bus._matches_pattern("runner.heartbeat", "kanban.*")

    def test_wildcard_gt(self):
        bus = EventBus()
        assert bus._matches_pattern("kanban.item-moved", ">")
        assert bus._matches_pattern("anything.at.all", ">")

    def test_multi_level_wildcard(self):
        bus = EventBus()
        assert bus._matches_pattern("being.agent1.thinking", "being.>")
        assert bus._matches_pattern("being.agent1.error", "being.>")
        assert not bus._matches_pattern("kanban.item-moved", "being.>")


class TestFleetAlertEventTypes:
    """Test that fleet alert EventTypes constants are defined."""

    def test_fleet_pr_created(self):
        assert EventTypes.FLEET_PR_CREATED == "fleet.pr-created"

    def test_fleet_ci_failed(self):
        assert EventTypes.FLEET_CI_FAILED == "fleet.ci-failed"

    def test_fleet_agent_stuck(self):
        assert EventTypes.FLEET_AGENT_STUCK == "fleet.agent-stuck"

    def test_fleet_agent_crash(self):
        assert EventTypes.FLEET_AGENT_CRASH == "fleet.agent-crash"

    def test_fleet_acf_delta(self):
        assert EventTypes.FLEET_ACF_DELTA == "fleet.acf-delta"

    def test_fleet_acf_regression(self):
        assert EventTypes.FLEET_ACF_REGRESSION == "fleet.acf-regression"


class TestFleetAlerts:
    """Test FleetAlerts class — methods should not raise regardless of NATS state."""

    def test_subject_constant(self):
        assert FleetAlerts.SUBJECT == "ship.fleet.alert"

    @pytest.mark.asyncio
    async def test_pr_created_does_not_raise(self):
        """pr_created should return a bool without raising."""
        result = await FleetAlerts.pr_created(pr=175, exp="EXP-994", agent="Mini")
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    async def test_ci_failed_does_not_raise(self):
        result = await FleetAlerts.ci_failed(pr=176, exp="EXP-995")
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    async def test_agent_stuck_does_not_raise(self):
        result = await FleetAlerts.agent_stuck(
            agent="DGX", exp="EXP-994", session="exp-994", idle_minutes=18
        )
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    async def test_agent_crash_does_not_raise(self):
        result = await FleetAlerts.agent_crash(
            agent="Mini", exp="EXP-994", session="exp-994", exit_code=1
        )
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    async def test_acf_delta_does_not_raise(self):
        result = await FleetAlerts.acf_delta(
            pr=175, exp="EXP-994", delta=0.03, being="santiago-toddler-v12"
        )
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    async def test_acf_regression_does_not_raise(self):
        result = await FleetAlerts.acf_regression(
            pr=176, exp="EXP-995", delta=-0.02, being="santiago-toddler-v12"
        )
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    async def test_pr_reviewed_does_not_raise(self):
        result = await FleetAlerts.pr_reviewed(pr=175, reviewer="DGX", passed=True)
        assert isinstance(result, bool)


class TestFleetAlertsPayload:
    """Test that FleetAlerts methods pass correct payloads to _publish."""

    @pytest.mark.asyncio
    async def test_pr_created_payload(self):
        with patch.object(FleetAlerts, "_publish", new_callable=AsyncMock) as mock_pub:
            mock_pub.return_value = True
            await FleetAlerts.pr_created(pr=175, exp="EXP-994", agent="Mini")
            mock_pub.assert_called_once_with("pr_created", {
                "pr": 175, "exp": "EXP-994", "agent": "Mini",
            })

    @pytest.mark.asyncio
    async def test_ci_failed_payload(self):
        with patch.object(FleetAlerts, "_publish", new_callable=AsyncMock) as mock_pub:
            mock_pub.return_value = True
            await FleetAlerts.ci_failed(pr=176, exp="EXP-995", details="lint error")
            mock_pub.assert_called_once_with("ci_failed", {
                "pr": 176, "exp": "EXP-995", "details": "lint error",
            })

    @pytest.mark.asyncio
    async def test_agent_stuck_payload(self):
        with patch.object(FleetAlerts, "_publish", new_callable=AsyncMock) as mock_pub:
            mock_pub.return_value = True
            await FleetAlerts.agent_stuck(
                agent="DGX", exp="EXP-994", session="exp-994", idle_minutes=18
            )
            mock_pub.assert_called_once_with("agent_stuck", {
                "agent": "DGX", "exp": "EXP-994", "session": "exp-994",
                "idle_minutes": 18,
            })

    @pytest.mark.asyncio
    async def test_acf_regression_payload_negative_delta(self):
        """Negative delta should publish as acf_regression."""
        with patch.object(FleetAlerts, "_publish", new_callable=AsyncMock) as mock_pub:
            mock_pub.return_value = True
            await FleetAlerts.acf_regression(
                pr=176, exp="EXP-995", delta=-0.02, being="santiago-toddler-v12"
            )
            mock_pub.assert_called_once_with("acf_regression", {
                "pr": 176, "exp": "EXP-995", "delta": -0.02,
                "being": "santiago-toddler-v12",
            })

    @pytest.mark.asyncio
    async def test_acf_regression_positive_delta_redirects(self):
        """Positive delta on acf_regression should redirect to acf_delta."""
        with patch.object(FleetAlerts, "_publish", new_callable=AsyncMock) as mock_pub:
            mock_pub.return_value = True
            await FleetAlerts.acf_regression(
                pr=175, exp="EXP-994", delta=0.03, being="santiago-toddler-v12"
            )
            # Should have been routed to acf_delta instead
            mock_pub.assert_called_once_with("acf_delta", {
                "pr": 175, "exp": "EXP-994", "delta": 0.03,
                "being": "santiago-toddler-v12",
            })
