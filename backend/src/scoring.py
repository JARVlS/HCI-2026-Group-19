"""The fast slot: G-Eval-style scores from an OpenAI-compatible chat completions API. Pure logic, no I/O.

The caller's prompt asks a question and tells the model to answer with exactly one of a few short
`options` ("1" = the student thought along, "2" = not). The model generates a single token, and
the probabilities of the options among that token's top logprobs are the score. Claude's API
returns no token probabilities, so this slot speaks the OpenAI chat completions format, which does
(OpenAI, Amazon Bedrock, Groq, vLLM, Ollama). llm.py stays the Anthropic format.
"""

import math
from typing import Any

from config import Settings
from errors import ApiError
from schemas import ScoreRequest, Usage

TOP_LOGPROBS = 20  # the most OpenAI allows; an option counts only if it is among them
MIN_MASS = 0.5  # below this the model mostly answered something else, and the score means little


def completions_url(settings: Settings) -> str:
    return f"{settings.fast_base_url}/chat/completions"


def request_headers(api_key: str) -> dict[str, str]:
    return {"authorization": f"Bearer {api_key}", "content-type": "application/json"}


def build_body(req: ScoreRequest, settings: Settings) -> dict[str, Any]:
    """One greedy token and its top logprobs. The system prompt goes first as a `system` message
    (left out when empty, as for Claude)."""
    system = [{"role": "system", "content": req.system}] if req.system else []
    return {
        "model": settings.model_fast,
        "messages": system + [{"role": m.role, "content": m.content} for m in req.messages],
        "max_tokens": 1,
        "temperature": 0,
        "logprobs": True,
        "top_logprobs": TOP_LOGPROBS,
    }


def usage_from(raw: dict[str, Any]) -> Usage:
    """OpenAI usage: prompt_tokens already include cached tokens, completion_tokens any reasoning."""
    return Usage(input_tokens=raw.get("prompt_tokens") or 0, output_tokens=raw.get("completion_tokens") or 0)


def option_probabilities(data: dict[str, Any], options: list[str]) -> tuple[dict[str, float], float]:
    """(probabilities, mass) from the top logprobs of the first generated token.

    A token counts for an option when it equals the option after stripping whitespace, so "1"
    and " 1" both count for "1". `mass` is the summed probability of all options; each option's
    probability is its share of the mass, so they sum to 1 (an option the model did not list
    gets 0). Raises 502 invalid_model_output when there are no logprobs or the mass is below
    MIN_MASS (the model did not answer with one of the options).
    """
    top = _first_token_top_logprobs(data)
    if not top:
        raise ApiError(502, "invalid_model_output",
                       "The fast model's answer has no logprobs, so it cannot be scored"
                       " (MODEL_FAST has to support logprobs).")
    found = dict.fromkeys(options, 0.0)
    for item in top:
        token = item["token"].strip()
        if token in found:
            found[token] += math.exp(item["logprob"])
    total = sum(found.values())
    if total < MIN_MASS:
        likeliest = max(top, key=lambda item: item["logprob"])["token"]
        raise ApiError(502, "invalid_model_output",
                       f"The fast model did not answer with one of the options {options}: they hold"
                       f" {total:.0%} of its first token (at least {MIN_MASS:.0%} needed);"
                       f" its likeliest token was {likeliest!r}.")
    # Rounding in the upstream logprobs can push the sum a hair above 1.
    return {option: p / total for option, p in found.items()}, min(total, 1.0)


def _first_token_top_logprobs(data: dict[str, Any]) -> list[dict[str, Any]] | None:
    try:
        return data["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
    except (KeyError, IndexError, TypeError):  # no logprobs at all, or `"logprobs": null`
        return None
