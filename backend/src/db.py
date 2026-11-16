"""Small async functions over the D1 binding (env.DB). Queries are scoped by user_id where the
table has one; only the admin export reads across users.

D1 call shapes (checked under `pywrangler dev`): `await db.prepare(sql).bind(*args).run()` returns
a dict with `meta.changes`, `.first()` a dict or None, `.all()` a dict with `results`, and
`await db.batch([...])` a list of `run()` results.
"""

from datetime import UTC, datetime
from typing import Any


def iso(dt: datetime) -> str:
    """Storage format for timestamps: UTC, millisecond precision, `Z` suffix (sortable as text)."""
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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


# --- usage --------------------------------------------------------------------------------

async def tokens_used(db: Any, user_id: str, day: str) -> int:
    row = await db.prepare(
        "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used FROM usage"
        " WHERE user_id = ? AND day = ?"
    ).bind(user_id, day).first()
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


# --- admin export -------------------------------------------------------------------------

# table -> (columns, ORDER BY). Fixed strings only: the table name never reaches SQL from input.
EXPORTS: dict[str, tuple[tuple[str, ...], str]] = {
    "events": (("id", "user_id", "condition", "type", "payload_json", "client_ts", "server_ts"), "server_ts, id"),
    "usage": (("user_id", "day", "task", "input_tokens", "output_tokens"), "day, user_id, task"),
    "users": (("id", "participant_id", "condition", "created_at"), "created_at, id"),
}


async def export_rows(db: Any, table: str) -> tuple[tuple[str, ...], list[dict]]:
    columns, order = EXPORTS[table]
    result = await db.prepare(f"SELECT {', '.join(columns)} FROM {table} ORDER BY {order}").all()
    return columns, list(result["results"])
