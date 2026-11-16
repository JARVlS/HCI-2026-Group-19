import csv
import io

import pytest

ADMIN = {"X-Admin-Token": "test-admin-token"}


def read_csv(response):
    return list(csv.reader(io.StringIO(response.text)))


def test_export_events(client, session):
    events = [{"id": f"e{i}", "type": "nav", "payload": {"to": "forest", "n": i},
               "clientTs": "2026-11-16T10:00:00Z"} for i in range(3)]
    client.post("/api/events", json={"events": events}, headers=session["headers"])
    response = client.get("/api/admin/export?table=events", headers=ADMIN)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert 'filename="arbor-events.csv"' in response.headers["content-disposition"]
    rows = read_csv(response)
    assert rows[0] == ["id", "user_id", "condition", "type", "payload_json", "client_ts", "server_ts"]
    assert [row[0] for row in rows[1:]] == ["e0", "e1", "e2"]
    assert rows[1][1:5] == [session["userId"], "A", "nav", '{"to": "forest", "n": 0}']


def test_export_users_and_usage(client, env, session):
    client.post("/api/session", json={})  # a second user without participant or condition
    env.DB.conn.execute("INSERT INTO usage VALUES (?, '2026-11-16', 'chat', 10, 5)", (session["userId"],))
    users = read_csv(client.get("/api/admin/export?table=users", headers=ADMIN))
    assert users[0] == ["id", "participant_id", "condition", "created_at"]
    assert users[1][:3] == [session["userId"], "P01", "A"]
    assert users[2][1:3] == ["", ""]
    usage = read_csv(client.get("/api/admin/export?table=usage", headers=ADMIN))
    assert usage == [["user_id", "day", "task", "input_tokens", "output_tokens"],
                     [session["userId"], "2026-11-16", "chat", "10", "5"]]


def test_empty_table_has_header_only(client):
    assert read_csv(client.get("/api/admin/export?table=events", headers=ADMIN)) == [
        ["id", "user_id", "condition", "type", "payload_json", "client_ts", "server_ts"]]


@pytest.mark.parametrize("headers", [{}, {"X-Admin-Token": "wrong"}, {"X-Admin-Token": "ünïcode".encode("latin-1")}])
@pytest.mark.parametrize("table", ["events", "messages"])
def test_bad_admin_token_is_403_before_anything_else(client, headers, table):
    response = client.get(f"/api/admin/export?table={table}", headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_unknown_table_with_good_token_is_422(client):
    response = client.get("/api/admin/export?table=messages", headers=ADMIN)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"
