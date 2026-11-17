from fastapi import APIRouter
from fastapi.responses import JSONResponse

import db
from auth import CurrentUser
from config import Env
from entities import MESSAGES, STATE, SYNCED
from errors import ApiError
from schemas import MAX_SYNC_ROWS, MessagesResponse, StateResponse, SyncRequest, SyncResponse

router = APIRouter(tags=["sync"])

# The entity lists are built straight from the rows and returned as JSONResponse, so FastAPI uses
# the response models only for the docs and does not validate (and reformat) every row again.


@router.get("/state", response_model=StateResponse)
async def state(user: CurrentUser, env: Env) -> JSONResponse:
    """Everything of this user except messages (those load per conversation). Soft-deleted
    concepts and trees are left out. Each list is ordered by createdAt, then id."""
    queries = [(table.select_sql("user_id = ?" + (" AND deleted_at IS NULL" if table.soft_delete else "")),
                (user.id,)) for table in STATE]
    results = await db.read_batch(env.DB, queries)
    return JSONResponse({table.key: [table.to_wire(row) for row in rows] for table, rows in zip(STATE, results)})


_CONVERSATION_SQL = "SELECT id FROM conversations WHERE id = ? AND user_id = ?"
_MESSAGES_SQL = MESSAGES.select_sql("user_id = ? AND conversation_id = ?")


@router.get("/conversations/{conversation_id}/messages", response_model=MessagesResponse)
async def messages(conversation_id: str, user: CurrentUser, env: Env) -> JSONResponse:
    """The messages of one of this user's conversations, ordered by createdAt, then id."""
    found, rows = await db.read_batch(env.DB, [
        (_CONVERSATION_SQL, (conversation_id, user.id)),
        (_MESSAGES_SQL, (user.id, conversation_id)),
    ])
    if not found:  # unknown, or another user's: the same answer, so ids of others stay hidden
        raise ApiError(404, "not_found", "No conversation with this id.")
    return JSONResponse({"messages": [MESSAGES.to_wire(row) for row in rows]})


@router.put("/sync", response_model=SyncResponse)
async def sync(body: SyncRequest, user: CurrentUser, env: Env) -> SyncResponse:
    """Idempotent upsert of the client's entities, all rows in one db.batch() call. Conflict
    rules per entity: see entities.py and docs/api.md."""
    rows = sum(len(getattr(body, table.key)) for table in SYNCED)
    if rows > MAX_SYNC_ROWS:
        raise ApiError(413, "too_many_rows",
                       f"{rows} rows in one sync request; at most {MAX_SYNC_ROWS} are allowed. Split it.")
    statements = [(table.upsert_sql, table.to_row(user.id, item))
                  for table in SYNCED for item in getattr(body, table.key)]
    if statements:
        await db.write_batch(env.DB, statements)
    return SyncResponse(ok=True, server_time=db.iso(db.now()))
