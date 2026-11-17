"""Step 5: a second opinion. Claude Sonnet 5 rates a stratified sample of 200 items with the same
rubric and the same message as the judge (scorePrompt, training condition), as one integer 1 to 5
through a JSON schema. Claude has no token probabilities, so this is a single rating per item.

  uv run python -m thinking_filter.sonnet            # data/sonnet.jsonl
"""
import sys

from . import design, frontend, models
from .files import SONNET, SYNTHETIC, read_jsonl, write_jsonl

SAMPLE = 200
SCHEMA = {"type": "object", "properties": {"rating": {"type": "integer"}}, "required": ["rating"], "additionalProperties": False}


def sample(items: list[dict]) -> list[int]:
    return design.stratified_sample(items, SAMPLE, seed=5, eligible=lambda i: design.round1(items[i]))


def main() -> None:
    items = read_jsonl(SYNTHETIC)
    picked = [items[i] for i in sample(items)]
    conds = [design.condition_for(it) for it in picked]
    prompts = frontend.score_prompts([frontend.thinking_input(it["text"], it["tutor"] if c == "with" else None) for it, c in zip(picked, conds)])
    bodies = [models.claude_body(p["system"], p["user"], SCHEMA, max_tokens=64) for p in prompts]
    answers = models.parallel(models.claude_json, bodies, workers=4, label="sonnet")
    rows = []
    for it, c, a in zip(picked, conds, answers):
        if isinstance(a, Exception):
            raise SystemExit(f"{it['id']}: {a!r} (answers so far are cached; run again)")
        if a["rating"] not in (1, 2, 3, 4, 5):
            raise SystemExit(f"{it['id']}: rating {a['rating']!r} is not 1 to 5")
        rows.append({"id": it["id"], "cond": c, "rating": a["rating"]})
    write_jsonl(SONNET, rows)
    print(f"sonnet: {len(rows)} ratings; Claude so far {models.LEDGER.claude_calls} calls, {models.LEDGER.claude_tokens} tokens", file=sys.stderr)


if __name__ == "__main__":
    main()
