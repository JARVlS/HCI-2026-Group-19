"""GET /admin/visits and GET /admin/events (the logs page): grouping, order, filters, paging over
ties, payloads that are not JSON, input errors and the admin token."""

import json

import pytest

ADMIN = {"X-Admin-Token": "test-admin-token"}
T = "2026-11-21T10:00:00.000Z"


def insert(env, i, user, server_ts=T, type="turn_sent", payload=None, client_ts=T, raw=None):
    """One events row as POST /api/events stores it; `raw` stores payload_json as given."""
    env.DB.conn.execute("INSERT INTO events VALUES (?, ?, 'A', ?, ?, ?, ?)",
                        (i, user, type, raw if raw is not None else json.dumps(payload or {}), client_ts, server_ts))


def guest(client):
    return client.post("/api/session", json={}).json()["userId"]


def get_all(client, path, key, **params):
    """Every page of a route; returns the items and the number of pages."""
    items, pages, cursor_name = [], 0, "before" if key == "visits" else "after"
    while True:
        response = client.get(path, params=params, headers=ADMIN)
        assert response.status_code == 200, response.text
        data = response.json()
        items += data[key]
        pages += 1
        if data["next"] is None:
            return items, pages
        params[cursor_name] = data["next"]


def test_visits_group_by_user_and_visit(client, env, session):
    me, other = session["userId"], guest(client)
    signup = client.post("/api/auth/signup", json={"username": "leon", "password": "correct horse"},
                         headers=session["headers"])
    assert signup.status_code == 200
    insert(env, "a1", me, "2026-11-21T10:00:01.000Z", "session_start", {"visit": "v1", "seq": 1, "design": "ascii"},
           client_ts="2026-11-21T09:59:58.000Z")
    insert(env, "a2", me, "2026-11-21T10:00:05.000Z", "turn_sent", {"visit": "v1", "seq": 2, "design": "ascii"},
           client_ts="2026-11-21T10:00:04.000Z")
    insert(env, "a3", me, "2026-11-21T10:00:05.000Z", "turn_sent", {"visit": "v1", "seq": 3, "design": "classic"},
           client_ts="2026-11-21T10:00:04.500Z")
    insert(env, "b1", other, "2026-11-21T10:00:09.000Z", "chat_new", {"visit": "v2", "seq": 1, "design": "ascii"})
    insert(env, "b2", other, "2026-11-21T10:00:03.000Z", "nav", {"to": "forest"})  # before the envelope existed
    insert(env, "b3", other, "2026-11-21T10:00:02.000Z", "nav", {"visit": "", "to": "chat"})

    response = client.get("/api/admin/visits", headers=ADMIN)
    assert response.status_code == 200
    body = response.json()
    assert body["next"] is None
    assert body["visits"] == [
        {"visit": "v2", "userId": other, "participantId": None, "condition": None, "username": None,
         "design": "ascii", "first": T, "last": T, "lastServerTs": "2026-11-21T10:00:09.000Z", "events": 1, "turns": 0},
        {"visit": "v1", "userId": me, "participantId": "P01", "condition": "A", "username": "leon",
         "design": "ascii,classic", "first": "2026-11-21T09:59:58.000Z", "last": "2026-11-21T10:00:04.500Z",
         "lastServerTs": "2026-11-21T10:00:05.000Z", "events": 3, "turns": 2},
        {"visit": None, "userId": other, "participantId": None, "condition": None, "username": None,
         "design": None, "first": T, "last": T, "lastServerTs": "2026-11-21T10:00:03.000Z", "events": 2, "turns": 0},
    ]
    assert "password" not in response.text and "pbkdf2" not in response.text


def test_visits_page_through_ties(client, env, session):
    """Seven visits whose last events share one server time: every visit exactly once, in order."""
    users = [session["userId"], guest(client)]
    for i in range(7):
        insert(env, f"e{i}", users[i % 2], payload={"visit": f"v{i}", "seq": 1})
    insert(env, "late", users[0], "2026-11-21T11:00:00.000Z", payload={"visit": "v9", "seq": 1})
    everything = client.get("/api/admin/visits", params={"limit": 500}, headers=ADMIN).json()["visits"]
    paged, pages = get_all(client, "/api/admin/visits", "visits", limit=3)
    assert pages == 3
    assert paged == everything
    assert [v["visit"] for v in paged][0] == "v9"
    assert sorted(v["visit"] for v in paged) == sorted([f"v{i}" for i in range(7)] + ["v9"])
    # Ties are ordered by user, then visit, both descending.
    tied = [(v["userId"], v["visit"]) for v in paged[1:]]
    assert tied == sorted(tied, reverse=True)


def test_events_filters_and_order(client, env, session):
    me, other = session["userId"], guest(client)
    insert(env, "x2", me, "2026-11-21T10:00:01.000Z", "turn_sent", {"visit": "v1", "seq": 2})
    insert(env, "x1", me, "2026-11-21T10:00:01.000Z", "compose", {"visit": "v1", "seq": 1})
    insert(env, "x3", me, "2026-11-21T10:00:00.000Z", "turn_sent", {"visit": "v2", "seq": 1})
    insert(env, "y1", other, "2026-11-21T10:00:02.000Z", "turn_sent", {"visit": "v1", "seq": 1})
    insert(env, "z1", other, "2026-11-21T09:00:00.000Z", "nav", {"to": "forest"})

    def ids(**params):
        response = client.get("/api/admin/events", params=params, headers=ADMIN)
        assert response.status_code == 200, response.text
        return [e["id"] for e in response.json()["events"]]

    assert ids() == ["z1", "x3", "x1", "x2", "y1"]  # by server_ts, then id
    assert ids(visit="v1") == ["x1", "x2", "y1"]
    assert ids(visit="v1", userId=me) == ["x1", "x2"]
    assert ids(visit="v1", userId=me, type="turn_sent") == ["x2"]
    assert ids(type="turn_sent") == ["x3", "x2", "y1"]
    assert ids(visit="") == ["z1"]  # the events without a visit
    assert ids(userId="nobody") == []

    first = client.get("/api/admin/events", params={"visit": "v2"}, headers=ADMIN).json()
    assert first == {"events": [{"id": "x3", "userId": me, "condition": "A", "type": "turn_sent",
                                 "payload": {"visit": "v2", "seq": 1}, "clientTs": T,
                                 "serverTs": "2026-11-21T10:00:00.000Z"}], "next": None}


def test_events_page_through_ties(client, env, session):
    """One batch: all events share a server time. Pages of 2 give every event exactly once."""
    for i in range(7):
        insert(env, f"e{i}", session["userId"], payload={"visit": "v1", "seq": i})
    paged, pages = get_all(client, "/api/admin/events", "events", visit="v1", limit=2)
    assert pages == 4
    assert [e["id"] for e in paged] == [f"e{i}" for i in range(7)]


def test_events_posted_through_the_api(client, session):
    body = {"events": [{"id": f"ev{i}", "type": "turn_sent", "conversationId": "c1", "clientTs": T,
                        "payload": {"text": "ein Gedanke " + "x" * 8000, "visit": "v1", "seq": i, "design": "ascii"}}
                       for i in (1, 2)]}
    assert client.post("/api/events", json=body, headers=session["headers"]).json()["stored"] == 2
    visit = client.get("/api/admin/visits", headers=ADMIN).json()["visits"][0]
    assert (visit["visit"], visit["userId"], visit["events"], visit["turns"]) == ("v1", session["userId"], 2, 2)
    events = client.get("/api/admin/events", params={"visit": "v1", "userId": session["userId"]},
                        headers=ADMIN).json()["events"]
    assert sorted(e["payload"]["seq"] for e in events) == [1, 2]
    assert events[0]["payload"]["conversationId"] == "c1"
    assert events[0]["payload"]["text"].startswith("ein Gedanke xxx")


def test_payload_that_is_not_a_json_object(client, env, session):
    me = session["userId"]
    insert(env, "bad1", me, raw="{not json")
    insert(env, "bad2", me, raw="[1, 2]")
    insert(env, "bad3", me, raw='{"visit": "v1", "x": NaN}')
    insert(env, "good", me, payload={"visit": "v1", "seq": 1})
    events = client.get("/api/admin/events", params={"userId": me}, headers=ADMIN).json()["events"]
    assert {e["id"]: e["payload"] for e in events} == {
        "bad1": {"_raw": "{not json"}, "bad2": {"_raw": "[1, 2]"},
        "bad3": {"_raw": '{"visit": "v1", "x": NaN}'}, "good": {"visit": "v1", "seq": 1}}
    visits = client.get("/api/admin/visits", headers=ADMIN)
    assert visits.status_code == 200
    # NaN is not JSON to SQLite either, so that row has no visit, like the other two.
    assert sorted((v["visit"] or "-", v["events"]) for v in visits.json()["visits"]) == [("-", 3), ("v1", 1)]


@pytest.mark.parametrize("path", [
    "/api/admin/visits?limit=0", "/api/admin/visits?limit=501", "/api/admin/visits?before=nope",
    "/api/admin/visits?user=P01", "/api/admin/events?limit=0", "/api/admin/events?limit=1001",
    "/api/admin/events?after=%%%", "/api/admin/events?type=", "/api/admin/events?userid=x",
])
def test_bad_query_is_422(client, path):
    response = client.get(path, headers=ADMIN)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "invalid_request"


def test_a_cursor_only_fits_its_own_route(client, env, session):
    for i in range(3):
        insert(env, f"e{i}", session["userId"], payload={"visit": f"v{i}"})
    visits_next = client.get("/api/admin/visits?limit=1", headers=ADMIN).json()["next"]
    events_next = client.get("/api/admin/events?limit=1", headers=ADMIN).json()["next"]
    assert visits_next and events_next
    for path in (f"/api/admin/visits?before={events_next}", f"/api/admin/events?after={visits_next}"):
        response = client.get(path, headers=ADMIN)
        assert response.status_code == 422
        assert "not a cursor" in response.json()["error"]["message"]


@pytest.mark.parametrize("headers", [{}, {"X-Admin-Token": "wrong"}])
@pytest.mark.parametrize("path", ["/api/admin/visits", "/api/admin/visits?limit=0", "/api/admin/events",
                                  "/api/admin/events?after=nope"])
def test_bad_admin_token_is_403_before_anything_else(client, headers, path):
    response = client.get(path, headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"
