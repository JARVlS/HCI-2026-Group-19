"""Pure logic in llm.py: request bodies, response parsing, the SSE parser."""

import json

import pytest
from fake_anthropic import message_json, stream_events
from fakes import make_env

import llm
from config import Settings
from errors import ApiError
from schemas import CompleteRequest

SETTINGS = Settings.from_env(make_env(EFFORT_ANALYZE="medium", MAX_TOKENS_JSON="2048"))
SCHEMA = {"type": "object", "properties": {"label": {"type": "string"}}, "required": ["label"],
          "additionalProperties": False}
NEVER_SENT = {"temperature", "top_p", "top_k", "thinking", "tool_choice", "tools", "fallbacks"}


def request(**fields):
    base = {"task": "chat", "system": "Be brief.", "messages": [{"role": "user", "content": "Hi"}]}
    return CompleteRequest.model_validate({**base, **fields})


def test_chat_body():
    body = llm.build_body(request(), SETTINGS)
    assert body == {
        "model": "claude-sonnet-5-5",
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": "Hi"}],
        "output_config": {"effort": "low"},
        "system": "Be brief.",
    }


def test_chat_stream_body_and_empty_system():
    body = llm.build_body(request(stream=True, system=""), SETTINGS)
    assert body["stream"] is True
    assert "system" not in body


@pytest.mark.parametrize("task", ["analyze", "tree", "quiz"])
def test_json_task_body(task):
    body = llm.build_body(request(task=task, schema=SCHEMA), SETTINGS)
    assert body["model"] == "claude-haiku-5-5"
    assert body["max_tokens"] == 2048
    assert body["output_config"] == {"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}}
    assert "stream" not in body
    assert not NEVER_SENT & set(body)


def test_effort_none_is_left_out():
    settings = Settings.from_env(make_env(EFFORT_CHAT="none", EFFORT_ANALYZE="none"))
    assert (settings.effort_chat, settings.effort_analyze) == (None, None)
    assert "output_config" not in llm.build_body(request(), settings)
    body = llm.build_body(request(task="analyze", schema=SCHEMA), settings)
    assert body["output_config"] == {"format": {"type": "json_schema", "schema": SCHEMA}}


def test_effort_none_per_slot():
    settings = Settings.from_env(make_env(EFFORT_CHAT="none", EFFORT_ANALYZE="high"))
    assert "output_config" not in llm.build_body(request(), settings)
    assert llm.build_body(request(task="quiz", schema=SCHEMA), settings)["output_config"]["effort"] == "high"


def test_headers_and_url():
    assert llm.request_headers("k") == {"x-api-key": "k", "anthropic-version": "2026-10-21",
                                         "content-type": "application/json"}
    assert llm.messages_url(SETTINGS) == "https://api.anthropic.test/v1/messages"


def test_usage_counts_cache_tokens_as_input():
    usage = llm.usage_from({"input_tokens": 10, "cache_creation_input_tokens": 5,
                            "cache_read_input_tokens": 2, "output_tokens": 4})
    assert (usage.input_tokens, usage.output_tokens, usage.total) == (17, 4, 21)
    assert llm.usage_from({"input_tokens": 3, "cache_read_input_tokens": None}).total == 3


def test_parse_chat_ignores_thinking_and_flags_truncation():
    assert llm.parse_message("chat", message_json("Hello")) == ("Hello", False)
    assert llm.parse_message("chat", message_json("Hel", stop_reason="max_tokens")) == ("Hel", True)


def test_parse_json_task():
    assert llm.parse_message("analyze", message_json('{"label": "x"}')) == ({"label": "x"}, False)


@pytest.mark.parametrize(("task", "text", "stop_reason", "code"), [
    ("chat", "", "refusal", "upstream_refusal"),
    ("analyze", "", "refusal", "upstream_refusal"),
    ("analyze", '{"label": "x', "max_tokens", "output_truncated"),
    ("analyze", "not json", "end_turn", "invalid_model_output"),
])
def test_parse_errors(task, text, stop_reason, code):
    with pytest.raises(ApiError) as caught:
        llm.parse_message(task, message_json(text, stop_reason=stop_reason))
    assert (caught.value.status, caught.value.code) == (502, code)


def test_upstream_error_message_has_status_and_type_but_no_key():
    body = json.dumps({"type": "error", "error": {"type": "authentication_error",
                                                    "message": "invalid x-api-key sk-secret"}})
    error = llm.upstream_error(401, body, "sk-secret")
    assert (error.status, error.code) == (502, "upstream_error")
    assert "401" in error.message and "authentication_error" in error.message
    assert "sk-secret" not in error.message
    assert "not JSON" in llm.upstream_error(502, "<html>bad gateway</html>", "k").message


def collect(chunks):
    parser, events = llm.SseParser(), []
    for chunk in chunks:
        events += parser.feed(chunk)
    return events


def test_sse_parser_handles_any_chunk_boundary():
    raw = "".join(stream_events(["Grüezi ", "wohl 🌳"])).encode()
    expected = collect([raw])
    assert [name for name, _ in expected][:2] == ["message_start", "content_block_start"]
    for size in (1, 2, 3, 7, 64):  # splits inside lines, events and multi-byte characters
        assert collect([raw[i:i + size] for i in range(0, len(raw), size)]) == expected


def test_sse_parser_crlf_comments_and_multiline_data():
    chunks = [b": keep-alive\r", b"\n\r\nevent: x\r\ndata: {\"a\":\r", b"\ndata: 1}\r\n\r\n"]
    assert collect(chunks) == [("x", {"a": 1})]


def run_stream(events):
    state, texts = llm.StreamState(), []
    for name, data in collect(["".join(events).encode()]):
        text = state.handle(name, data)
        if text:
            texts.append(text)
    return state, texts


def test_stream_state_happy_path():
    state, texts = run_stream(stream_events(["a", "b"], input_tokens=12, output_tokens=30))
    assert texts == ["a", "b"]  # thinking and signature deltas are dropped
    assert state.finished and state.stop_reason == "end_turn"
    assert (state.usage.input_tokens, state.usage.output_tokens) == (12, 30)  # cumulative, not 1 + 30
    assert state.outcome_error() is None


def test_stream_state_errors():
    with pytest.raises(llm.UpstreamStreamError, match="overloaded_error"):
        run_stream(stream_events(["a", "b", "c"], error_after=2))
    state, _ = run_stream(stream_events(["a"], finish=False))
    assert state.outcome_error().code == "upstream_error"
    state, _ = run_stream(stream_events(["a"], stop_reason="refusal"))
    assert state.outcome_error().code == "upstream_refusal"


def test_stream_state_takes_cumulative_input_from_message_delta():
    state = llm.StreamState()
    state.handle("message_start", {"message": {"usage": {"input_tokens": 5, "cache_read_input_tokens": 2}}})
    state.handle("message_delta", {"delta": {"stop_reason": "end_turn"},
                                   "usage": {"input_tokens": 6, "output_tokens": 9}})
    assert (state.usage.input_tokens, state.usage.output_tokens) == (8, 9)
