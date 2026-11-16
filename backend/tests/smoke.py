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
        bad = client.get("/api/admin/export", params={"table": "events"}, headers={"X-Admin-Token": "wrong"})
        check("admin export with wrong token is 403", bad.status_code == 403)
    guarded("admin export", export)

    def not_found() -> None:
        r = client.get("/api/nope")
        check("unknown route -> 404 not_found", r.status_code == 404 and r.json()["error"]["code"] == "not_found")
    guarded("unknown route", not_found)


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
