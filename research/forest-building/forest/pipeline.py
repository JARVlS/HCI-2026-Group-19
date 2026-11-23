"""One placement step: shortlist -> judge -> scores -> IP -> new forest (plan §1.3)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .config import IPParams
from .embed import Embedder, shortlist
from .ip import IPInput, StepResult, place
from .judge import NEW_GROUP, Candidate, Judge, JudgeMeta, NeighbourhoodOut, NeighbourhoodRequest, PlacementOut, PlacementRequest
from .model import Forest, Prompt
from .scores import ScoreMemo, build_input


@dataclass
class StepContext:
    cfg: dict
    emb: Embedder
    judge: Judge
    params: IPParams
    memo: ScoreMemo = field(default_factory=ScoreMemo)
    order_seed: int = 0


@dataclass
class JudgeView:
    shortlist: list[str]
    placement: PlacementOut
    neighbourhood: NeighbourhoodOut | None
    metas: list[JudgeMeta]

    @property
    def live_calls(self) -> int:
        return sum(m.calls for m in self.metas)


def judge_step(forest: Forest, n: Prompt, ctx: StepContext) -> JudgeView:
    cfg = ctx.cfg
    sl = cfg["shortlist"]
    ids = shortlist(ctx.emb, forest, n.text, sl["k"], cfg["embed"]["topic_vector"], sl["include_parents"], sl["enabled"])
    k_ex = cfg["judge"]["examples_per_topic"]
    cands = [Candidate(c, forest.path(c), [forest.prompts[p].text for p in forest.prompts_in(c)[-k_ex:]]) for c in ids]
    req = PlacementRequest(prompt_id=n.id, text=n.text, candidates=cands,
                           groups=[(g, grp.label) for g, grp in forest.groups.items()], forest=forest,
                           order_seed=ctx.order_seed)
    placement, m1 = ctx.judge.placement(req)
    metas = [m1]
    nb = None
    if placement.proposed and forest.prompts:
        nb_req = neighbourhood_request(forest, placement, ctx)
        if nb_req.prompts or nb_req.topics or nb_req.roots:
            nb, m2 = ctx.judge.neighbourhood(nb_req)
            metas.append(m2)
    return JudgeView(ids, placement, nb, metas)


def neighbourhood_request(forest: Forest, placement: PlacementOut, ctx: StepContext) -> NeighbourhoodRequest:
    """Old prompts and topics near the proposed topics: those of each proposed parent topic, its
    children and its siblings, ranked by cosine to the proposed names; all tree roots when a new
    group is proposed."""
    names = [p.name for p in placement.proposed]
    new_groups = sorted({pa.id[len(NEW_GROUP):] for p in placement.proposed for pa in p.parents if pa.id.startswith(NEW_GROUP)})
    near: set[str] = set()
    for p in placement.proposed:
        for pa in p.parents:
            if pa.id in forest.topics:
                par = forest.topics[pa.id]
                sibs = forest.children(par.parent_id) if par.parent_kind == "topic" else forest.roots(par.parent_id)
                near.update([pa.id, *forest.children(pa.id), *sibs])
            elif pa.id in forest.groups:
                near.update(forest.roots(pa.id))
    near.update(e.topic_id for e in placement.existing if e.fit >= 3)
    near &= set(forest.topics)
    prompts = [p for c in near for p in forest.prompts_in(c)]
    if prompts and names:
        pv = ctx.emb.embed([forest.prompts[p].text for p in prompts])
        nv = ctx.emb.embed(names)
        rel = (pv @ nv.T).max(axis=1)
        prompts = [prompts[i] for i in np.argsort(-rel)[: ctx.cfg["judge"]["neighbourhood_max_prompts"]]]
    prompts.sort(key=lambda p: forest.prompts[p].step)
    return NeighbourhoodRequest(
        proposed=names, new_groups=new_groups,
        prompts=[(p, forest.prompts[p].text) for p in prompts],
        topics=[(c, forest.path(c)) for c in sorted(near)],
        roots=[(c, forest.path(c)) for c in sorted(forest.roots())] if new_groups else [],
        forest=forest, order_seed=ctx.order_seed)


def ensure_candidates(forest: Forest, n: Prompt, view: JudgeView) -> None:
    """The very first prompt needs somewhere to go even if the judge proposed nothing usable."""
    if forest.topics or any(p.parents for p in view.placement.proposed):
        return
    from .judge import ParentFit, ProposedTopic
    view.placement.proposed.append(ProposedTopic(name="Unsorted", fit=3, parents=[ParentFit(id=NEW_GROUP + "General", fit=3)]))


def build_step_input(forest: Forest, n: Prompt, view: JudgeView, ctx: StepContext) -> IPInput:
    ensure_candidates(forest, n, view)
    return build_input(forest, n, view.placement, view.neighbourhood, ctx.memo, ctx.emb, ctx.cfg, ctx.params.use_renames)


def ip_step(forest: Forest, n: Prompt, ctx: StepContext, params: IPParams | None = None) -> tuple[StepResult, IPInput, JudgeView]:
    params = params or ctx.params
    view = judge_step(forest, n, ctx)
    inp = build_step_input(forest, n, view, ctx)
    res = place(inp, params)
    for orig, change in res.diff["renamed_topics"].items():
        rid = next(r for r, o in inp.info["renames"].items() if o == orig)
        ctx.memo.apply_rename(rid, orig)
    return res, inp, view


# --- judge_argmax: the judge's highest-scored option, no IP -----------------------------------------

def argmax_decision(forest: Forest, n: Prompt, view: JudgeView, inp: IPInput) -> dict[str, Any]:
    """{'kind': 'old', 'topic': id} or {'kind': 'new', 'topic': cand id, 'parent': id, 'parent_kind': ...}.

    Ties prefer an existing topic over a new one, and among equal fits the higher combined score s."""
    pl = view.placement
    best_old = None
    if pl.existing:
        best_old = max(pl.existing, key=lambda e: (e.fit, inp.s.get((n.id, e.topic_id), 0.0)))
    usable = [p for p in pl.proposed if p.name in inp.info["proposal_ids"] or p.name in inp.info["aliases"]]
    best_new = max(usable, key=lambda p: p.fit) if usable else None
    if best_old and (best_new is None or best_old.fit >= best_new.fit):
        return {"kind": "old", "topic": best_old.topic_id}
    if best_new is None:
        raise ValueError("judge gave no existing topic and no usable proposal")
    if best_new.name in inp.info["aliases"]:
        return {"kind": "old", "topic": inp.info["aliases"][best_new.name]}
    top = max(best_new.parents, key=lambda pa: pa.fit)
    if top.id.startswith(NEW_GROUP):
        parent, kind = inp.info["new_group_ids"][top.id[len(NEW_GROUP):].strip().lower()], "group"
    else:
        parent, kind = top.id, ("topic" if top.id in forest.topics else "group")
    return {"kind": "new", "topic": inp.info["proposal_ids"][best_new.name], "parent": parent, "parent_kind": kind,
            "label": inp.new_topics[inp.info["proposal_ids"][best_new.name]].label}


def ip_decision(res: StepResult, inp: IPInput) -> dict[str, Any]:
    """The IP's placement of n in the same shape as argmax_decision."""
    c = res.solution.q[inp.n.id]
    if c in inp.forest.topics or c in inp.info["renames"]:
        return {"kind": "old", "topic": inp.info["renames"].get(c, c)}
    pid, kind = res.solution.parent[c]
    return {"kind": "new", "topic": c, "parent": inp.info["renames"].get(pid, pid), "parent_kind": kind,
            "label": inp.new_topics[c].label}


def same_decision(a: dict, b: dict) -> bool:
    if a["kind"] != b["kind"]:
        return False
    if a["kind"] == "old":
        return a["topic"] == b["topic"]
    return a["topic"] == b["topic"] and a["parent"] == b["parent"]
