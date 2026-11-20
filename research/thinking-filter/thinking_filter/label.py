"""Step 3: judge labels. The app's own question (scorePrompt from score.ts, rendered by bridge.ts) goes
to the fast model zai.glm-4.7, and the five options' probabilities from its first token are the
label (G-Eval), exactly as backend/src/scoring.py computes them.

For every synthetic item: once WITHOUT history; for replies also once WITH the tutor's message as
history (`recent`). Habit items and Leon's linter set (data/linter-set.json) without (they are first
messages). For the prefix sample: the first third and two thirds of the words, in the training
condition (design.TRAIN_CONDITION).

  uv run python -m thinking_filter.label            # data/labels.jsonl
"""
import hashlib
import sys

from . import design, frontend, linter_set, models
from .files import HABIT, LABELS, SYNTHETIC, read_jsonl, write_jsonl


def requests() -> list[dict]:
    items = read_jsonl(SYNTHETIC)
    reqs = []
    for it in items:
        reqs.append({"id": it["id"], "cond": "without", "prefix": None, "text": it["text"], "tutor": None})
        if it["tutor"]:
            reqs.append({"id": it["id"], "cond": "with", "prefix": None, "text": it["text"], "tutor": it["tutor"]})
    for it in read_jsonl(HABIT) + linter_set.load():
        reqs.append({"id": it["id"], "cond": "without", "prefix": None, "text": it["text"], "tutor": None})
    for i in design.prefix_sample(items):
        it = items[i]
        cond = design.condition_for(it)
        for name, text in design.prefixes(it["text"]).items():
            reqs.append({"id": it["id"], "cond": cond, "prefix": name, "text": text, "tutor": it["tutor"] if cond == "with" else None})
    return reqs


def bodies(reqs: list[dict]) -> tuple[list[dict], dict]:
    """The judge requests, rendered by the frontend's scorePrompt(), and the scale."""
    prompts = frontend.score_prompts([frontend.thinking_input(r["text"], r["tutor"]) for r in reqs])
    scale = prompts[0]["scale"]
    return [models.judge_body(p["system"], p["user"]) for p in prompts], scale


def label(reqs: list[dict]) -> list[dict]:
    bs, scale = bodies(reqs)
    options = list(scale)
    tops = models.parallel(models.judge_top, bs, workers=4, label="judge")
    rows = []
    for r, b, top in zip(reqs, bs, tops):
        row = {"id": r["id"], "cond": r["cond"], "prefix": r["prefix"], "text": r["text"],
               "prompt": hashlib.sha256(b["messages"][0]["content"].encode()).hexdigest()[:12]}
        if isinstance(top, Exception):
            row["error"] = f"transport: {top}"
        else:
            try:
                probs, mass = models.option_probabilities(top, options)
                row.update(probs=[probs[o] for o in options], mass=mass, percent=sum(probs[o] * w for o, w in scale.items()))
            except models.JudgeRejected as e:
                row["error"] = f"rejected: {e}"
        rows.append(row)
    return rows


def main() -> None:
    rows = label(requests())
    write_jsonl(LABELS, rows)
    errors = [r for r in rows if "error" in r]
    print(f"labels: {len(rows)} rows, {len(errors)} without a label; judge calls so far {models.LEDGER.judge_calls}", file=sys.stderr)
    for r in errors[:10]:
        print(f"  {r['id']} {r['cond']} {r['prefix']}: {r['error']}", file=sys.stderr)
    if any(r["error"].startswith("transport") for r in errors):
        sys.exit("some judge calls failed in transport: run again (answers so far are cached)")


if __name__ == "__main__":
    main()
