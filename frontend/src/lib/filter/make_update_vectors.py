"""Test vectors for the browser's learning step (`update` in src/lib/thinkingFilter.ts), made with the
research's reference implementation (research/thinking-filter/thinking_filter/nb.py), read-only:

  python3 -B src/lib/filter/make_update_vectors.py > src/lib/filter/update.vectors.json   # from frontend/

Starts from weights.json, learns from three judged drafts of vectors.json (weight 1, as the app does;
one has features the weights do not know, one repeats a word), then records the belief, estimate and
certainty of every case of vectors.json after the first update and after all three.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[3] / "research" / "thinking-filter"))
from thinking_filter import nb  # noqa: E402

LEARN = [  # (index into vectors.json cases, the judge's distribution over levels 1..5)
    (39, [0.6, 0.2, 0.1, 0.07, 0.03]),  # "zxqv blorf gnarp": unknown words become new features
    (37, [0.05, 0.1, 0.15, 0.4, 0.3]),  # "no no no no": a repeated feature counts every time
    (5, [0.01, 0.02, 0.07, 0.5, 0.4]),  # "I think that's igneous rock, right?"
]


def probe(m: nb.Model, cases: list[dict]) -> list[dict]:
    out = []
    for c in cases:
        b = nb.belief(c["features"], m)
        out.append({"belief": b, "estimate": nb.estimate(b), "certainty": nb.certainty(b)})
    return out


def main() -> None:
    m = nb.load(HERE / "weights.json")
    cases = json.loads((HERE / "vectors.json").read_text(encoding="utf-8"))["cases"]
    learn = [{"case": i, "features": cases[i]["features"], "distribution": d, "weight": 1.0} for i, d in LEARN]
    after = []
    for step in learn:
        nb.update(m, step["features"], step["distribution"], step["weight"])
        after.append({"vocabSize": len(m.counts), "prior": list(m.prior), "totals": list(m.totals), "cases": probe(m, cases)})
    json.dump(
        {
            "about": "nb.update() from weights.json, one learn step after another; after[j] = the model after the first afterSteps[j] learn steps, probed on every case of vectors.json. Made by make_update_vectors.py.",
            "tolerance": 1e-6,
            "learn": learn,
            "after": [after[0], after[-1]],
            "afterSteps": [1, len(learn)],
        },
        sys.stdout,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
