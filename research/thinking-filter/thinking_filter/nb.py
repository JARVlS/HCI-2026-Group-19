"""The thinking filter: a multinomial naive Bayes over the five levels of the app's thinking scale,
learned from soft labels (the judge's distribution), evaluated after every typed word.

This file is the REFERENCE implementation the frontend mirrors. Its three public functions and the
weights file (out/weights.json) are the whole contract:

  features(text, tutor_asked) -> list[str]     how a draft becomes features (FEATURE_SPEC, exact)
  belief(features, model)     -> list[5]       the belief over the levels 1..5
  update(model, features, distribution, weight)  adds soft counts: the filter keeps learning

estimate(belief) = sum(belief[k] * LEVEL_WEIGHTS[k]); certainty(belief) = 1 - H(belief) / ln 5.
"""
import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

LEVELS = 5
LEVEL_WEIGHTS = [0.0, 0.25, 0.5, 0.75, 1.0]  # THINKING_SCALE in frontend/src/ai/prompts/score.ts

# Letters and digits (Unicode), with apostrophes kept inside words. `[^\W_]` is Python's spelling of
# JavaScript's `[\p{L}\p{N}]` (with the `u` flag).
TOKEN = re.compile(r"[^\W_]+(?:'[^\W_]+)*")
LENGTH_BUCKETS = [(2, "1-2"), (5, "3-5"), (10, "6-10"), (20, "11-20")]  # more: "21+"

FEATURE_SPEC = """\
A draft becomes features in five steps (the TypeScript port must give the same list, in this order):
1. Normalise: replace U+2019 and U+2018 (curly single quotes) with U+0027 ('), then lower-case the whole
   text (JavaScript toLowerCase() / Python str.lower()). No other normalisation (no NFC, no trimming).
2. Tokens: every match of /[\\p{L}\\p{N}]+(?:'[\\p{L}\\p{N}]+)*/gu in the normalised text, left to right
   (runs of Unicode letters and digits; an apostrophe stays only between two such runs, so "don't" is
   one token and "'quoted'" is the token quoted). Everything else separates tokens.
3. Word features, in this order: every token (unigram); then every adjacent pair "a b" (one space);
   then "^" + the first token, and "^" + the first two tokens joined by one space if there are two or more.
4. "?$" if the text without trailing whitespace ends with "?".
5. If there is at least one token, "#len:" + the token-count bucket: 1-2 -> "1-2", 3-5 -> "3-5",
   6-10 -> "6-10", 11-20 -> "11-20", more -> "21+".
6. "@tutor_asked" if the tutor's last message (without trailing whitespace) ends with "?".
A feature that is not a key of `counts` is skipped by belief(); repeated features count every time.
belief() reads `prior`, `totals`, `alpha`, `beta` and V = the number of keys of `counts` as they are in
the file; update() keeps `totals` equal to the column sums of `counts`.
"""


@dataclass
class Spec:
    """Which feature groups are on (chosen by cross-validation, see evaluate.py)."""
    bigrams: bool = True
    start: bool = True
    qmark: bool = True
    length: bool = True
    context: bool = True


SHIPPED = Spec()


def normalise(text: str) -> str:
    return text.replace("’", "'").replace("‘", "'").lower()


def tokens(text: str) -> list[str]:
    return TOKEN.findall(normalise(text))


def length_bucket(n: int) -> str:
    for upper, name in LENGTH_BUCKETS:
        if n <= upper:
            return name
    return "21+"


def tutor_asked(tutor: str | None) -> bool:
    return bool(tutor) and tutor.rstrip().endswith("?")


def features(text: str, asked: bool, spec: Spec = SHIPPED) -> list[str]:
    toks = tokens(text)
    out = list(toks)
    if spec.bigrams:
        out += [f"{a} {b}" for a, b in zip(toks, toks[1:])]
    if spec.start and toks:
        out.append("^" + toks[0])
        if len(toks) > 1:
            out.append(f"^{toks[0]} {toks[1]}")
    if spec.qmark and text.rstrip().endswith("?"):
        out.append("?$")
    if spec.length and toks:
        out.append("#len:" + length_bucket(len(toks)))
    if spec.context and asked:
        out.append("@tutor_asked")
    return out


@dataclass
class Model:
    """Soft counts. prior[k]: summed label mass of level k; counts[f][k]: summed label mass of the
    items, times how often f occurs in each; totals[k] = sum over f of counts[f][k]."""
    alpha: float
    beta: float
    prior: list[float] = field(default_factory=lambda: [0.0] * LEVELS)
    counts: dict[str, list[float]] = field(default_factory=dict)
    totals: list[float] = field(default_factory=lambda: [0.0] * LEVELS)


def belief(feats: list[str], m: Model) -> list[float]:
    """log b_k = ln(prior_k / sum(prior)) + alpha * sum over known f of ln((counts[f][k] + beta) /
    (totals[k] + beta * V)), V = number of keys in counts; then normalised (softmax)."""
    v = len(m.counts)
    p_sum = sum(m.prior)
    denom = [m.totals[k] + m.beta * v for k in range(LEVELS)]
    ll = [0.0] * LEVELS
    for f in feats:
        c = m.counts.get(f)
        if c is None:
            continue
        for k in range(LEVELS):
            ll[k] += math.log((c[k] + m.beta) / denom[k])
    # A level with no prior mass stays at 0 (JavaScript's Math.log(0) is -Infinity; Python's raises).
    z = [math.log(m.prior[k] / p_sum) + m.alpha * ll[k] if m.prior[k] > 0 else -math.inf for k in range(LEVELS)]
    top = max(z)
    e = [math.exp(x - top) for x in z]
    s = sum(e)
    return [x / s for x in e]


def estimate(b: list[float]) -> float:
    return sum(p * w for p, w in zip(b, LEVEL_WEIGHTS))


def certainty(b: list[float]) -> float:
    return 1 + sum(p * math.log(p) for p in b if p > 0) / math.log(LEVELS)


def update(m: Model, feats: list[str], dist: list[float], weight: float = 1.0) -> None:
    """Learn from one judged message: add weight * distribution to the prior, and to the counts of
    every feature (new features become keys) and the totals."""
    add = [weight * p for p in dist]
    for k in range(LEVELS):
        m.prior[k] += add[k]
    for f in feats:
        c = m.counts.setdefault(f, [0.0] * LEVELS)
        for k in range(LEVELS):
            c[k] += add[k]
            m.totals[k] += add[k]


# --- fitting and the weights file --------------------------------------------------------------------

def _smoothed(c: list[float]) -> list[float]:
    n = sum(c)
    return [(x + 0.5) / (n + 0.5 * LEVELS) for x in c]


def informativeness(c: list[float], prior: list[float]) -> float:
    """How much a feature tells about the level: its mass times the KL divergence of its level
    distribution from the prior's (both lightly smoothed)."""
    p, q = _smoothed(c), _smoothed(prior)
    return sum(c) * sum(pk * math.log(pk / qk) for pk, qk in zip(p, q))


def fit(feature_lists: list[list[str]], dists: list[list[float]], alpha: float, beta: float,
        min_docs: int = 1, top_k: int | None = None) -> Model:
    """Soft-count fit. Keeps features that occur in at least `min_docs` items, then the `top_k` most
    informative ones; totals are summed over the kept features only."""
    m = Model(alpha=alpha, beta=beta)
    docs: dict[str, int] = {}
    for feats, q in zip(feature_lists, dists):
        update(m, feats, q, 1.0)
        for f in set(feats):
            docs[f] = docs.get(f, 0) + 1
    keep = [f for f in m.counts if docs[f] >= min_docs]
    if top_k is not None and len(keep) > top_k:
        keep.sort(key=lambda f: (-informativeness(m.counts[f], m.prior), f))
        keep = keep[:top_k]
    m.counts = {f: m.counts[f] for f in sorted(keep)}
    m.totals = [sum(c[k] for c in m.counts.values()) for k in range(LEVELS)]
    return m


def rounded(m: Model, digits: int = 4) -> Model:
    """The model as shipped: counts and prior rounded, totals the column sums of the rounded counts."""
    counts = {f: [round(x, digits) for x in c] for f, c in m.counts.items()}
    totals = [sum(c[k] for c in counts.values()) for k in range(LEVELS)]
    return Model(alpha=m.alpha, beta=m.beta, prior=[round(x, digits) for x in m.prior], counts=counts, totals=totals)


def to_json(m: Model, version: str) -> dict:
    return {
        "version": version,
        "levels": LEVELS,
        "levelWeights": LEVEL_WEIGHTS,
        "alpha": m.alpha,
        "beta": m.beta,
        "vocabSize": len(m.counts),
        "prior": m.prior,
        "totals": m.totals,
        "counts": m.counts,
        "featureSpec": FEATURE_SPEC,
    }


def save(m: Model, path: Path, version: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(to_json(m, version), ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def load(path: Path) -> Model:
    d = json.loads(path.read_text(encoding="utf-8"))
    if d["levels"] != LEVELS or d["levelWeights"] != LEVEL_WEIGHTS or d["vocabSize"] != len(d["counts"]):
        raise ValueError(f"{path}: levels, level weights or vocabSize do not match this filter")
    return Model(alpha=d["alpha"], beta=d["beta"], prior=d["prior"], counts=d["counts"], totals=d["totals"])
