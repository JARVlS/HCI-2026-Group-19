from fakes import SECRETS

from auth import make_token, verify_token

SECRET = "s3cret"


def test_token_round_trip():
    token = make_token("user-1", SECRET)
    assert token.startswith("user-1.")
    assert verify_token(token, SECRET) == "user-1"


def test_bad_tokens_are_rejected():
    token = make_token("user-1", SECRET)
    assert verify_token(token, "other-secret") is None
    assert verify_token(token[:-1] + ("0" if token[-1] != "0" else "1"), SECRET) is None
    assert verify_token("user-2." + token.split(".")[1], SECRET) is None
    assert verify_token("no-dot-at-all", SECRET) is None
    assert verify_token(".abc", SECRET) is None
    assert verify_token("user-1.ünïcode", SECRET) is None  # no TypeError from compare_digest


def test_endpoint_without_token_is_401(client):
    response = client.post("/api/events", json={"events": []})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_endpoint_with_bad_token_is_401(client, session):
    for header in ("Bearer nonsense", f"Bearer {session['token']}x", f"Basic {session['token']}"):
        response = client.post("/api/events", json={"events": []}, headers={"Authorization": header})
        assert response.status_code == 401, header
        assert response.json()["error"]["code"] == "unauthorized"


def test_valid_token_for_unknown_user_is_401(client):
    token = make_token("deleted-user", SECRETS["SESSION_SECRET"])
    response = client.post("/api/events", json={"events": []}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert "new session" in response.json()["error"]["message"]


def test_good_token_passes_auth(client, session):
    # Auth passes, so the empty batch reaches validation (422), not 401.
    response = client.post("/api/events", json={"events": []}, headers=session["headers"])
    assert response.status_code == 422
