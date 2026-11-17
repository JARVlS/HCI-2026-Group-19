"""Model calls through the local Bedrock stand-in (byok_proxy.py), with a disk cache and hard budgets.

Every answer is cached in cache/<api>.jsonl, keyed by the request, so a rerun costs nothing.
Every HTTP attempt (also failed ones) is counted in cache/ledger.jsonl, and a call that would go
over the package's budget raises instead of being sent.
"""
import hashlib
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from .files import CACHE

BASE = os.environ.get("PROXY_URL", "http://127.0.0.1:8790")
JUDGE_MODEL = "zai.glm-4.7"
CLAUDE_MODEL = "anthropic.claude-sonnet-5"
ANTHROPIC_VERSION = "2026-10-21"

# Cumulative budgets over all runs, as counted in cache/ledger.jsonl. Round 1: 3,000 judge calls and
# 250,000 Claude tokens (used 1,602 and 243,087). Round 2: at most 900 calls and 70,000 tokens more.
JUDGE_MAX_CALLS = 1_602 + 900
CLAUDE_MAX_TOKENS = 243_087 + 70_000
TOP_LOGPROBS = 20  # as backend/src/scoring.py
MIN_MASS = 0.5  # as backend/src/scoring.py: below this the judge mostly answered something else

_lock = threading.Lock()


class BudgetExceeded(RuntimeError):
    pass


class JudgeRejected(ValueError):
    """The judge did not answer with one of the options (mass below MIN_MASS)."""


def _key(path: str, body: dict) -> str:
    return hashlib.sha256(json.dumps([path, body], sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class _Store:
    """An append-only JSON Lines file of cached answers, loaded once."""

    def __init__(self, name: str):
        self.path = CACHE / f"{name}.jsonl"
        self.rows: dict[str, dict] = {}
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    row = json.loads(line)
                    self.rows[row["key"]] = row

    def get(self, key: str) -> dict | None:
        return self.rows.get(key)

    def put(self, row: dict) -> None:
        with _lock:
            self.rows[row["key"]] = row
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")


class _Ledger:
    """Counts every HTTP attempt and every Claude token, across runs."""

    def __init__(self):
        self.path = CACHE / "ledger.jsonl"
        self.judge_calls = 0
        self.claude_tokens = 0
        self.claude_calls = 0
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    self._count(json.loads(line))

    def _count(self, row: dict) -> None:
        if row["api"] == "judge":
            self.judge_calls += 1
        else:
            self.claude_calls += 1
            self.claude_tokens += row.get("tokens", 0)

    def reserve(self, api: str, tokens: int = 0) -> None:
        with _lock:
            if api == "judge" and self.judge_calls + 1 > JUDGE_MAX_CALLS:
                raise BudgetExceeded(f"judge budget: {self.judge_calls} of {JUDGE_MAX_CALLS} calls used")
            if api == "claude" and self.claude_tokens + tokens > CLAUDE_MAX_TOKENS:
                raise BudgetExceeded(f"Claude budget: {self.claude_tokens} of {CLAUDE_MAX_TOKENS} tokens used, next call may need {tokens}")

    def add(self, row: dict) -> None:
        with _lock:
            self._count(row)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")


LEDGER = _Ledger()
_judge_cache = _Store("judge")
_claude_cache = _Store("claude")


def _post(path: str, body: dict, headers: dict, timeout: float) -> dict:
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# --- the judge: G-Eval scores from the first token's logprobs -------------------------------------

def judge_body(system: str, user: str) -> dict:
    """The same request as the backend's fast slot (backend/src/scoring.py build_body)."""
    return {
        "model": JUDGE_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": 1,
        "temperature": 0,
        "logprobs": True,
        "top_logprobs": TOP_LOGPROBS,
    }


def option_probabilities(top: list[list], options: list[str]) -> tuple[dict[str, float], float]:
    """Mirror of backend/src/scoring.py option_probabilities: a token counts for an option when it
    equals the option after stripping whitespace; each option's share of the summed mass."""
    found = dict.fromkeys(options, 0.0)
    for token, logprob in top:
        t = token.strip()
        if t in found:
            found[t] += math.exp(logprob)
    total = sum(found.values())
    if total < MIN_MASS:
        likeliest = max(top, key=lambda x: x[1])[0] if top else None
        raise JudgeRejected(f"options hold {total:.0%} of the first token; likeliest {likeliest!r}")
    return {o: p / total for o, p in found.items()}, min(total, 1.0)


def judge_top(body: dict, timeout: float = 20, retries: int = 2) -> list[list]:
    """The first token's top logprobs as [[token, logprob], ...], from the cache or the judge."""
    key = _key("/v1/chat/completions", body)
    hit = _judge_cache.get(key)
    if hit:
        return hit["top"]
    last = None
    for attempt in range(retries + 1):
        LEDGER.reserve("judge")
        t0 = time.time()
        try:
            data = _post("/v1/chat/completions", body, {"authorization": "Bearer dummy"}, timeout)
            top = [[x["token"], x["logprob"]] for x in data["choices"][0]["logprobs"]["content"][0]["top_logprobs"]]
            usage = data.get("usage") or {}
            LEDGER.add({"api": "judge", "ok": True, "s": round(time.time() - t0, 2),
                        "in": usage.get("prompt_tokens", 0), "out": usage.get("completion_tokens", 0)})
            _judge_cache.put({"key": key, "model": body["model"], "top": top})
            return top
        except (urllib.error.URLError, TimeoutError, KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
            LEDGER.add({"api": "judge", "ok": False, "s": round(time.time() - t0, 2), "error": type(e).__name__})
            last = e
            time.sleep(1 + attempt)
    raise RuntimeError(f"judge failed after {retries + 1} attempts: {last!r}")


# --- Claude: structured answers --------------------------------------------------------------------

def claude_body(system: str, user: str, schema: dict, max_tokens: int) -> dict:
    """Anthropic Messages format with JSON outputs (output_config.format), as backend/src/llm.py."""
    return {
        "model": CLAUDE_MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": schema}},
    }


def claude_json(body: dict, timeout: float = 240, retries: int = 1) -> dict:
    """The parsed JSON answer, from the cache or Claude. Fails loudly on a cut or invalid answer."""
    key = _key("/anthropic/v1/messages", body)
    hit = _claude_cache.get(key)
    if hit:
        return json.loads(hit["text"])
    last = None
    for attempt in range(retries + 1):
        LEDGER.reserve("claude", len(json.dumps(body)) // 3 + body["max_tokens"])
        t0 = time.time()
        try:
            data = _post("/anthropic/v1/messages", body, {"x-api-key": "dummy", "anthropic-version": ANTHROPIC_VERSION}, timeout)
        except (urllib.error.URLError, TimeoutError) as e:
            LEDGER.add({"api": "claude", "ok": False, "tokens": 0, "s": round(time.time() - t0, 2), "error": type(e).__name__})
            last = e
            time.sleep(2 + attempt)
            continue
        usage = data.get("usage") or {}
        tokens = sum(usage.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
        LEDGER.add({"api": "claude", "ok": True, "tokens": tokens, "s": round(time.time() - t0, 2)})
        if data.get("stop_reason") == "max_tokens":
            raise RuntimeError("Claude's structured answer hit max_tokens and is incomplete")
        text = next(c["text"] for c in data["content"] if c.get("type") == "text")
        value = json.loads(text)
        _claude_cache.put({"key": key, "model": body["model"], "text": text, "usage": usage})
        return value
    raise RuntimeError(f"Claude failed after {retries + 1} attempts: {last!r}")


def parallel(fn, items: list, workers: int = 4, label: str = "") -> list:
    """fn over items with at most `workers` in flight, in order. Exceptions are returned, not raised,
    so one failed item does not lose the others; the caller decides what a failure means."""
    out: list = [None] * len(items)

    def one(i):
        try:
            out[i] = fn(items[i])
        except BudgetExceeded:
            raise
        except Exception as e:  # noqa: BLE001 - handed back to the caller, which reports it
            out[i] = e

    with ThreadPoolExecutor(workers) as ex:
        for n, _ in enumerate(ex.map(one, range(len(items))), 1):
            if label and (n % 100 == 0 or n == len(items)):
                print(f"{label}: {n}/{len(items)}  (judge calls so far {LEDGER.judge_calls}, Claude tokens {LEDGER.claude_tokens})", file=sys.stderr)
    return out
