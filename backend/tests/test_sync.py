"""PUT /sync, GET /state, GET /conversations/:id/messages: round trip, conflict rules, user
scoping, soft delete, the opaque message meta and the limits."""

import json

import pytest

import entities
from schemas import MAX_FIELD_CHARS, MAX_MESSAGE_TEXT, MAX_SYNC_ROWS

T0 = "2026-11-16T10:00:00.000Z"
T1 = "2026-11-16T11:00:00.000Z"
T2 = "2026-11-16T12:00:00.000Z"


def concept(i="c1", **fields):
    return {"id": i, "label": "Recursion", "slug": "recursion", "aliases": ["recursive function"],
            "kind": "concept", "parentId": "s1", "description": "A function calling itself.",
            "createdBy": "llm", "createdAt": T0, "updatedAt": T0, **fields}


def edge(i="e1", **fields):
    return {"id": i, "fromId": "c1", "toId": "c2", "kind": "prerequisite", "createdAt": T0, **fields}


def tree(i="t1", **fields):
    return {"id": i, "rootConceptId": "s1", "title": "Computer science", "groveId": "s1",
            "splitFrom": "t0", "createdAt": T0, "updatedAt": T0, **fields}


def conversation(i="conv1", **fields):
    return {"id": i, "title": "Recursion", "subjectId": "s1", "studyMode": True, "continuedFrom": "conv0",
            "carrySummary": "We talked about loops.", "createdAt": T0, "updatedAt": T0, **fields}


def message(i="m1", **fields):
    return {"id": i, "conversationId": "conv1", "role": "user", "text": "I think it calls itself.",
            "classification": {"mode": "own", "confidence": 0.8, "reasons": ["claim"],
                               "evidence": [{"start": 0, "end": 7, "mode": "own", "reason": "I think"}]},
            "createdAt": T0, "conceptIds": ["c1"], "provider": "arbor", "model": "claude-sonnet-5-5",
            "analysis": "done", "veiled": False, **fields}


def attempt(i="a1", **fields):
    return {"id": i, "conversationId": "conv1", "messageId": "m1", "conceptId": "c1", "mode": "own",
            "independence": 1.0, "correctness": 0.5, "confidence": 0.9, "reasons": ["own claim"],
            "evidence": [{"start": 0, "end": 7, "mode": "own", "reason": "I think"}], "source": "prompt",
            "supersededBy": "a2", "createdAt": T0, **fields}


def full_body():
    return {"concepts": [concept(), concept("s1", kind="subject", parentId=None, label="CS", slug="cs")],
            "edges": [edge()], "trees": [tree()], "conversations": [conversation()],
            "messages": [message(), message("m2", role="assistant", text="Yes.", reflectOn="c1")],
            "attempts": [attempt()]}


def put(client, user, body):
    return client.put("/api/sync", json=body, headers=user["headers"])


def get_state(client, user):
    response = client.get("/api/state", headers=user["headers"])
    assert response.status_code == 200, response.text
    return response.json()


def get_messages(client, user, conversation_id="conv1"):
    return client.get(f"/api/conversations/{conversation_id}/messages", headers=user["headers"])


@pytest.fixture
def other(client):
    data = client.post("/api/session", json={}).json()
    return {**data, "headers": {"Authorization": f"Bearer {data['token']}"}}


def table_rows(env, table):
    return env.DB.rows(f"SELECT * FROM {table} ORDER BY id")


# --- round trip ---------------------------------------------------------------------------

def test_round_trip_of_every_entity(client, session):
    body = full_body()
    response = put(client, session, body)
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert response.json()["serverTime"].endswith("Z")

    state = get_state(client, session)
    assert set(state) == {"concepts", "edges", "trees", "conversations", "attempts"}
    for key in state:
        assert sorted(state[key], key=lambda row: row["id"]) == sorted(body[key], key=lambda row: row["id"]), key
    assert get_messages(client, session).json() == {"messages": body["messages"]}


def test_columns_match_the_migrations(env):
    for table in entities.SYNCED:
        columns = [row["name"] for row in env.DB.rows(f"PRAGMA table_info({table.name})")]
        assert sorted(["id", "user_id", *table.columns]) == sorted(columns), table.name


def test_rows_are_stored_with_the_token_user_and_mapped_columns(client, env, session):
    put(client, session, full_body())
    row = env.DB.rows("SELECT * FROM conversations")[0]
    assert row["user_id"] == session["userId"]
    assert row["study_mode"] == 1
    attempt_row = env.DB.rows("SELECT reasons_json, evidence_json, superseded_by FROM attempts")[0]
    assert json.loads(attempt_row["reasons_json"]) == ["own claim"]
    assert attempt_row["superseded_by"] == "a2"
    message_row = env.DB.rows("SELECT classification_json, meta_json FROM messages WHERE id = 'm1'")[0]
    assert json.loads(message_row["classification_json"])["mode"] == "own"
    assert json.loads(message_row["meta_json"]) == {
        "conceptIds": ["c1"], "provider": "arbor", "model": "claude-sonnet-5-5", "analysis": "done", "veiled": False}


def test_optional_fields_are_left_out_and_nullable_fields_stay_null(client, session):
    bare = {"concepts": [concept(description=None, parentId=None) | {"deletedAt": None}],
            "trees": [{k: v for k, v in tree(groveId=None).items() if k != "splitFrom"}],
            "conversations": [{k: v for k, v in conversation(subjectId=None, studyMode=False).items()
                               if k not in ("continuedFrom", "carrySummary")}],
            "attempts": [{k: v for k, v in attempt(correctness=None).items() if k != "supersededBy"}],
            "messages": [{"id": "m1", "conversationId": "conv1", "role": "user", "text": "", "createdAt": T0}]}
    assert put(client, session, bare).status_code == 200
    state = get_state(client, session)
    c = state["concepts"][0]
    assert c["parentId"] is None and "description" not in c and "deletedAt" not in c
    assert state["trees"][0]["groveId"] is None and "splitFrom" not in state["trees"][0]
    conv = state["conversations"][0]
    assert conv["subjectId"] is None and conv["studyMode"] is False
    assert "continuedFrom" not in conv and "carrySummary" not in conv
    assert state["attempts"][0]["correctness"] is None and "supersededBy" not in state["attempts"][0]
    assert get_messages(client, session).json()["messages"] == [bare["messages"][0]]


def test_timestamps_are_stored_in_utc(client, env, session):
    put(client, session, {"concepts": [concept(createdAt="2026-11-16T11:00:00+01:00", updatedAt="2026-11-16T10:00:00Z")]})
    assert get_state(client, session)["concepts"][0]["createdAt"] == "2026-11-16T10:00:00.000Z"
    response = put(client, session, {"concepts": [concept(updatedAt="2026-11-16T10:00:00")]})
    assert response.status_code == 422


def test_empty_body_is_fine(client, session):
    assert put(client, session, {}).status_code == 200
    assert get_state(client, session) == {"concepts": [], "edges": [], "trees": [], "conversations": [], "attempts": []}


# --- idempotency and conflict rules --------------------------------------------------------

def test_same_body_twice_changes_nothing(client, env, session):
    body = full_body()
    put(client, session, body)
    before = {table.name: table_rows(env, table.name) for table in entities.SYNCED}
    assert put(client, session, body).status_code == 200
    assert {table.name: table_rows(env, table.name) for table in entities.SYNCED} == before


@pytest.mark.parametrize(("key", "make", "field"), [
    ("concepts", concept, "label"), ("trees", tree, "title"), ("conversations", conversation, "title")])
def test_last_write_wins_on_updated_at(client, session, key, make, field):
    def stored():
        row = get_state(client, session)[key][0]
        return row[field], row["updatedAt"]

    put(client, session, {key: [make(**{field: "v1", "updatedAt": T1})]})
    put(client, session, {key: [make(**{field: "older", "updatedAt": T0})]})
    assert stored() == ("v1", T1)  # an older write is ignored
    put(client, session, {key: [make(**{field: "newer", "updatedAt": T2})]})
    assert stored() == ("newer", T2)
    put(client, session, {key: [make(**{field: "same time", "updatedAt": "2026-11-16T13:00:00+01:00"})]})
    assert stored() == ("same time", T2)  # equal updatedAt (in another zone): the incoming row wins


def test_messages_and_attempts_are_always_replaced(client, session):
    put(client, session, {"conversations": [conversation()], "messages": [message(veiled=True)], "attempts": [attempt()]})
    put(client, session, {"messages": [message(veiled=False, guess="it loops", analysis="done")],
                          "attempts": [attempt(supersededBy="a9", createdAt=T0)]})
    stored = get_messages(client, session).json()["messages"][0]
    assert stored["veiled"] is False and stored["guess"] == "it loops"
    assert get_state(client, session)["attempts"][0]["supersededBy"] == "a9"


def test_edges_are_insert_or_ignore(client, env, session):
    put(client, session, {"edges": [edge()]})
    put(client, session, {"edges": [edge(kind="related")]})  # same id, other content: ignored
    put(client, session, {"edges": [edge("e2")]})  # same from/to/kind, other id: ignored
    put(client, session, {"edges": [edge("e3", toId="c3")]})
    assert [(e["id"], e["kind"]) for e in get_state(client, session)["edges"]] == [("e1", "prerequisite"), ("e3", "prerequisite")]


def test_duplicate_ids_in_one_request_the_later_row_wins(client, session):
    put(client, session, {"concepts": [concept(label="first", updatedAt=T1), concept(label="second", updatedAt=T2)],
                          "messages": [message(text="first"), message(text="second")]})
    assert get_state(client, session)["concepts"][0]["label"] == "second"


# --- user scoping -------------------------------------------------------------------------

def test_other_users_rows_are_neither_readable_nor_overwritable(client, env, session, other):
    body = full_body()
    put(client, session, body)
    before = {table.name: table_rows(env, table.name) for table in entities.SYNCED}

    # The other user sends rows with the same ids and a newer updatedAt: all skipped.
    hostile = {key: [{**row, "updatedAt": T2} if "updatedAt" in row else row for row in rows]
               for key, rows in full_body().items()}
    for rows in hostile.values():
        for row in rows:
            for field in ("label", "title", "text"):
                if field in row:
                    row[field] = "overwritten"
    hostile["attempts"] = [attempt(mode="ai", independence=0.0)]
    hostile["edges"] = [edge(kind="related")]
    assert put(client, other, hostile).status_code == 200
    assert {table.name: table_rows(env, table.name) for table in entities.SYNCED} == before

    assert get_state(client, other) == {"concepts": [], "edges": [], "trees": [], "conversations": [], "attempts": []}
    response = get_messages(client, other, "conv1")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert get_state(client, session)["concepts"] != []


def test_state_holds_only_the_own_rows(client, session, other):
    put(client, session, {"concepts": [concept("mine")]})
    put(client, other, {"concepts": [concept("theirs")], "conversations": [conversation("conv2")],
                        "messages": [message("m9", conversationId="conv1")]})
    assert [c["id"] for c in get_state(client, session)["concepts"]] == ["mine"]
    assert [c["id"] for c in get_state(client, other)["concepts"]] == ["theirs"]
    # A message of the other user that points at a conversation id of ours never shows up for us.
    put(client, session, {"conversations": [conversation()]})
    assert get_messages(client, session).json() == {"messages": []}


def test_unknown_conversation_is_404(client, session):
    response = get_messages(client, session, "nope")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "No conversation with this id."}}


@pytest.mark.parametrize(("method", "path"), [("GET", "/api/state"), ("GET", "/api/conversations/conv1/messages"),
                                              ("PUT", "/api/sync")])
def test_401_without_token(client, method, path):
    response = client.request(method, path, json={})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


# --- soft delete, ordering ----------------------------------------------------------------

def test_soft_deleted_concepts_and_trees_disappear_from_state(client, env, session):
    put(client, session, {"concepts": [concept(), concept("c2")], "trees": [tree(), tree("t2")]})
    put(client, session, {"concepts": [concept(updatedAt=T1, deletedAt=T1)], "trees": [tree(updatedAt=T1, deletedAt=T1)]})
    state = get_state(client, session)
    assert [c["id"] for c in state["concepts"]] == ["c2"]
    assert [t["id"] for t in state["trees"]] == ["t2"]
    assert len(env.DB.rows("SELECT id FROM concepts WHERE deleted_at IS NOT NULL")) == 1  # kept for the study data
    put(client, session, {"concepts": [concept(updatedAt=T2)]})  # restored by a newer write without deletedAt
    assert [c["id"] for c in get_state(client, session)["concepts"]] == ["c1", "c2"]


def test_messages_are_ordered_by_created_at_then_id(client, session):
    put(client, session, {"conversations": [conversation()],
                          "messages": [message("m3", createdAt=T1), message("m2", createdAt=T0), message("m1", createdAt=T1)]})
    assert [m["id"] for m in get_messages(client, session).json()["messages"]] == ["m2", "m1", "m3"]


# --- messages: opaque meta ----------------------------------------------------------------

def test_message_meta_round_trip_and_streaming_is_dropped(client, env, session):
    future = {"futureField": {"nested": [1, 2, {"deep": "ü"}]}, "stopped": True, "error": "network"}
    put(client, session, {"conversations": [conversation()], "messages": [message(streaming=True, **future)]})
    stored = get_messages(client, session).json()["messages"][0]
    assert "streaming" not in stored
    assert stored == {**message(), **future}
    assert "streaming" not in json.loads(env.DB.rows("SELECT meta_json FROM messages")[0]["meta_json"])


def test_nan_in_opaque_json_is_422_not_a_poisoned_row(client, session):
    raw = json.dumps({"messages": [message(classification={"confidence": float("nan")})]})
    for body in (raw, json.dumps({"messages": [message(score=float("inf"))]})):
        response = client.put("/api/sync", content=body, headers={**session["headers"], "content-type": "application/json"})
        assert response.status_code == 422, body[:80]
    put(client, session, {"conversations": [conversation()]})
    assert get_messages(client, session).status_code == 200


def test_message_core_is_validated(client, session):
    for bad in (message(role="system"), message(text=None), {**message(), "id": ""},
                {k: v for k, v in message().items() if k != "createdAt"}, message(classification="own")):
        response = put(client, session, {"messages": [bad]})
        assert response.status_code == 422, bad
        assert response.json()["error"]["code"] == "invalid_request"


# --- validation and limits ----------------------------------------------------------------

@pytest.mark.parametrize("body", [
    {"concepts": [concept(color="red")]}, {"edges": [edge(weight=1)]}, {"trees": [tree(leaves=[])]},
    {"conversations": [conversation(userId="someone")]}, {"attempts": [attempt(score=1)]}, {"notes": []},
])
def test_unknown_fields_are_422(client, session, body):
    response = put(client, session, body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"
    assert "Extra inputs are not permitted" in response.json()["error"]["message"]


def test_bad_values_are_422(client, session):
    for body in ({"concepts": [concept(kind="leaf")]}, {"attempts": [attempt(independence=50)]},
                 {"attempts": [attempt(confidence=-0.1)]}, {"edges": [edge(kind="parent")]},
                 {"concepts": [concept(id="x" * 101)]}, {"concepts": "not a list"}):
        response = put(client, session, body)
        assert response.status_code == 422, body


def test_row_limit(client, session):
    rows = [concept(f"c{i}") for i in range(MAX_SYNC_ROWS - 1)]
    assert put(client, session, {"concepts": rows, "edges": [edge()]}).status_code == 200
    assert len(get_state(client, session)["concepts"]) == MAX_SYNC_ROWS - 1
    response = put(client, session, {"concepts": rows, "edges": [edge(), edge("e2", toId="c9")]})
    assert response.status_code == 413
    assert response.json()["error"] == {
        "code": "too_many_rows",
        "message": f"{MAX_SYNC_ROWS + 1} rows in one sync request; at most {MAX_SYNC_ROWS} are allowed. Split it."}


def test_message_text_limit(client, session):
    assert put(client, session, {"messages": [message(text="x" * MAX_MESSAGE_TEXT)]}).status_code == 200
    response = put(client, session, {"messages": [message(text="x" * (MAX_MESSAGE_TEXT + 1))]})
    assert response.status_code == 422
    assert "messages.0.text" in response.json()["error"]["message"]


def _json_of_size(size):
    """A JSON object that serializes (compact) to exactly `size` characters: {"k":"xx..."}."""
    return {"k": "x" * (size - len('{"k":""}'))}


CORE = {k: v for k, v in message().items() if k in ("id", "conversationId", "role", "text", "createdAt")}


def test_json_field_limits(client, session):
    fits, too_big = _json_of_size(MAX_FIELD_CHARS), _json_of_size(MAX_FIELD_CHARS + 1)
    assert put(client, session, {"messages": [message(classification=fits)]}).status_code == 200
    assert put(client, session, {"messages": [{**CORE, **fits}]}).status_code == 200  # meta exactly at the limit
    cases = [
        ({"messages": [message(classification=too_big)]}, "messages.0.classification"),
        ({"messages": [{**CORE, **too_big}]}, "messages.0: Value error, the message's other fields (meta)"),
        ({"concepts": [concept(aliases=["x" * MAX_FIELD_CHARS])]}, "concepts.0.aliases"),
        ({"attempts": [attempt(reasons=["x" * MAX_FIELD_CHARS])]}, "attempts.0.reasons"),
        ({"attempts": [attempt(evidence=[too_big])]}, "attempts.0.evidence"),
        ({"concepts": [concept(description="x" * (MAX_FIELD_CHARS + 1))]}, "concepts.0.description"),
    ]
    for body, where in cases:
        response = put(client, session, body)
        assert response.status_code == 422, where
        assert response.json()["error"]["message"].startswith(where), response.json()
