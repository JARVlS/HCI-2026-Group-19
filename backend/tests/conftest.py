"""Fixtures. The test doubles live in fakes.py."""

from types import SimpleNamespace
from typing import Any

import pytest
from fakes import FakeUpstream, build_client, make_env
from fastapi.testclient import TestClient


@pytest.fixture
def env() -> SimpleNamespace:
    return make_env()


@pytest.fixture
def upstream() -> FakeUpstream:
    return FakeUpstream()


@pytest.fixture
def client(env: SimpleNamespace, upstream: FakeUpstream) -> TestClient:
    with build_client(env, upstream) as test_client:
        yield test_client


@pytest.fixture
def session(client: TestClient) -> dict[str, Any]:
    """A fresh user: the /session response plus ready-made auth headers."""
    data = client.post("/api/session", json={"participantId": "P01", "condition": "A"}).json()
    return {**data, "headers": {"Authorization": f"Bearer {data['token']}"}}
