"""Placement methods that are not the IP (plan Phase 5).

chronological      one tree per chat, prompts in order (the status quo of a chat sidebar)
greedy             best existing topic by s if s >= tau_greedy, else the judge's top proposal under its top parent
judge_argmax       the judge's highest-rated option, no IP
judge_restructure  every N prompts the judge's full restructure, otherwise judge_argmax

All of them respect the depth limit D by construction (a new topic that would be too deep goes one
level up), so Forest.validate(D) holds; the tree and group limits K_T, K_G are only counted.
"""
from __future__ import annotations

from typing import Any

from .embed import keyphrases
from .ip import IPInput
from .judge import NEW_GROUP, RestructureOut
from .model import Forest, Group, Prompt, Topic
from .pipeline import JudgeView, StepContext, argmax_decision, build_step_input, judge_step


def _add(forest: Forest, n: Prompt, topic: str) -> Forest:
    f = forest.copy()
    f.step = n.step
    f.prompts[n.id] = n
    f.assignment[n.id] = topic
    f.access_log[n.id] = n.step
    return f


def _new_topic(forest: Forest, n: Prompt, tid: str, label: str, parent: str, kind: str, D: int,
               new_group_label: str | None = None) -> Forest:
    f = forest.copy()
    if kind == "group" and parent not in f.groups:
        f.groups[parent] = Group(parent, new_group_label or parent)
    while kind == "topic" and f.depth(parent) >= D - 1:  # keep within the depth limit
        parent, kind = f.parent_of(parent)
    f.topics[tid] = Topic(tid, label, parent, kind)
    return _add(f, n, tid)


def apply_decision(forest: Forest, n: Prompt, dec: dict[str, Any], inp: IPInput, D: int) -> tuple[Forest, str]:
    """Apply an argmax-style decision; returns the new forest and the action letter."""
    if dec["kind"] == "old":
        return _add(forest, n, dec["topic"]), "a"
    parent, kind = dec["parent"], dec["parent_kind"]
    glabel = inp.new_groups[parent].label if parent in inp.new_groups else None
    f = _new_topic(forest, n, dec["topic"], dec["label"], parent, kind, D, glabel)
    tp, tk = f.parent_of(dec["topic"])
    action = "b" if tk == "topic" else ("c" if tp in forest.groups else "d")
    return f, action


# --- methods -------------------------------------------------------------------------------------

def chronological_step(forest: Forest, n: Prompt, ctx: StepContext, state: dict) -> tuple[Forest, dict]:
    gid = "g_chats"
    tid = f"chat_{n.chat_id}"
    if tid in forest.topics:
        return _add(forest, n, tid), {"action": "a"}
    title = (keyphrases(ctx.emb, [n.text], k=1) or ["Chat"])[0]
    f = forest.copy()
    action = "c" if gid in f.groups else "d"
    f.groups.setdefault(gid, Group(gid, "Chats"))
    f.topics[tid] = Topic(tid, f"Chat {n.chat_id[1:]}: {title}", gid, "group")
    return _add(f, n, tid), {"action": action}


def greedy_step(forest: Forest, n: Prompt, ctx: StepContext, state: dict) -> tuple[Forest, dict]:
    view = judge_step(forest, n, ctx)
    inp = build_step_input(forest, n, view, ctx)
    tau = ctx.cfg["baselines"]["tau_greedy"]
    best = max(forest.topics, key=lambda c: inp.s.get((n.id, c), 0.0), default=None)
    info = {"live_calls": view.live_calls}
    if best is not None and inp.s.get((n.id, best), 0.0) >= tau:
        return _add(forest, n, best), {**info, "action": "a"}
    props = [p for p in view.placement.proposed if p.name in inp.info["proposal_ids"]]
    if not props:
        if best is None:
            raise ValueError("greedy: empty forest and no proposal")
        return _add(forest, n, best), {**info, "action": "a"}
    top = max(props, key=lambda p: p.fit)
    pa = max(top.parents, key=lambda x: x.fit)
    if pa.id.startswith(NEW_GROUP):
        parent, kind = inp.info["new_group_ids"][pa.id[len(NEW_GROUP):].strip().lower()], "group"
    else:
        parent, kind = pa.id, ("topic" if pa.id in forest.topics else "group")
    tid = inp.info["proposal_ids"][top.name]
    dec = {"kind": "new", "topic": tid, "parent": parent, "parent_kind": kind, "label": inp.new_topics[tid].label}
    f, action = apply_decision(forest, n, dec, inp, ctx.params.D)
    return f, {**info, "action": action}


def judge_argmax_step(forest: Forest, n: Prompt, ctx: StepContext, state: dict) -> tuple[Forest, dict]:
    view = judge_step(forest, n, ctx)
    inp = build_step_input(forest, n, view, ctx)
    f, action = apply_decision(forest, n, argmax_decision(forest, n, view, inp), inp, ctx.params.D)
    return f, {"action": action, "live_calls": view.live_calls}


def judge_restructure_step(forest: Forest, n: Prompt, ctx: StepContext, state: dict) -> tuple[Forest, dict]:
    f, info = judge_argmax_step(forest, n, ctx, state)
    every = ctx.cfg["baselines"]["restructure_every"]
    if n.step % every:
        return f, info
    out, meta = ctx.judge.restructure(f)
    g = forest_from_restructure(out, f, ctx.params.D, tag=f"{n.step:02d}")
    return g, {**info, "action": "e", "live_calls": info.get("live_calls", 0) + meta.calls}


def forest_from_restructure(out: RestructureOut, old: Forest, D: int, tag: str) -> Forest:
    """Build a forest from a restructure answer. Topics and groups whose label matches an old one
    keep its id (so disruption is measured fairly); prompts the answer forgot keep their old topic
    if it survives, else go to an 'Unsorted' topic."""
    f = Forest(step=old.step, prompts=dict(old.prompts), access_log=dict(old.access_log))
    old_g = {g.label.lower(): gid for gid, g in old.groups.items()}
    old_t = {t.label.lower(): tid for tid, t in old.topics.items()}
    for i, name in enumerate(dict.fromkeys(out.groups)):
        gid = old_g.get(name.lower(), f"g{tag}r{i}")
        f.groups[gid] = Group(gid, name)
    by_label: dict[str, str] = {}
    for i, t in enumerate(out.topics):
        tid = old_t.get(t.name.lower(), f"t{tag}r{i}")
        if tid in f.topics:
            tid = f"t{tag}r{i}"
        by_label[t.name.lower()] = tid
    for i, t in enumerate(out.topics):
        tid = by_label[t.name.lower()]
        if t.parent.startswith("GROUP:"):
            gname = t.parent[len("GROUP:"):]
            gid = next((g for g, grp in f.groups.items() if grp.label.lower() == gname.lower()), None)
            if gid is None:
                gid = old_g.get(gname.lower(), f"g{tag}x{len(f.groups)}")
                f.groups[gid] = Group(gid, gname)
            f.topics[tid] = Topic(tid, t.name, gid, "group")
        else:
            f.topics[tid] = Topic(tid, t.name, by_label.get(t.parent.lower(), ""), "topic")
        for p in t.prompt_ids:
            if p in f.prompts and p not in f.assignment:
                f.assignment[p] = tid
    first_group = next(iter(f.groups), None)
    for tid, t in list(f.topics.items()):  # unresolved parents and cycles become tree roots
        if t.parent_kind == "topic" and t.parent_id not in f.topics:
            t.parent_id, t.parent_kind = first_group, "group"
    for tid in list(f.topics):
        try:
            f.ancestors(tid)
        except Exception:  # noqa: BLE001 - a cycle: cut it at this topic
            f.topics[tid].parent_id, f.topics[tid].parent_kind = first_group, "group"
    for tid in sorted(f.topics, key=lambda c: -f.depth(c)):  # too deep: move up
        while f.depth(tid) > D - 1:
            par = f.topics[tid].parent_id
            f.topics[tid].parent_id, f.topics[tid].parent_kind = f.parent_of(par)
    missing = [p for p in f.prompts if p not in f.assignment]
    for p in missing:
        if old.assignment.get(p) in f.topics:
            f.assignment[p] = old.assignment[p]
        else:
            if first_group is None:
                first_group = f"g{tag}u"
                f.groups[first_group] = Group(first_group, "General")
            f.topics.setdefault(f"t{tag}u", Topic(f"t{tag}u", "Unsorted", first_group, "group"))
            f.assignment[p] = f"t{tag}u"
    changed = True
    while changed:  # drop empty topics and groups
        changed = False
        for tid in list(f.topics):
            if not f.prompts_in(tid) and not f.children(tid):
                del f.topics[tid]
                changed = True
        for gid in list(f.groups):
            if not f.roots(gid):
                del f.groups[gid]
                changed = True
    return f


METHODS = {
    "chronological": chronological_step,
    "greedy": greedy_step,
    "judge_argmax": judge_argmax_step,
    "judge_restructure": judge_restructure_step,
}
