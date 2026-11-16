"""POST /api/ai/complete through the app, with the fake D1 and a fake upstream."""

import asyncio
import json

import pytest
from fake_anthropic import stream_events
from fakes import FakeResponse, build_client, make_env

from db import now
from routes.ai import _relay
from schemas import Usage

SCHEMA = {"type": "object", "properties": {"label": {"type": "string"}}, "required": ["label"],
          "additionalProperties": False}


def chat(**fields):
    return {"task": "chat", "system": "Be brief.", "messages": [{"role": "user", "content": "Hi"}], **fields}


def usage_rows(env):
    return env.DB.rows("SELECT task, input_tokens, output_tokens FROM usage ORDER BY task")


def parse_sse(text):
    events = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.split("\n"))
        events.append((lines["event"], json.loads(lines["data"])))
    return events


# --- non-streaming ------------------------------------------------------------------------

def test_chat_relays_and_records_usage(client, env, upstream, session):
    upstream.reply_message("Hello there", input_tokens=12, cache_read=3, output_tokens=7)
    response = client.post("/api/ai/complete", json=chat(), headers=session["headers"])
    assert response.status_code == 200
    assert response.json() == {"output": "Hello there", "usage": {"inputTokens": 15, "outputTokens": 7},
                               "model": "claude-sonnet-5-5", "truncated": False}
    sent = upstream.requests[0]
    assert sent["url"] == "https://api.anthropic.test/v1/messages"
    assert sent["headers"]["x-api-key"] == "test-anthropic-key"
    assert sent["headers"]["anthropic-version"] == "2026-10-21"
    assert sent["body"]["model"] == "claude-sonnet-5-5"
    assert sent["body"]["max_tokens"] == 4096
    assert sent["body"]["output_config"] == {"effort": "low"}
    assert not {"temperature", "top_p", "top_k", "thinking", "tool_choice", "stream"} & set(sent["body"])
    assert usage_rows(env) == [{"task": "chat", "input_tokens": 15, "output_tokens": 7}]


@pytest.mark.parametrize("task", ["analyze", "tree", "quiz"])
def test_json_tasks_return_parsed_object(client, upstream, session, task):
    upstream.reply_message('{"label": "recursion"}')
    response = client.post("/api/ai/complete", json=chat(task=task, schema=SCHEMA), headers=session["headers"])
    assert response.status_code == 200
    assert response.json()["output"] == {"label": "recursion"}
    assert response.json()["model"] == "claude-haiku-5-5"
    body = upstream.requests[0]["body"]
    assert body["model"] == "claude-haiku-5-5"
    assert body["output_config"]["format"] == {"type": "json_schema", "schema": SCHEMA}


def test_usage_adds_up_per_task(client, env, upstream, session):
    for _ in range(2):
        upstream.reply_message("x", input_tokens=10, cache_read=0, output_tokens=5)
        client.post("/api/ai/complete", json=chat(), headers=session["headers"])
    upstream.reply_message('{"label": "y"}', input_tokens=1, cache_read=0, output_tokens=1)
    client.post("/api/ai/complete", json=chat(task="quiz", schema=SCHEMA), headers=session["headers"])
    assert usage_rows(env) == [{"task": "chat", "input_tokens": 20, "output_tokens": 10},
                               {"task": "quiz", "input_tokens": 1, "output_tokens": 1}]


@pytest.mark.parametrize("body", [
    chat(messages=[]),
    chat(messages=[{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}]),
    chat(messages=[{"role": "system", "content": "Hi"}]),
    chat(messages=[{"role": "user", "content": ""}]),
    chat(schema=SCHEMA),
    chat(task="analyze"),
    chat(task="analyze", schema=SCHEMA, stream=True),
    chat(task="translate"),
    chat(model="claude-opus-5-5"),
    chat(maxTokens=99999),
])
def test_validation_errors(client, upstream, session, body):
    response = client.post("/api/ai/complete", json=body, headers=session["headers"])
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"
    assert upstream.requests == []


def test_input_too_large(upstream, session):
    env = make_env(MAX_INPUT_CHARS="20")
    with build_client(env, upstream) as client:
        headers = {"Authorization": f"Bearer {client.post('/api/session', json={}).json()['token']}"}
        response = client.post("/api/ai/complete", json=chat(system="x" * 19, messages=[
            {"role": "user", "content": "ab"}]), headers=headers)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "input_too_large"
    assert upstream.requests == []


def test_budget_exceeded_blocks_before_the_upstream_call(client, env, upstream, session):
    day = now().date().isoformat()
    env.DB.conn.execute("INSERT INTO usage VALUES (?, ?, 'chat', 150000, 50000)", (session["userId"], day))
    response = client.post("/api/ai/complete", json=chat(), headers=session["headers"])
    assert response.status_code == 429
    error = response.json()["error"]
    assert error["code"] == "budget_exceeded"
    assert "200000 of 200000" in error["message"] and "T00:00:00Z" in error["message"]
    assert upstream.requests == []


def test_budget_of_yesterday_and_other_users_does_not_count(client, env, upstream, session):
    env.DB.conn.execute("INSERT INTO usage VALUES (?, '2000-01-01', 'chat', 999999, 0)", (session["userId"],))
    env.DB.conn.execute("INSERT INTO usage VALUES ('someone-else', ?, 'chat', 999999, 0)", (now().date().isoformat(),))
    upstream.reply_message("ok")
    assert client.post("/api/ai/complete", json=chat(), headers=session["headers"]).status_code == 200


def test_total_budget_counts_all_users_and_all_days(upstream):
    env = make_env(TOTAL_TOKEN_BUDGET="1000")
    with build_client(env, upstream) as client:
        headers = {"Authorization": f"Bearer {client.post('/api/session', json={}).json()['token']}"}
        env.DB.conn.execute("INSERT INTO usage VALUES ('someone-else', '2000-01-01', 'chat', 600, 399)")
        upstream.reply_message("ok", input_tokens=1, cache_read=0, output_tokens=0)
        assert client.post("/api/ai/complete", json=chat(), headers=headers).status_code == 200
        response = client.post("/api/ai/complete", json=chat(), headers=headers)
    assert response.status_code == 429
    error = response.json()["error"]
    assert error["code"] == "total_budget_exceeded"
    assert "1000 of 1000" in error["message"]
    assert len(upstream.requests) == 1


def test_refusal_is_502_and_still_recorded(client, env, upstream, session):
    upstream.reply_message("", stop_reason="refusal", input_tokens=4, cache_read=0, output_tokens=0)
    response = client.post("/api/ai/complete", json=chat(), headers=session["headers"])
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_refusal"
    assert usage_rows(env) == [{"task": "chat", "input_tokens": 4, "output_tokens": 0}]


def test_truncated_chat_is_returned_with_flag(client, upstream, session):
    upstream.reply_message("Half an ans", stop_reason="max_tokens")
    response = client.post("/api/ai/complete", json=chat(), headers=session["headers"])
    assert response.status_code == 200
    assert response.json()["truncated"] is True
    assert response.json()["output"] == "Half an ans"


def test_truncated_json_is_502(client, upstream, session):
    upstream.reply_message('{"label": "re', stop_reason="max_tokens")
    response = client.post("/api/ai/complete", json=chat(task="analyze", schema=SCHEMA), headers=session["headers"])
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "output_truncated"


def test_invalid_json_output_is_502(client, upstream, session):
    upstream.reply_message("Sure! Here is your JSON:")
    response = client.post("/api/ai/complete", json=chat(task="tree", schema=SCHEMA), headers=session["headers"])
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "invalid_model_output"


@pytest.mark.parametrize("stream", [False, True])
def test_upstream_error_is_502_and_records_nothing(client, env, upstream, session, stream):
    upstream.reply_json({"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}, status=429)
    response = client.post("/api/ai/complete", json=chat(stream=stream), headers=session["headers"])
    assert response.status_code == 502
    assert response.headers["content-type"] == "application/json"
    error = response.json()["error"]
    assert error["code"] == "upstream_error"
    assert "429" in error["message"] and "rate_limit_error" in error["message"]
    assert "test-anthropic-key" not in response.text
    assert usage_rows(env) == []


def test_missing_api_key_is_server_misconfigured(upstream):
    with build_client(make_env(ANTHROPIC_API_KEY=None), upstream) as client:
        headers = {"Authorization": f"Bearer {client.post('/api/session', json={}).json()['token']}"}
        response = client.post("/api/ai/complete", json=chat(), headers=headers)
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "server_misconfigured"
    assert "ANTHROPIC_API_KEY" in response.json()["error"]["message"]
    assert upstream.requests == []


def test_bad_numeric_var_is_server_misconfigured(upstream, session):
    with build_client(make_env(DAILY_TOKEN_BUDGET="lots"), upstream) as client:
        headers = {"Authorization": f"Bearer {client.post('/api/session', json={}).json()['token']}"}
        response = client.post("/api/ai/complete", json=chat(), headers=headers)
    assert response.status_code == 500
    assert "DAILY_TOKEN_BUDGET" in response.json()["error"]["message"]


# --- streaming ----------------------------------------------------------------------------

def test_stream_happy_path(client, env, upstream, session):
    upstream.reply_stream(stream_events(["Hel", "lo ", "you"], input_tokens=12, output_tokens=30))
    response = client.post("/api/ai/complete", json=chat(stream=True), headers=session["headers"])
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    events = parse_sse(response.text)
    assert events == [
        ("delta", {"text": "Hel"}), ("delta", {"text": "lo "}), ("delta", {"text": "you"}),
        ("done", {"usage": {"inputTokens": 12, "outputTokens": 30}, "model": "claude-sonnet-5-5", "truncated": False}),
    ]
    assert upstream.requests[0]["body"]["stream"] is True
    assert usage_rows(env) == [{"task": "chat", "input_tokens": 12, "output_tokens": 30}]


def test_stream_reassembles_events_split_across_chunks(client, upstream, session):
    raw = "".join(stream_events(["Grüezi ", "🌳"])).encode()
    upstream.reply_chunks([raw[i:i + 5] for i in range(0, len(raw), 5)])
    response = client.post("/api/ai/complete", json=chat(stream=True), headers=session["headers"])
    events = parse_sse(response.text)
    assert [data["text"] for name, data in events if name == "delta"] == ["Grüezi ", "🌳"]
    assert events[-1][0] == "done"


def test_stream_truncated(client, upstream, session):
    upstream.reply_stream(stream_events(["a"], stop_reason="max_tokens"))
    events = parse_sse(client.post("/api/ai/complete", json=chat(stream=True), headers=session["headers"]).text)
    assert events[-1][0] == "done" and events[-1][1]["truncated"] is True


@pytest.mark.parametrize(("kwargs", "fail", "code"), [
    ({"error_after": 2}, False, "upstream_error"),       # upstream `error` event mid-stream
    ({"finish": False}, False, "upstream_error"),        # stream ends without message_stop
    ({"finish": False}, True, "upstream_error"),         # connection drops mid-stream
    ({"stop_reason": "refusal"}, False, "upstream_refusal"),
])
def test_stream_errors_end_with_one_error_event(client, env, upstream, session, kwargs, fail, code):
    upstream.reply_stream(stream_events(["a", "b", "c"], input_tokens=12, **kwargs), fail_after_chunks=fail)
    response = client.post("/api/ai/complete", json=chat(stream=True), headers=session["headers"])
    assert response.status_code == 200  # the stream had already started
    events = parse_sse(response.text)
    assert [name for name, _ in events[:-1]] == ["delta"] * (len(events) - 1)
    assert events[-1][0] == "error" and events[-1][1]["code"] == code
    assert usage_rows(env)[0]["input_tokens"] == 12  # tokens seen so far are still counted


def test_stream_records_usage_when_client_disconnects():
    recorded: list[Usage] = []

    async def record(usage: Usage) -> None:
        recorded.append(usage)

    async def scenario() -> None:
        events = stream_events(["a", "b", "c"], input_tokens=12)
        generator = _relay(FakeResponse(chunks=[e.encode() for e in events]), record, "m")
        assert (await anext(generator)).startswith("event: delta")
        await generator.aclose()  # what happens when the browser goes away

    asyncio.run(scenario())
    assert [(u.input_tokens, u.output_tokens) for u in recorded] == [(12, 1)]


def test_stream_with_cors_origin(client, upstream, session):
    upstream.reply_stream(stream_events(["a"]))
    response = client.post("/api/ai/complete", json=chat(stream=True),
                           headers={**session["headers"], "Origin": "http://localhost:5173"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert parse_sse(response.text)[-1][0] == "done"
