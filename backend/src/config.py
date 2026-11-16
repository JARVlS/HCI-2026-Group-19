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


def secret(env: Any, name: str) -> str:
    """A required secret (ANTHROPIC_API_KEY, SESSION_SECRET, ADMIN_TOKEN). Never log the value."""
    return _text(env, name)


@dataclass(frozen=True)
class Settings:
    model_chat: str
    model_analyze: str
    effort_chat: str
    effort_analyze: str
    max_tokens_chat: int
    max_tokens_json: int
    max_input_chars: int
    daily_token_budget: int
    total_token_budget: int
    anthropic_base_url: str

    @classmethod
    def from_env(cls, env: Any) -> "Settings":
        return cls(
            model_chat=_text(env, "MODEL_CHAT"),
            model_analyze=_text(env, "MODEL_ANALYZE"),
            effort_chat=_text(env, "EFFORT_CHAT"),
            effort_analyze=_text(env, "EFFORT_ANALYZE"),
            max_tokens_chat=_positive_int(env, "MAX_TOKENS_CHAT"),
            max_tokens_json=_positive_int(env, "MAX_TOKENS_JSON"),
            max_input_chars=_positive_int(env, "MAX_INPUT_CHARS"),
            daily_token_budget=_positive_int(env, "DAILY_TOKEN_BUDGET"),
            total_token_budget=_positive_int(env, "TOTAL_TOKEN_BUDGET"),
            anthropic_base_url=_text(env, "ANTHROPIC_BASE_URL").rstrip("/"),
        )


def get_settings(env: Env) -> Settings:
    return Settings.from_env(env)


AppSettings = Annotated[Settings, Depends(get_settings)]
