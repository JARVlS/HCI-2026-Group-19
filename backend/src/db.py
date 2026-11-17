"""Small async functions over the D1 binding (env.DB). Queries are scoped by user_id where the
table has one; only the admin export reads across users.

D1 call shapes (checked under `pywrangler dev`): `await db.prepare(sql).bind(*args).run()` returns
a dict with `meta.changes`, `.first()` a dict or None, `.all()` a dict with `results`, and
`await db.batch([...])` a list of `run()` results.
"""

import json
from datetime import UTC, datetime
from typing import Any


def iso(dt: datetime) -> str:
    """Storage format for timestamps: UTC, millisecond precision, `Z` suffix (sortable as text)."""
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def to_json(value: Any) -> str:
    """Storage format for the *_json columns of the synced tables: compact, non-ASCII kept.
    NaN and Infinity raise ValueError (a 422 during validation): stored, they would break every
    later read, because responses are strict JSON."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def now() -> datetime:
    return datetime.now(UTC)


# --- users --------------------------------------------------------------------------------

async def get_user(db: Any, user_id: str) -> dict | None:
    return await db.prepare(
        "SELECT id, participant_id, condition, created_at FROM users WHERE id = ?"
    ).bind(user_id).first()


async def create_user(db: Any, user_id: str, participant_id: str | None, condition: str | None) -> dict:
    """Insert a user. With a participant_id that already exists, the stored user wins and is
    returned unchanged (two tabs racing for the same participant get the same user)."""
    await db.prepare(
        "INSERT INTO users (id, participant_id, condition, created_at) VALUES (?, ?, ?, ?)"
        " ON CONFLICT(participant_id) DO NOTHING"
    ).bind(user_id, participant_id, condition, iso(now())).run()
    if participant_id is None:
        row = await get_user(db, user_id)
    else:
        row = await db.prepare(
            "SELECT id, participant_id, condition, created_at FROM users WHERE participant_id = ?"
        ).bind(participant_id).first()
    if row is None:
        raise RuntimeError("user row missing right after insert")
    return row


# --- accounts -----------------------------------------------------------------------------

async def get_account(db: Any, user_id: str) -> dict | None:
    return await db.prepare("SELECT user_id, username FROM accounts WHERE user_id = ?").bind(user_id).first()


async def find_account(db: Any, username: str) -> dict | None:
    """The account with this username, case-insensitive (the column is COLLATE NOCASE)."""
    return await db.prepare(
        "SELECT user_id, username, password_hash FROM accounts WHERE username = ?"
    ).bind(username).first()


async def create_account(db: Any, user_id: str, username: str, password_hash: str) -> bool:
    """Insert an account. False if the user already has one or the username is taken (both are
    UNIQUE, so a race between two sign-ups with one name leaves exactly one row)."""
    result = await db.prepare(
        "INSERT INTO accounts (user_id, username, password_hash, created_at) VALUES (?, ?, ?, ?)"
        " ON CONFLICT DO NOTHING"
    ).bind(user_id, username, password_hash, iso(now())).run()
    return int(result["meta"]["changes"]) == 1


# --- usage --------------------------------------------------------------------------------

async def tokens_used(db: Any, user_id: str, day: str) -> int:
    row = await db.prepare(
        "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used FROM usage"
        " WHERE user_id = ? AND day = ?"
    ).bind(user_id, day).first()
    return int(row["used"])


async def tokens_used_total(db: Any) -> int:
    row = await db.prepare("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used FROM usage").first()
    return int(row["used"])


async def add_usage(db: Any, user_id: str, day: str, task: str, input_tokens: int, output_tokens: int) -> None:
    await db.prepare(
        "INSERT INTO usage (user_id, day, task, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)"
        " ON CONFLICT(user_id, day, task) DO UPDATE SET"
        " input_tokens = input_tokens + excluded.input_tokens,"
        " output_tokens = output_tokens + excluded.output_tokens"
    ).bind(user_id, day, task, input_tokens, output_tokens).run()


# --- events -------------------------------------------------------------------------------

async def insert_events(db: Any, rows: list[tuple]) -> int:
    """rows: (id, user_id, condition, type, payload_json, client_ts, server_ts).
    Idempotent by id; returns how many rows were new. One db.batch() call (ADR-5)."""
    statement = db.prepare(
        "INSERT OR IGNORE INTO events (id, user_id, condition, type, payload_json, client_ts, server_ts)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    results = await db.batch([statement.bind(*row) for row in rows])
    return sum(int(result["meta"]["changes"]) for result in results)


# --- synced entities (the SQL is built in entities.py) --------------------------------------

async def write_batch(db: Any, statements: list[tuple[str, tuple]]) -> None:
    """All writes of one request as ONE db.batch() call (ADR-5): a single transaction, so a
    failing statement rolls back the whole request. statements: (sql, params) pairs."""
    await db.batch([db.prepare(sql).bind(*params) for sql, params in statements])


async def read_batch(db: Any, queries: list[tuple[str, tuple]]) -> list[list[dict]]:
    """Several SELECTs as one db.batch() call: one round trip and one consistent snapshot.
    Returns the rows of each query, in order."""
    results = await db.batch([db.prepare(sql).bind(*params) for sql, params in queries])
    return [list(result["results"]) for result in results]


# --- admin export -------------------------------------------------------------------------

# table -> (columns, ORDER BY). Fixed strings only: the table name never reaches SQL from input.
# Every column of each table (tests/test_admin.py checks this against the migrations).
EXPORTS: dict[str, tuple[tuple[str, ...], str]] = {
    "events": (("id", "user_id", "condition", "type", "payload_json", "client_ts", "server_ts"), "server_ts, id"),
    "usage": (("user_id", "day", "task", "input_tokens", "output_tokens"), "day, user_id, task"),
    "users": (("id", "participant_id", "condition", "created_at"), "created_at, id"),
    "conversations": (("id", "user_id", "subject_id", "title", "study_mode", "continued_from", "carry_summary",
                       "created_at", "updated_at"), "created_at, id"),
    "messages": (("id", "user_id", "conversation_id", "role", "text", "classification_json", "meta_json",
                  "created_at"), "created_at, id"),
    "attempts": (("id", "user_id", "conversation_id", "message_id", "concept_id", "mode", "independence",
                  "correctness", "confidence", "source", "reasons_json", "evidence_json", "superseded_by",
                  "created_at"), "created_at, id"),
    "concepts": (("id", "user_id", "parent_id", "kind", "label", "slug", "aliases_json", "description",
                  "created_by", "created_at", "updated_at", "deleted_at"), "created_at, id"),
    "concept_edges": (("id", "user_id", "from_id", "to_id", "kind", "created_at"), "created_at, id"),
    "trees": (("id", "user_id", "root_concept_id", "title", "grove_id", "split_from", "created_at", "updated_at",
               "deleted_at"), "created_at, id"),
}


async def export_rows(db: Any, table: str) -> tuple[tuple[str, ...], list[dict]]:
    columns, order = EXPORTS[table]
    result = await db.prepare(f"SELECT {', '.join(columns)} FROM {table} ORDER BY {order}").all()
    return columns, list(result["results"])
