import json


def event(i, **fields):
    return {"id": f"ev-{i}", "type": "turn_sent", "payload": {"length": i},
            "clientTs": "2026-11-16T10:00:00.123+01:00", **fields}


def test_events_are_stored_once(client, env, session):
    body = {"events": [event(1, conversationId="conv-1"), event(2)]}
    first = client.post("/api/events", json=body, headers=session["headers"])
    assert first.status_code == 200
    assert first.json() == {"ok": True, "stored": 2}
    again = client.post("/api/events", json=body, headers=session["headers"])
    assert again.json() == {"ok": True, "stored": 0}

    rows = env.DB.rows("SELECT * FROM events ORDER BY id")
    assert len(rows) == 2
    row = rows[0]
    assert row["user_id"] == session["userId"]
    assert row["condition"] == "A"  # copied from the user, not sent by the client
    assert row["type"] == "turn_sent"
    assert json.loads(row["payload_json"]) == {"length": 1, "conversationId": "conv-1"}
    assert row["client_ts"] == "2026-11-16T09:00:00.123Z"  # normalized to UTC
    assert row["server_ts"].endswith("Z")
    assert json.loads(rows[1]["payload_json"]) == {"length": 2}


def test_duplicate_ids_in_one_batch_count_once(client, session):
    response = client.post("/api/events", json={"events": [event(1), event(1)]}, headers=session["headers"])
    assert response.json()["stored"] == 1


def test_batch_limits(client, session):
    assert client.post("/api/events", json={"events": [event(i) for i in range(200)]},
                       headers=session["headers"]).json()["stored"] == 200
    for events in ([], [event(i) for i in range(201)]):
        response = client.post("/api/events", json={"events": events}, headers=session["headers"])
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "invalid_request"


def test_event_validation(client, session):
    for bad in (event(1, clientTs="2026-11-16T10:00:00"),  # no time zone
                event(1, clientTs="yesterday"),
                event(1, payload="text"),
                {"type": "x", "payload": {}, "clientTs": "2026-11-16T10:00:00Z"},
                event(1, pid="P01")):
        response = client.post("/api/events", json={"events": [bad]}, headers=session["headers"])
        assert response.status_code == 422, bad
