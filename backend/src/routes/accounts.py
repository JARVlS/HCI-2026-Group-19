"""Optional accounts (ADR-8, amended 17 Nov 2026): sign up, log in, who am I.

An account is a username and password on top of an anonymous user. Signing up with a guest's
token turns that guest into the account, so the chats made as a guest stay. Logging in returns
the account's token; the token format is the one from POST /api/session (auth.py), so every other
route works unchanged. There is no logout route: tokens are stateless, the client forgets its own.
"""

import uuid

from fastapi import APIRouter

import db
import passwords
from auth import CurrentUser, OptionalUser, make_token
from config import Env, secret
from errors import ApiError
from schemas import AccountResponse, Credentials, MeResponse

router = APIRouter(tags=["auth"])


def _response(user: dict, username: str, env) -> AccountResponse:
    return AccountResponse(
        user_id=user["id"],
        token=make_token(user["id"], secret(env, "SESSION_SECRET")),
        participant_id=user["participant_id"],
        condition=user["condition"],
        username=username,
    )


@router.post("/auth/signup", response_model=AccountResponse)
async def signup(body: Credentials, env: Env, guest: OptionalUser) -> AccountResponse:
    """Create an account. With a guest's `Authorization: Bearer` token the guest becomes the
    account (same userId, chats kept); without one (or with a token that is no longer valid) a
    new user is made. 409 `username_taken`, 409 `already_registered` (the token's user has an
    account already: log in instead)."""
    secret(env, "SESSION_SECRET")  # fail before any write if the server cannot issue tokens
    if guest is not None and await db.get_account(env.DB, guest.id):
        raise ApiError(409, "already_registered", "This session already belongs to an account. Log in instead.")
    if await db.find_account(env.DB, body.username):
        raise ApiError(409, "username_taken", "That username is taken.")
    password_hash = await passwords.hash_password(body.password)
    user = await db.get_user(env.DB, guest.id) if guest else await db.create_user(env.DB, str(uuid.uuid4()), None, None)
    if not await db.create_account(env.DB, user["id"], body.username, password_hash):
        # Lost a race: the same name or the same guest signed up a moment ago.
        raise ApiError(409, "username_taken", "That username is taken.")
    return _response(user, body.username, env)


@router.post("/auth/login", response_model=AccountResponse)
async def login(body: Credentials, env: Env) -> AccountResponse:
    """Log in with username and password; returns that account's token. 401
    `invalid_credentials` for a wrong username or a wrong password alike."""
    secret(env, "SESSION_SECRET")
    account = await db.find_account(env.DB, body.username)
    if account is None:
        await passwords.burn_time(body.password)
        raise ApiError(401, "invalid_credentials", "Wrong username or password.")
    if not await passwords.verify_password(body.password, account["password_hash"]):
        raise ApiError(401, "invalid_credentials", "Wrong username or password.")
    user = await db.get_user(env.DB, account["user_id"])
    if user is None:  # an account row without its user: only after manual database edits
        raise ApiError(401, "invalid_credentials", "Wrong username or password.")
    return _response(user, account["username"], env)


@router.get("/me", response_model=MeResponse)
async def me(user: CurrentUser, env: Env) -> MeResponse:
    """Who the token belongs to: `username` is null for a guest."""
    account = await db.get_account(env.DB, user.id)
    return MeResponse(
        user_id=user.id,
        username=account["username"] if account else None,
        participant_id=user.participant_id,
        condition=user.condition,
    )
