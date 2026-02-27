"""Shared BDD fixtures for step definitions."""

import pytest


@pytest.fixture
def alert_context():
    """Shared context for fleet alert BDD scenarios."""
    return {"alert_type": None, "payload": {}, "redirected_to": None}


@pytest.fixture
def message_context():
    """Shared context for channel messaging BDD scenarios."""
    return {"message": None}
