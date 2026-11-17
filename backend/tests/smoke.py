"""Smoke test against a running Worker (`pywrangler dev`) that talks to tests/fake_anthropic.py.

Normally started by tests/smoke.sh. By hand:
    uv run --group test python tests/smoke.py --base-url http://localhost:8787 --admin-token <ADMIN_TOKEN>

Prints one line per check and exits 1 if any check fails. Every run uses new users and event ids,
so it can run repeatedly against the same local database.
"""

import argparse
import csv
import io
import json
import sys
import time
import uuid
from collections.abc import Callable

import httpx2

ORIGIN = "http://localhost:5173"
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["concepts"],
          "properties": {"concepts": {"type": "array", "items": {
              "type": "object", "additionalProperties": False, "required": ["label", "mode"],
              "properties": {"label": {"type": "string"}, "mode": {"enum": ["own", "together", "ai"]}}}}}}
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  (' + detail + ')' if detail else ''}", flush=True)


def guarded(name: str, step: Callable[[], None]) -> None:
    try:
        step()
    except Exception as exc:  # a crashed step is a failed check, the others still run
        check(name, False, f"{type(exc).__name__}: {exc}")


def chat_body(text: str, **fields: object) -> dict:
    return {"task": "chat", "system": "You are a tutor.", "messages": [{"role": "user", "content": text}], **fields}


def read_stream(client: httpx2.Client, headers: dict, text: str) -> tuple[httpx2.Response, list[tuple[float, str, dict]]]:
    """POST a streaming chat; returns the response and (arrival time, event, data) per SSE event."""
    events, name = [], ""
    with client.stream("POST", "/api/ai/complete", json=chat_body(text, stream=True), headers=headers) as response:
        for line in response.iter_lines():
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                events.append((time.monotonic(), name, json.loads(line[6:])))
    return response, events


def run(base_url: str, admin_token: str) -> None:
    client = httpx2.Client(base_url=base_url, timeout=30)
    run_id = uuid.uuid4().hex[:8]

    def health() -> None:
        r = client.get("/api/health")
        check("GET /api/health", r.status_code == 200 and r.json()["ok"] is True, r.text)
    guarded("GET /api/health", health)

    session: dict = {}

    def create_session() -> None:
        pid = f"smoke-{run_id}"
        r = client.post("/api/session", json={"participantId": pid, "condition": "A"})
        session.update(r.json())
        again = client.post("/api/session", json={"participantId": pid, "condition": "B"}).json()
        check("POST /api/session", r.status_code == 200 and "." in session["token"], f"userId {session['userId']}")
        check("POST /api/session same participant", again["userId"] == session["userId"] and again["condition"] == "A")
    guarded("POST /api/session", create_session)
    auth = {"Authorization": f"Bearer {session.get('token', '')}"}

    def unauthorized() -> None:
        r = client.post("/api/events", json={"events": []})
        check("401 without token", r.status_code == 401 and r.json()["error"]["code"] == "unauthorized")
    guarded("401 without token", unauthorized)

    def chat() -> None:
        r = client.post("/api/ai/complete", json=chat_body("What is recursion?"), headers=auth)
        data = r.json()
        check("chat, not streamed", r.status_code == 200 and data["output"] == "Echo: What is recursion?"
              and data["model"] == "claude-sonnet-5-5" and data["usage"]["outputTokens"] == 7, r.text[:120])
    guarded("chat, not streamed", chat)

    def preflight() -> None:
        r = client.options("/api/ai/complete", headers={
            "Origin": ORIGIN, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization, content-type"})
        check("CORS preflight", r.status_code == 200 and r.headers.get("access-control-allow-origin") == ORIGIN
              and "authorization" in r.headers.get("access-control-allow-headers", "").lower())
    guarded("CORS preflight", preflight)

    def stream() -> None:
        start = time.monotonic()
        r, events = read_stream(client, {**auth, "Origin": ORIGIN}, "Tell me about trees in a forest please")
        deltas = [(t - start, d["text"]) for t, name, d in events if name == "delta"]
        spread = deltas[-1][0] - deltas[0][0]
        text = "".join(t for _, t in deltas)
        check("chat stream: CORS header", r.headers.get("access-control-allow-origin") == ORIGIN)
        check("chat stream: content type", r.headers.get("content-type", "").startswith("text/event-stream"))
        check("chat stream: text", text == "Echo: Tell me about trees in a forest please ", repr(text))
        check("chat stream: deltas arrive spread over time (not buffered)", len(deltas) >= 5 and spread > 1.5,
              f"{len(deltas)} deltas at " + ", ".join(f"{t:.2f}s" for t, _ in deltas))
        check("chat stream: ends with done", events[-1][1] == "done" and events[-1][2]["usage"]["inputTokens"] > 0,
              json.dumps(events[-1][2]))
    guarded("chat stream", stream)

    def stream_error() -> None:
        _, events = read_stream(client, auth, "please fail [stream-error] now")
        names = [name for _, name, _ in events]
        check("chat stream: upstream error mid-stream", names == ["delta", "delta", "error"]
              and events[-1][2]["code"] == "upstream_error", json.dumps(events[-1][2]))
    guarded("chat stream: upstream error mid-stream", stream_error)

    def analyze() -> None:
        r = client.post("/api/ai/complete", headers=auth, json={
            "task": "analyze", "system": "Label concepts.", "schema": SCHEMA,
            "messages": [{"role": "user", "content": "I think recursion is a function calling itself."}]})
        data = r.json()
        check("analyze with schema", r.status_code == 200 and data["model"] == "claude-haiku-5-5"
              and data["output"] == {"concepts": [{"label": "example", "mode": "own"}]}, r.text[:160])
    guarded("analyze with schema", analyze)

    def score() -> None:
        body = {"system": "Did the student think along? Answer 1 (yes) or 2 (no).", "options": ["1", "2"],
                "messages": [{"role": "user", "content": "I think recursion is a function calling itself."}]}
        r = client.post("/api/ai/score", json=body, headers=auth)
        data = r.json()
        # The fake answers "1" 0.6, " 1" 0.2, "2" 0.15, "Sure" 0.05 (SCORE_TOP in fake_anthropic.py).
        check("score: probabilities from the first token's logprobs", r.status_code == 200
              and abs(data["probabilities"]["1"] - 0.8 / 0.95) < 1e-6 and abs(data["mass"] - 0.95) < 1e-6
              and data["model"] == "fast-model-for-smoke" and data["usage"] == {"inputTokens": 40, "outputTokens": 1},
              r.text[:160])
        for marker, code in (("[off-topic]", "invalid_model_output"), ("[no-logprobs]", "invalid_model_output"),
                             ("[upstream-500]", "upstream_error")):
            r = client.post("/api/ai/score", headers=auth,
                            json={**body, "messages": [{"role": "user", "content": f"Hm {marker}"}]})
            check(f"score: {marker} -> 502 {code}", r.status_code == 502 and r.json()["error"]["code"] == code,
                  r.text[:160])
    guarded("score", score)

    def upstream_failures() -> None:
        r = client.post("/api/ai/complete", json=chat_body("[upstream-500]"), headers=auth)
        check("upstream HTTP 500 -> 502 upstream_error", r.status_code == 502
              and r.json()["error"]["code"] == "upstream_error", r.text[:160])
        r = client.post("/api/ai/complete", json=chat_body("[refuse]"), headers=auth)
        check("refusal -> 502 upstream_refusal", r.status_code == 502
              and r.json()["error"]["code"] == "upstream_refusal")
    guarded("upstream failures", upstream_failures)

    def budget() -> None:
        token = client.post("/api/session", json={}).json()["token"]
        other = {"Authorization": f"Bearer {token}"}
        first = client.post("/api/ai/complete", json=chat_body("[expensive]"), headers=other)
        second = client.post("/api/ai/complete", json=chat_body("one more"), headers=other)
        check("budget: expensive call passes", first.status_code == 200, first.text[:120])
        check("budget: next call is 429 budget_exceeded", second.status_code == 429
              and second.json()["error"]["code"] == "budget_exceeded", second.text[:160])
    guarded("budget", budget)

    event_ids = [f"smoke-{run_id}-{i}" for i in range(3)]

    def events() -> None:
        body = {"events": [{"id": event_id, "type": "turn_sent", "payload": {"i": i}, "conversationId": "c1",
                            "clientTs": "2026-11-16T12:00:00.000Z"} for i, event_id in enumerate(event_ids)]}
        first = client.post("/api/events", json=body, headers=auth).json()
        second = client.post("/api/events", json=body, headers=auth).json()
        check("events: first batch stored", first == {"ok": True, "stored": 3}, json.dumps(first))
        check("events: same batch again stores 0", second == {"ok": True, "stored": 0}, json.dumps(second))
    guarded("events", events)

    def export() -> None:
        r = client.get("/api/admin/export", params={"table": "events"}, headers={"X-Admin-Token": admin_token})
        rows = list(csv.DictReader(io.StringIO(r.text)))
        ours = [row for row in rows if row["id"] in event_ids]
        check("admin export events CSV", r.status_code == 200 and len(ours) == 3
              and ours[0]["condition"] == "A" and json.loads(ours[0]["payload_json"])["conversationId"] == "c1",
              f"{len(rows)} rows total")
        usage = client.get("/api/admin/export", params={"table": "usage"}, headers={"X-Admin-Token": admin_token})
        check("admin export usage CSV", usage.status_code == 200
              and usage.text.startswith("user_id,day,task,input_tokens,output_tokens"))
        tasks = {row["task"] for row in csv.DictReader(io.StringIO(usage.text)) if row["user_id"] == session.get("userId")}
        check("admin export usage CSV: score tokens under task score", {"chat", "analyze", "score"} <= tasks,
              ", ".join(sorted(tasks)))
        bad = client.get("/api/admin/export", params={"table": "events"}, headers={"X-Admin-Token": "wrong"})
        check("admin export with wrong token is 403", bad.status_code == 403)
    guarded("admin export", export)

    def not_found() -> None:
        r = client.get("/api/nope")
        check("unknown route -> 404 not_found", r.status_code == 404 and r.json()["error"]["code"] == "not_found")
    guarded("unknown route", not_found)

    def accounts() -> None:
        # Password hashing runs in WebCrypto under the Workers runtime (passwords.py), which only
        # this test exercises; pytest uses hashlib.
        guest = client.post("/api/session", json={}).json()
        guest_auth = {"Authorization": f"Bearer {guest['token']}"}
        creds = {"username": f"smoke-{run_id}", "password": "smoke password"}
        t0 = time.monotonic()
        r = client.post("/api/auth/signup", json=creds, headers=guest_auth)
        signup_s = time.monotonic() - t0
        check("accounts: signup keeps the guest", r.status_code == 200 and r.json()["userId"] == guest["userId"],
              f"{r.status_code} {r.text[:120]} in {signup_s:.2f}s")
        t0 = time.monotonic()
        r = client.post("/api/auth/login", json={**creds, "username": creds["username"].upper()})
        login_s = time.monotonic() - t0
        check("accounts: login (case-insensitive) returns the same token",
              r.status_code == 200 and r.json()["token"] == guest["token"], f"{r.status_code} in {login_s:.2f}s")
        r = client.post("/api/auth/login", json={**creds, "password": "wrong password"})
        check("accounts: wrong password -> 401 invalid_credentials",
              r.status_code == 401 and r.json()["error"]["code"] == "invalid_credentials", r.text[:120])
        r = client.post("/api/auth/signup", json=creds)
        check("accounts: same username again -> 409", r.status_code == 409, r.text[:120])
        me = client.get("/api/me", headers=guest_auth).json()
        check("accounts: /api/me names the account", me.get("username") == creds["username"], json.dumps(me))
    guarded("accounts", accounts)

    run_sync(client, run_id, auth, admin_token)


T0, T1 = "2026-11-17T10:00:00.000Z", "2026-11-17T11:00:00.000Z"


def sync_body(p: str) -> dict:
    """One row of every entity, ids prefixed with p (new per run). All optional fields set, plus
    unknown message fields that must come back as they were sent."""
    conv, msg = f"{p}-conv", f"{p}-m1"
    return {
        "concepts": [
            {"id": f"{p}-s", "label": "CS", "slug": "cs", "aliases": [], "kind": "subject", "parentId": None,
             "createdBy": "seed", "createdAt": T0, "updatedAt": T0},
            {"id": f"{p}-c", "label": "Rekursion", "slug": "rekursion", "aliases": ["recursion", "Rückruf"],
             "kind": "concept", "parentId": f"{p}-s", "description": "Eine Funktion ruft sich selbst auf.",
             "createdBy": "llm", "createdAt": T0, "updatedAt": T0}],
        "edges": [{"id": f"{p}-e", "fromId": f"{p}-s", "toId": f"{p}-c", "kind": "related", "createdAt": T0}],
        "trees": [{"id": f"{p}-t", "rootConceptId": f"{p}-s", "title": "CS", "groveId": f"{p}-s",
                   "splitFrom": f"{p}-t0", "createdAt": T0, "updatedAt": T0}],
        "conversations": [{"id": conv, "title": "Recursion", "subjectId": f"{p}-s", "studyMode": True,
                           "continuedFrom": f"{p}-conv0", "carrySummary": "loops", "createdAt": T0, "updatedAt": T0}],
        "messages": [
            {"id": msg, "conversationId": conv, "role": "user", "text": "I think it calls itself.",
             "classification": {"mode": "own", "confidence": 0.8, "reasons": ["claim"]}, "createdAt": T0,
             "conceptIds": [f"{p}-c"], "analysis": "done"},
            {"id": f"{p}-m2", "conversationId": conv, "role": "assistant", "text": "Yes.", "createdAt": T1,
             "conceptIds": [], "veiled": True, "guess": None, "provider": "arbor", "model": "claude-sonnet-5-5"}],
        "attempts": [{"id": f"{p}-a", "conversationId": conv, "messageId": msg, "conceptId": f"{p}-c", "mode": "own",
                      "independence": 1.0, "correctness": None, "confidence": 0.75, "reasons": ["own claim"],
                      "evidence": [{"start": 0, "end": 7, "mode": "own", "reason": "I think"}], "source": "prompt",
                      "createdAt": T0}],
    }


def by_id(rows: list[dict]) -> list[dict]:
    return sorted(rows, key=lambda row: row["id"])


def run_sync(client: httpx2.Client, run_id: str, auth: dict, admin_token: str) -> None:
    """PUT /sync, GET /state, GET /conversations/:id/messages against real (local) D1."""
    body = sync_body(f"smoke-{run_id}")
    conv = body["conversations"][0]["id"]
    sent_messages = [dict(body["messages"][0]), dict(body["messages"][1])]
    body["messages"][1]["streaming"] = True  # transient UI state: must not be stored

    def state() -> dict:
        r = client.get("/api/state", headers=auth)
        r.raise_for_status()
        return r.json()

    def round_trip() -> None:
        r = client.put("/api/sync", json=body, headers=auth)
        check("sync: PUT /api/sync", r.status_code == 200 and r.json()["ok"] is True
              and r.json()["serverTime"].endswith("Z"), r.text[:160])
        got = state()
        same = {key: by_id(got[key]) == by_id(body[key]) for key in got}
        check("sync: GET /api/state returns what was synced", set(got) == set(body) - {"messages"} and all(same.values()),
              json.dumps(same))
        messages = client.get(f"/api/conversations/{conv}/messages", headers=auth).json()["messages"]
        check("sync: messages come back in order, meta flattened, streaming dropped", messages == sent_messages,
              json.dumps(messages)[:200])
        again = client.put("/api/sync", json=body, headers=auth)
        check("sync: same body again changes nothing", again.status_code == 200 and state() == got)
    guarded("sync: round trip", round_trip)

    def conflicts() -> None:
        concept = body["concepts"][1]
        client.put("/api/sync", json={"concepts": [{**concept, "label": "old", "updatedAt": "2026-11-17T09:00:00Z"}]},
                   headers=auth)
        label = next(c for c in state()["concepts"] if c["id"] == concept["id"])["label"]
        client.put("/api/sync", json={"concepts": [{**concept, "label": "deleted", "updatedAt": T1, "deletedAt": T1}]},
                   headers=auth)
        ids = [c["id"] for c in state()["concepts"]]
        check("sync: older updatedAt ignored, soft delete hides the concept", label == "Rekursion"
              and concept["id"] not in ids and len(ids) == 1, f"{label}, {ids}")

        token = client.post("/api/session", json={}).json()["token"]
        other = {"Authorization": f"Bearer {token}"}
        hostile = {"conversations": [{**body["conversations"][0], "title": "taken", "updatedAt": T1}],
                   "messages": [{**sent_messages[0], "text": "taken"}]}
        r = client.put("/api/sync", json=hostile, headers=other)
        theirs = client.get(f"/api/conversations/{conv}/messages", headers=other)
        mine = client.get(f"/api/conversations/{conv}/messages", headers=auth).json()["messages"]
        check("sync: another user can neither overwrite nor read our rows", r.status_code == 200
              and theirs.status_code == 404 and state()["conversations"][0]["title"] == "Recursion"
              and mine[0]["text"] == sent_messages[0]["text"], theirs.text[:120])
    guarded("sync: conflicts", conflicts)

    def limits() -> None:
        p = f"smoke-{run_id}-bulk"
        rows = [{**body["attempts"][0], "id": f"{p}-{i}", "createdAt": T1} for i in range(500)]
        r = client.put("/api/sync", json={"attempts": rows}, headers=auth)
        stored = sum(a["id"].startswith(p) for a in state()["attempts"])
        check("sync: 500 rows in one request (one D1 batch)", r.status_code == 200 and stored == 500,
              f"{r.status_code}, {stored} stored")
        r = client.put("/api/sync", json={"attempts": rows, "edges": body["edges"]}, headers=auth)
        check("sync: 501 rows -> 413 too_many_rows", r.status_code == 413
              and r.json()["error"]["code"] == "too_many_rows", r.text[:120])
        # Rows at every size limit, written with 4-byte characters (UTF-8): about 0.9 MB per row.
        big = "\U0001d538" * 200_000
        meta = {"note": "\U0001d538" * (20_000 - len('{"note":""}'))}
        classification = {"note": "\U0001d538" * (20_000 - len('{"note":""}'))}
        large = [{"id": f"{p}-big{i}", "conversationId": conv, "role": "assistant", "text": big,
                  "classification": classification, "createdAt": T1, **meta} for i in range(3)]
        r = client.put("/api/sync", json={"messages": large}, headers=auth)
        back = client.get(f"/api/conversations/{conv}/messages", headers=auth).json()["messages"]
        bigs = [m for m in back if m["id"].startswith(f"{p}-big")]
        check("sync: 3 messages at the size limits (200k + 2 x 20k 4-byte chars each)", r.status_code == 200
              and len(bigs) == 3 and all(m["text"] == big and m["note"] == meta["note"] for m in bigs),
              f"{r.status_code} {r.text[:120]}")
    guarded("sync: limits", limits)

    def export() -> None:
        r = client.get("/api/admin/export", params={"table": "messages"}, headers={"X-Admin-Token": admin_token})
        csv.field_size_limit(1_000_000)  # the large messages above are longer than csv's default 131072
        rows = [row for row in csv.DictReader(io.StringIO(r.text)) if row["conversation_id"] == conv]
        check("admin export messages CSV", r.status_code == 200 and len(rows) >= 2
              and json.loads(rows[0]["meta_json"])["conceptIds"] == sent_messages[0]["conceptIds"], f"{len(rows)} rows")
    guarded("admin export messages", export)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://localhost:8787")
    parser.add_argument("--admin-token", required=True)
    args = parser.parse_args()
    run(args.base_url, args.admin_token)
    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
