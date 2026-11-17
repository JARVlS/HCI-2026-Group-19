"""Test vectors for the TypeScript port: 40 drafts with their features, belief, estimate and certainty
under out/weights.json, and for 5 of them the same after every typed word.

  uv run python -m thinking_filter.vectors           # out/vectors.json
"""
import json
import sys

from . import design, frontend, nb
from .files import SYNTHETIC, VECTORS, WEIGHTS, read_jsonl, write_json

EDGE_CASES = [
    ("", False), ("", True), ("?!  ", False), ("why?   ", True),
    ("Don’t just tell me the answer, I’d rather get a hint", False),
    ("Qu’est-ce que la photosynthèse ? Je pense que c’est la lumière", False),
    ("2x + 4 = 10 so x = 3, right?", True), ("no no no no", False),
    ("WRITE ME AN ESSAY ABOUT THE FRENCH REVOLUTION", False), ("zxqv blorf gnarp", False),
]
STEP_CASES = 5


def linter_of(text: str) -> dict:
    """classify() of the draft as the port gets it in the browser (only what features() reads)."""
    x = frontend.word_rules([text])[0]
    return {"mode": x["mode"], "confidence": x["confidence"], "reasons": x["reasons"]}


def case(text: str, asked: bool, m: nb.Model, steps: bool = False) -> dict:
    lin = linter_of(text)
    feats = nb.features(text, asked, lin)
    b = nb.belief(feats, m)
    out = {"text": text, "tutorAsked": asked, "linter": lin, "features": feats, "belief": b, "estimate": nb.estimate(b), "certainty": nb.certainty(b)}
    if steps:
        out["steps"] = []
        for end in design.chunk_ends(text):
            sl = linter_of(text[:end])
            sf = nb.features(text[:end], asked, sl)
            sb = nb.belief(sf, m)
            out["steps"].append({"text": text[:end], "linter": sl, "features": sf, "belief": sb, "estimate": nb.estimate(sb), "certainty": nb.certainty(sb)})
    return out


def main() -> None:
    m = nb.load(WEIGHTS)
    version = json.loads(WEIGHTS.read_text())["version"]
    items = read_jsonl(SYNTHETIC)
    picked = [items[i] for i in design.stratified_sample(items, 30, seed=3)]
    drafts = [(it["text"], nb.tutor_asked(it["tutor"])) for it in picked] + EDGE_CASES
    frontend.word_rules([t[:e] for t, _ in drafts for e in design.chunk_ends(t)] + [t for t, _ in drafts])  # one bridge call
    # Per-word steps for five drafts of different kinds and lengths, one of them a reply.
    with_steps = {0, 1, 2, 3, 4} if any(a for _, a in drafts[:5]) else {0, 1, 2, 3, next(i for i, (_, a) in enumerate(drafts) if a)}
    cases = [case(t, a, m, steps=i in with_steps) for i, (t, a) in enumerate(drafts)]
    assert len(cases) == 40 and sum("steps" in c for c in cases) == STEP_CASES
    write_json(VECTORS, {
        "weights": WEIGHTS.name, "weightsVersion": version, "tolerance": 1e-6,
        "about": ("belief/estimate/certainty of nb.py under weights.json; linter = classify() of the same draft "
                  "(mode, confidence, reasons: what features() reads); steps = the draft after each whitespace-separated word (text[:end of word n])"),
        "cases": cases,
    })
    print(f"wrote {VECTORS}: {len(cases)} cases, {STEP_CASES} with steps", file=sys.stderr)


if __name__ == "__main__":
    main()
