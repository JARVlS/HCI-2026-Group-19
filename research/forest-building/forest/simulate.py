"""Run a method over the arrival order, starting from an empty forest (plan Phase 3).

Methods: chronological (no judge, one tree per 5 consecutive prompts), judge_argmax (the judge's
highest-fit option for the new prompt, restructure proposals ignored, no IP), ip (judge + IP).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

import pandas as pd

from . import ROOT
from .ip import Decision, Params, candidates, solve
from .judge import NEW_GROUP, JudgeOutput, LLMJudge
from .metrics import balance, disruption, pair_f1, placed_right
from .model import Forest, Group, Ideal, Placement, Prompt, Topic

FORESTS = ROOT / "outputs" / "forests"


@dataclass
class Step:
    step: int
    prompt: Prompt
    intended: str
    before: Forest
    after: Forest
    judge: JudgeOutput | None
    decision: Decision
    argmax: Decision | None = None     # what judge_argmax would do with the same judge output (ip runs)
    metrics: dict = field(default_factory=dict)

    @property
    def differs(self) -> bool | None:
        """The IP put the new prompt elsewhere than the judge's top option (topic, or new topic's parent)."""
        if self.argmax is None:
            return None
        a, b = self.after, self.argmax_after
        ta, tb = a.placement[self.prompt.id].topic, b.placement[self.prompt.id].topic
        if ta != tb:
            return True
        return ta not in self.before.topics and (a.topics[ta].parent != b.topics[tb].parent)


@dataclass
class Run:
    name: str
    method: str
    judge: str
    steps: list[Step]

    def table(self) -> pd.DataFrame:
        rows = []
        for s in self.steps:
            rows.append({"step": s.step, "prompt": s.prompt.id, "intended": s.intended, "action": s.decision.action,
                         **s.metrics, "differs_from_argmax": s.differs,
                         "vars": s.decision.size.get("vars"), "constrs": s.decision.size.get("constrs"),
                         "solve_s": s.decision.solve_s})
        return pd.DataFrame(rows)

    @property
    def slug(self) -> str:
        """The run name as a folder name: ip_oracle(noise=0.2) -> ip_oracle_noise_0.2."""
        return re.sub(r"[^\w.-]+", "_", self.name).strip("_")

    @property
    def final(self) -> Forest:
        return self.steps[-1].after


def chronological(forest: Forest, n: Prompt, step: int) -> tuple[Forest, Decision]:
    f = forest.copy()
    f.step = step
    k = (step - 1) // 5
    tid = f"t_chat{k + 1}"
    action = "a" if tid in f.topics else ("d" if not f.groups else "c")
    f.groups.setdefault("g_chats", Group("g_chats", "Chat history"))
    f.topics.setdefault(tid, Topic(tid, f"Prompts {5 * k + 1}-{5 * k + 5}", "g_chats", "group", 0.0))
    f.prompts[n.id] = n
    f.placement[n.id] = Placement(tid, 0.0, step)
    return f, Decision(action, tid, [], [], [], {"moved_prompts": [], "moved_topics": [], "deleted_topics": [], "deleted_groups": []})


def judge_argmax(forest: Forest, n: Prompt, out: JudgeOutput, step: int, P: Params) -> tuple[Forest, Decision]:
    """The highest-fit existing topic, or the highest-fit proposal if strictly better, created under
    its highest-fit parent (and that parent first, if it is the other proposal). Restructure ignored."""
    cand = candidates(forest, n, out, step)
    best_old = max(out.existing, key=lambda e: e.fit, default=None)
    best_new = max(out.proposed, key=lambda p: p.fit, default=None)
    f = forest.copy()
    f.step = step
    created: list[str] = []

    def create(name: str, avoid: str | None = None) -> str:
        """Create the proposal `name` under its highest-fit usable parent; return its id."""
        tid = cand.proposal_ids[name.lower()]
        if tid in f.topics:
            return tid
        prop = next(p for p in out.proposed if p.name.lower() == name.lower())
        for pa in sorted(prop.parents, key=lambda pa: -pa.fit):
            ref = pa.parent
            if ref.lower() in cand.proposal_ids and ref.lower() != name.lower() and ref.lower() != (avoid or "").lower():
                parent, kind = create(ref, avoid=name), "topic"
            elif ref in f.topics:
                parent, kind = ref, "topic"
            elif ref in f.groups:
                parent, kind = ref, "group"
            elif ref.startswith(NEW_GROUP):
                gid = next((g for g, lbl in cand.new_groups.items() if lbl.lower() == ref[len(NEW_GROUP):].strip().lower()), None)
                gid = gid or next(g for g, grp in f.groups.items() if grp.label.lower() == ref[len(NEW_GROUP):].strip().lower())
                f.groups.setdefault(gid, Group(gid, cand.new_groups.get(gid, ref[len(NEW_GROUP):].strip())))
                parent, kind = gid, "group"
            else:
                continue
            while kind == "topic" and f.depth(parent) >= P.D - 1:   # keep within the depth limit
                parent, kind = f.topics[parent].parent, f.topics[parent].parent_kind
            f.topics[tid] = Topic(tid, prop.name, parent, kind, (pa.fit - 1) / 4)
            created.append(prop.name)
            return tid
        raise ValueError(f"proposal {name!r} has no usable parent")

    if best_new is not None and (best_old is None or best_new.fit > best_old.fit):
        target, fit = create(best_new.name), best_new.fit
    else:
        target, fit = best_old.topic_id, best_old.fit
    f.prompts[n.id] = n
    f.placement[n.id] = Placement(target, (fit - 1) / 4, step)
    if target in forest.topics:
        action = "a"
    else:
        t = f.topics[target]
        action = "b" if t.parent_kind == "topic" else ("c" if t.parent in forest.groups else "d")
    rejected = [p.name for p in out.proposed if p.name not in created]
    return f, Decision(action, target, created, rejected, [(m, False) for m in out.restructure],
                       {"moved_prompts": [], "moved_topics": [], "deleted_topics": [], "deleted_groups": []},
                       new_ids={**{p.name: cand.proposal_ids[p.name.lower()] for p in out.proposed},
                                **{NEW_GROUP + lbl: gid for gid, lbl in cand.new_groups.items()}})


def run(method: str, ideal: Ideal, judge=None, P: Params | None = None, name: str | None = None,
        save: bool = True) -> Run:
    """Place the prompts in arrival order; validate after every step; save a snapshot per step."""
    P = P or Params()
    name = name or (method if judge is None else f"{method}_{judge.name}")
    if isinstance(judge, LLMJudge) and not judge.cached_only:
        print(f"{judge.name}: at most {len(ideal.arrival)} LLM calls (cached answers are free); "
              f"limit {judge.cfg['max_calls']}")
        if len(ideal.arrival) > judge.cfg["max_calls"]:
            raise RuntimeError("more possible LLM calls than llm.max_calls")
    forest, steps = Forest(), []
    for i, pid in enumerate(ideal.arrival, 1):
        n = ideal.forest.prompts[pid]
        out, argmax_dec, argmax_after = None, None, None
        if method == "chronological":
            after, dec = chronological(forest, n, i)
        else:
            out = judge(forest, n, i)
            if method == "judge_argmax":
                after, dec = judge_argmax(forest, n, out, i, P)
            elif method == "ip":
                after, dec = solve(forest, n, out, i, P)
                argmax_after, argmax_dec = judge_argmax(forest, n, out, i, P)
            else:
                raise ValueError(method)
        after.validate(P.D)
        s = Step(i, n, ideal.intended.get(pid, ("", ""))[0], forest, after, out, dec, argmax_dec)
        s.argmax_after = argmax_after
        s.metrics = {"f1_topic": pair_f1(after, ideal, "topic"), "f1_tree": pair_f1(after, ideal, "tree"),
                     "placed_right": placed_right(after, ideal, n.id),
                     **disruption(forest, after, i), **balance(after, P)}
        steps.append(s)
        if save:
            after.save(FORESTS / re.sub(r"[^\w.-]+", "_", name).strip("_") / f"step_{i:02d}.json")
        forest = after
    r = Run(name, method, getattr(judge, "name", "none"), steps)
    if save:
        (FORESTS / r.slug / "sequence.json").write_text(
            json.dumps({"run": name, "method": method, "judge": r.judge,
                        "steps": [{"step": s.step, "prompt": s.prompt.id, "action": s.decision.action,
                                   "forest": s.after.to_json()} for s in steps]}, ensure_ascii=False) + "\n",
            encoding="utf-8")
    return r


def summary(runs: list[Run]) -> pd.DataFrame:
    rows = []
    for r in runs:
        t = r.table()
        rows.append({"run": r.name, "method": r.method, "judge": r.judge,
                     "final f1 topic": t["f1_topic"].iloc[-1], "final f1 tree": t["f1_tree"].iloc[-1],
                     "placed right": t["placed_right"].mean(),
                     "moved prompts (w)": t["moved_prompts_w"].sum(), "moved topics": t["moved_topics"].sum(),
                     "deleted": t["deleted"].sum(), "restructures": int((t["action"] == "e").sum()),
                     "over U (final)": t["over_U"].iloc[-1], "under L (final)": t["under_L"].iloc[-1],
                     "differs from argmax": t["differs_from_argmax"].dropna().astype(float).mean() if r.method == "ip" else None,
                     "max vars": t["vars"].max(), "max constrs": t["constrs"].max(),
                     "actions": " ".join(f"{a}:{n}" for a, n in sorted(t["action"].value_counts().items()))})
    return pd.DataFrame(rows)
