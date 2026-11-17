"""A tiny stand-in for the Anthropic Messages API, for tests and the local smoke test. It also
plays the fast slot's OpenAI-compatible chat completions API (POST /v1/chat/completions).

The builder functions (message_json, stream_events, example_for, completion_json) are used by the
unit tests. Run as a script, it serves both APIs on a local port (stdlib only):

    uv run python tests/fake_anthropic.py --port 8790

Like the real API (version 2026-10-21) it rejects temperature/top_p/top_k and forced tool_choice
with a 400. Markers in the last user message pick special behaviour:
    [refuse]        stop_reason "refusal"
    [max-tokens]    stop_reason "max_tokens"
    [upstream-500]  HTTP 500 api_error (both APIs)
    [stream-error]  streaming: an `error` event after two deltas
    [expensive]     reports 250000 output tokens (to exhaust the daily budget)
    [no-logprobs]   chat completions: an answer without logprobs
    [off-topic]     chat completions: the first token is mostly "Sure", not "1" or "2"
Chat answers echo the last user message word by word; JSON tasks get a minimal object that
matches the json_schema. Streams wait --delay seconds between text deltas. Chat completions
answer one token with the top logprobs in SCORE_TOP (for the options "1" and "2").
"""

import argparse
import json
import math
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

API_VERSION = "2026-10-21"


def example_for(schema: dict[str, Any]) -> Any:
    """A minimal value that satisfies a simple JSON schema (objects, arrays, scalars, enum)."""
    if "enum" in schema:
        return schema["enum"][0]
    kind = schema.get("type")
    if kind == "object":
        props = schema.get("properties", {})
        return {name: example_for(props[name]) for name in schema.get("required", props)}
    if kind == "array":
        return [example_for(schema["items"])] if "items" in schema else []
    return {"string": "example", "number": 0.5, "integer": 1, "boolean": True, "null": None}[kind]


def message_json(text: str, *, stop_reason: str = "end_turn", input_tokens: int = 12,
                 output_tokens: int = 7, cache_read: int = 3, model: str = "fake-model") -> dict[str, Any]:
    """A non-streaming response with a thinking block before the text (which must be ignored)."""
    return {
        "id": "msg_fake",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [
            {"type": "thinking", "thinking": "", "signature": "sig"},
            {"type": "text", "text": text},
        ],
        "stop_reason": stop_reason,
        "usage": {
            "input_tokens": input_tokens,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": cache_read,
            "output_tokens": output_tokens,
        },
    }


def _event(name: str, data: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


def stream_events(parts: list[str], *, stop_reason: str = "end_turn", input_tokens: int = 12,
                  output_tokens: int = 7, error_after: int | None = None,
                  finish: bool = True) -> list[str]:
    """SSE events of a streamed response, one string per event. error_after=n sends an `error`
    event after n text deltas; finish=False leaves out message_delta and message_stop."""
    events = [
        _event("message_start", {"type": "message_start", "message": {
            "id": "msg_fake", "type": "message", "role": "assistant", "content": [],
            "usage": {"input_tokens": input_tokens, "cache_creation_input_tokens": 0,
                      "cache_read_input_tokens": 0, "output_tokens": 1}}}),
        _event("content_block_start", {"type": "content_block_start", "index": 0,
                                       "content_block": {"type": "thinking", "thinking": ""}}),
        _event("content_block_delta", {"type": "content_block_delta", "index": 0,
                                       "delta": {"type": "thinking_delta", "thinking": "hmm"}}),
        _event("content_block_delta", {"type": "content_block_delta", "index": 0,
                                       "delta": {"type": "signature_delta", "signature": "sig"}}),
        _event("content_block_stop", {"type": "content_block_stop", "index": 0}),
        _event("ping", {"type": "ping"}),
        _event("content_block_start", {"type": "content_block_start", "index": 1,
                                       "content_block": {"type": "text", "text": ""}}),
    ]
    for i, part in enumerate(parts):
        if error_after is not None and i == error_after:
            events.append(_event("error", {"type": "error", "error": {
                "type": "overloaded_error", "message": "Overloaded"}}))
            return events
        events.append(_event("content_block_delta", {"type": "content_block_delta", "index": 1,
                                                     "delta": {"type": "text_delta", "text": part}}))
    if finish:
        events += [
            _event("content_block_stop", {"type": "content_block_stop", "index": 1}),
            _event("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason},
                                     "usage": {"output_tokens": output_tokens}}),
            _event("message_stop", {"type": "message_stop"}),
        ]
    return events


# The fake fast model's first token: "1" and " 1" both count for option "1", so with the options
# "1" and "2" the score is {"1": 0.8 / 0.95, "2": 0.15 / 0.95} with mass 0.95.
SCORE_TOP = {"1": 0.6, " 1": 0.2, "2": 0.15, "Sure": 0.05}
OFF_TOPIC_TOP = {"Sure": 0.9, "1": 0.06, "2": 0.04}


def completion_json(top: dict[str, float] | None, *, prompt_tokens: int = 40, completion_tokens: int = 1,
                    model: str = "fake-fast-model") -> dict[str, Any]:
    """An OpenAI-style chat completion of one token. `top` maps tokens to the probabilities of the
    first token's top_logprobs (the likeliest one is the answer); None leaves logprobs out."""
    content = max(top, key=top.get) if top else "1"
    logprobs = None
    if top is not None:
        items = [{"token": token, "logprob": math.log(p), "bytes": list(token.encode())}
                 for token, p in sorted(top.items(), key=lambda kv: -kv[1])]
        logprobs = {"content": [{**items[0], "top_logprobs": items}] if items else []}
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion",
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                     "logprobs": logprobs, "finish_reason": "length"}],
        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
                  "total_tokens": prompt_tokens + completion_tokens},
    }


def openai_error(kind: str, message: str) -> dict[str, Any]:
    return {"error": {"message": message, "type": kind, "param": None, "code": None}}


def _error_body(kind: str, message: str) -> dict[str, Any]:
    return {"type": "error", "error": {"type": kind, "message": message}}


class _Handler(BaseHTTPRequestHandler):
    delay = 0.3

    def log_message(self, fmt: str, *args: Any) -> None:  # keep the smoke output readable
        pass

    def _json(self, status: int, data: dict[str, Any]) -> None:
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _chat_completions(self) -> None:
        if not self.headers.get("authorization", "").startswith("Bearer "):
            return self._json(401, openai_error("invalid_request_error", "Missing bearer token"))
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if body.get("top_logprobs", 0) > 20:  # OpenAI's limit
            return self._json(400, openai_error("invalid_request_error", "top_logprobs must be at most 20"))
        prompt = body["messages"][-1]["content"]
        if "[upstream-500]" in prompt:
            return self._json(500, openai_error("server_error", "Internal server error"))
        top = None if "[no-logprobs]" in prompt else OFF_TOPIC_TOP if "[off-topic]" in prompt else SCORE_TOP
        if not body.get("logprobs"):
            top = None
        self._json(200, completion_json(top, model=body["model"]))

    def do_POST(self) -> None:  # noqa: N802 (stdlib name)
        if self.path == "/v1/chat/completions":
            return self._chat_completions()
        if self.path != "/v1/messages":
            return self._json(404, _error_body("not_found_error", "Not found"))
        if not self.headers.get("x-api-key"):
            return self._json(401, _error_body("authentication_error", "x-api-key header is required"))
        if self.headers.get("anthropic-version") != API_VERSION:
            return self._json(400, _error_body("invalid_request_error", "unexpected anthropic-version"))
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        for name in ("temperature", "top_p", "top_k"):
            if name in body:
                return self._json(400, _error_body("invalid_request_error", f"{name}: not supported"))
        if body.get("tool_choice", {}).get("type") in ("any", "tool"):
            return self._json(400, _error_body("invalid_request_error", "tool_choice any/tool not supported"))

        prompt = body["messages"][-1]["content"]
        if "[upstream-500]" in prompt:
            return self._json(500, _error_body("api_error", "Internal server error"))
        stop_reason = "refusal" if "[refuse]" in prompt else "max_tokens" if "[max-tokens]" in prompt else "end_turn"
        output_tokens = 250000 if "[expensive]" in prompt else 7
        schema = body.get("output_config", {}).get("format", {}).get("schema")
        text = json.dumps(example_for(schema)) if schema else f"Echo: {prompt}"

        if not body.get("stream"):
            return self._json(200, message_json(text, stop_reason=stop_reason, output_tokens=output_tokens,
                                                model=body["model"]))

        parts = [word + " " for word in text.split(" ")]
        events = stream_events(parts, stop_reason=stop_reason, output_tokens=output_tokens,
                               error_after=2 if "[stream-error]" in prompt else None)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        for event in events:
            data = event.encode()
            if '"text_delta"' in event:
                time.sleep(self.delay)
                # Split each delta event in two writes, so the relay must reassemble it.
                self.wfile.write(data[:15])
                self.wfile.flush()
                data = data[15:]
            self.wfile.write(data)
            self.wfile.flush()
        self.close_connection = True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--delay", type=float, default=0.3, help="seconds between streamed text deltas")
    args = parser.parse_args()
    _Handler.delay = args.delay
    server = ThreadingHTTPServer(("127.0.0.1", args.port), _Handler)
    print(f"fake Anthropic API on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
