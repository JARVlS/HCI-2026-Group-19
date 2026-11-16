import json

from fastapi import APIRouter

import db
from auth import CurrentUser
from config import Env
from schemas import EventsRequest, EventsResponse

router = APIRouter(tags=["events"])


@router.post("/events", response_model=EventsResponse)
async def store_events(body: EventsRequest, user: CurrentUser, env: Env) -> EventsResponse:
    """Store 1..200 study events. Idempotent by event id: sending the same batch again stores 0.
    The user's condition is copied from the users table; conversationId goes into payload_json."""
    server_ts = db.iso(db.now())
    rows = []
    for event in body.events:
        payload = dict(event.payload)
        if event.conversation_id is not None:
            payload["conversationId"] = event.conversation_id
        rows.append((
            event.id, user.id, user.condition, event.type,
            json.dumps(payload, ensure_ascii=False), db.iso(event.client_ts), server_ts,
        ))
    stored = await db.insert_events(env.DB, rows)
    return EventsResponse(ok=True, stored=stored)
