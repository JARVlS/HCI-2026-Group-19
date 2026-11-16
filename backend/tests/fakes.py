"""Test doubles for the Workers runtime: a fake env, an sqlite3-backed D1 and a fake upstream.

The app gets the env exactly as in the Worker (request.scope["env"]); only the upstream caller
is swapped through app.dependency_overrides. No test-only branches in production code.
"""

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fake_anthropic import message_json
from fastapi.testclient import TestClient

from app import create_app
from upstream import get_upstream

MIGRATIONS = sorted((Path(__file__).parent.parent / "migrations").glob("*.sql"))

SECRETS = {"ANTHROPIC_API_KEY": "test-anthropic-key", "SESSION_SECRET": "test-session-secret",
           "ADMIN_TOKEN": "test-admin-token"}


class FakeStatement:
    """Same call shapes as a D1 prepared statement: bind() returns a new statement;
    run()/first()/all() are awaitable."""

    def __init__(self, db: "FakeD1", sql: str, params: tuple = ()) -> None:
        self.db, self.sql, self.params = db, sql, params

    def bind(self, *params: Any) -> "FakeStatement":
        return FakeStatement(self.db, self.sql, params)

    def _execute(self) -> dict[str, Any]:
        cursor = self.db.conn.execute(self.sql, self.params)
        rows = [dict(row) for row in cursor.fetchall()]
        return {"success": True, "meta": {"changes": max(cursor.rowcount, 0)}, "results": rows}

    async def run(self) -> dict[str, Any]:
        result = self._execute()
        self.db.conn.commit()
        return result

    async def first(self) -> dict[str, Any] | None:
        rows = self._execute()["results"]
        return rows[0] if rows else None

    async def all(self) -> dict[str, Any]:
        return self._execute()


class FakeD1:
    def __init__(self) -> None:
        # The app runs in another thread under TestClient, hence check_same_thread=False.
        self.conn = sqlite3.connect(":memory:", check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        for migration in MIGRATIONS:
            self.conn.executescript(migration.read_text())

    def prepare(self, sql: str) -> FakeStatement:
        return FakeStatement(self, sql)

    async def batch(self, statements: list[FakeStatement]) -> list[dict[str, Any]]:
        with self.conn:  # one transaction, like D1
            return [statement._execute() for statement in statements]

    def rows(self, sql: str, *params: Any) -> list[dict[str, Any]]:
        """Test helper: read rows directly."""
        return [dict(row) for row in self.conn.execute(sql, params).fetchall()]


def make_env(**overrides: str) -> SimpleNamespace:
    values = {
        "ENVIRONMENT": "test",
        "MODEL_CHAT": "claude-sonnet-5-5",
        "MODEL_ANALYZE": "claude-haiku-5-5",
        "EFFORT_CHAT": "low",
        "EFFORT_ANALYZE": "low",
        "MAX_TOKENS_CHAT": "4096",
        "MAX_TOKENS_JSON": "4096",
        "MAX_INPUT_CHARS": "200000",
        "DAILY_TOKEN_BUDGET": "200000",
        "ANTHROPIC_BASE_URL": "https://api.anthropic.test",
        **SECRETS,
        **overrides,
    }
    return SimpleNamespace(DB=FakeD1(), **{k: v for k, v in values.items() if v is not None})


class FakeResponse:
    def __init__(self, status: int = 200, body: str = "", chunks: list[bytes] | None = None,
                 fail_after_chunks: bool = False) -> None:
        self.status, self._body, self._chunks = status, body, chunks or []
        self._fail = fail_after_chunks

    async def text(self) -> str:
        return self._body

    async def iter_bytes(self):
        for chunk in self._chunks:
            yield chunk
        if self._fail:
            raise ConnectionResetError("connection reset by peer")


class FakeUpstream:
    """Records every request; answers with the queued responses in order."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.responses: list[FakeResponse] = []

    def reply_json(self, data: dict[str, Any], status: int = 200) -> None:
        self.responses.append(FakeResponse(status, json.dumps(data)))

    def reply_message(self, text: str, **kwargs: Any) -> None:
        self.reply_json(message_json(text, **kwargs))

    def reply_stream(self, events: list[str], *, fail_after_chunks: bool = False) -> None:
        self.responses.append(FakeResponse(chunks=[e.encode() for e in events], fail_after_chunks=fail_after_chunks))

    def reply_chunks(self, chunks: list[bytes]) -> None:
        self.responses.append(FakeResponse(chunks=chunks))

    async def post(self, url: str, headers: dict[str, str], body: str) -> FakeResponse:
        self.requests.append({"url": url, "headers": headers, "body": json.loads(body)})
        return self.responses.pop(0)


def build_client(env: SimpleNamespace, upstream: FakeUpstream) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_upstream] = lambda: upstream

    async def asgi_with_env(scope, receive, send):  # what workers.asgi does: env in the scope
        await app(scope if scope["type"] == "lifespan" else {**scope, "env": env}, receive, send)

    return TestClient(asgi_with_env, raise_server_exceptions=False)
