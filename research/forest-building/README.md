# Forest building (research, Milestone 3)

A judge scores where a new prompt could go in a student's knowledge forest; an integer program,
solved with Gurobi, decides what happens: add, new branch, new tree, new group, or restructure.
This is the lean implementation of [`FOREST_NOTEBOOK_PLAN.md`](FOREST_NOTEBOOK_PLAN.md).

```
new prompt + current forest -> [judge] -> scores and proposals -> [integer program, Gurobi] -> new forest + action
```

## Status (26 Nov 2026)

| Phase | State |
|---|---|
| 0 Setup | done: pinned `requirements.txt`, `config.yaml`, `.env.example` |
| 1 Data | done, **draft**: `data/ideal_forest.yaml` (25 prompts, 2 groups, 4 trees, 10 topics) with the arrival order and the intended outcome per step |
| 2 Judge and IP | done: `OracleJudge`, `LLMJudge` (cached), the IP (C1 to C17), 16 tests, step views per test case |
| 3 Simulation | done with the oracle judge (noise 0 and 0.2) and the LLM judge (Claude Haiku 5.5, answers frozen in `data/llm_answers.jsonl`) |
| 4 Submission | `ui_optimization.ipynb` runs from the committed data without a key or login, with the frozen LLM answers; Findings cell and `Deliverables/` copy open |

The oracle judge is right (or, with noise, nearly right) by construction, so its runs test the
IP's trade-offs, not the system; the LLM runs are the real result. Both use one drafted session:
read the numbers with that caveat until the group has reviewed the prompts and the ideal forest.

## Run

```bash
cd research/forest-building
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q tests          # 16 tests
# then open notebooks/01_data, 02_pipeline, 03_simulation and ui_optimization in VS Code or Jupyter
```

The notebooks are the source; edit them in Jupyter. Everything under `outputs/` (figures,
storyboards, the forest JSON per step) is written by the notebooks and is not committed; run them
to regenerate it. The frozen LLM answers in `data/llm_answers.jsonl` are committed.

## The hand-in notebook

`ui_optimization.ipynb` follows one session from input to graphs:

1. **Input:** the ideal forest (how a person would sort the 25 prompts) and the arrival order.
2. **Step by step:** for each of the 25 steps, a table with the input (forest so far, new prompt),
   the judge's answer, the IP's output (action, where the prompt went, moves, objective terms), the
   ideal answer and what `judge_argmax` and `chronological` did. ✓ / ✗: the new prompt shares its
   topic with exactly the prompts it shares it with in the ideal forest (`metrics.placed_right`).
   Then one figure (`viz.step_explainer`), top to bottom: the forest the judge saw, shaded by the
   judge's fit of the new prompt to each topic (the add options; orange: the IP adds it there);
   every option, numbered and grouped by kind (add to an existing topic the judge rated / create a
   topic the judge proposed / a proposed move), each solved on its own (`ip.options`) with the
   judge's fit and the IP's **gain** (the change in the objective against the forest before the
   step, split into fit, new categories, imbalance and disruption); and one card per proposed
   topic (per parent the judge rated) and per proposed move, showing only the tree the option
   changes (`viz._focus`; other trees collapse into a stub). New topics are green with a NEW
   badge, adds orange. An option a hard limit rules out (mostly a fifth tree in a group,
   `K_T = 4`) is kept in a red dashed card, with the reason from Gurobi's IIS, drawn with that
   limit lifted. All trees use one fixed scale (`viz.SCALE`), so the figure grows instead of
   squeezing the boxes.
3. **Comparison:** the per-step overview, the totals and the final forests side by side.
4. **Graphs and diagrams:** F1 and disruption over the steps, the action per step (`viz.action_timeline`),
   and the what-if over `mu` and `F` (every step re-solved with its stored judge answer, no new calls).

The judge is the LLM judge (Claude Haiku 5.5) from its frozen answers; the notebook stops with a
clear error if they are missing. The oracle judge is only used by the tests and `notebooks/02`, `03`.

## The LLM judge

Chosen 26 Nov 2026: **Claude Haiku 5.5 (`claude-haiku-5-5`)**, called through the Claude Code CLI
on a Claude subscription (`llm.provider: claude-cli` in `config.yaml`). No API key: `claude -p` uses
the logged-in subscription, and the judge removes any `ANTHROPIC_API_KEY` from its environment so it
is never billed to an API account. Each call runs in safe mode (no CLAUDE.md, skills, plugins or MCP
servers), with no tools, only the judge's system prompt, in an empty folder, so the model sees
nothing but the forest. The JSON schema is enforced by `--json-schema`. The CLI is found on `PATH`,
else as the copy bundled with the VS Code extension, else set `llm.claude_bin`. The CLI has no
temperature setting, so a rerun without the cache can answer differently; the cache makes the
results reproducible.

To rerun (only needed after a change to the prompt, the judge or the forests it sees):

1. Log in to Claude Code once (`claude`, or the VS Code extension).
2. Run `02_pipeline` and `03_simulation`. A run prints its maximum number of calls (one per step)
   and refuses to start above `llm.max_calls`. Every answer is cached in `data/cache/llm.jsonl`
   with the exact model that answered (`model_id`). The full set is about 50 calls, about 5 minutes.
3. `python -c "from forest.judge import LLMJudge; print(LLMJudge.freeze())"` copies the answers to
   `data/llm_answers.jsonl` (committed), so `ui_optimization.ipynb` runs without a login.

Any chat-completions endpoint still works instead: `provider: openai`, `base_url`, `model`, and the
key in `.env` as `LLM_API_KEY` (template `.env.example`).

## Layout

| Path | What |
|---|---|
| `config.yaml` | IP parameters, Gurobi limits, oracle noise, LLM endpoint |
| `data/ideal_forest.yaml` | the ideal forest, the arrival order and the intended outcomes (draft) |
| `forest/model.py` | `Forest` (stored link fits, creation steps), `validate()`, JSON, the ideal-forest loader |
| `forest/judge.py` | output schema, `OracleJudge`, `LLMJudge` |
| `forest/ip.py` | candidate links, the model (C1 to C17), solve (optionally with variables pinned), decode; `options` (every option forced in turn, scored by its gain) |
| `forest/simulate.py` | `chronological`, `judge_argmax`, `ip` over the arrival order |
| `forest/metrics.py` | pairwise F1, placed right, disruption, balance |
| `forest/viz.py` | `draw_forest`, overlays, `step_view`, `step_card`, `step_explainer`, `compare_view`, `step_browser`, `save_storyboard`, `action_timeline`, heatmaps |
| `tests/test_ip.py` | one case per outcome (also drawn in `02_pipeline`) |
| `outputs/forests/<run>/` | the forest after every step (`step_XX.json`) and `sequence.json` for the prototype (generated, not committed) |
| `outputs/figures/` | the figures named by notebook (generated, not committed) |

## Choices the plan leaves open, as implemented

- **`lam_G = 0.5`, not 1.0** (decided 25 Nov). A new group with its first tree costs
  `lam_G + lam + beta` but gains at most `1 + alpha_G`, so with 1.0 no group could ever be added
  after the first prompt. `tests/test_ip.py` checks this.
- **Oracle proposals.** When intermediate ideal topics are missing, the oracle chains them (the
  closest one first) and also lists the nearest existing ancestor as a parent of the prompt's own
  topic (fit 4). The IP can then open the topic now and insert the missing parent later, the plan's
  "insert Training problems above them".
- **Moves.** The oracle proposes topic moves first, then prompt moves oldest first, at most 6 in all.
- **Export format.** `sequence.json` holds `Forest.to_json()` per step. The format the prototype
  expects is open (plan Section 10.4).
