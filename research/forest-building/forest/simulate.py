"""Run a placement method over a whole session (plan Phase 5).

run() starts from an empty forest, applies each step's access events (a re-opened prompt counts as
recently used for the disruption weight w), places the prompt, validates the forest, optionally
saves a snapshot to outputs/forests/<session>/<method>/step_XX.json and records the metrics.
"""
from __future__ import annotations

import time
from pathlib import Path

import pandas as pd

from .baselines import METHODS
from .cache import BudgetExceeded
from .config import IPParams
from .embed import Embedder
from .io import Session, save_forest, write_jsonl
from .judge import Judge
from .metrics import Scorer, step_metrics, summarize
from .model import Forest
from .pipeline import StepContext, argmax_decision, ip_decision, ip_step, same_decision
from .scores import ScoreMemo

IP_METHODS = ("ip", "ip_full_recluster")
ALL_METHODS = ("chronological", "greedy", "judge_argmax", "judge_restructure", "ip_full_recluster", "ip")


TIE_BREAK = 1e-4


def full_recluster(params: IPParams) -> IPParams:
    """The IP without stability costs: mu = nu = F = rho = 0 up to a tie-breaking 1e-4, so that a
    prompt is not moved between two topics it fits equally well for no gain."""
    return params.replace(mu=TIE_BREAK, nu=TIE_BREAK, F=0.0, rho=TIE_BREAK)


def make_context(cfg: dict, params: IPParams | None = None, emb: Embedder | None = None,
                 judge: Judge | None = None) -> StepContext:
    emb = emb or Embedder(cfg)
    return StepContext(cfg=cfg, emb=emb, judge=judge or Judge(cfg, emb),
                       params=params or IPParams.from_config(cfg), order_seed=cfg["seed"])


def cost_guard(ctx: StepContext, n_steps: int, n_runs: int = 1) -> int:
    est = ctx.judge.estimate_calls(n_steps) * n_runs
    limit = ctx.cfg["judge"]["max_calls_per_run"]
    if ctx.judge.live:
        print(f"cost guard: at most {est} live judge calls ({ctx.judge.backend}/{ctx.judge.model}); "
              f"cached answers are free; limit {limit}" + ("" if ctx.judge.paid else " (local model: no cost, not enforced)"))
        if ctx.judge.paid and est > limit:
            raise BudgetExceeded(f"estimated {est} live calls exceed judge.max_calls_per_run = {limit}")
    return est


def run(method: str, session: Session, ctx: StepContext, params: IPParams | None = None, gold: dict | None = None,
        save_dir: Path | None = None, scorer: Scorer | None = None, guard: bool = True,
        upto: int | None = None) -> tuple[pd.DataFrame, list[Forest]]:
    """Returns the per-step table and the forest after every step."""
    params = params or ctx.params
    if method == "ip_full_recluster":
        params = full_recluster(params)
    if guard:
        cost_guard(ctx, len(session.prompts))
    ctx = StepContext(ctx.cfg, ctx.emb, ctx.judge, params, ScoreMemo(), ctx.order_seed)  # fresh memo per run
    scorer = scorer or Scorer(ctx.emb, ctx.cfg)
    forest = Forest()
    rows, forests, log = [], [], []
    for p in session.prompts[:upto]:
        if session.accesses_at(p.step):
            forest = forest.copy()  # never mutate the previous step's snapshot
            for opened in session.accesses_at(p.step):
                forest.access_log[opened] = p.step
        prev = forest
        t0 = time.time()
        rec: dict = {"session": session.id, "method": method, "step": p.step, "prompt": p.id}
        if method in IP_METHODS:
            res, inp, view = ip_step(forest, p, ctx, params)
            forest = res.forest
            am = argmax_decision(prev, p, view, inp)
            rec.update(action=res.action, placement=res.placement, topic_of_n=res.topic_of_n,
                       solve_s=res.solution.runtime_s, vars=res.size["vars"], constrs=res.size["constrs"],
                       c2_mode=res.size["c2_mode"], status=res.solution.status, objective=res.solution.objective,
                       live_calls=view.live_calls, same_as_argmax=same_decision(am, ip_decision(res, inp)),
                       new_candidates=len(inp.new_topics), cosine_only_s=inp.info["cosine_only_s"],
                       s_pairs=inp.info["s_pairs"])
            log.append({"step": p.step, "prompt": p.id, "action": res.action, "topic": res.topic_of_n,
                        "diff": res.diff, "terms": res.solution.terms})
        else:
            forest, info = METHODS[method](forest, p, ctx, {})
            rec.update(action=info["action"], placement=info["action"] if info["action"] != "e" else "a",
                       topic_of_n=forest.assignment[p.id], solve_s=0.0, live_calls=info.get("live_calls", 0))
            log.append({"step": p.step, "prompt": p.id, "action": info["action"], "topic": forest.assignment[p.id]})
        forest.validate(params.D)
        rec["step_s"] = time.time() - t0
        rec["path_of_n"] = forest.path(forest.assignment[p.id])
        rec.update(step_metrics(prev, forest, p.step, scorer, params, ctx.cfg, gold))
        rows.append(rec)
        forests.append(forest)
        if save_dir is not None:
            save_forest(forest, Path(save_dir) / f"step_{p.step:02d}.json")
    if save_dir is not None:
        write_jsonl(Path(save_dir) / "decisions.jsonl", log)
    return pd.DataFrame(rows), forests


def trace_ip(session: Session, ctx: StepContext, params: IPParams | None = None, upto: int | None = None) -> list[dict]:
    """Replay the IP and keep every step's input: [{'before', 'prompt', 'result', 'input', 'view'}].
    An input can be re-solved with other parameters (ip.place(input, params)) for a what-if on one step."""
    params = params or ctx.params
    ctx = StepContext(ctx.cfg, ctx.emb, ctx.judge, params, ScoreMemo(), ctx.order_seed)
    forest, out = Forest(), []
    for p in session.prompts[:upto]:
        if session.accesses_at(p.step):
            forest = forest.copy()  # never mutate the previous step's snapshot
            for opened in session.accesses_at(p.step):
                forest.access_log[opened] = p.step
        res, inp, view = ip_step(forest, p, ctx, params)
        out.append({"before": forest, "prompt": p, "result": res, "input": inp, "view": view})
        forest = res.forest
    return out


def compare(methods: list[str], session: Session, ctx: StepContext, gold: dict | None = None,
            save_root: Path | None = None, params: IPParams | None = None) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """Run several methods on one session. Returns (steps, summary, forests by method)."""
    cost_guard(ctx, len(session.prompts), n_runs=sum(m != "chronological" for m in methods))
    scorer = Scorer(ctx.emb, ctx.cfg)
    steps, summ, forests = [], [], {}
    for m in methods:
        save = Path(save_root) / session.id / m if save_root else None
        df, fs = run(m, session, ctx, params, gold, save, scorer, guard=False)
        steps.append(df)
        forests[m] = fs
        summ.append({"session": session.id, "method": m, **summarize(df)})
    return pd.concat(steps, ignore_index=True), pd.DataFrame(summ), forests
