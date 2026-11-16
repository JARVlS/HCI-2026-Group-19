import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

import db
import llm
from auth import CurrentUser
from config import AppSettings, Env, secret
from errors import ApiError
from schemas import CompleteRequest, CompleteResponse, Usage
from upstream import Upstream, UpstreamResponse, get_upstream

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ai"])

_SSE_DOC = {"content": {"text/event-stream": {}}, "description": "chat with stream: true (SSE)"}


@router.post("/ai/complete", response_model=CompleteResponse, responses={200: _SSE_DOC})
async def complete(
    body: CompleteRequest,
    user: CurrentUser,
    settings: AppSettings,
    env: Env,
    upstream: Annotated[Upstream, Depends(get_upstream)],
) -> Any:
    """Relay one call to Claude. The server picks model, max_tokens and effort per task and
    enforces the per-user daily token budget and the project's total token budget. See docs/api.md for the SSE format."""
    api_key = secret(env, "ANTHROPIC_API_KEY")
    if body.input_chars() > settings.max_input_chars:
        raise ApiError(
            413, "input_too_large",
            f"system + messages have {body.input_chars()} characters; the limit is {settings.max_input_chars}.",
        )
    start = db.now()
    day = start.date().isoformat()
    used = await db.tokens_used(env.DB, user.id, day)
    if used >= settings.daily_token_budget:
        reset = (start + timedelta(days=1)).date().isoformat()
        raise ApiError(
            429, "budget_exceeded",
            f"Daily token budget used up ({used} of {settings.daily_token_budget} tokens)."
            f" It resets at {reset}T00:00:00Z (midnight UTC).",
        )
    total = await db.tokens_used_total(env.DB)
    if total >= settings.total_token_budget:
        raise ApiError(
            429, "total_budget_exceeded",
            f"The project's total token budget is used up ({total} of {settings.total_token_budget} tokens,"
            " all users together). It does not reset; the team has to raise TOTAL_TOKEN_BUDGET.",
        )

    model = llm.model_for(body.task, settings)
    response = await upstream.post(
        llm.messages_url(settings), llm.request_headers(api_key), json.dumps(llm.build_body(body, settings))
    )
    if response.status != 200:  # nothing was generated, so nothing is recorded
        raise llm.upstream_error(response.status, await response.text(), api_key)

    async def record(usage: Usage) -> None:
        if usage.total > 0:
            await db.add_usage(env.DB, user.id, day, body.task, usage.input_tokens, usage.output_tokens)

    if body.stream:
        return StreamingResponse(
            _relay(response, record, model),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache"},
        )

    data = json.loads(await response.text())
    usage = llm.usage_from(data.get("usage") or {})
    await record(usage)  # also for refusals and truncated answers: those tokens were billed
    output, truncated = llm.parse_message(body.task, data)
    return CompleteResponse(output=output, usage=usage, model=model, truncated=truncated)


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _relay(
    response: UpstreamResponse, record: Callable[[Usage], Awaitable[None]], model: str
) -> AsyncIterator[str]:
    """Upstream SSE -> our SSE: `delta` events, then exactly one `done` or `error` event.
    The usage row is written before the terminal event."""
    state = llm.StreamState()
    recorded = False
    try:
        try:
            parser = llm.SseParser()
            async for chunk in response.iter_bytes():
                for name, data in parser.feed(chunk):
                    text = state.handle(name, data)
                    if text:
                        yield _sse("delta", {"text": text})
            error = state.outcome_error()
        except llm.UpstreamStreamError as exc:
            error = ApiError(502, "upstream_error", f"The model API stream failed ({exc}).")
        except Exception:
            logger.exception("upstream stream broke off")
            error = ApiError(502, "upstream_error", "The connection to the model API broke off.")

        recorded = True
        try:
            await record(state.usage)
        except Exception:
            logger.exception("could not record token usage")
            error = error or ApiError(500, "internal_error", "Could not record token usage.")

        if error is None:
            usage = state.usage.model_dump(by_alias=True)
            yield _sse("done", {"usage": usage, "model": model, "truncated": state.stop_reason == "max_tokens"})
        else:
            yield _sse("error", {"code": error.code, "message": error.message})
    finally:
        if not recorded:  # the client went away mid-stream: best effort, keep what we saw
            try:
                await record(state.usage)
            except Exception:
                logger.exception("could not record token usage after client disconnect")
