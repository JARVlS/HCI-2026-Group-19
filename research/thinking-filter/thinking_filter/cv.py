"""Step 6: choose the filter's features, vocabulary cap, alpha and beta by 5-fold cross-validation, then
fit it on all items and write out/weights.json.

The grid search runs on a numpy version of nb.belief (same formula, vectorised over items); the
shipped model is fitted and checked with the reference implementation in nb.py.

  uv run python -m thinking_filter.cv            # out/weights.json, out/selection.json
"""
import itertools
import json
import sys
from dataclasses import asdict, replace

import numpy as np

from . import design, nb
from .files import LABELS, OUT, SYNTHETIC, WEIGHTS, read_jsonl, write_json

ALPHAS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.7, 1.0]
BETAS = [0.03, 0.1, 0.3, 1.0, 2.0]
GROUPS = ["bigrams", "start", "qmark", "length", "context"]
MAX_BYTES = 150_000
# The objective is the Brier score of the belief against the judge's distribution (sum over the five
# levels of the squared difference, mean over items). Like cross-entropy it is a proper scoring rule,
# so it calibrates the belief (and alpha), but a few confident mistakes do not dominate it; cross-
# entropy alone picks alpha 0.2 and drops the word pairs at a clear cost in error and label agreement
# (see out/report.md).


def training_set() -> tuple[list[dict], np.ndarray]:
    """The synthetic items with a judge label in their training condition, and the labels (n x 5)."""
    items = read_jsonl(SYNTHETIC)
    labels = {(r["id"], r["cond"]): r for r in read_jsonl(LABELS) if r["prefix"] is None}
    kept, q = [], []
    for it in items:
        lab = labels.get((it["id"], design.condition_for(it)))
        if lab is None:
            raise RuntimeError(f"{it['id']} has no label row: run thinking_filter.label first")
        if "probs" in lab:
            kept.append(it)
            q.append(lab["probs"])
    return kept, np.array(q)


class Encoded:
    """All items' features as flat index arrays: occurrence j is feature flat[j] of item owner[j]."""

    def __init__(self, feature_lists: list[list[str]]):
        names = sorted({f for fl in feature_lists for f in fl})
        self.names = names
        index = {f: i for i, f in enumerate(names)}
        self.n, self.f = len(feature_lists), len(names)
        self.flat = np.array([index[f] for fl in feature_lists for f in fl], dtype=np.int64)
        self.owner = np.repeat(np.arange(self.n), [len(fl) for fl in feature_lists])


def fold_counts(enc: Encoded, q: np.ndarray, train: np.ndarray, min_docs: int, top_k: int | None):
    """Soft counts on the training items, the kept-feature mask and the prior (as nb.fit)."""
    in_train = np.zeros(enc.n, bool)
    in_train[train] = True
    occ = in_train[enc.owner]
    counts = np.zeros((enc.f, nb.LEVELS))
    np.add.at(counts, enc.flat[occ], q[enc.owner[occ]])
    pairs = np.unique(enc.owner[occ] * enc.f + enc.flat[occ]) % enc.f
    docs = np.bincount(pairs, minlength=enc.f)
    keep = docs >= max(min_docs, 1)
    prior = q[train].sum(0)
    if top_k is not None and keep.sum() > top_k:
        n = counts.sum(1)
        p = (counts + 0.5) / (n[:, None] + 0.5 * nb.LEVELS)
        pq = (prior + 0.5) / (prior.sum() + 0.5 * nb.LEVELS)
        info = n * (p * np.log(p / pq)).sum(1)
        info[~keep] = -np.inf
        # Same order as nb.fit: most informative first, ties by feature name (names are sorted).
        order = np.lexsort((np.arange(enc.f), -info))
        keep = np.zeros(enc.f, bool)
        keep[order[:top_k]] = True
    return counts, keep, prior


def fold_beliefs(enc: Encoded, test: np.ndarray, counts, keep, prior, alpha: float, beta: float) -> np.ndarray:
    v = keep.sum()
    totals = counts[keep].sum(0)
    ll = np.log((counts + beta) / (totals + beta * v))
    in_test = np.zeros(enc.n, bool)
    in_test[test] = True
    occ = in_test[enc.owner] & keep[enc.flat]
    s = np.zeros((enc.n, nb.LEVELS))
    np.add.at(s, enc.owner[occ], ll[enc.flat[occ]])
    z = np.log(prior / prior.sum()) + alpha * s[test]
    z -= z.max(1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(1, keepdims=True)


def cv_grid(items: list[dict], q: np.ndarray, spec: nb.Spec, min_docs: int = 1, top_k: int | None = None,
            alphas=ALPHAS, betas=BETAS) -> dict:
    """Out-of-fold beliefs for every alpha x beta; returns the best by Brier score, with the other measures."""
    enc = Encoded([nb.features(it["text"], nb.tutor_asked(it["tutor"]), spec) for it in items])
    fold = np.array(design.folds(items))
    w = np.array(nb.LEVEL_WEIGHTS)
    pct = q @ w
    beliefs = {(a, b): np.zeros_like(q) for a in alphas for b in betas}
    vocab = []
    for k in range(design.FOLDS):
        train, test = np.where(fold != k)[0], np.where(fold == k)[0]
        counts, keep, prior = fold_counts(enc, q, train, min_docs, top_k)
        vocab.append(int(keep.sum()))
        for a, b in itertools.product(alphas, betas):
            beliefs[(a, b)][test] = fold_beliefs(enc, test, counts, keep, prior, a, b)
    grid = [{"alpha": a, "beta": b, **measures(bel, q, pct, w)} for (a, b), bel in beliefs.items()]
    best = min(grid, key=lambda g: g["brier"])
    return {"spec": asdict(spec), "min_docs": min_docs, "top_k": top_k, "vocab_per_fold": vocab, **best, "grid": grid}


def label_index(p: np.ndarray) -> np.ndarray:
    """0 ai, 1 together, 2 own: thinkingMode() with OWN_FROM 0.67 and AI_UP_TO 0.2 (evaluate.py reads them from modes.ts)."""
    return np.where(p >= 0.67, 2, np.where(p <= 0.2, 0, 1))


def measures(bel: np.ndarray, q: np.ndarray, pct: np.ndarray, w: np.ndarray) -> dict:
    est = bel @ w
    return {
        "brier": float(((bel - q) ** 2).sum(1).mean()),
        "ce": float(-(q * np.log(np.clip(bel, 1e-300, None))).sum(1).mean()),
        "mae": float(np.abs(est - pct).mean()),
        "rmse": float(np.sqrt(((est - pct) ** 2).mean())),
        "label_agree": float((label_index(est) == label_index(pct)).mean()),
        "top_p": float(bel.max(1).mean()),
        "top_hit": float((bel.argmax(1) == q.argmax(1)).mean()),
    }


def size_of(items, q, spec, min_docs, top_k, alpha, beta) -> tuple[int, int]:
    m = nb.rounded(nb.fit([nb.features(it["text"], nb.tutor_asked(it["tutor"]), spec) for it in items], q.tolist(),
                          alpha, beta, min_docs, top_k))
    return len(json.dumps(nb.to_json(m, "size-probe"), ensure_ascii=False, separators=(",", ":")).encode()), len(m.counts)


SHOWN = ("brier", "ce", "mae", "rmse", "label_agree", "top_p", "top_hit", "alpha", "beta")


def brief(r: dict) -> str:
    return (f"brier {r['brier']:.4f} ce {r['ce']:.3f} mae {r['mae']:.4f} labels {r['label_agree']:.3f}"
            f" top-p {r['top_p']:.3f} vs hit {r['top_hit']:.3f} (alpha {r['alpha']}, beta {r['beta']})")


def main() -> None:
    items, q = training_set()
    print(f"training items: {len(items)} (label condition for replies: {design.TRAIN_CONDITION})", file=sys.stderr)
    entropy = float(-(q * np.log(np.clip(q, 1e-300, None))).sum(1).mean())

    # 1+2. Feature groups and vocabulary cap together (which groups help depends on the pruning:
    # word pairs seen once are noise, word pairs seen twice or more help). Specs: all, all but one
    # group, unigrams only; caps: minimum document count x the most informative features.
    full = nb.Spec()
    specs = {"all": full, **{f"all but {g}": replace(full, **{g: False}) for g in GROUPS}, "unigrams only": nb.Spec(False, False, False, False, False)}
    rows = []
    for name, spec in specs.items():
        for min_docs, top_k in itertools.product([1, 2, 3], [None, 3000, 2000, 1500, 1000, 600, 300]):
            r = cv_grid(items, q, spec, min_docs, top_k)
            if top_k is not None and max(r["vocab_per_fold"]) < top_k:
                continue  # the cap does not bite: same as top_k None
            size, v = size_of(items, q, spec, min_docs, top_k, r["alpha"], r["beta"])
            rows.append({"features": name, "min_docs": min_docs, "top_k": top_k, **{k: r[k] for k in SHOWN}, "bytes": size, "vocab": v})
            print(f"  {name:16s} min_docs {min_docs} top_k {top_k!s:5s} vocab {v:5d} {size / 1000:6.1f} KB  {brief(r)}", file=sys.stderr)
    pick = min((r for r in rows if r["bytes"] <= MAX_BYTES), key=lambda r: r["brier"])
    spec = specs[pick["features"]]
    print(f"  picked {pick['features']}, min_docs {pick['min_docs']}, top_k {pick['top_k']}: vocab {pick['vocab']}, {pick['bytes'] / 1000:.1f} KB", file=sys.stderr)

    # 3. Final alpha and beta on a finer grid; alpha 1 (no tempering) kept for comparison.
    fine = cv_grid(items, q, spec, pick["min_docs"], pick["top_k"],
                   alphas=[round(x, 3) for x in np.arange(0.1, 1.001, 0.05)], betas=[0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0])
    untempered = min((g for g in fine["grid"] if g["alpha"] == 1.0), key=lambda g: g["brier"])
    by_ce = min(fine["grid"], key=lambda g: g["ce"])
    print(f"  final:      {brief(fine)}", file=sys.stderr)
    print(f"  alpha 1:    {brief(untempered)}", file=sys.stderr)
    print(f"  best by ce: {brief(by_ce)}", file=sys.stderr)

    model = nb.rounded(nb.fit([nb.features(it["text"], nb.tutor_asked(it["tutor"]), spec) for it in items], q.tolist(),
                              fine["alpha"], fine["beta"], pick["min_docs"], pick["top_k"]))
    if asdict(spec) != asdict(nb.SHIPPED):
        raise SystemExit(f"nb.SHIPPED must be set to the chosen feature groups {asdict(spec)} before writing the weights")
    nb.save(model, WEIGHTS, version="2026-11-17")
    print(f"wrote {WEIGHTS}: vocab {len(model.counts)}, {WEIGHTS.stat().st_size / 1000:.1f} KB", file=sys.stderr)

    write_json(OUT / "selection.json", {
        "items": len(items), "label_entropy": entropy, "train_condition": design.TRAIN_CONDITION, "objective": "brier",
        "search": rows, "picked": pick, "chosen_spec": asdict(spec),
        "final": {k: fine[k] for k in (*SHOWN, "min_docs", "top_k", "vocab_per_fold")},
        "alpha_1": {k: untempered[k] for k in SHOWN}, "best_by_ce": {k: by_ce[k] for k in SHOWN},
    })


if __name__ == "__main__":
    main()
