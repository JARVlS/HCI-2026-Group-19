import asyncio

import passwords
from fakes import SECRETS

from auth import verify_token

CREDS = {"username": "leon", "password": "correct horse"}


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --- passwords.py -------------------------------------------------------------------------

def test_hash_round_trip_and_format():
    stored = asyncio.run(passwords.hash_password("secret pass", iterations=1000))
    scheme, iterations, salt, digest = stored.split("$")
    assert (scheme, iterations, len(salt), len(digest)) == ("pbkdf2-sha256", "1000", 32, 64)
    assert asyncio.run(passwords.verify_password("secret pass", stored))
    assert not asyncio.run(passwords.verify_password("secret pasS", stored))


def test_same_password_gets_a_new_salt():
    a = asyncio.run(passwords.hash_password("x" * 8, iterations=1000))
    b = asyncio.run(passwords.hash_password("x" * 8, iterations=1000))
    assert a != b


def test_malformed_hash_never_matches():
    for stored in ("", "plain", "md5$1$00$00", "pbkdf2-sha256$x$00$00", "pbkdf2-sha256$1000$zz$00"):
        assert not asyncio.run(passwords.verify_password("anything", stored)), stored


# --- POST /api/auth/signup ----------------------------------------------------------------

def test_signup_without_token_makes_a_new_user(client, env):
    response = client.post("/api/auth/signup", json=CREDS)
    assert response.status_code == 200
    data = response.json()
    assert set(data) == {"userId", "token", "participantId", "condition", "username"}
    assert data["username"] == "leon"
    assert verify_token(data["token"], SECRETS["SESSION_SECRET"]) == data["userId"]
    row = env.DB.rows("SELECT user_id, username, password_hash FROM accounts")[0]
    assert row["user_id"] == data["userId"] and row["username"] == "leon"
    assert row["password_hash"].startswith("pbkdf2-sha256$100000$")
    assert "correct horse" not in row["password_hash"]


def test_signup_with_guest_token_keeps_the_guest(client, env):
    guest = client.post("/api/session", json={}).json()
    data = client.post("/api/auth/signup", json=CREDS, headers=bearer(guest["token"])).json()
    assert data["userId"] == guest["userId"]
    assert data["token"] == guest["token"]  # same user, same token: nothing to swap on the device
    assert len(env.DB.rows("SELECT id FROM users")) == 1


def test_signup_keeps_study_fields(client):
    guest = client.post("/api/session", json={"participantId": "P09", "condition": "B"}).json()
    data = client.post("/api/auth/signup", json=CREDS, headers=bearer(guest["token"])).json()
    assert (data["participantId"], data["condition"]) == ("P09", "B")


def test_signup_with_stale_token_makes_a_new_user(client, env):
    response = client.post("/api/auth/signup", json=CREDS, headers=bearer("nobody.deadbeef"))
    assert response.status_code == 200
    assert len(env.DB.rows("SELECT id FROM users")) == 1


def test_username_is_unique_ignoring_case(client):
    assert client.post("/api/auth/signup", json=CREDS).status_code == 200
    response = client.post("/api/auth/signup", json={**CREDS, "username": "LEON"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "username_taken"


def test_an_account_cannot_sign_up_again(client):
    first = client.post("/api/auth/signup", json=CREDS).json()
    response = client.post("/api/auth/signup", json={**CREDS, "username": "other"}, headers=bearer(first["token"]))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "already_registered"


def test_signup_rejects_bad_credentials(client, env):
    bad = (
        {"username": "ab", "password": "long enough"},
        {"username": "x" * 65, "password": "long enough"},
        {"username": "has space", "password": "long enough"},
        {"username": "leon", "password": "short"},
        {"username": "leon"},
        {"username": "leon", "password": "long enough", "email": "a@b.c"},
    )
    for body in bad:
        response = client.post("/api/auth/signup", json=body)
        assert response.status_code == 422, body
    assert env.DB.rows("SELECT * FROM accounts") == []


def test_email_works_as_username(client):
    assert client.post("/api/auth/signup", json={"username": "a.b+c@uni.ch", "password": "long enough"}).status_code == 200


# --- POST /api/auth/login -----------------------------------------------------------------

def test_login_returns_the_accounts_token(client):
    signed = client.post("/api/auth/signup", json=CREDS).json()
    response = client.post("/api/auth/login", json={**CREDS, "username": "Leon"})
    assert response.status_code == 200
    data = response.json()
    assert data["userId"] == signed["userId"] and data["token"] == signed["token"]
    assert data["username"] == "leon"  # as stored, not as typed


def test_login_wrong_password_or_user_is_the_same_401(client):
    client.post("/api/auth/signup", json=CREDS)
    for body in ({**CREDS, "password": "wrong horse"}, {**CREDS, "username": "nobody"}):
        response = client.post("/api/auth/login", json=body)
        assert response.status_code == 401
        assert response.json()["error"] == {"code": "invalid_credentials", "message": "Wrong username or password."}


def test_login_token_reaches_the_guests_chats(client):
    guest = client.post("/api/session", json={}).json()
    client.post("/api/auth/signup", json=CREDS, headers=bearer(guest["token"]))
    token = client.post("/api/auth/login", json=CREDS).json()["token"]
    assert client.get("/api/state", headers=bearer(token)).status_code == 200


# --- GET /api/me --------------------------------------------------------------------------

def test_me_for_guest_and_account(client):
    guest = client.post("/api/session", json={}).json()
    me = client.get("/api/me", headers=bearer(guest["token"])).json()
    assert me == {"userId": guest["userId"], "username": None, "participantId": None, "condition": None}
    client.post("/api/auth/signup", json=CREDS, headers=bearer(guest["token"]))
    assert client.get("/api/me", headers=bearer(guest["token"])).json()["username"] == "leon"


def test_me_needs_a_token(client):
    assert client.get("/api/me").status_code == 401


def test_accounts_are_not_exportable(client):
    response = client.get("/api/admin/export?table=accounts", headers={"X-Admin-Token": SECRETS["ADMIN_TOKEN"]})
    assert response.status_code == 422
