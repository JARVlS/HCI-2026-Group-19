"""Metrics per step and per run, the same for every method (plan Phase 5).

Fit uses one scorer for all methods: the calibrated cosine of a prompt to its topic's LABEL
(label, not centroid, so a method cannot score well by naming topics badly but grouping tightly;
and no judge scores, since methods see different judge calls). Hierarchy fit: calibrated cosine of
child and parent labels. Gold agreement: adjusted Rand index of the topic (and group) partition of
the prompts against the draft gold labels.
"""
from __future__ import annotations

from collections import Counter

import numpy as np
from sklearn.metrics import adjusted_rand_score

from .config import IPParams
from .embed import Embedder, cal_bounds, calibrate
from .model import Forest
from .scores import disruption_weights


class Scorer:
    def __init__(self, emb: Embedder, cfg: dict):
        self.emb = emb
        self.lo, self.hi = cal_bounds(cfg, emb.name)

    def cal(self, a: str, b: str) -> float:
        return float(calibrate(float(self.emb.one(a) @ self.emb.one(b)), self.lo, self.hi))

    def fit(self, f: Forest) -> float:
        return sum(self.cal(f.prompts[p].text, f.topics[c].label) for p, c in f.assignment.items())

    def hierarchy(self, f: Forest) -> float:
        tot = 0.0
        for t in f.topics.values():
            parent = f.topics[t.parent_id].label if t.parent_kind == "topic" else f.groups[t.parent_id].label
            tot += self.cal(t.label, parent)
        return tot


def structure(f: Forest) -> dict:
    depths = [f.depth(c) for c in f.topics] or [0]
    sizes = [len(f.prompts_in(c)) for c in f.topics]
    return {"groups": len(f.groups), "trees": len(f.roots()), "topics": len(f.topics),
            "max_depth": max(depths), "mean_depth": float(np.mean(depths)),
            "sizes": sorted(sizes, reverse=True)}


def imbalance(f: Forest, p: IPParams) -> dict:
    over = sum(1 for c in f.topics if len(f.prompts_in(c)) > p.U)
    under = sum(1 for c in f.topics if len(f.prompts_in(c)) + len(f.children(c)) < p.L)
    wide = sum(1 for c in f.topics if len(f.children(c)) > p.B)
    excess = sum(max(0, len(f.prompts_in(c)) - p.U) for c in f.topics)
    return {"over_U": over, "under_L": under, "over_B": wide, "excess_prompts": excess}


def violations(f: Forest, p: IPParams) -> dict:
    """Hard limits of the IP: trees per group (K_T), groups (K_G), depth (D)."""
    return {"viol_K_T": sum(max(0, len(f.roots(g)) - p.K_T) for g in f.groups),
            "viol_K_G": max(0, len(f.groups) - p.K_G),
            "viol_D": sum(1 for c in f.topics if f.depth(c) > p.D - 1)}


def disruption(prev: Forest, cur: Forest, now: int, cfg: dict) -> dict:
    """Changes to what existed before this step (adding the new prompt is not a change)."""
    w, v = disruption_weights(prev, now, cfg["disruption"]["a"], cfg["disruption"]["T"]) if prev.prompts else ({}, {})
    moved = [p for p in prev.prompts if cur.assignment.get(p) != prev.assignment[p]]
    moved_t = [c for c in prev.topics if c in cur.topics and
               (cur.topics[c].parent_id, cur.topics[c].parent_kind) != prev.parent_of(c)]
    deleted_t = [c for c in prev.topics if c not in cur.topics]
    renamed = [c for c in prev.topics if c in cur.topics and cur.topics[c].label != prev.topics[c].label]
    deleted_g = [g for g in prev.groups if g not in cur.groups]
    return {"moved_prompts": len(moved), "moved_prompts_w": sum(w.get(p, 1.0) for p in moved),
            "moved_topics": len(moved_t), "deleted_topics": len(deleted_t), "renamed_topics": len(renamed),
            "deleted_groups": len(deleted_g),
            "moved_categories_w": sum(v.get(c, 1.0) for c in moved_t + deleted_t + deleted_g),
            "changed": int(bool(moved or moved_t or deleted_t or renamed or deleted_g))}


def gold_agreement(f: Forest, gold: dict) -> dict:
    ps = [p for p in f.assignment if p in gold]
    if len(ps) < 2:
        return {"ari_topic": np.nan, "ari_group": np.nan, "ari_tree": np.nan}
    topic = [f.assignment[p] for p in ps]
    group = [f.group_of(f.assignment[p]) for p in ps]
    tree = [f.root_of(f.assignment[p]) for p in ps]
    return {"ari_topic": adjusted_rand_score([gold[p].path for p in ps], topic),
            "ari_tree": adjusted_rand_score([" > ".join(gold[p].parts[:2]) for p in ps], tree),
            "ari_group": adjusted_rand_score([gold[p].group for p in ps], group)}


def step_metrics(prev: Forest, cur: Forest, step: int, scorer: Scorer, params: IPParams, cfg: dict,
                 gold: dict | None) -> dict:
    row = {"fit": scorer.fit(cur), "fit_mean": scorer.fit(cur) / max(1, len(cur.prompts)),
           "hier_fit": scorer.hierarchy(cur)}
    st = structure(cur)
    row.update({k: v for k, v in st.items() if k != "sizes"})
    row["sizes"] = " ".join(map(str, st["sizes"]))
    row.update(imbalance(cur, params))
    row.update(violations(cur, params))
    row.update(disruption(prev, cur, step, cfg))
    if gold:
        row.update(gold_agreement(cur, gold))
    return row


def summarize(df) -> dict:
    """Per-run summary of a step table (one method, one session)."""
    last = df.iloc[-1]
    s = {
        "final_fit": last["fit"], "final_fit_mean": last["fit_mean"], "final_hier_fit": last["hier_fit"],
        "groups": last["groups"], "trees": last["trees"], "topics": last["topics"], "max_depth": last["max_depth"],
        "over_U": last["over_U"], "under_L": last["under_L"], "over_B": last["over_B"],
        "viol_K_T": last["viol_K_T"], "viol_K_G": last["viol_K_G"], "viol_D": last["viol_D"],
        "moved_prompts": df["moved_prompts"].sum(), "moved_prompts_w": df["moved_prompts_w"].sum(),
        "moved_topics": df["moved_topics"].sum(), "deleted_topics": df["deleted_topics"].sum(),
        "renamed_topics": df["renamed_topics"].sum(), "steps_changed": df["changed"].sum(),
        "disruption_w": df["moved_prompts_w"].sum() + df["moved_categories_w"].sum(),
        "solve_s_mean": df["solve_s"].mean() if "solve_s" in df else np.nan,
        "live_calls": df["live_calls"].sum() if "live_calls" in df else 0,
    }
    for k in ("ari_topic", "ari_tree", "ari_group"):
        if k in df:
            s[k] = last[k]
    if "same_as_argmax" in df and df["same_as_argmax"].notna().any():
        s["ip_differs_from_judge_argmax"] = 1 - df["same_as_argmax"].dropna().astype(float).mean()
    s["actions"] = " ".join(f"{k}:{v}" for k, v in sorted(Counter(df["action"]).items()))
    return s
