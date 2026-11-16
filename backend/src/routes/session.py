import uuid

from fastapi import APIRouter

import db
from auth import make_token
from config import Env, secret
from schemas import SessionRequest, SessionResponse

router = APIRouter(tags=["session"])


@router.post("/session", response_model=SessionResponse)
async def create_session(env: Env, body: SessionRequest | None = None) -> SessionResponse:
    """Create an anonymous user and return its token (ADR-8). No auth.

    With a `participantId` that already exists, the stored user is returned unchanged (same
    userId, stored condition). Anyone who knows a participantId can get that participant's token;
    acceptable for a course study without personal data."""
    body = body or SessionRequest()
    session_secret = secret(env, "SESSION_SECRET")
    row = await db.create_user(env.DB, str(uuid.uuid4()), body.participant_id, body.condition)
    return SessionResponse(
        user_id=row["id"],
        token=make_token(row["id"], session_secret),
        participant_id=row["participant_id"],
        condition=row["condition"],
    )
