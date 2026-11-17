"""Leon's hand-labelled prompt set (frontend/eval/linter-set.ts, PR #16, commit 058f289): 136 prompts
with three labels (own / together / ai, Claude's draft labels, not yet rated by the team) and tags.
The filter never trains on it; it is an outside check next to the word rules and the judge.

  uv run python -m thinking_filter.linter_set        # data/linter-set.json, exported from git

Metrics mirror frontend/eval/metrics.ts (rows: the set's label, columns: predicted; order own,
together, ai; kappa plain and linearly weighted).
"""
import json
import subprocess
import sys

from .files import DATA, ROOT, write_json

COMMIT = "058f289"
SOURCE = "frontend/eval/linter-set.ts"
LINTER_SET = DATA / "linter-set.json"
ORDER = ["own", "together", "ai"]


def export() -> None:
    """Runs the set's own TypeScript (type stripping) on its source at COMMIT, so nothing is retyped."""
    src = subprocess.run(["git", "show", f"{COMMIT}:{SOURCE}"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    out = subprocess.run(["node", "--input-type=module-typescript"], input=src + "\nprocess.stdout.write(JSON.stringify(LINTER_SET));\n",
                         capture_output=True, text=True, check=True).stdout
    cases = [{"id": f"L{i:03d}", "text": c["text"], "label": c["label"], "tags": c.get("tags", [])} for i, c in enumerate(json.loads(out), 1)]
    write_json(LINTER_SET, {"source": f"{SOURCE} at {COMMIT}", "labels": "Claude's draft, not yet rated by the team", "cases": cases})
    print(f"wrote {LINTER_SET}: {len(cases)} cases", file=sys.stderr)


def load() -> list[dict]:
    return json.loads(LINTER_SET.read_text(encoding="utf-8"))["cases"]


def confusion(gold: list[str], pred: list[str]) -> list[list[int]]:
    m = [[0] * 3 for _ in ORDER]
    for g, p in zip(gold, pred):
        m[ORDER.index(g)][ORDER.index(p)] += 1
    return m


def kappa(m: list[list[int]], linear: bool = False) -> float:
    n = sum(map(sum, m))
    k = len(m)
    w = (lambda i, j: 1 - abs(i - j) / (k - 1)) if linear else (lambda i, j: float(i == j))
    rows = [sum(r) / n for r in m]
    cols = [sum(r[j] for r in m) / n for j in range(k)]
    po = sum(w(i, j) * m[i][j] / n for i in range(k) for j in range(k))
    pe = sum(w(i, j) * rows[i] * cols[j] for i in range(k) for j in range(k))
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)


def summary(gold: list[str], pred: list[str], tags: list[list[str]]) -> dict:
    m = confusion(gold, pred)
    n = len(gold)
    per_class = {}
    for i, mode in enumerate(ORDER):
        support, predicted = sum(m[i]), sum(r[i] for r in m)
        per_class[mode] = {"recall": round(m[i][i] / support, 3) if support else None,
                           "precision": round(m[i][i] / predicted, 3) if predicted else None, "support": support}
    by_tag: dict[str, list[bool]] = {}
    for g, p, ts in zip(gold, pred, tags):
        for t in ts or ["(no tag)"]:
            by_tag.setdefault(t, []).append(g == p)
    english = [i for i, ts in enumerate(tags) if "de" not in ts]
    return {
        "n": n, "accuracy": round(sum(m[i][i] for i in range(3)) / n, 3),
        "kappa": round(kappa(m), 3), "weighted_kappa": round(kappa(m, linear=True), 3),
        "confusion_rows_label_cols_pred": m, "per_class": per_class,
        "by_tag": {t: {"n": len(v), "accuracy": round(sum(v) / len(v), 3)} for t, v in sorted(by_tag.items())},
        "english_only": {"n": len(english), "accuracy": round(sum(gold[i] == pred[i] for i in english) / len(english), 3),
                         "kappa": round(kappa(confusion([gold[i] for i in english], [pred[i] for i in english])), 3)},
    }


if __name__ == "__main__":
    export()
