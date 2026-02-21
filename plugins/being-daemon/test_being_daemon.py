#!/usr/bin/env python3
"""Tests for BeingDaemon message filtering and response logic.

Covers the should_respond truth table from README.md:
- Human messages → always respond
- Directed agent messages → respond if addressed to this being
- Self-messages → never respond (loop prevention via fromId and origin)
- Undirected broadcasts → never respond
"""

import json
import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


# --- Extracted filtering logic for testability ---

def should_respond(being: str, data: dict) -> bool:
    """Determine if the being should respond to a message.

    This mirrors the filtering logic in BeingDaemon.handle_message().
    """
    from_id = data.get('fromId', '')
    origin = data.get('origin', '')
    to_recipient = data.get('to', '')

    # Loop prevention: ignore self-messages
    if from_id.lower() == f'being:{being.lower()}':
        return False
    if origin.lower() == f'being-daemon:{being.lower()}':
        return False

    # Only respond to human messages or directed messages
    is_from_human = (from_id == 'carclaw:user')
    is_directed_to_me = (to_recipient.lower() == being.lower())

    return is_from_human or is_directed_to_me


class TestShouldRespond(unittest.TestCase):
    """Truth table tests for message filtering."""

    def test_human_message_responds(self):
        """Human messages → always respond."""
        data = {
            'fromId': 'carclaw:user',
            'from': 'Captain',
            'to': '',
            'message': 'How are you?',
        }
        self.assertTrue(should_respond('santiago', data))

    def test_human_directed_message_responds(self):
        """Human directed to this being → respond."""
        data = {
            'fromId': 'carclaw:user',
            'from': 'Captain',
            'to': 'santiago',
            'message': 'Santiago, status?',
        }
        self.assertTrue(should_respond('santiago', data))

    def test_agent_directed_message_responds(self):
        """Agent directed to this being → respond."""
        data = {
            'fromId': 'agent:m5',
            'from': 'M5',
            'to': 'santiago',
            'message': 'Santiago, what is your training progress?',
        }
        self.assertTrue(should_respond('santiago', data))

    def test_self_message_ignored_via_fromid(self):
        """Self-messages via fromId → never respond."""
        data = {
            'fromId': 'being:santiago',
            'from': 'santiago',
            'to': '',
            'message': 'My own response',
        }
        self.assertFalse(should_respond('santiago', data))

    def test_self_message_ignored_via_origin(self):
        """Self-messages via origin → never respond."""
        data = {
            'fromId': 'relay:mini',
            'origin': 'being-daemon:santiago',
            'from': 'santiago',
            'to': '',
            'message': 'Relayed self-message',
        }
        self.assertFalse(should_respond('santiago', data))

    def test_undirected_broadcast_ignored(self):
        """Undirected broadcast from agent → never respond."""
        data = {
            'fromId': 'agent:m5',
            'from': 'M5',
            'to': '',
            'message': 'General announcement',
        }
        self.assertFalse(should_respond('santiago', data))

    def test_other_being_undirected_ignored(self):
        """Undirected message from another being → never respond."""
        data = {
            'fromId': 'being:copilot',
            'from': 'copilot',
            'to': '',
            'message': 'Hello fleet',
        }
        self.assertFalse(should_respond('santiago', data))

    def test_other_being_directed_responds(self):
        """Another being directed to this being → respond."""
        data = {
            'fromId': 'being:copilot',
            'from': 'copilot',
            'to': 'santiago',
            'message': 'Santiago, I need your help',
        }
        self.assertTrue(should_respond('santiago', data))

    def test_case_insensitive_self_check(self):
        """Self-check is case-insensitive."""
        data = {
            'fromId': 'being:Santiago',
            'from': 'Santiago',
            'to': '',
            'message': 'test',
        }
        self.assertFalse(should_respond('santiago', data))

    def test_case_insensitive_directed_check(self):
        """Directed check is case-insensitive."""
        data = {
            'fromId': 'agent:m5',
            'from': 'M5',
            'to': 'Santiago',
            'message': 'Hey Santiago',
        }
        self.assertTrue(should_respond('santiago', data))

    def test_missing_fields_safe(self):
        """Missing fields don't crash — treated as empty."""
        data = {'message': 'hello'}
        self.assertFalse(should_respond('santiago', data))

    def test_empty_message_still_filters(self):
        """Empty message from human still passes filter."""
        data = {
            'fromId': 'carclaw:user',
            'from': 'Captain',
            'to': '',
            'message': '',
        }
        self.assertTrue(should_respond('santiago', data))


class TestLogLineFilter(unittest.TestCase):
    """Tests for log line filtering in response output."""

    def test_filters_timestamped_lines(self):
        """Lines starting with YYYY-MM-DD are filtered."""
        import re
        log_re = re.compile(r'^\d{4}-\d{2}-\d{2}')

        lines = [
            '2026-02-21 13:00:00 INFO Starting...',
            'This is the actual response.',
            '2027-01-01 00:00:00 DEBUG Something',
            'More response content.',
        ]

        filtered = [l for l in lines if not log_re.match(l) and l.strip()]
        self.assertEqual(filtered, [
            'This is the actual response.',
            'More response content.',
        ])

    def test_does_not_filter_2026_in_middle(self):
        """Dates in middle of line are not filtered."""
        import re
        log_re = re.compile(r'^\d{4}-\d{2}-\d{2}')

        line = 'The event happened on 2026-02-21.'
        self.assertFalse(log_re.match(line))


if __name__ == '__main__':
    unittest.main()
