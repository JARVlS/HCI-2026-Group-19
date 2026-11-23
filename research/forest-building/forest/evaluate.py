"""Evaluation against the (draft) gold labels: shortlist recall@k and judge agreement.

Both replay the gold forest: at step t the forest holds the gold placement of prompts 1..t-1, and
prompt t is scored against it. A prompt whose gold topic does not exist yet at step t ("new") is
excluded from recall and reported separately.
"""
from __future__ import annotations

import random
import time

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from .embed import Embedder, shortlist
from .io import Session, gold_forest, gold_topic_id
from .judge import Candidate, Judge, PlacementRequest


def shortlist_recall(emb: Embedder, session: Session, gold: dict, ks: list[int], option: str,
                     include_parents: bool = False) -> pd.DataFrame:
    rows = []
    for p in session.prompts:
        f = gold_forest(session, gold, p.step)
        target = gold_topic_id(gold[p.id])
        if target not in f.topics:
            continue
        for k in ks:
            sl = shortlist(emb, f, p.text, k, option, include_parents, enabled=True)
            rows.append({"session": session.id, "prompt": p.id, "k": k, "hit": target in sl,
                         "n_topics": len(f.topics), "shortlist_len": len(sl)})
    return pd.DataFrame(rows)


def judge_agreement(judge: Judge, session: Session, gold: dict, order_seed: int = 0, max_prompts: int | None = None,
                    examples: int = 3) -> pd.DataFrame:
    """Per prompt: the judge's top-1 existing topic vs the gold topic (all gold-forest topics are
    candidates, no shortlist), whether it proposed something when the gold topic is new, latency."""
    rows = []
    prompts = session.prompts[:max_prompts] if max_prompts else session.prompts
    for p in prompts:
        f = gold_forest(session, gold, p.step)
        target = gold_topic_id(gold[p.id])
        cands = [Candidate(c, f.path(c), [f.prompts[x].text for x in f.prompts_in(c)[-examples:]]) for c in sorted(f.topics)]
        req = PlacementRequest(p.id, p.text, cands, [(g, grp.label) for g, grp in f.groups.items()], f, order_seed)
        t0 = time.time()
        try:
            out, meta = judge.placement(req)
            err = None
        except Exception as e:  # noqa: BLE001 - recorded as a failure row
            out, meta, err = None, None, str(e)[:200]
        row = {"session": session.id, "prompt": p.id, "gold_exists": target in f.topics, "error": err,
               "latency_s": time.time() - t0, "cached": bool(meta and meta.cached), "calls": meta.calls if meta else 0}
        if out is not None:
            fits = {e.topic_id: e.fit for e in out.existing}
            top = max(fits.items(), key=lambda kv: kv[1])[0] if fits else None
            row.update(top1=top, top1_hit=(top == target), gold_fit=fits.get(target), max_fit=max(fits.values(), default=None),
                       n_proposed=len(out.proposed), fits=fits,
                       proposed=[x.name for x in out.proposed])
        rows.append(row)
    return pd.DataFrame(rows)


def position_bias(judge: Judge, session: Session, gold: dict, seeds=(0, 1), max_prompts: int | None = None) -> float:
    """Share of prompts whose top-1 existing topic changes between two candidate orders."""
    a = judge_agreement(judge, session, gold, seeds[0], max_prompts)
    b = judge_agreement(judge, session, gold, seeds[1], max_prompts)
    m = a.merge(b, on="prompt", suffixes=("_a", "_b"))
    m = m[m["top1_a"].notna() & m["top1_b"].notna()]
    return float((m["top1_a"] != m["top1_b"]).mean()) if len(m) else float("nan")


def fit_spearman(df: pd.DataFrame, human: pd.DataFrame) -> float:
    """Spearman correlation of judge fits with human ratings (columns prompt, topic_id, rating)."""
    pairs = []
    for _, r in human.iterrows():
        fits = df.set_index("prompt").loc[r["prompt"], "fits"] if r["prompt"] in set(df["prompt"]) else {}
        if r["topic_id"] in fits:
            pairs.append((fits[r["topic_id"]], r["rating"]))
    if len(pairs) < 3:
        return float("nan")
    return float(spearmanr(*zip(*pairs)).statistic)


def validation_sample(session_gold: dict[str, tuple[Session, dict]], n: int, seed: int) -> pd.DataFrame:
    """n random (prompt, topic) pairs from the gold forests for human rating, half of them the gold topic."""
    rng = random.Random(seed)
    rows = []
    for sid, (s, gold) in session_gold.items():
        f = gold_forest(s, gold, len(s.prompts) + 1)
        for p in s.prompts:
            target = gold_topic_id(gold[p.id])
            other = rng.choice([c for c in f.topics if c != target])
            for c in (target, other):
                rows.append({"session": sid, "prompt": p.id, "prompt_text": p.text, "topic_id": c, "topic_path": f.path(c)})
    rng.shuffle(rows)
    df = pd.DataFrame(rows[:n])
    df["rating_rater1"] = ""
    df["rating_rater2"] = ""
    return df


def weighted_kappa(a: list[int], b: list[int], levels=(1, 2, 3, 4, 5)) -> float:
    """Cohen's kappa with linear weights."""
    a, b = np.asarray(a), np.asarray(b)
    k = len(levels)
    idx = {v: i for i, v in enumerate(levels)}
    O = np.zeros((k, k))
    for x, y in zip(a, b):
        O[idx[x], idx[y]] += 1
    W = np.abs(np.subtract.outer(range(k), range(k))) / (k - 1)
    E = np.outer(O.sum(1), O.sum(0)) / O.sum()
    return float(1 - (W * O).sum() / (W * E).sum())
