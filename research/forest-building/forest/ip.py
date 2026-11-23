"""The integer program of one placement step (FOREST_NOTEBOOK_PLAN.md §2), solved with Gurobi.

build_model() -> solve() -> decode(). place() runs all three and handles the size limit of the
pip license (switch C2 to its aggregated form, then prune harder). Every constraint is named with
its plan ID, e.g. C9[t03a].
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal

import gurobipy as gp
from gurobipy import GRB

from .config import IPParams
from .model import Forest, Group, Prompt, Topic

Action = Literal["a", "b", "c", "d", "e"]
ACTION_NAMES = {"a": "add", "b": "new branch", "c": "new tree", "d": "new group", "e": "rebalance"}


# --- input -----------------------------------------------------------------------------------------

@dataclass
class NewTopic:
    id: str
    label: str
    rename_of: str | None = None  # set for a rename candidate r: orig(r)


@dataclass
class NewGroup:
    id: str
    label: str


@dataclass
class IPInput:
    """Everything one step's IP needs. Score dicts hold every scored pair; pruning (C18) is here."""
    forest: Forest                    # the old state, without the new prompt
    n: Prompt                         # the new prompt
    new_topics: dict[str, NewTopic]   # C_T_new (rename candidates included)
    new_groups: dict[str, NewGroup]   # C_G_new
    s: dict[tuple[str, str], float]   # (prompt, topic) fit
    h: dict[tuple[str, str], float]   # (parent topic, child topic) fit
    hg: dict[tuple[str, str], float]  # (group, root topic) fit
    w: dict[str, float]               # disruption weight of old prompts
    v: dict[str, float]               # disruption weight of old topics and groups
    info: dict = field(default_factory=dict)


@dataclass
class Handles:
    y: dict
    q: dict
    x: dict
    xg: dict
    d: dict
    m: dict
    k: dict
    z: gp.Var
    o: dict
    u: dict
    b: dict
    renames: dict[str, str]           # r -> orig
    pruned: dict
    c2_mode: str


@dataclass
class Solution:
    status: str
    objective: float
    runtime_s: float
    n_vars: int
    n_constrs: int
    y: dict[str, int]
    q: dict[str, str]                         # prompt -> topic (candidate ids)
    parent: dict[str, tuple[str, str]]        # topic -> (parent id, "topic" | "group") (candidate ids)
    m: list[str]
    k: list[str]
    z: int
    slack: dict[str, dict[str, float]]
    terms: dict[str, float]
    c2_mode: str


@dataclass
class StepResult:
    forest: Forest
    action: Action
    placement: Action          # where n went, ignoring z (a/b/c/d)
    topic_of_n: str            # final topic id of n
    diff: dict
    solution: Solution
    size: dict


class SizeLimitExceeded(RuntimeError):
    pass


class Infeasible(RuntimeError):
    pass


# --- pruning (C18) ---------------------------------------------------------------------------------

def prune(inp: IPInput, params: IPParams, max_alt: int | None = None) -> dict:
    """The surviving q, x, xg pairs. Drops pairs below tau, keeps every old link (so 'change nothing'
    stays feasible) and the links a rename needs, caps alternatives per old prompt and parents per topic."""
    f, tau = inp.forest, params.tau
    max_alt = params.max_alternatives_per_old_prompt if max_alt is None else max_alt
    renames = {r: nt.rename_of for r, nt in inp.new_topics.items() if nt.rename_of} if params.use_renames else {}
    new_topics = [t for t, nt in inp.new_topics.items() if not nt.rename_of or params.use_renames]
    topics = list(f.topics) + new_topics
    topic_set = set(topics)
    groups = list(f.groups) + list(inp.new_groups)
    renames_of: dict[str, list[str]] = {}
    for r, o in renames.items():
        renames_of.setdefault(o, []).append(r)

    # q pairs
    q: dict[str, list[str]] = {}
    for p in [*f.prompts, inp.n.id]:
        scored = sorted(((c, inp.s[(p, c)]) for c in topics if (p, c) in inp.s), key=lambda x: -x[1])
        keep: list[str] = []
        if p in f.assignment:
            c0 = f.assignment[p]
            keep.append(c0)                                   # C18: always keep the old topic
            keep += renames_of.get(c0, [])                    # R3 needs q[p, r]
            alts = [c for c, sc in scored if sc >= tau and c not in keep][:max_alt]
        else:
            alts = [c for c, sc in scored if sc >= tau]
            best_old = next((c for c, _ in scored if c in f.topics), None)
            if best_old and best_old not in alts:
                alts.append(best_old)                         # n can always join an existing topic
            if not alts and scored:
                alts.append(scored[0][0])
        q[p] = list(dict.fromkeys(keep + alts))

    # x pairs (parent topic -> child topic) and xg pairs (group -> root topic)
    x: list[tuple[str, str]] = []
    xg: list[tuple[str, str]] = []
    for c in topics:
        mand_x, mand_g = [], []
        if c in f.topics:
            pid, kind = f.parent_of(c)
            (mand_x if kind == "topic" else mand_g).append(pid)   # C18: keep the old parent link
            if kind == "topic":
                # R4: a child of a renamed topic may stay under the rename
                mand_x += [r for r in renames_of.get(pid, [])]
        if c in renames:
            pid, kind = f.parent_of(renames[c])
            (mand_x if kind == "topic" else mand_g).append(pid)   # R2: the rename keeps the position
        cand_x = sorted(((c1, inp.h[(c1, c)]) for c1 in topics
                         if c1 != c and (c1, c) in inp.h and c1 in topic_set
                         and not (c1 in inp.new_topics and c in inp.new_topics)          # no new -> new
                         and renames.get(c1) != c and renames.get(c) != c1),
                        key=lambda t: -t[1])
        cand_g = sorted(((g, inp.hg[(g, c)]) for g in groups if (g, c) in inp.hg), key=lambda t: -t[1])
        best = sorted([(("x", c1), sc) for c1, sc in cand_x if sc >= tau and c1 not in mand_x]
                      + [(("g", g), sc) for g, sc in cand_g if sc >= tau and g not in mand_g],
                      key=lambda t: -t[1])[: params.max_parents_per_topic]
        for c1 in dict.fromkeys(mand_x + [k[1] for k, _ in best if k[0] == "x"]):
            x.append((c1, c))
        for g in dict.fromkeys(mand_g + [k[1] for k, _ in best if k[0] == "g"]):
            xg.append((g, c))

    # drop new topics that can neither hang anywhere nor hold anything, and groups without trees
    for _ in range(3):
        has_parent = {c for _, c in x} | {c for _, c in xg}
        holds = {c for p, cs in q.items() for c in cs} | {c1 for c1, _ in x}
        dead = {c for c in new_topics if c not in has_parent or c not in holds}
        if not dead:
            break
        new_topics = [c for c in new_topics if c not in dead]
        q = {p: [c for c in cs if c not in dead] for p, cs in q.items()}
        x = [(a, b) for a, b in x if a not in dead and b not in dead]
        xg = [(g, c) for g, c in xg if c not in dead]
        renames = {r: o for r, o in renames.items() if r not in dead}
    live_groups = {g for g, _ in xg}
    groups_new = [g for g in inp.new_groups if g in live_groups]
    return {"q": q, "x": x, "xg": xg, "topics": list(f.topics) + new_topics, "new_topics": new_topics,
            "groups": list(f.groups) + groups_new, "new_groups": groups_new, "renames": renames}


def estimate_size(pr: dict, n_prompts: int, aggregated_c2: bool) -> tuple[int, int]:
    nq = sum(len(v) for v in pr["q"].values())
    nx, nxg = len(pr["x"]), len(pr["xg"])
    nT, nG = len(pr["topics"]), len(pr["groups"])
    n_old = n_prompts - 1
    n_old_cat = nT - len(pr["new_topics"]) + nG - len(pr["new_groups"])
    nvars = nT + nG + nq + nx + nxg + nT + n_old + n_old_cat + 1 + 3 * nT
    c2 = nT if aggregated_c2 else nq
    ncons = (n_prompts + c2 + nT + nx + nxg + nT + nG + nx + nT + 3 * nT + nG + 1
             + n_old + n_old_cat + n_old + n_old_cat + 2 * len(pr["renames"]))
    return nvars, ncons


# --- model -----------------------------------------------------------------------------------------

def build_model(inp: IPInput, params: IPParams, pruned: dict | None = None,
                c2_mode: str = "per_pair", env: gp.Env | None = None) -> tuple[gp.Model, Handles]:
    f = inp.forest
    pr = pruned or prune(inp, params)
    T, G = pr["topics"], pr["groups"]
    T_old, G_old = list(f.topics), list(f.groups)
    T_new, G_new = pr["new_topics"], pr["new_groups"]
    R = pr["renames"]
    P_old = list(f.prompts)
    P = P_old + [inp.n.id]
    D, L, U, B = params.D, params.L, params.U, params.B

    model = gp.Model("forest_step", env=env) if env else gp.Model("forest_step")
    model.Params.OutputFlag = params.output_flag
    model.Params.TimeLimit = params.time_limit_s
    model.Params.MIPGap = params.mip_gap
    model.Params.Seed = 0
    model.Params.Threads = 1

    y = {c: model.addVar(vtype=GRB.BINARY, name=f"y[{c}]") for c in T + G}
    q = {(p, c): model.addVar(vtype=GRB.BINARY, name=f"q[{p},{c}]") for p in P for c in pr["q"][p]}
    x = {(c1, c): model.addVar(vtype=GRB.BINARY, name=f"x[{c1},{c}]") for c1, c in pr["x"]}
    xg = {(g, c): model.addVar(vtype=GRB.BINARY, name=f"xg[{g},{c}]") for g, c in pr["xg"]}
    d = {c: model.addVar(vtype=GRB.INTEGER, lb=0, ub=D - 1, name=f"d[{c}]") for c in T}
    m = {p: model.addVar(vtype=GRB.BINARY, name=f"m[{p}]") for p in P_old}
    k = {c: model.addVar(vtype=GRB.BINARY, name=f"k[{c}]") for c in T_old + G_old}
    z = model.addVar(vtype=GRB.BINARY, name="z")
    o = {c: model.addVar(lb=0, name=f"o[{c}]") for c in T}
    u = {c: model.addVar(lb=0, name=f"u[{c}]") for c in T}
    b = {c: model.addVar(lb=0, name=f"b[{c}]") for c in T}

    q_of = {c: [] for c in T}
    for (p, c), var in q.items():
        q_of[c].append(var)
    kids = {c: [] for c in T}
    parents = {c: [] for c in T}
    for (c1, c), var in x.items():
        kids[c1].append(var)
        parents[c].append(var)
    roots_of = {g: [] for g in G}
    gparents = {c: [] for c in T}
    for (g, c), var in xg.items():
        roots_of[g].append(var)
        gparents[c].append(var)

    # objective (plan §2.4)
    for p in P:
        if not pr["q"][p]:
            raise ValueError(f"prompt {p} has no candidate topic after pruning; scores.py must score at least one")
    # a pair kept only for feasibility (C18) may have no score: it counts as fit 0
    fit = gp.quicksum(inp.s.get(pc, 0.0) * var for pc, var in q.items())
    hier = gp.quicksum(inp.h.get(pc, 0.0) * var for pc, var in x.items())
    hier_g = gp.quicksum(inp.hg.get(pc, 0.0) * var for pc, var in xg.items())
    new_cost = gp.quicksum(y[c] for c in T_new if c not in R)
    new_g_cost = gp.quicksum(y[g] for g in G_new)
    imbalance = gp.quicksum(o[c] + u[c] + b[c] for c in T)
    moved = gp.quicksum(inp.w.get(p, 1.0) * m[p] for p in P_old)
    moved_cat = gp.quicksum(inp.v.get(c, 1.0) * k[c] for c in k)
    rename_cost = gp.quicksum(inp.v.get(R[r], 1.0) * y[r] for r in R)
    model.setObjective(fit + params.alpha * hier + params.alpha_G * hier_g
                       - params.lam * new_cost - params.lam_G * new_g_cost - params.beta * imbalance
                       - params.mu * moved - params.nu * moved_cat - params.rho * rename_cost - params.F * z,
                       GRB.MAXIMIZE)
    terms = {"fit": fit, "hierarchy": hier, "hierarchy_group": hier_g, "new_topics": new_cost,
             "new_groups": new_g_cost, "imbalance": imbalance, "moved_prompts": moved,
             "moved_categories": moved_cat, "renames": rename_cost}

    # C1: every prompt in exactly one topic
    for p in P:
        model.addConstr(gp.quicksum(q[p, c] for c in pr["q"][p]) == 1, name=f"C1[{p}]")
    # C2: prompts only in existing topics
    if c2_mode == "per_pair":
        for (p, c), var in q.items():
            model.addConstr(var <= y[c], name=f"C2[{p},{c}]")
    else:  # aggregated form (plan §2.5 alternative), one row per topic
        for c in T:
            if q_of[c]:
                model.addConstr(gp.quicksum(q_of[c]) <= len(P) * y[c], name=f"C2[{c}]")
    for c in T:
        # C3: an existing topic has exactly one parent (topic or group); a missing one has none
        model.addConstr(gp.quicksum(parents[c]) + gp.quicksum(gparents[c]) == y[c], name=f"C3[{c}]")
        # C5: no empty topics
        model.addConstr(y[c] <= gp.quicksum(q_of[c]) + gp.quicksum(kids[c]), name=f"C5[{c}]")
        # C8: tree roots have depth 0
        if D > 1:
            model.addConstr(d[c] <= (D - 1) * (1 - gp.quicksum(gparents[c])), name=f"C8[{c}]")
        # C9: too full (soft)
        model.addConstr(gp.quicksum(q_of[c]) <= U + o[c], name=f"C9[{c}]")
        # C10: too sparse (soft)
        model.addConstr(gp.quicksum(q_of[c]) + gp.quicksum(kids[c]) >= L * y[c] - u[c], name=f"C10[{c}]")
        # C11: too many subtopics (soft)
        model.addConstr(gp.quicksum(kids[c]) <= B + b[c], name=f"C11[{c}]")
    # C4: parents must exist
    for (c1, c), var in x.items():
        model.addConstr(var <= y[c1], name=f"C4[{c1},{c}]")
        # C7: depth grows along edges (also rules out cycles)
        model.addConstr(d[c] >= d[c1] + 1 - D * (1 - var), name=f"C7[{c1},{c}]")
    for (g, c), var in xg.items():
        model.addConstr(var <= y[g], name=f"C4g[{g},{c}]")
    for g in G:
        # C6: no empty groups
        model.addConstr(y[g] <= gp.quicksum(roots_of[g]), name=f"C6[{g}]")
        # C12: trees per group
        model.addConstr(gp.quicksum(roots_of[g]) <= params.K_T, name=f"C12[{g}]")
    # C13: number of groups
    model.addConstr(gp.quicksum(y[g] for g in G) <= params.K_G, name="C13")

    # stability
    renames_of: dict[str, list[str]] = {}
    for r, orig in R.items():
        renames_of.setdefault(orig, []).append(r)
    for p in P_old:
        c0 = f.assignment[p]
        if c0 in renames_of:
            # R3: staying in a renamed topic is not a move
            model.addConstr(m[p] >= 1 - q[p, c0] - gp.quicksum(q[p, r] for r in renames_of[c0]), name=f"R3[{p}]")
        else:
            # C14: prompt moved
            model.addConstr(m[p] >= 1 - q[p, c0], name=f"C14[{p}]")
        # C17
        model.addConstr(m[p] <= z, name=f"C17m[{p}]")
    for c in T_old:
        pid, kind = f.parent_of(c)
        keep = x[pid, c] if kind == "topic" else xg[pid, c]
        if c in renames_of:
            # R2: a rename that keeps the position is not a move
            alt = gp.quicksum((x[pid, r] if kind == "topic" else xg[pid, r]) for r in renames_of[c])
            model.addConstr(k[c] >= 1 - keep - alt, name=f"R2[{c}]")
        elif kind == "topic" and pid in renames_of:
            # R4: a child of a renamed topic may stay under the rename
            alt = gp.quicksum(x[r, c] for r in renames_of[pid] if (r, c) in x)
            model.addConstr(k[c] >= 1 - keep - alt, name=f"R4[{c}]")
        else:
            # C15: category re-parented or removed
            model.addConstr(k[c] >= 1 - keep, name=f"C15[{c}]")
    for g in G_old:
        # C16: old group removed
        model.addConstr(k[g] >= 1 - y[g], name=f"C16[{g}]")
    for c in k:
        # C17
        model.addConstr(k[c] <= z, name=f"C17k[{c}]")
    for r, orig in R.items():
        # R1: a topic and its rename never both exist
        model.addConstr(y[orig] + y[r] <= 1, name=f"R1[{r}]")
        # R5: a rename is a rebalance
        model.addConstr(y[r] <= z, name=f"R5[{r}]")

    model.update()
    model._terms = terms
    return model, Handles(y, q, x, xg, d, m, k, z, o, u, b, R, pr, c2_mode)


def model_size(model: gp.Model) -> dict:
    return {"vars": model.NumVars, "constrs": model.NumConstrs, "binary": model.NumBinVars,
            "integer": model.NumIntVars - model.NumBinVars, "nonzeros": model.NumNZs}


def solve(model: gp.Model, h: Handles) -> Solution:
    t0 = time.time()
    model.optimize()
    runtime = time.time() - t0
    if model.Status == GRB.INFEASIBLE:
        model.computeIIS()
        ids = sorted({c.ConstrName for c in model.getConstrs() if c.IISConstr})
        raise Infeasible("IP infeasible; irreducible set: " + ", ".join(ids))
    if model.SolCount == 0:
        raise RuntimeError(f"no solution (Gurobi status {model.Status})")
    status = {GRB.OPTIMAL: "optimal", GRB.TIME_LIMIT: "time_limit"}.get(model.Status, str(model.Status))
    on = lambda var: var.X > 0.5  # noqa: E731
    q = {p: c for (p, c), var in h.q.items() if on(var)}
    parent = {c: (c1, "topic") for (c1, c), var in h.x.items() if on(var)}
    parent.update({c: (g, "group") for (g, c), var in h.xg.items() if on(var)})
    slack = {name: {c: var.X for c, var in vs.items() if var.X > 1e-6} for name, vs in (("o", h.o), ("u", h.u), ("b", h.b))}
    return Solution(
        status=status, objective=model.ObjVal, runtime_s=runtime, n_vars=model.NumVars, n_constrs=model.NumConstrs,
        y={c: int(on(var)) for c, var in h.y.items()}, q=q, parent=parent,
        m=sorted(p for p, var in h.m.items() if on(var)), k=sorted(c for c, var in h.k.items() if on(var)),
        z=int(on(h.z)), slack=slack, terms={k_: float(e.getValue()) for k_, e in model._terms.items()},
        c2_mode=h.c2_mode)


# --- decode ----------------------------------------------------------------------------------------

def decode(sol: Solution, inp: IPInput, h: Handles, params: IPParams) -> tuple[Forest, Action, Action, str, dict]:
    """The new forest, the action, where n went (a/b/c/d) and the diff against the old forest."""
    old = inp.forest
    R = h.renames
    final_id = {c: R.get(c, c) for c in sol.y}  # a rename keeps the original topic's id

    new = Forest(step=inp.n.step)
    for g, on in sol.y.items():
        if on and g in old.groups:
            new.groups[g] = Group(g, old.groups[g].label)
        elif on and g in inp.new_groups:
            new.groups[g] = Group(g, inp.new_groups[g].label)
    for c, on in sol.y.items():
        if not on or c in old.groups or c in inp.new_groups:
            continue
        pid, kind = sol.parent[c]
        label = inp.new_topics[c].label if c in inp.new_topics else old.topics[c].label
        cid = final_id[c]
        new.topics[cid] = Topic(cid, label, final_id.get(pid, pid) if kind == "topic" else pid, kind)
    new.prompts = dict(old.prompts)
    new.prompts[inp.n.id] = inp.n
    new.assignment = {p: final_id[c] for p, c in sol.q.items()}
    new.access_log = dict(old.access_log)
    new.access_log[inp.n.id] = inp.n.step
    new.validate(params.D)

    c_star = sol.q[inp.n.id]
    if c_star in old.topics or c_star in R:
        placement: Action = "a"
    else:
        pid, kind = sol.parent[c_star]
        placement = "b" if kind == "topic" else ("c" if pid in old.groups else "d")
    renamed = {R[r]: {"from": old.topics[R[r]].label, "to": inp.new_topics[r].label}
               for r in R if sol.y.get(r)}
    # z = 1 means (e). When F = 0 the solver may also set z = 1 without any change (a tie), so (e)
    # additionally needs a moved prompt, a moved or removed category, or a rename.
    action: Action = "e" if sol.z and (sol.m or sol.k or renamed) else placement
    diff = {
        "moved_prompts": sorted(p for p in old.prompts if new.assignment[p] != old.assignment[p]),
        "moved_topics": sorted(c for c in old.topics if c in new.topics
                               and (new.topics[c].parent_id, new.topics[c].parent_kind) != old.parent_of(c)),
        "deleted_topics": sorted(c for c in old.topics if c not in new.topics),
        "deleted_groups": sorted(g for g in old.groups if g not in new.groups),
        "renamed_topics": renamed,
        "new_topics": sorted(c for c in new.topics if c not in old.topics),
        "new_groups": sorted(g for g in new.groups if g not in old.groups),
        "m_fired": sol.m, "k_fired": sol.k,
    }
    return new, action, placement, final_id[c_star], diff


def place(inp: IPInput, params: IPParams, env: gp.Env | None = None) -> StepResult:
    """Prune, build within the size limit, solve, decode."""
    max_alt = params.max_alternatives_per_old_prompt
    while True:
        pr = prune(inp, params, max_alt)
        n_prompts = len(inp.forest.prompts) + 1
        mode = "per_pair"
        nv, nc = estimate_size(pr, n_prompts, aggregated_c2=False)
        if params.size_limited and (nv >= params.max_vars or nc >= params.max_constrs):
            mode = "aggregated"
            nv, nc = estimate_size(pr, n_prompts, aggregated_c2=True)
        if not params.size_limited or (nv < params.max_vars and nc < params.max_constrs) or max_alt == 0:
            break
        max_alt -= 1
    model, h = build_model(inp, params, pr, mode, env)
    size = model_size(model)
    size.update(c2_mode=mode, max_alternatives=max_alt)
    if params.size_limited and (size["vars"] >= params.max_vars or size["constrs"] >= params.max_constrs):
        raise SizeLimitExceeded(f"model has {size['vars']} variables and {size['constrs']} constraints "
                                f"(limit {params.max_vars}/{params.max_constrs})")
    sol = solve(model, h)
    forest, action, placement, topic_of_n, diff = decode(sol, inp, h, params)
    model.dispose()
    return StepResult(forest, action, placement, topic_of_n, diff, sol, size)
