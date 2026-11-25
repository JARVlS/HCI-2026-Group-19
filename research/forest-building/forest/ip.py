"""The integer program of one step (plan Section 4), solved with Gurobi.

candidates() turns the forest and the judge output into candidate links with scores; solve() builds
the model (constraints named by their ID, e.g. C9[t_backpropagation]), solves it and decodes the new
forest, the action and what was adopted.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, fields, replace

import gurobipy as gp
import yaml
from gurobipy import GRB

from . import ROOT
from .judge import NEW_GROUP, JudgeOutput, Move, rescale
from .model import Forest, Group, Placement, Prompt, Topic

ACTIONS = {"a": "add", "b": "new branch", "c": "new tree", "d": "new group", "e": "restructure"}


def load_config(path=ROOT / "config.yaml") -> dict:
    return yaml.safe_load(open(path, encoding="utf-8"))


@dataclass(frozen=True)
class Params:
    L: int = 2
    U: int = 5
    B: int = 5
    D: int = 3
    K_T: int = 4
    K_G: int = 4
    alpha: float = 0.5
    alpha_G: float = 0.5
    lam: float = 0.4
    lam_G: float = 0.5
    beta: float = 0.3
    mu: float = 0.3
    nu: float = 0.5
    F: float = 0.5
    time_limit_s: float = 10
    size_limited: bool = True

    @classmethod
    def from_config(cls, cfg: dict) -> "Params":
        return cls(**cfg["ip"], **cfg["gurobi"])

    def replace(self, **kw) -> "Params":
        return replace(self, **kw)


# --- candidate links (Section 4.1) ---------------------------------------------------------------

@dataclass
class Candidates:
    new_topics: dict[str, str] = field(default_factory=dict)    # id -> label (adopted proposals become these)
    new_groups: dict[str, str] = field(default_factory=dict)    # id -> label
    proposal_ids: dict[str, str] = field(default_factory=dict)  # proposal name -> topic id (new or existing)
    s: dict[tuple[str, str], float] = field(default_factory=dict)   # (prompt, topic)
    h: dict[tuple[str, str], float] = field(default_factory=dict)   # (parent topic, topic)
    hg: dict[tuple[str, str], float] = field(default_factory=dict)  # (group, topic)
    moves: list[tuple[Move, tuple | None]] = field(default_factory=list)  # move and its link, None if unusable


def candidates(forest: Forest, n: Prompt, out: JudgeOutput, step: int) -> Candidates:
    c = Candidates()
    labels = {t.label.lower(): t.id for t in forest.topics.values()}
    glabels = {g.label.lower(): g.id for g in forest.groups.values()}

    def group_ref(name: str) -> str:
        name = name.strip()
        if name.lower() in glabels:
            return glabels[name.lower()]
        for gid, label in c.new_groups.items():
            if label.lower() == name.lower():
                return gid
        gid = f"g{step:02d}{chr(97 + len(c.new_groups))}"
        c.new_groups[gid] = name
        return gid

    for i, p in enumerate(out.proposed):  # a proposal named like an existing topic is that topic
        c.proposal_ids[p.name.lower()] = labels.get(p.name.lower()) or f"t{step:02d}{chr(97 + i)}"
        if p.name.lower() not in labels:
            c.new_topics[c.proposal_ids[p.name.lower()]] = p.name

    def resolve(ref: str) -> tuple[str, str] | None:
        if ref in forest.topics:
            return "topic", ref
        if ref in forest.groups:
            return "group", ref
        if ref.lower() in c.proposal_ids:
            return "topic", c.proposal_ids[ref.lower()]
        if ref.startswith(NEW_GROUP) and ref[len(NEW_GROUP):].strip():
            return "group", group_ref(ref[len(NEW_GROUP):])
        return None

    def put(d: dict, key: tuple, val: float) -> None:
        d[key] = max(val, d.get(key, -1.0))

    # current links keep their stored fit
    for p, pl in forest.placement.items():
        c.s[(p, pl.topic)] = pl.fit
    for t in forest.topics.values():
        (c.h if t.parent_kind == "topic" else c.hg)[(t.parent, t.id)] = t.fit
    # the new prompt: every existing topic (fit 1 if the judge left it out) and every proposal
    fits = {e.topic_id: e.fit for e in out.existing}
    for t in forest.topics:
        c.s[(n.id, t)] = rescale(fits.get(t, 1))
    for p in out.proposed:
        tid = c.proposal_ids[p.name.lower()]
        put(c.s, (n.id, tid), rescale(p.fit))
        if tid in forest.topics:
            continue
        for pa in p.parents:
            r = resolve(pa.parent)
            if r and r[1] != tid:
                put(c.h if r[0] == "topic" else c.hg, (r[1], tid), rescale(pa.fit))
    # restructure proposals
    for m in out.restructure:
        r = resolve(m.to)
        link = None
        if m.kind == "prompt" and m.id in forest.placement and r and r[0] == "topic" and r[1] != forest.placement[m.id].topic:
            link = ("q", m.id, r[1])
            put(c.s, (m.id, r[1]), rescale(m.fit))
        elif m.kind == "topic" and m.id in forest.topics and r and r[1] != m.id:
            t = forest.topics[m.id]
            if (r[0], r[1]) != (t.parent_kind, t.parent):
                link = ("x" if r[0] == "topic" else "xg", r[1], m.id)
                put(c.h if r[0] == "topic" else c.hg, (r[1], m.id), rescale(m.fit))
        c.moves.append((m, link))
    return c


# --- model, solve, decode ----------------------------------------------------------------------------

@dataclass
class Decision:
    action: str
    topic_of_n: str
    adopted: list[str]                      # proposed topic names that now exist
    rejected: list[str]
    moves: list[tuple[Move, bool | None]]   # True adopted, False rejected, None unusable
    diff: dict
    terms: dict[str, float] = field(default_factory=dict)
    size: dict = field(default_factory=dict)
    solve_s: float = 0.0
    new_ids: dict[str, str] = field(default_factory=dict)  # proposal name or NEW_GROUP:<name> -> id


_env = None


def env() -> gp.Env:
    global _env
    if _env is None:
        _env = gp.Env(empty=True)
        _env.setParam("OutputFlag", 0)
        _env.start()
    return _env


def weights(forest: Forest, t: int) -> tuple[dict[str, float], dict[str, float]]:
    """w[p] = 1 + 2 exp(-(t - created) / 5); v[c] = max w over the subtree (1 if none)."""
    w = {p: 1 + 2 * math.exp(-(t - pl.created) / 5) for p, pl in forest.placement.items()}
    v = {c: max((w[p] for p in forest.subtree_prompts(c)), default=1.0) for c in forest.topics}
    v.update({g: max((w[p] for r in forest.roots(g) for p in forest.subtree_prompts(r)), default=1.0)
              for g in forest.groups})
    return w, v


def solve(forest: Forest, n: Prompt, out: JudgeOutput, step: int, P: Params) -> tuple[Forest, Decision]:
    cand = candidates(forest, n, out, step)
    T_old, G_old = list(forest.topics), list(forest.groups)
    T, G = T_old + list(cand.new_topics), G_old + list(cand.new_groups)
    P_old, prompts = list(forest.placement), list(forest.placement) + [n.id]
    w, v = weights(forest, step)
    D = P.D

    mdl = gp.Model("forest_step", env=env())
    mdl.Params.TimeLimit = P.time_limit_s
    y = {c: mdl.addVar(vtype=GRB.BINARY, name=f"y[{c}]") for c in T + G}
    q = {k: mdl.addVar(vtype=GRB.BINARY, name=f"q[{k[0]},{k[1]}]") for k in cand.s}
    x = {k: mdl.addVar(vtype=GRB.BINARY, name=f"x[{k[0]},{k[1]}]") for k in cand.h}
    xg = {k: mdl.addVar(vtype=GRB.BINARY, name=f"xg[{k[0]},{k[1]}]") for k in cand.hg}
    d = {c: mdl.addVar(vtype=GRB.INTEGER, lb=0, ub=D - 1, name=f"d[{c}]") for c in T}
    m = {p: mdl.addVar(vtype=GRB.BINARY, name=f"m[{p}]") for p in P_old}
    k = {c: mdl.addVar(vtype=GRB.BINARY, name=f"k[{c}]") for c in T_old + G_old}
    z = mdl.addVar(vtype=GRB.BINARY, name="z")
    o = {c: mdl.addVar(lb=0, name=f"o[{c}]") for c in T}
    u = {c: mdl.addVar(lb=0, name=f"u[{c}]") for c in T}
    b = {c: mdl.addVar(lb=0, name=f"b[{c}]") for c in T}

    q_in = {c: [] for c in T}
    q_of = {p: [] for p in prompts}
    for (p, c), var in q.items():
        q_in[c].append(var)
        q_of[p].append(var)
    kids = {c: [] for c in T}
    up = {c: [] for c in T}
    for (c1, c), var in x.items():
        kids[c1].append(var)
        up[c].append(var)
    roots = {g: [] for g in G}
    for (g, c), var in xg.items():
        roots[g].append(var)
        up[c].append(var)

    fit = (gp.quicksum(cand.s[kk] * var for kk, var in q.items())
           + P.alpha * gp.quicksum(cand.h[kk] * var for kk, var in x.items())
           + P.alpha_G * gp.quicksum(cand.hg[kk] * var for kk, var in xg.items()))
    new_cost = P.lam * gp.quicksum(y[c] for c in cand.new_topics) + P.lam_G * gp.quicksum(y[g] for g in cand.new_groups)
    imbalance = P.beta * gp.quicksum(o[c] + u[c] + b[c] for c in T)
    disruption = (P.mu * gp.quicksum(w[p] * m[p] for p in P_old) + P.nu * gp.quicksum(v[c] * k[c] for c in k)
                  + P.F * z)
    mdl.setObjective(fit - new_cost - imbalance - disruption, GRB.MAXIMIZE)

    for p in prompts:                                   # C1: every prompt in exactly one topic
        mdl.addConstr(gp.quicksum(q_of[p]) == 1, name=f"C1[{p}]")
    for (p, c), var in q.items():                       # C2: only in existing topics
        mdl.addConstr(var <= y[c], name=f"C2[{p},{c}]")
    for c in T:
        mdl.addConstr(gp.quicksum(up[c]) == y[c], name=f"C3[{c}]")                       # C3: one parent
        mdl.addConstr(y[c] <= gp.quicksum(q_in[c]) + gp.quicksum(kids[c]), name=f"C5[{c}]")  # C5: not empty
        if D > 1:                                       # C8: tree roots have depth 0
            mdl.addConstr(d[c] <= (D - 1) * (1 - gp.quicksum(xg[gk] for gk in xg if gk[1] == c)), name=f"C8[{c}]")
        mdl.addConstr(gp.quicksum(q_in[c]) <= P.U + o[c], name=f"C9[{c}]")             # C9: too full
        mdl.addConstr(gp.quicksum(q_in[c]) + gp.quicksum(kids[c]) >= P.L * y[c] - u[c], name=f"C10[{c}]")  # C10
        mdl.addConstr(gp.quicksum(kids[c]) <= P.B + b[c], name=f"C11[{c}]")             # C11: too many children
    for (c1, c), var in x.items():
        mdl.addConstr(var <= y[c1], name=f"C4[{c1},{c}]")                               # C4: parent exists
        mdl.addConstr(d[c] >= d[c1] + 1 - D * (1 - var), name=f"C7[{c1},{c}]")         # C7: depth, no cycles
    for (g, c), var in xg.items():
        mdl.addConstr(var <= y[g], name=f"C4[{g},{c}]")
    for g in G:
        mdl.addConstr(y[g] <= gp.quicksum(roots[g]), name=f"C6[{g}]")                   # C6: no empty groups
        mdl.addConstr(gp.quicksum(roots[g]) <= P.K_T, name=f"C12[{g}]")                 # C12: trees per group
    mdl.addConstr(gp.quicksum(y[g] for g in G) <= P.K_G, name="C13")                    # C13: groups
    for p in P_old:
        mdl.addConstr(m[p] >= 1 - q[(p, forest.placement[p].topic)], name=f"C14[{p}]")  # C14: prompt moved
        mdl.addConstr(m[p] <= z, name=f"C17[{p}]")
    for c in T_old:
        t = forest.topics[c]
        cur = x[(t.parent, c)] if t.parent_kind == "topic" else xg[(t.parent, c)]
        mdl.addConstr(k[c] >= 1 - cur, name=f"C15[{c}]")                                # C15: topic moved or gone
    for g in G_old:
        mdl.addConstr(k[g] >= 1 - y[g], name=f"C16[{g}]")                               # C16: group gone
    for c in k:
        mdl.addConstr(k[c] <= z, name=f"C17[{c}]")                                      # C17

    mdl.update()
    size = {"vars": mdl.NumVars, "constrs": mdl.NumConstrs}
    if P.size_limited and (size["vars"] >= 2000 or size["constrs"] >= 2000):
        raise RuntimeError(f"model too large for the pip license: {size}")
    t0 = time.time()
    mdl.optimize()
    solve_s = time.time() - t0
    if mdl.Status == GRB.INFEASIBLE:
        mdl.computeIIS()
        raise RuntimeError("infeasible: " + ", ".join(c.ConstrName for c in mdl.getConstrs() if c.IISConstr))
    on = lambda var: var.X > 0.5  # noqa: E731

    # decode
    new = Forest(step=step)
    for g in G:
        if on(y[g]):
            new.groups[g] = Group(g, forest.groups[g].label if g in forest.groups else cand.new_groups[g])
    for c in T:
        if not on(y[c]):
            continue
        label = forest.topics[c].label if c in forest.topics else cand.new_topics[c]
        par = next(((c1, "topic", cand.h[(c1, cc)]) for (c1, cc), var in x.items() if cc == c and on(var)), None) \
            or next((g, "group", cand.hg[(g, cc)]) for (g, cc), var in xg.items() if cc == c and on(var))
        new.topics[c] = Topic(c, label, par[0], par[1], par[2])
    new.prompts = {**forest.prompts, n.id: n}
    for (p, c), var in q.items():
        if on(var):
            created = forest.placement[p].created if p in forest.placement else step
            new.placement[p] = Placement(c, cand.s[(p, c)], created)
    new.validate(D)

    c_star = new.placement[n.id].topic
    if on(z):
        action = "e"
    elif c_star in forest.topics:
        action = "a"
    else:
        t = new.topics[c_star]
        action = "b" if t.parent_kind == "topic" else ("c" if t.parent in forest.groups else "d")
    moves = []
    for mv, link in cand.moves:
        var = None if link is None else {"q": q, "x": x, "xg": xg}[link[0]][(link[1], link[2])]
        moves.append((mv, None if var is None else on(var)))
    names = {cand.new_topics[i]: i for i in cand.new_topics}
    terms = {"fit": fit.getValue(), "new categories": -new_cost.getValue(), "imbalance": -imbalance.getValue(),
             "disruption": -disruption.getValue(), "total": mdl.ObjVal}
    diff = {
        "moved_prompts": sorted(p for p in forest.placement if new.placement[p].topic != forest.placement[p].topic),
        "moved_topics": sorted(c for c in T_old if c in new.topics
                               and (new.topics[c].parent, new.topics[c].parent_kind) != (forest.topics[c].parent, forest.topics[c].parent_kind)),
        "deleted_topics": sorted(c for c in T_old if c not in new.topics),
        "deleted_groups": sorted(g for g in G_old if g not in new.groups),
    }
    decision = Decision(
        action=action, topic_of_n=c_star,
        adopted=[nm for nm, i in names.items() if i in new.topics],
        rejected=[nm for nm, i in names.items() if i not in new.topics],
        moves=moves, diff=diff, terms=terms, size=size, solve_s=solve_s,
        new_ids={**{p.name: cand.proposal_ids[p.name.lower()] for p in out.proposed},
                 **{NEW_GROUP + lbl: gid for gid, lbl in cand.new_groups.items()}})
    mdl.dispose()
    return new, decision
