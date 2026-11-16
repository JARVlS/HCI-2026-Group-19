import uuid

from fakes import SECRETS

from auth import verify_token


def test_new_session_returns_user_and_valid_token(client, env):
    response = client.post("/api/session", json={})
    assert response.status_code == 200
    data = response.json()
    assert set(data) == {"userId", "token", "participantId", "condition"}
    assert uuid.UUID(data["userId"])
    assert verify_token(data["token"], SECRETS["SESSION_SECRET"]) == data["userId"]
    assert data["participantId"] is None and data["condition"] is None
    assert env.DB.rows("SELECT id FROM users") == [{"id": data["userId"]}]


def test_session_without_body_works(client):
    assert client.post("/api/session").status_code == 200


def test_two_anonymous_sessions_are_two_users(client):
    first = client.post("/api/session", json={}).json()
    second = client.post("/api/session", json={}).json()
    assert first["userId"] != second["userId"]


def test_same_participant_gets_same_user_and_stored_condition(client, env):
    first = client.post("/api/session", json={"participantId": "P07", "condition": "A"}).json()
    again = client.post("/api/session", json={"participantId": "P07", "condition": "B"}).json()
    assert again["userId"] == first["userId"]
    assert again["token"] == first["token"]
    assert again["condition"] == "A"  # the existing user wins, nothing is updated
    assert env.DB.rows("SELECT participant_id, condition FROM users") == [{"participant_id": "P07", "condition": "A"}]


def test_session_rejects_bad_fields(client):
    for body in ({"participantId": ""}, {"participantId": "x" * 65}, {"userId": "abc"}):
        response = client.post("/api/session", json=body)
        assert response.status_code == 422, body
        assert response.json()["error"]["code"] == "invalid_request"


def test_missing_session_secret_is_a_loud_500(env, upstream):
    from fakes import build_client, make_env

    with build_client(make_env(SESSION_SECRET=None), upstream) as client:
        response = client.post("/api/session", json={})
    assert response.status_code == 500
    assert response.json()["error"] == {
        "code": "server_misconfigured",
        "message": "The server setting SESSION_SECRET is missing or invalid.",
    }
