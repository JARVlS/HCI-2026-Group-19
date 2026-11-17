"""Configuration from the Worker environment.

Plain values come from [vars] in wrangler.toml (locally overridden by .dev.vars), secrets from
`pywrangler secret put` (locally .dev.vars). Both arrive on request.scope["env"]. There are no
defaults in code: a missing value is a loud 500 `server_misconfigured` that names the variable.
"""

from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import Depends, Request

from errors import ApiError


def get_env(request: Request) -> Any:
    """The Worker env (bindings, vars, secrets). Tests put a fake one into the scope."""
    return request.scope["env"]


Env = Annotated[Any, Depends(get_env)]


def _missing(name: str) -> ApiError:
    return ApiError(500, "server_misconfigured", f"The server setting {name} is missing or invalid.")


def _text(env: Any, name: str) -> str:
    value = getattr(env, name, None)
    if not isinstance(value, str) or not value:
        raise _missing(name)
    return value


def _positive_int(env: Any, name: str) -> int:
    text = _text(env, name)
    if not text.isdigit() or int(text) <= 0:
        raise _missing(name)
    return int(text)


def _effort(env: Any, name: str) -> str | None:
    """`none` means: send no effort at all. Some models (Claude Haiku 4.5) answer HTTP 400
    "This model does not support the effort parameter" to any value."""
    text = _text(env, name)
    return None if text == "none" else text


def secret(env: Any, name: str) -> str:
    """A required secret (ANTHROPIC_API_KEY, SESSION_SECRET, ADMIN_TOKEN, FAST_API_KEY). Never log
    the value. Routes read only the secrets they use, so a Worker without FAST_API_KEY keeps
    serving everything except the score route."""
    return _text(env, name)


@dataclass(frozen=True)
class Settings:
    model_chat: str
    model_analyze: str
    effort_chat: str | None  # None: no effort is sent
    effort_analyze: str | None
    max_tokens_chat: int
    max_tokens_json: int
    max_input_chars: int
    daily_token_budget: int
    total_token_budget: int
    anthropic_base_url: str
    # The fast slot (POST /api/ai/score): an OpenAI-compatible chat completions API with logprobs.
    model_fast: str
    fast_base_url: str

    @classmethod
    def from_env(cls, env: Any) -> "Settings":
        return cls(
            model_chat=_text(env, "MODEL_CHAT"),
            model_analyze=_text(env, "MODEL_ANALYZE"),
            effort_chat=_effort(env, "EFFORT_CHAT"),
            effort_analyze=_effort(env, "EFFORT_ANALYZE"),
            max_tokens_chat=_positive_int(env, "MAX_TOKENS_CHAT"),
            max_tokens_json=_positive_int(env, "MAX_TOKENS_JSON"),
            max_input_chars=_positive_int(env, "MAX_INPUT_CHARS"),
            daily_token_budget=_positive_int(env, "DAILY_TOKEN_BUDGET"),
            total_token_budget=_positive_int(env, "TOTAL_TOKEN_BUDGET"),
            anthropic_base_url=_text(env, "ANTHROPIC_BASE_URL").rstrip("/"),
            model_fast=_text(env, "MODEL_FAST"),
            fast_base_url=_text(env, "FAST_BASE_URL").rstrip("/"),
        )


def get_settings(env: Env) -> Settings:
    return Settings.from_env(env)


AppSettings = Annotated[Settings, Depends(get_settings)]
