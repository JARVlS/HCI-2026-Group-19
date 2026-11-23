# Forest building (research, Milestone 3)

An integer program, solved with Gurobi, decides where a new prompt goes in a student's knowledge
forest: add it to a topic, open a branch, a tree or a group, or rebalance. This folder is the
implementation of `FOREST_NOTEBOOK_PLAN.md` (the plan written for this work). The formulation is
the plan's §2, with constraints C1 to C18 and the rename extension R1 to R5, in
[`forest/ip.py`](forest/ip.py).

```
new prompt -> [1. judge (scores + candidate names), on the whole forest]
           -> [2. scores: judge mixed with embedding cosine] -> [3. integer program (Gurobi)]
           -> [4. new forest + action]
```

## Status (23 Nov 2026)

| Phase | State |
|---|---|
| 0 Setup | done. Pinned requirements, `config/default.yaml`, a disk cache with a committed snapshot, a cost guard and ledger |
| 1 Data | done, **drafts**. Three sessions (30, 30, 25 prompts) and gold labels written by Claude Opus 5.5; empty templates for the group |
| 2 Embeddings | done. **No shortlist** (removed 24 Nov): the judge rates every topic. MiniLM + `mix` finds the gold topic first for 82.5 % of prompts (draft labels). The API embedding model is open (no key) |
| 3 Judge | templates, Pydantic outputs, Claude backends and a validation sample done. **Only the offline stand-in has run**; the live model comparison is open |
| 4 IP | done. 17 unit tests, one per outcome. Every step solves in under 15 ms with at most 375 variables and 534 constraints |
| 5 Simulation | done. Six methods on three sessions, all forests valid, metrics, figures, export in the app's data model |
| 6 What-if | done. `mu` x `F` sweep with Pareto frontier, single-step flip, `U` x `K_T`, `gamma`, `lam_G` |
| 7 Submission | done. `ui_optimization.ipynb` runs in a fresh environment from `data/frozen/` with no API call (checked 23 Nov) |

**Every judge-dependent number so far comes from the offline stand-in judge**
(`offline-heuristic-v1`: calibrated cosines and key phrases, not an LLM), and every gold-based
number from draft labels. Do not quote them in the report until the live judge has run and the
group has reviewed the labels.

## Run

```bash
cd research/forest-building
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q                               # 46 tests (IP, model, pipeline)
.venv/bin/python scripts/build_notebooks.py                 # build + execute notebooks/01..06 and ui_optimization
.venv/bin/python -m forest.cache freeze                     # snapshot data/cache -> data/frozen (committed)
.venv/bin/python scripts/package_submission.py <dir>        # hand-in folder: notebook, forest/, config/, data/, requirements.txt
```

Notebook sources are `notebooks/src/*.py` in jupytext percent format (`# %%` cells), so they diff
cleanly. `scripts/build_notebooks.py` turns them into `.ipynb` and executes them. Edit the
sources, not the `.ipynb` files.

## The live judge

`judge.backend` in the config is `offline`, so nothing calls a paid model. To run a real judge:

1. Agree in the group on the provider and the budget (plan §6, §7.1). The candidates are in
   `judge.compare` (`claude-opus-5-5`, `claude-haiku-5-5`); `proxy` reaches the Bedrock stand-in
   that `research/thinking-filter` uses.
2. Put `ANTHROPIC_API_KEY` (or `PROXY_URL`) in `.env` (template `.env.example`), or run `ant auth login`.
3. `notebooks/src/03_judge.py`: set `RUN_LIVE = True` and rebuild. About 255 calls per model; the
   guard refuses a run above `judge.max_calls_per_run` (300) and the ledger stops at
   `judge.total_max_calls` (1500), counting every attempt in `data/cache/ledger.jsonl`.
4. Set `judge.backend` and `judge.model` to the chosen model, rebuild 04 to 06 and
   `ui_optimization`, then `freeze` so the submission runs from the cached answers. Cite the exact
   model id in the report.

The Claude backend uses structured JSON output (`output_config.format`), effort `low`, one retry on
a parse failure, and server-side refusal fallback (`fallbacks: "default"`). Current Claude models
reject `temperature`, so the plan's "temperature 0" cannot be set; consistency is measured instead.

## Layout

| Path | What |
|---|---|
| `forest/model.py` | `Forest` (groups, topics, prompts, assignment, access log), `validate()`, JSON |
| `forest/io.py` | sessions, gold labels, gold-forest replay, snapshots |
| `forest/embed.py` | cached embeddings (MiniLM, bge-small, TF-IDF), calibration, key phrases |
| `forest/judge.py` | templates (`TEMPLATE_VERSION`), Pydantic outputs, offline stand-in, Claude backends |
| `forest/scores.py` | `s`, `h`, `hg` from judge and cosine; score memo across steps; `w`, `v` |
| `forest/ip.py` | prune (C18), build, solve, decode; size-limit handling |
| `forest/pipeline.py` | one step: judge (whole forest), scores, IP; the judge-argmax decision for comparison |
| `forest/baselines.py` | `chronological`, `greedy`, `judge_argmax`, `judge_restructure` |
| `forest/simulate.py` | a method over a session (`run`, `compare`, `trace_ip`) |
| `forest/metrics.py`, `forest/evaluate.py` | per-step metrics; nearest-topic accuracy, judge agreement, kappa |
| `forest/viz.py`, `forest/export.py` | figures; app-format export |
| `data/sessions/`, `data/gold/` | drafted sessions, draft gold labels, templates for raters, judge validation sample |
| `data/frozen/` | committed cache snapshot (embeddings; judge answers once a live judge ran) |
| `outputs/metrics/`, `outputs/figures/` | tables and figures named by notebook |
| `outputs/forests/<session>/<method>/` | `decisions.jsonl`, `app_final.json`; for `ip` also every step and `app_sequence.json` |
| `outputs/export/planner-params.json` | the parameters the prototype's planner would use |

## Export for the prototype

`app_sequence.json` holds the forest after every step in the frontend's data model
(`IMPLEMENTATION_PLAN.md` ADR-2):
- groups become `Concept` with kind `subject`;
- tree roots become kind `topic`, deeper topics kind `concept`;
- each root gets a `KnowledgeTree` with id `t:<root>`, as `applyPlan` derives it;
- each prompt becomes one `ConceptAttempt` and one message.

Each step also carries its decision (action and diff). Ids stay stable across steps (a rename
keeps the id), so the app can animate moves. The attempt fields the forest does not know (mode,
independence) are placeholders. `planner-params.json` is meant for
`frontend/src/study/planner-params.json`, which is a frontend PR of its own.

## Deviations from the plan, and why

1. **Folder.** `optimization/` became `research/forest-building/`, next to `research/thinking-filter/`.
2. **No shortlist** (decided 24 Nov). The judge rates every topic of the forest: at most 12 in the
   gold forests and at most 26 in the method runs, which fits one prompt easily. Phase 2 now only
   picks the embedding model, by how often its cosine ranks the gold topic first.
3. **Judge.** The offline stand-in is the default; the live backends are wired but have not been
   called (no key was available, and plan §6 asks the group to choose the provider first).
4. **Hierarchy call merged.** Parent fits of proposed topics come with the placement call, as the
   plan allows. Children of proposed topics and trees under proposed groups come with the
   neighbourhood call, so a step makes at most 2 calls.
5. **Calibrated cosine.** `s` mixes the judge (0 to 1) with a cosine mapped to 0 to 1 per
   embedding model (`scores.calibration`; rule in `forest/embed.py fit_calibration`). Raw cosines
   sit on different scales per model (bge: unrelated 0.56, own topic 0.70).
6. **`lam_G = 0.5`, not 1.0.** A new group costs `lam_G + lam + beta (L - 1)` and gains at most
   `1 + alpha_G`. With the start values (1.7 against 1.5) no group can ever be created
   (`notebooks/04`).
7. **Action (e)** needs `z = 1` *and* an actual move, removal or rename. With `F = 0` the solver
   may set `z = 1` without any change. `ip_full_recluster` uses a cost of 1e-4 instead of exactly 0,
   so ties do not move prompts for nothing.
8. **Extra pruning (part of C18).** At most 4 alternatives per old prompt and 4 candidate parents
   per topic, on top of `tau`. No edge links two proposed topics.
9. **Cache.** `data/cache/` stays git-ignored as planned. Phase 7 needs cached inputs in git, so
   `data/frozen/` holds a snapshot, and `cache.REQUIRE_CACHED` turns any miss into an error.
10. **Evaluation fit.** All methods are scored by the calibrated cosine of each prompt to its
   topic's label (no judge scores, since every method sees different judge calls). This rewards
   many narrowly named topics; read it together with topics, `under_L` and the limit violations.
11. **Baselines respect `D`** (a new topic that would be too deep goes one level up), so every
    forest validates. `K_T` and `K_G` breaches are counted, not prevented.

## What the stand-in runs show (to be redone with a live judge)

- **Non-trivial:** given the same judge answer, the IP decides differently from the judge's
  argmax in 50 %, 60 % and 80 % of the steps.
- **Fit:** it scores below the judge-based baselines on the shared fit (e.g. 23.5 vs 28.8 on s1),
  with far fewer topics.
- **Limits and stability:** it never breaks `K_T`, where `greedy` and `judge_argmax` exceed it by 5
  to 12 trees, and it moves at most 2 old prompts per session.
- **What-if:** on s1, `mu` and `F` trade up to 13 % of fit against 0 to 17 rebalancing steps.
  At s1 step 13 the decision flips between a new branch and a rebalance.
- **Side effect to discuss:** the `L` slack can pull a prompt into a small topic it fits worse
  (`notebooks/04`).

## Open for the group

1. Provider, model and budget for the judge; then run 03 live, switch the config, rebuild, freeze.
2. Review the drafted prompts for realism; fill in `data/gold/*_template.csv`; two raters for
   `data/gold/judge_validation.csv` (kappa in 03).
3. Pick the operating point (`mu`, `F`) from the 06 frontier, and the session and baseline for
   the Milestone 4 A/B test.
4. The report (PDF) and the hand-in folder (`scripts/package_submission.py`). Deadline: 3 Dec 2026.
