# Forest building (research, Milestone 3)

A judge scores where a new prompt could go in a student's knowledge forest; an integer program,
solved with Gurobi, decides what happens: add, new branch, new tree, new group, or restructure.
This is the lean implementation of [`FOREST_NOTEBOOK_PLAN.md`](FOREST_NOTEBOOK_PLAN.md).

```
new prompt + current forest -> [judge] -> scores and proposals -> [integer program, Gurobi] -> new forest + action
```

## Status (25 Nov 2026)

| Phase | State |
|---|---|
| 0 Setup | done: pinned `requirements.txt`, `config.yaml`, `.env.example` |
| 1 Data | done, **draft**: `data/ideal_forest.yaml` (25 prompts, 2 groups, 4 trees, 10 topics) with the arrival order and the intended outcome per step |
| 2 Judge and IP | done: `OracleJudge`, `LLMJudge` (cached), the IP (C1 to C17), 11 tests, step views per test case |
| 3 Simulation | done with the oracle judge (noise 0 and 0.2); **the LLM runs are open** until a model is chosen |
| 4 Submission | `ui_optimization.ipynb` runs from the committed data without a key; the LLM part fills in once answers are frozen |

Every result so far comes from the oracle judge, which is right (or, with noise, nearly right) by
construction, and from a drafted session. Read the numbers as a pipeline check until the LLM runs
exist and the group has reviewed the prompts.

## Run

```bash
cd research/forest-building
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q tests          # 11 tests
# then open notebooks/01_data, 02_pipeline, 03_simulation and ui_optimization in VS Code or Jupyter
```

The notebooks are the source; edit them in Jupyter. Storyboards (one PNG per step) are written by
`03_simulation` to `outputs/figures/<run>/` and are not committed.

## The LLM judge

`llm.model` in `config.yaml` is empty, so every LLM step is skipped. To run it:

1. Choose provider and model with the group (plan Section 9). Any chat-completions endpoint works:
   GLM-4.7 on Bedrock (`base_url: https://bedrock-mantle.eu-north-1.api.aws/v1`, `model: zai.glm-4.7`),
   a free tier such as Groq or Gemini, or OpenAI. Claude would need the Anthropic SDK path added.
2. Put the key in `.env` as `LLM_API_KEY` (template `.env.example`).
3. Run `02_pipeline` and `03_simulation`. A run prints its maximum number of calls (one per step)
   and refuses to start above `llm.max_calls`. Every answer is cached in `data/cache/llm.jsonl`.
4. `python -c "from forest.judge import LLMJudge; print(LLMJudge.freeze())"` copies the answers to
   `data/llm_answers.jsonl` (committed), so `ui_optimization.ipynb` runs without a key. Cite the
   exact model name in the report.

## Layout

| Path | What |
|---|---|
| `config.yaml` | IP parameters, Gurobi limits, oracle noise, LLM endpoint |
| `data/ideal_forest.yaml` | the ideal forest, the arrival order and the intended outcomes (draft) |
| `forest/model.py` | `Forest` (stored link fits, creation steps), `validate()`, JSON, the ideal-forest loader |
| `forest/judge.py` | output schema, `OracleJudge`, `LLMJudge` |
| `forest/ip.py` | candidate links, the model (C1 to C17), solve, decode |
| `forest/simulate.py` | `chronological`, `judge_argmax`, `ip` over the arrival order |
| `forest/metrics.py` | pairwise F1, disruption, balance |
| `forest/viz.py` | `draw_forest`, overlays, `step_view`, `compare_view`, `step_browser`, `save_storyboard`, heatmaps |
| `tests/test_ip.py` | one case per outcome (also drawn in `02_pipeline`) |
| `outputs/forests/<run>/` | the forest after every step (`step_XX.json`) and `sequence.json` for the prototype |
| `outputs/figures/` | the figures named by notebook |

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
