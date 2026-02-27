"""Step definitions for fleet_alerts.feature."""

import pytest
from pytest_bdd import scenarios, given, when, then, parsers
from unittest.mock import patch, AsyncMock

from noesis_ship.core.event_bus import FleetAlerts

scenarios("../features/fleet_alerts.feature")


# ── When steps ───────────────────────────────────────────────────────────────

@when(
    parsers.parse(
        'an agent publishes a pr_created alert for PR {pr:d} by "{agent}" on "{exp}"'
    ),
    target_fixture="alert_context",
)
def publish_pr_created(pr, agent, exp):
    ctx = {"alert_type": None, "payload": {}, "redirected_to": None}
    with patch.object(FleetAlerts, "_publish", new_callable=AsyncMock) as mock:
        mock.return_value = True

        import asyncio
        asyncio.get_event_loop().run_until_complete(
            FleetAlerts.pr_created(pr=pr, exp=exp, agent=agent)
        )

        ctx["alert_type"] = mock.call_args[0][0]
        ctx["payload"] = mock.call_args[0][1]
    return ctx


@when(
    parsers.parse(
        'an agent publishes a ci_failed alert for PR {pr:d} on "{exp}" with details "{details}"'
    ),
    target_fixture="alert_context",
)
def publish_ci_failed(pr, exp, details):
    ctx = {"alert_type": None, "payload": {}, "redirected_to": None}
    with patch.object(FleetAlerts, "_publish", new_callable=AsyncMock) as mock:
        mock.return_value = True

        import asyncio
        asyncio.get_event_loop().run_until_complete(
            FleetAlerts.ci_failed(pr=pr, exp=exp, details=details)
        )

        ctx["alert_type"] = mock.call_args[0][0]
        ctx["payload"] = mock.call_args[0][1]
    return ctx


@when(
    parsers.parse(
        'an agent publishes an agent_stuck alert for "{agent}" on "{exp}" session "{session}" idle {minutes:d} minutes'
    ),
    target_fixture="alert_context",
)
def publish_agent_stuck(agent, exp, session, minutes):
    ctx = {"alert_type": None, "payload": {}, "redirected_to": None}
    with patch.object(FleetAlerts, "_publish", new_callable=AsyncMock) as mock:
        mock.return_value = True

        import asyncio
        asyncio.get_event_loop().run_until_complete(
            FleetAlerts.agent_stuck(
                agent=agent, exp=exp, session=session, idle_minutes=minutes
            )
        )

        ctx["alert_type"] = mock.call_args[0][0]
        ctx["payload"] = mock.call_args[0][1]
    return ctx


@when(
    parsers.parse(
        'an agent publishes an acf_regression alert with delta {delta:g} for PR {pr:d} on "{exp}" being "{being}"'
    ),
    target_fixture="alert_context",
)
def publish_acf_regression(delta, pr, exp, being):
    ctx = {"alert_type": None, "payload": {}, "redirected_to": None}
    with patch.object(FleetAlerts, "_publish", new_callable=AsyncMock) as mock:
        mock.return_value = True

        import asyncio
        asyncio.get_event_loop().run_until_complete(
            FleetAlerts.acf_regression(pr=pr, exp=exp, delta=delta, being=being)
        )

        ctx["alert_type"] = mock.call_args[0][0]
        ctx["payload"] = mock.call_args[0][1]

        # Check if it was redirected (acf_delta instead of acf_regression)
        if ctx["alert_type"] == "acf_delta" and delta >= 0:
            ctx["redirected_to"] = "acf_delta"
    return ctx


# ── Then steps ───────────────────────────────────────────────────────────────

@then(parsers.parse('the alert type should be "{expected}"'))
def check_alert_type(alert_context, expected):
    assert alert_context["alert_type"] == expected


@then(parsers.parse("the payload should contain pr {pr:d}"))
def check_payload_pr(alert_context, pr):
    assert alert_context["payload"]["pr"] == pr


@then(parsers.parse('the payload should contain agent "{agent}"'))
def check_payload_agent(alert_context, agent):
    assert alert_context["payload"]["agent"] == agent


@then(parsers.parse('the payload should contain exp "{exp}"'))
def check_payload_exp(alert_context, exp):
    assert alert_context["payload"]["exp"] == exp


@then(parsers.parse('the payload should contain details "{details}"'))
def check_payload_details(alert_context, details):
    assert alert_context["payload"]["details"] == details


@then(parsers.parse("the payload should contain idle_minutes {minutes:d}"))
def check_payload_idle_minutes(alert_context, minutes):
    assert alert_context["payload"]["idle_minutes"] == minutes


@then(parsers.parse("the payload should contain delta {delta:g}"))
def check_payload_delta(alert_context, delta):
    assert alert_context["payload"]["delta"] == pytest.approx(delta)


@then("it should be redirected to acf_delta")
def check_redirected(alert_context):
    assert alert_context["redirected_to"] == "acf_delta"
    assert alert_context["alert_type"] == "acf_delta"
