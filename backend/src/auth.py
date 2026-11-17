"""Anonymous session tokens (ADR-8) and the admin token check.

Token = "<userId>.<hex HMAC-SHA256(userId, SESSION_SECRET)>", sent as `Authorization: Bearer`.
No expiry and no server-side session table: rotating SESSION_SECRET logs everybody out.
"""

import hashlib
import hmac
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer

import db
from config import Env, secret
from errors import ApiError


@dataclass(frozen=True)
class User:
    id: str
    participant_id: str | None
    condition: str | None


def _signature(user_id: str, session_secret: str) -> str:
    return hmac.new(session_secret.encode(), user_id.encode(), hashlib.sha256).hexdigest()


def make_token(user_id: str, session_secret: str) -> str:
    return f"{user_id}.{_signature(user_id, session_secret)}"


def verify_token(token: str, session_secret: str) -> str | None:
    """The user id if the token is genuine, else None."""
    user_id, _, signature = token.rpartition(".")
    expected = _signature(user_id, session_secret)
    if not user_id or not hmac.compare_digest(signature.encode(), expected.encode()):
        return None
    return user_id


# auto_error=False: we raise our own 401 in the common error format. The schemes also make the
# "Authorize" button in /api/docs work.
_bearer = HTTPBearer(auto_error=False, description="Token from POST /api/session")
_admin_header = APIKeyHeader(name="X-Admin-Token", auto_error=False, description="ADMIN_TOKEN secret")


async def current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)], env: Env
) -> User:
    if credentials is None:
        raise ApiError(401, "unauthorized", "Missing Authorization: Bearer <token> header.")
    user_id = verify_token(credentials.credentials, secret(env, "SESSION_SECRET"))
    if user_id is None:
        raise ApiError(401, "unauthorized", "Invalid session token.")
    row = await db.get_user(env.DB, user_id)
    if row is None:  # e.g. the database was reset; the client should create a new session
        raise ApiError(401, "unauthorized", "Unknown user. Create a new session.")
    return User(id=row["id"], participant_id=row["participant_id"], condition=row["condition"])


CurrentUser = Annotated[User, Depends(current_user)]


async def optional_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)], env: Env
) -> User | None:
    """The caller's user if a valid token came along, else None (never a 401)."""
    if credentials is None:
        return None
    try:
        return await current_user(credentials, env)
    except ApiError as e:
        if e.status == 401:
            return None
        raise


OptionalUser = Annotated[User | None, Depends(optional_user)]


def require_admin(token: Annotated[str | None, Depends(_admin_header)], env: Env) -> None:
    expected = secret(env, "ADMIN_TOKEN")
    if token is None or not hmac.compare_digest(token.encode(), expected.encode()):
        raise ApiError(403, "forbidden", "Missing or wrong X-Admin-Token header.")
