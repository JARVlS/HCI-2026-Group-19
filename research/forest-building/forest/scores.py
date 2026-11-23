"""Assemble the IP's scores s, h, hg and candidate sets from the judge's output (plan Phase 4).

- Judge fits are rescaled (fit - 1) / 4 to [0, 1].
- s[p, c] = gamma * judge + (1 - gamma) * calibrated cosine; pairs the judge never rated use the
  calibrated cosine alone and are counted in info["cosine_only"].
- h and hg are the judge's parent fits; unrated pairs between OLD categories fall back to the
  calibrated cosine of their topic vectors (flagged). A new topic only gets the parents the judge
  rated, and a new parent only gets the children the judge rated.
- Judge scores persist across steps in a ScoreMemo, so an old prompt keeps the fits it got when it
  was placed (and from neighbourhood calls).
Pruning with tau happens in ip.prune (C18).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .embed import Embedder, cal_bounds, calibrate
from .ip import IPInput, NewGroup, NewTopic
from .judge import NEW_GROUP, NeighbourhoodOut, PlacementOut
from .model import Forest, Prompt


def rescale(fit: int) -> float:
    return (fit - 1) / 4


@dataclass
class ScoreMemo:
    """Judge scores of one run, keyed by prompt / topic / group ids (candidate ids for new ones)."""
    s: dict[tuple[str, str], float] = field(default_factory=dict)
    h: dict[tuple[str, str], float] = field(default_factory=dict)
    hg: dict[tuple[str, str], float] = field(default_factory=dict)

    def apply_rename(self, r: str, orig: str) -> None:
        """After a rename r of orig, orig's scores are the rename's."""
        for d in (self.s, self.h, self.hg):
            for (a, b), val in list(d.items()):
                if b == r:
                    d[(a, orig)] = val
                if a == r:
                    d[(orig, b)] = val


def disruption_weights(forest: Forest, now: int, a: float, T: float) -> tuple[dict[str, float], dict[str, float]]:
    """w[p] = 1 + a * exp(-(now - last access) / T); v[c] = max w over the subtree (plan §5.4)."""
    w = {p: 1 + a * math.exp(-(now - forest.access_log.get(p, forest.prompts[p].step)) / T) for p in forest.prompts}
    v: dict[str, float] = {}
    for c in forest.topics:
        v[c] = max((w[p] for p in forest.subtree_prompts(c)), default=1.0)
    for g in forest.groups:
        v[g] = max((w[p] for p in forest.group_prompts(g)), default=1.0)
    return w, v


class Vectors:
    """Embeddings and cosines for one step."""

    def __init__(self, emb: Embedder, forest: Forest, extra: list[Prompt], lo: float, hi: float, option: str):
        self.emb, self.f, self.lo, self.hi, self.option = emb, forest, lo, hi, option
        self.prompt_text = {p: forest.prompts[p].text for p in forest.prompts}
        self.prompt_text.update({p.id: p.text for p in extra})
        ids = list(self.prompt_text)
        X = emb.embed([self.prompt_text[p] for p in ids]) if ids else np.zeros((0, 1))
        self.pv = {p: X[i] for i, p in enumerate(ids)}
        self._sum: dict[str, np.ndarray] = {}
        self._cnt: dict[str, int] = {}
        for c in forest.topics:
            members = forest.prompts_in(c)
            self._cnt[c] = len(members)
            if members:
                self._sum[c] = np.sum([self.pv[p] for p in members], axis=0)

    def cal(self, cos: float) -> float:
        return float(calibrate(cos, self.lo, self.hi))

    @staticmethod
    def _unit(v: np.ndarray) -> np.ndarray:
        n = np.linalg.norm(v)
        return v / n if n else v

    def prompt_topic(self, p: str, c: str, label: str | None = None, members_of: str | None = None) -> float:
        """Cosine of prompt p to topic c (or to a candidate with `label` whose members are those of
        `members_of`, for renames). Leave-one-out centroid for p's own topic."""
        base = members_of or c
        lab = label if label is not None else self.f.topics[c].label
        v = self.pv[p]
        c_label = float(v @ self.emb.one(lab))
        if self.option == "label" or base not in self._sum:
            return c_label
        s, n = self._sum[base], self._cnt[base]
        if self.f.assignment.get(p) == base:
            s, n = s - v, n - 1
        if n == 0:
            return c_label
        c_cen = float(v @ self._unit(s))
        return c_cen if self.option == "centroid" else 0.5 * (c_cen + c_label)

    def topic_vec(self, c: str) -> np.ndarray:
        """Label plus subtree centroid, normalised (for topic-topic and group-topic cosines)."""
        lab = self.emb.one(self.f.topics[c].label)
        members = self.f.subtree_prompts(c)
        if not members:
            return lab
        cen = self._unit(np.sum([self.pv[p] for p in members], axis=0))
        return self._unit(lab + cen)

    def group_vec(self, g: str) -> np.ndarray:
        lab = self.emb.one(self.f.groups[g].label)
        members = self.f.group_prompts(g)
        if not members:
            return lab
        return self._unit(lab + self._unit(np.sum([self.pv[p] for p in members], axis=0)))


def build_input(forest: Forest, n: Prompt, placement: PlacementOut, neighbourhood: NeighbourhoodOut | None,
                memo: ScoreMemo, emb: Embedder, cfg: dict, use_renames: bool = True) -> IPInput:
    """The IP input for placing n into forest, given this step's judge answers. Updates memo."""
    sc = cfg["scores"]
    gamma, dedup = sc["gamma"], sc["dedup_threshold"]
    lo, hi = cal_bounds(cfg, emb.name)
    vec = Vectors(emb, forest, [n], lo, hi, cfg["embed"]["topic_vector"])
    tag = f"{n.step:02d}"
    cos = lambda a, b: float(emb.one(a) @ emb.one(b))  # noqa: E731

    # --- candidate groups (NEW_GROUP:<name>) ----------------------------------------------------
    group_of_name: dict[str, str] = {}
    new_groups: dict[str, NewGroup] = {}

    def group_id(name: str) -> str:
        key = name.strip().lower()
        if key in group_of_name:
            return group_of_name[key]
        for g, grp in forest.groups.items():
            if grp.label.lower() == key or cos(grp.label, name) >= dedup:
                group_of_name[key] = g
                return g
        for gid, ng in new_groups.items():
            if cos(ng.label, name) >= dedup:
                group_of_name[key] = gid
                return gid
        gid = f"g{tag}{chr(97 + len(new_groups))}"
        new_groups[gid] = NewGroup(gid, name.strip())
        group_of_name[key] = gid
        return gid

    # --- candidate topics ------------------------------------------------------------------------
    existing_fit = {e.topic_id: rescale(e.fit) for e in placement.existing}
    new_topics: dict[str, NewTopic] = {}
    proposal_ids: dict[str, str] = {}
    aliases: dict[str, str] = {}
    for prop in placement.proposed:
        alias = next((c for c, t in forest.topics.items() if t.label.lower() == prop.name.lower()
                      or cos(t.label, prop.name) >= dedup), None)
        if alias:  # the proposal is an existing topic under another name: count it as that topic
            aliases[prop.name] = alias
            existing_fit[alias] = max(existing_fit.get(alias, 0.0), rescale(prop.fit))
            continue
        dup = next((tid for tid, nt in new_topics.items() if cos(nt.label, prop.name) >= dedup), None)
        tid = dup or f"t{tag}{chr(97 + len(new_topics))}"
        if not dup:
            new_topics[tid] = NewTopic(tid, prop.name)
        proposal_ids[prop.name] = tid
        memo.s[(n.id, tid)] = max(memo.s.get((n.id, tid), 0.0), rescale(prop.fit))
        for pa in prop.parents:
            if pa.id.startswith(NEW_GROUP):
                memo.hg[(group_id(pa.id[len(NEW_GROUP):]), tid)] = rescale(pa.fit)
            elif pa.id in forest.groups:
                memo.hg[(pa.id, tid)] = rescale(pa.fit)
            elif pa.id in forest.topics:
                memo.h[(pa.id, tid)] = rescale(pa.fit)
    for c, val in existing_fit.items():
        memo.s[(n.id, c)] = val

    renames: dict[str, str] = {}
    if use_renames:
        best: dict[str, tuple[int, str]] = {}
        for r in placement.renames:
            if r.topic_id in forest.topics and r.new_name.lower() != forest.topics[r.topic_id].label.lower():
                if r.topic_id not in best or r.fit > best[r.topic_id][0]:
                    best[r.topic_id] = (r.fit, r.new_name)
        for i, (orig, (fit, name)) in enumerate(sorted(best.items())):
            rid = f"r{tag}{chr(97 + i)}"
            new_topics[rid] = NewTopic(rid, name, rename_of=orig)
            renames[rid] = orig
            for p in [*forest.prompts_in(orig), n.id]:
                memo.s[(p, rid)] = rescale(fit)
            pid, kind = forest.parent_of(orig)
            if kind == "topic" and (pid, orig) in memo.h:
                memo.h[(pid, rid)] = memo.h[(pid, orig)]
            if kind == "group" and (pid, orig) in memo.hg:
                memo.hg[(pid, rid)] = memo.hg[(pid, orig)]
            for c2 in forest.children(orig):
                if (orig, c2) in memo.h:
                    memo.h[(rid, c2)] = memo.h[(orig, c2)]

    if neighbourhood is not None:
        for pf in neighbourhood.prompts:
            tid = proposal_ids.get(pf.proposed)
            if tid and pf.prompt_id in forest.prompts:
                memo.s[(pf.prompt_id, tid)] = rescale(pf.fit)
        for cf in neighbourhood.children:
            tid = proposal_ids.get(cf.proposed)
            if tid and cf.topic_id in forest.topics:
                memo.h[(tid, cf.topic_id)] = rescale(cf.fit)
        for rf in neighbourhood.roots:
            gid = group_of_name.get(rf.group.strip().lower())
            if gid in new_groups and rf.topic_id in forest.topics:
                memo.hg[(gid, rf.topic_id)] = rescale(rf.fit)

    # --- s ---------------------------------------------------------------------------------------
    P = [*forest.prompts, n.id]
    s: dict[tuple[str, str], float] = {}
    cosine_only = 0
    for p in P:
        for c in [*forest.topics, *new_topics]:
            nt = new_topics.get(c)
            if nt and nt.rename_of:
                cs = vec.prompt_topic(p, c, label=nt.label, members_of=nt.rename_of)
            elif nt:
                cs = float(vec.pv[p] @ emb.one(nt.label))
            else:
                cs = vec.prompt_topic(p, c)
            cal = vec.cal(cs)
            if (p, c) in memo.s:
                s[(p, c)] = gamma * memo.s[(p, c)] + (1 - gamma) * cal
            else:
                s[(p, c)] = cal
                cosine_only += 1

    # --- h, hg -------------------------------------------------------------------------------------
    h: dict[tuple[str, str], float] = {}
    hg: dict[tuple[str, str], float] = {}
    tv = {c: vec.topic_vec(c) for c in forest.topics}
    gv = {g: vec.group_vec(g) for g in forest.groups}
    h_cos = hg_cos = 0
    for c in forest.topics:
        for c1 in forest.topics:
            if c1 == c:
                continue
            if (c1, c) in memo.h:
                h[(c1, c)] = memo.h[(c1, c)]
            else:
                h[(c1, c)] = vec.cal(float(tv[c1] @ tv[c]))
                h_cos += 1
        for g in forest.groups:
            if (g, c) in memo.hg:
                hg[(g, c)] = memo.hg[(g, c)]
            else:
                hg[(g, c)] = vec.cal(float(gv[g] @ tv[c]))
                hg_cos += 1
    for c, nt in new_topics.items():
        # new topics: only judged links (as parent or child), plus what a rename inherited
        for (a, b), val in memo.h.items():
            if b == c and a in forest.topics:
                h[(a, c)] = val
            if a == c and b in forest.topics:
                h[(c, b)] = val
        for (g, b), val in memo.hg.items():
            if b == c and (g in forest.groups or g in new_groups):
                hg[(g, c)] = val
        if nt.rename_of:  # a rename keeps the old position and children even if never judged
            orig = nt.rename_of
            pid, kind = forest.parent_of(orig)
            if kind == "topic":
                h.setdefault((pid, c), h.get((pid, orig), 0.0))
            else:
                hg.setdefault((pid, c), hg.get((pid, orig), 0.0))
            for c2 in forest.children(orig):
                h.setdefault((c, c2), h.get((orig, c2), 0.0))
    for (g, b), val in memo.hg.items():
        if g in new_groups and b in forest.topics:
            hg[(g, b)] = val

    w, v = disruption_weights(forest, n.step, cfg["disruption"]["a"], cfg["disruption"]["T"])
    info = {"cosine_only_s": cosine_only, "s_pairs": len(s), "cosine_only_h": h_cos, "cosine_only_hg": hg_cos,
            "proposal_ids": proposal_ids, "aliases": aliases, "new_group_ids": dict(group_of_name),
            "renames": renames}
    return IPInput(forest=forest, n=n, new_topics=new_topics, new_groups=new_groups,
                   s=s, h=h, hg=hg, w=w, v=v, info=info)
