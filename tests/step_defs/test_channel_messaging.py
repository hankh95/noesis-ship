"""Step definitions for channel_messaging.feature.

Tests the Node.js wire protocol logic via Python equivalents,
verifying the same patterns used by @noesis-ship/shared.
"""

import pytest
from pytest_bdd import scenarios, given, when, then, parsers

scenarios("../features/channel_messaging.feature")


# ── Helpers ──────────────────────────────────────────────────────────────────

def build_message(group, from_name, from_id, message, to=None):
    """Python equivalent of buildMessage() from wire-protocol.js."""
    from datetime import datetime, timezone

    msg = {
        "type": "message",
        "group": group,
        "from": from_name,
        "fromId": from_id,
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if to:
        msg["to"] = to
    return msg


def is_from_self(msg, agent_name):
    return msg.get("from", "").lower() == agent_name.lower()


def is_from_human(msg):
    return msg.get("fromId", "").startswith("carclaw:")


def is_from_agent(msg):
    return msg.get("fromId", "").startswith("agent:")


def channel_subject(group):
    return f"ship.channel.{group}"


# ── When / Given steps ───────────────────────────────────────────────────────

@when(
    parsers.parse(
        'a message is built from "{from_name}" in group "{group}" saying "{text}"'
    ),
    target_fixture="message_context",
)
def build_basic_message(from_name, group, text):
    return {"message": build_message(group, from_name, f"agent:{from_name.lower()}", text)}


@when(
    parsers.parse(
        'a message is built from "{from_name}" in group "{group}" saying "{text}" directed to "{to}"'
    ),
    target_fixture="message_context",
)
def build_directed_message(from_name, group, text, to):
    return {"message": build_message(group, from_name, f"agent:{from_name.lower()}", text, to=to)}


@given(
    parsers.parse('a message from "{from_name}" with fromId "{from_id}"'),
    target_fixture="message_context",
)
def given_message(from_name, from_id):
    return {
        "message": {
            "type": "message",
            "from": from_name,
            "fromId": from_id,
            "message": "test",
        }
    }


@when(
    parsers.parse('building a channel subject for "{group}"'),
    target_fixture="subject_result",
)
def build_subject(group):
    return channel_subject(group)


# ── Then steps ───────────────────────────────────────────────────────────────

@then(parsers.parse('the message type should be "{expected}"'))
def check_message_type(message_context, expected):
    assert message_context["message"]["type"] == expected


@then(parsers.parse('the message group should be "{expected}"'))
def check_message_group(message_context, expected):
    assert message_context["message"]["group"] == expected


@then(parsers.parse('the message from should be "{expected}"'))
def check_message_from(message_context, expected):
    assert message_context["message"]["from"] == expected


@then("the message should have a timestamp")
def check_message_timestamp(message_context):
    assert "timestamp" in message_context["message"]
    assert message_context["message"]["timestamp"].endswith("Z")


@then(parsers.parse('the message should have to field "{expected}"'))
def check_message_to(message_context, expected):
    assert message_context["message"]["to"] == expected


@when(parsers.parse('checking if it is from "{agent}"'))
def check_self(message_context, agent):
    message_context["is_self"] = is_from_self(message_context["message"], agent)


@then("it should be detected as self")
def assert_is_self(message_context):
    assert message_context["is_self"] is True


@then("it should be detected as human")
def assert_is_human(message_context):
    assert is_from_human(message_context["message"]) is True


@then("it should not be detected as human")
def assert_not_human(message_context):
    assert is_from_human(message_context["message"]) is False


@then("it should be detected as agent")
def assert_is_agent(message_context):
    assert is_from_agent(message_context["message"]) is True


@then("it should not be detected as agent")
def assert_not_agent(message_context):
    assert is_from_agent(message_context["message"]) is False


@then(parsers.parse('the subject should be "{expected}"'))
def check_subject(subject_result, expected):
    assert subject_result == expected
