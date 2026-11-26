"""Per-step metrics against the ideal forest (plan Phase 3)."""
from __future__ import annotations

from itertools import combinations

from .ip import Params, weights
from .model import Forest, Ideal


def pair_f1(forest: Forest, ideal: Ideal, level: str = "topic") -> float:
    """F1 of "these two prompts sit in the same topic" (or the same tree) over all pairs of placed
    prompts, against the ideal forest. Label-independent, so it also works for LLM-named topics."""
    def key(f: Forest, t: str) -> str:
        return t if level == "topic" else f.root_of(t)

    ps = sorted(forest.placement)
    pred = {(a, b) for a, b in combinations(ps, 2)
            if key(forest, forest.placement[a].topic) == key(forest, forest.placement[b].topic)}
    true = {(a, b) for a, b in combinations(ps, 2)
            if key(ideal.forest, ideal.topic_of(a)) == key(ideal.forest, ideal.topic_of(b))}
    if not pred and not true:
        return 1.0
    hit = len(pred & true)
    return 2 * hit / (len(pred) + len(true))


def topic_mates(forest: Forest, p: str) -> list[str]:
    """The other prompts in p's topic."""
    return [q for q in forest.prompts_in(forest.placement[p].topic) if q != p]


def placed_right(after: Forest, ideal: Ideal, p: str) -> bool:
    """The new prompt p shares its topic with exactly the prompts it shares it with in the ideal
    forest, counting only the prompts that have arrived by this step. Label-independent."""
    return set(topic_mates(after, p)) == set(topic_mates(ideal.upto(after.step), p))


def disruption(before: Forest, after: Forest, step: int) -> dict:
    """What changed for things that existed before this step (adding the new prompt is no change)."""
    w, _ = weights(before, step)
    moved = [p for p in before.placement if after.placement[p].topic != before.placement[p].topic]
    moved_t = [c for c in before.topics if c in after.topics
               and (after.topics[c].parent, after.topics[c].parent_kind) != (before.topics[c].parent, before.topics[c].parent_kind)]
    deleted = [c for c in before.topics if c not in after.topics] + [g for g in before.groups if g not in after.groups]
    return {"moved_prompts": len(moved), "moved_prompts_w": sum(w[p] for p in moved),
            "moved_topics": len(moved_t), "deleted": len(deleted)}


def balance(forest: Forest, P: Params) -> dict:
    return {"over_U": sum(len(forest.prompts_in(c)) > P.U for c in forest.topics),
            "under_L": sum(len(forest.prompts_in(c)) + len(forest.children(c)) < P.L for c in forest.topics)}


def misplaced(forest: Forest, ideal: Ideal) -> set[str]:
    """Prompts whose ideal topic differs from the ideal topic most prompts of their topic share
    (label-independent; used to colour prompts red in compare_view)."""
    out = set()
    for c in forest.topics:
        ps = forest.prompts_in(c)
        if not ps:
            continue
        ideal_topics = [ideal.topic_of(p) for p in ps]
        major = max(set(ideal_topics), key=ideal_topics.count)
        out |= {p for p in ps if ideal.topic_of(p) != major}
    return out
