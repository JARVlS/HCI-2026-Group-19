"""Anthropic Messages API: request bodies, response parsing, SSE parsing. Pure logic, no I/O.

Why raw HTTP and not the `anthropic` SDK: this code runs in Pyodide on Cloudflare Workers. The
upstream call goes through the Workers `fetch` (upstream.py), and the chat stream is passed through
to the browser chunk by chunk. The SDK is not verified in that runtime; a plain JSON body is.
"""

import json
from dataclasses import dataclass, field
from typing import Any

from config import Settings
from errors import ApiError
from schemas import CompleteRequest, Task, Usage

API_VERSION = "2026-10-21"
INPUT_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")


def messages_url(settings: Settings) -> str:
    return f"{settings.anthropic_base_url}/v1/messages"


def request_headers(api_key: str) -> dict[str, str]:
    return {"x-api-key": api_key, "anthropic-version": API_VERSION, "content-type": "application/json"}


def model_for(task: Task, settings: Settings) -> str:
    return settings.model_chat if task == "chat" else settings.model_analyze


def build_body(req: CompleteRequest, settings: Settings) -> dict[str, Any]:
    """The upstream request. The server fixes model, max_tokens and effort per task.

    Never sent: `temperature`/`top_p`/`top_k` (API version 2026-10-21 rejects them with a 400)
    and `thinking` (both models think adaptively by default; `effort` controls how much).
    Structured output uses JSON outputs (`output_config.format`), not forced tool use, because
    forced `tool_choice` returns a 400 on claude-sonnet-5-5.
    """
    chat = req.task == "chat"
    output_config: dict[str, Any] = {"effort": settings.effort_chat if chat else settings.effort_analyze}
    if not chat:
        output_config["format"] = {"type": "json_schema", "schema": req.output_schema}
    body: dict[str, Any] = {
        "model": model_for(req.task, settings),
        "max_tokens": settings.max_tokens_chat if chat else settings.max_tokens_json,
        "messages": [{"role": m.role, "content": m.content} for m in req.messages],
        "output_config": output_config,
    }
    if req.system:
        body["system"] = req.system
    if req.stream:
        body["stream"] = True
    return body


def usage_from(raw: dict[str, Any]) -> Usage:
    """Billable input = plain + cache write + cache read input tokens."""
    return Usage(
        input_tokens=sum(raw.get(name) or 0 for name in INPUT_FIELDS),
        output_tokens=raw.get("output_tokens") or 0,
    )


def refusal_error() -> ApiError:
    return ApiError(502, "upstream_refusal", "Claude declined to answer this request (stop_reason: refusal).")


def upstream_error(status: int, body_text: str, api_key: str) -> ApiError:
    """Error for a non-200 upstream response: status plus Anthropic's error.type and message."""
    try:
        error = json.loads(body_text).get("error") or {}
        detail = f"{error.get('type', 'unknown')}: {error.get('message', '')}"
    except (ValueError, AttributeError):
        detail = "response was not JSON"
    detail = detail.replace(api_key, "[redacted]")[:300]
    return ApiError(502, "upstream_error", f"The model API returned HTTP {status} ({detail}).")


def parse_message(task: Task, data: dict[str, Any]) -> tuple[Any, bool]:
    """(output, truncated) from a non-streaming response. Thinking blocks are ignored.
    Raises ApiError for a refusal, a truncated JSON answer or JSON that does not parse."""
    stop_reason = data.get("stop_reason")
    if stop_reason == "refusal":
        raise refusal_error()
    text = "".join(block["text"] for block in data["content"] if block.get("type") == "text")
    if task == "chat":
        return text, stop_reason == "max_tokens"
    if stop_reason == "max_tokens":
        raise ApiError(502, "output_truncated", "The structured answer hit max_tokens and is incomplete.")
    try:
        return json.loads(text), False
    except ValueError:
        raise ApiError(502, "invalid_model_output", "The structured answer was not valid JSON.") from None


class SseParser:
    """Splits an SSE byte stream into (event, data) pairs. Network chunks can end anywhere,
    also inside an event or a UTF-8 character, so bytes are buffered until a blank line."""

    def __init__(self) -> None:
        self._buffer = b""

    def feed(self, chunk: bytes) -> list[tuple[str, dict[str, Any]]]:
        # A trailing "\r" stays in the buffer and pairs up with the "\n" of the next chunk.
        self._buffer = (self._buffer + chunk).replace(b"\r\n", b"\n")
        events = []
        while (end := self._buffer.find(b"\n\n")) != -1:
            block, self._buffer = self._buffer[:end], self._buffer[end + 2:]
            event = _parse_block(block.decode("utf-8"))
            if event is not None:
                events.append(event)
        return events


def _parse_block(block: str) -> tuple[str, dict[str, Any]] | None:
    name, data_lines = "", []
    for line in block.split("\n"):
        key, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if key == "event":
            name = value
        elif key == "data":
            data_lines.append(value)
    if not data_lines:
        return None  # comment or keep-alive
    data = json.loads("\n".join(data_lines))
    return name or data.get("type", ""), data


class UpstreamStreamError(Exception):
    """The upstream stream sent an `error` event."""


@dataclass
class StreamState:
    """Follows one upstream stream: text deltas out, usage and stop_reason collected."""

    input_parts: dict[str, int] = field(default_factory=lambda: dict.fromkeys(INPUT_FIELDS, 0))
    output_tokens: int = 0
    stop_reason: str | None = None
    finished: bool = False

    def handle(self, name: str, data: dict[str, Any]) -> str | None:
        """Returns the text of a text delta, else None. Raises UpstreamStreamError on `error`."""
        if name == "message_start":
            self._take_usage(data["message"].get("usage") or {})
        elif name == "content_block_delta":
            delta = data["delta"]
            if delta.get("type") == "text_delta":  # thinking/signature/json deltas are not relayed
                return delta["text"]
        elif name == "message_delta":
            self.stop_reason = data["delta"].get("stop_reason")
            self._take_usage(data.get("usage") or {})
        elif name == "message_stop":
            self.finished = True
        elif name == "error":
            error = data.get("error") or {}
            raise UpstreamStreamError(f"{error.get('type', 'unknown')}: {error.get('message', '')}")
        return None

    def _take_usage(self, raw: dict[str, Any]) -> None:
        # Usage in message_delta is cumulative, so values replace (never add to) earlier ones.
        for name in INPUT_FIELDS:
            if raw.get(name) is not None:
                self.input_parts[name] = raw[name]
        if raw.get("output_tokens") is not None:
            self.output_tokens = raw["output_tokens"]

    @property
    def usage(self) -> Usage:
        return Usage(input_tokens=sum(self.input_parts.values()), output_tokens=self.output_tokens)

    def outcome_error(self) -> ApiError | None:
        """Called after the upstream stream ended without raising."""
        if not self.finished:
            return ApiError(502, "upstream_error", "The model API stream ended before message_stop.")
        if self.stop_reason == "refusal":
            return refusal_error()
        return None
