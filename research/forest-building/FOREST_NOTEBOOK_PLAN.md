# Implementation Plan: Prompt Forest Optimization (lean version)

> Kept here as written (brainstormed with Claude, 25 Nov 2026), because the code and notebooks cite
> it. `optimization/` in the layout is this folder. Where the implementation fills a gap the plan
> leaves open, `README.md` ("Choices the plan leaves open") says how.

This plan is written for a coding agent (Claude in VS Code). It contains everything needed; no other context is assumed. Keep the implementation as small as possible. Do not add components that are not listed here.

## 1. Context

### 1.1 The project

HCI 2026 course project at ETH Zurich, theme "Studying with AI". Our prototype organizes the prompts a student sends to an LLM into a **forest**:

```
Forest
├── Group: Deep Learning
│   ├── Tree: Neural networks
│   │   ├── Backpropagation        <- prompts
│   │   └── Training problems      <- prompts
│   │       ├── Vanishing gradients <- prompts
│   │       └── Overfitting         <- prompts
│   └── Tree: Optimizers
│       └── Adam vs SGD            <- prompts
└── Group: Linear Algebra
    └── Tree: Eigenvalues          <- prompts
```

- **Groups** sit directly under the forest.
- **Topics** are tree nodes. A topic whose parent is a group is a tree root; otherwise its parent is another topic.
- **Prompts** are attached to topics. Several prompts can share a topic.

When a new prompt arrives, one of five outcomes happens:

| Outcome | Meaning |
|---|---|
| (a) add | Prompt goes into an existing topic |
| (b) new branch | New topic under an existing topic |
| (c) new tree | New topic directly under an existing group |
| (d) new group | New group containing a new tree |
| (e) restructure | Existing prompts or topics move (including inserting a new topic above existing ones), or empty topics get deleted |

### 1.2 Architecture

```
new prompt + current forest -> [judge LLM] -> scores and proposals
                            -> [integer program, Gurobi] -> new forest + action label
```

- The **judge** never decides. It scores options and proposes changes.
- The **IP** decides which proposals to adopt, trading semantic fit against balance and stability (moving things the user has seen breaks their mental map).
- No embeddings and no shortlist. The judge sees the whole forest.

### 1.3 The experiment

There is **one input**: a hand-made **ideal forest** for one scripted study session, plus the **arrival order** of its prompts. The notebooks simulate the pipeline: prompts arrive one by one, starting from an empty forest, and after each step we compare the system's forest with the ideal forest.

### 1.4 Course requirements this must satisfy (Milestone 3)

- An **Integer Program solved with Gurobi** in a Jupyter notebook.
- Submission files in `Deliverables/UIOptimization/`: `ui_optimization.ipynb`, `requirements.txt` (plus a PDF the group writes).
- Pip Gurobi is limited to **2000 variables and 2000 constraints**. Log model size every step.
- The problem must be non-trivial: show steps where the IP chooses differently from simply taking the judge's top option.
- **At least 2 alternative designs** to compare against, and **one what-if analysis** (change a parameter, re-solve, show how the result changes).
- LLM estimates must be cited (exact model name and version).
- Export the resulting forests so the prototype can show them (Milestone 4 A/B test).
- Deadline: Thursday, 3 December 2026, 23:59.

## 2. The ideal forest (input data)

File: `data/ideal_forest.yaml`. The agent drafts it; the group reviews the prompts for realism before results are reported.

```yaml
session: nn_exercise_sheet
groups:
  - label: Deep Learning
    trees:
      - label: Neural networks
        prompts: [...]
        children:
          - label: Backpropagation
            prompts:
              - id: p01
                text: "How does the chain rule apply in backprop?"
          - label: Training problems
            children:
              - label: Vanishing gradients
                prompts: [...]
              - label: Overfitting
                prompts: [...]
      - label: Optimizers
        children:
          - label: Adam vs SGD
            prompts: [...]
  - label: Linear Algebra
    trees:
      - label: Eigenvalues
        prompts: [...]
arrival_order: [p03, p01, p07, ...]
```

Size: about 25 prompts, 2 groups, 4 to 5 trees, 8 to 10 topics, max depth 3, at least one topic with more than `U` prompts.

**Design the arrival order so that every outcome is needed at least once:**
- early prompts that fit an existing topic: (a)
- a prompt about vanishing gradients after several backprop prompts: (b)
- the first optimizer prompt: (c)
- the first linear algebra prompt, mid-session: (d)
- prompts about vanishing gradients and overfitting arriving before any prompt that makes "Training problems" obvious, so the system first places them elsewhere and later has to insert "Training problems" above them: (e)
- one overloaded topic that only becomes worth splitting after several prompts: (e)

Write the intended outcome per step as a comment next to `arrival_order`. It is a design intention, not a test assertion.

## 3. The judge

### 3.1 Input

The new prompt and the full current forest: groups, topics with their path, and the prompts in each topic (id and text). Topic order is shuffled with a fixed seed.

### 3.2 Output (three parts, validated with Pydantic)

Scale for every fit: 5 = exactly right; 4 = right area, a more specific topic would be better; 3 = same broader area; 2 = loosely related; 1 = unrelated.

1. **existing**: fit of the new prompt to every existing topic: `{topic_id, fit}`.
2. **proposed**: up to 2 new topics: `{name, fit, parents: [{parent, fit}]}`. A parent is an existing topic id, an existing group id (new tree), `"NEW_GROUP:<name>"` (new group), or the name of the other proposed topic.
3. **restructure**: a list of proposed moves, at most 6:
   - `{kind: "prompt", id, to, fit}`: move an old prompt to an existing or proposed topic
   - `{kind: "topic", id, to, fit}`: move an existing topic under an existing topic, a proposed topic, an existing group, or a new group

There is no decision field. Example:

```json
{
  "existing": [{"topic_id": "t_overfit", "fit": 4}, {"topic_id": "t_nn", "fit": 3}],
  "proposed": [{"name": "Training problems", "fit": 5,
                "parents": [{"parent": "t_nn", "fit": 5}]}],
  "restructure": [
    {"kind": "topic", "id": "t_vanish",  "to": "Training problems", "fit": 4},
    {"kind": "topic", "id": "t_overfit", "to": "Training problems", "fit": 5},
    {"kind": "topic", "id": "t_optim",   "to": "t_nn", "fit": 2}
  ]
}
```

### 3.3 Two judge backends with the same interface

- **`OracleJudge`** derives scores from the ideal forest. No API calls; used to test the pipeline and for parameter sweeps. Rules:
  - New prompt vs. existing topic: 5 if it is the prompt's ideal topic; 4 if the prompt's ideal topic is a descendant of it; 3 if in the same ideal tree; 2 if in the same ideal group; 1 otherwise. Topics are matched to ideal topics by label.
  - Proposed: if the prompt's ideal topic does not exist yet, propose it with its nearest existing ideal ancestor as parent (topic, else group, else `NEW_GROUP:<ideal group label>`), fit 5. If intermediate ideal topics are missing too, propose the closest one first and chain them.
  - Restructure: every existing topic whose current parent differs from its ideal parent, where the ideal parent exists or is proposed (fit 5), and every old prompt whose ideal topic exists or is proposed but which sits elsewhere (fit 5).
  - Parameter `noise`: with probability `noise`, shift each fit by +1 or -1 (clipped to 1..5).
- **`LLMJudge`** calls the chosen model with temperature 0 and the JSON schema enforced; retries once on a parse failure. Every call is cached to disk, keyed by a hash of (model, template version, input). Topic labels it invents will differ from the ideal ones; that is expected.

## 4. The integer program

Implement exactly this. Constraint IDs must appear as comments and as Gurobi constraint names (e.g. `C9[t_backprop]`).

### 4.1 Candidate links (replaces pruning)

Variables exist only for candidate pairs:
- **Prompt to topic:** each old prompt's current topic; the new prompt to every existing topic and every proposed topic; restructure prompt moves.
- **Topic to parent:** each existing topic's current parent; parents listed for proposed topics; restructure topic moves.

Scores: the current link of an old prompt or topic keeps the fit **stored** when it was created (store it in the forest). New links take the judge's fit. Rescale every fit with `(fit - 1) / 4`.

Keeping current links guarantees that "change nothing, add the new prompt somewhere" is always feasible.

### 4.2 Sets and parameters

- `P`: prompts; `n` is the new one; `P_old = P \ {n}`.
- `C_G = C_G_old ∪ C_G_new`: groups. `C_T = C_T_old ∪ C_T_new`: topics.
- `s[p,c]`, `h[c1,c]`, `hg[g,c]`: rescaled fits for prompt-topic, topic-topic and topic-group candidate links.
- `c0[p]`, `pi0[c]`: current topic of p, current parent of c.
- `w[p] = 1 + 2 * exp(-(t - t_created[p]) / 5)` where t is the step index; `v[c]` = max of `w` over prompts in c's subtree (1 if none).
- `L, U, B, D, K_T, K_G`, weights `alpha, alpha_G, lam, lam_G, beta, mu, nu, F`: from config (Section 6).

### 4.3 Variables

| Variable | Domain | Meaning |
|---|---|---|
| `y[c]` | binary | category exists |
| `q[p,c]` | binary | prompt p in topic c |
| `x[c1,c]` | binary | topic c1 is parent of topic c |
| `xg[g,c]` | binary | topic c is a tree root in group g |
| `d[c]` | integer 0..D-1 | depth of topic c |
| `m[p]` | binary, p in P_old | prompt moved |
| `k[c]` | binary, old categories | category moved or removed |
| `z` | binary | any restructure |
| `o[c], u[c], b[c]` | continuous >= 0 | too full, too sparse, too many children |

### 4.4 Objective (maximize)

```
  sum s[p,c] q[p,c] + alpha * sum h[c1,c] x[c1,c] + alpha_G * sum hg[g,c] xg[g,c]
- lam * sum_{c in C_T_new} y[c] - lam_G * sum_{g in C_G_new} y[g]
- beta * sum_c (o[c] + u[c] + b[c])
- mu * sum_p w[p] m[p] - nu * sum_c v[c] k[c] - F * z
```

### 4.5 Constraints

- **C1** `sum_c q[p,c] = 1` for all p
- **C2** `q[p,c] <= y[c]`
- **C3** `sum_c1 x[c1,c] + sum_g xg[g,c] = y[c]` for topics
- **C4** `x[c1,c] <= y[c1]`, `xg[g,c] <= y[g]`
- **C5** `y[c] <= sum_p q[p,c] + sum_c2 x[c,c2]` (no empty topics)
- **C6** `y[g] <= sum_c xg[g,c]` (no empty groups)
- **C7** `d[c] >= d[c1] + 1 - D * (1 - x[c1,c])`
- **C8** `d[c] <= (D - 1) * (1 - sum_g xg[g,c])`
- **C9** `sum_p q[p,c] <= U + o[c]`
- **C10** `sum_p q[p,c] + sum_c2 x[c,c2] >= L * y[c] - u[c]`
- **C11** `sum_c2 x[c,c2] <= B + b[c]`
- **C12** `sum_c xg[g,c] <= K_T` per group
- **C13** `sum_g y[g] <= K_G`
- **C14** `m[p] >= 1 - q[p, c0[p]]`
- **C15** `k[c] >= 1 - x[pi0[c], c]` (or `xg` if the current parent is a group)
- **C16** `k[g] >= 1 - y[g]` for old groups
- **C17** `m[p] <= z`, `k[c] <= z`

### 4.6 Decoding

Let `c*` be the topic with `q[n, c*] = 1`.

| Condition | Action |
|---|---|
| `z = 1` | (e) restructure |
| `c*` old | (a) add |
| `c*` new, parent is a topic | (b) new branch |
| `c*` new, parent is an old group | (c) new tree |
| `c*` new, parent is a new group | (d) new group |

Also return a diff: moved prompts, moved topics, deleted topics and groups, and which restructure proposals were adopted or rejected.

## 5. Repository layout

```
optimization/
├── requirements.txt
├── config.yaml
├── data/
│   ├── ideal_forest.yaml
│   └── cache/                  # LLM responses (git-ignored)
├── outputs/
│   ├── forests/                # forest snapshot per step and method (JSON)
│   └── figures/
├── forest/
│   ├── model.py                # Forest dataclasses, validate(), JSON, load ideal forest
│   ├── judge.py                # OracleJudge, LLMJudge, Pydantic schema
│   ├── ip.py                   # build, solve, decode
│   ├── simulate.py             # run a method over the arrival order
│   ├── metrics.py
│   └── viz.py                  # forest rendering with judge and IP overlays (Section 7)
├── tests/
│   └── test_ip.py
├── notebooks/
│   ├── 01_data.ipynb
│   ├── 02_pipeline.ipynb
│   └── 03_simulation.ipynb
└── ui_optimization.ipynb       # final submission notebook
```

## 6. Config defaults

| Param | Start | Rationale to document |
|---|---|---|
| `L` | 2 | A topic with one prompt is barely a category |
| `U` | 5 | Visible in the sidebar without scrolling |
| `B` | 5 | Sibling lists stay scannable |
| `D` | 3 | Deeper trees slow navigation |
| `K_T`, `K_G` | 4, 4 | Sidebar space |
| `alpha`, `alpha_G` | 0.5 | Hierarchy matters less than prompt placement |
| `lam` | 0.4 | A new topic must gain 0.4 fit points |
| `lam_G` | 1.0 | New groups are the most visible change |
| `beta` | 0.3 | Per unit of imbalance |
| `mu` | 0.3 | Per weighted moved prompt |
| `nu` | 0.5 | Moving a topic moves its subtree |
| `F` | 0.5 | Fixed cost of any visible reorganization |
| `noise` | 0.0 | Oracle noise; also run 0.2 |
| `seed` | 42 | |

Also in config: LLM model name, Gurobi time limit (10 s), `size_limited: true`.

## 7. Forest visualization

Visualization is a core part of the deliverable: the group needs to see what the judge proposed and what the IP did with it. Implement it in `forest/viz.py` with **matplotlib only** (no Graphviz or other system dependencies), so it runs on every machine and in the graders' environment.

### 7.1 Base renderer

`draw_forest(forest, ax, overlay=None, show_prompts="ids")`:
- Top-down tree layout. Groups side by side at the top, trees below their group, topics as boxes, edges as lines.
- Visual encoding: groups in one color, topics in another, depth by vertical position.
- Prompts shown inside each topic box as ids (`p07 p12`), as a count (`3 prompts`), or as truncated text (first 30 characters), chosen by `show_prompts`.
- Topics above `U` get a red border; topics below `L` a dashed border.
- Readable at about 25 prompts and 10 topics in a 12 x 6 inch figure.

### 7.2 Overlays

`overlay` is an object that marks parts of the drawing. Use the same colors everywhere:

| Element | Encoding |
|---|---|
| New prompt | Orange, bold id |
| Judge fit of the new prompt to each existing topic | Topic box fill shaded by fit (light = 1, dark = 5), fit number in the corner |
| Proposed new topic or group | Dashed orange box, attached with a dashed edge to each proposed parent, labelled with the fit |
| Proposed move (prompt or topic) | Dashed arrow from current position to target, labelled with the fit |
| Adopted by the IP | Same element drawn solid green |
| Rejected by the IP | Same element drawn grey with a cross on the arrow |
| Moved in this step | Green outline on the moved prompt or topic |
| Deleted in this step | Grey box, struck through |

Add a small legend to every figure that uses overlays.

### 7.3 Composite views

- **`step_view(before, judge_output, decision, after)`**: one figure with three panels per simulation step:
  1. *Before*: current forest and the new prompt text as a title.
  2. *Judge*: the same forest with fit shading, proposed topics and proposed moves.
  3. *IP result*: the new forest with adopted (green) and rejected (grey) proposals and the action label, e.g. "(e) restructure: 2 topics moved, 1 move rejected".

  Below the panels, a one-line text summary of the objective terms for the chosen solution (fit, imbalance, disruption, total).
- **`compare_view(forests: dict[str, Forest])`**: side-by-side panels for the same step, e.g. `ideal`, `ip`, `judge_argmax`. Prompts that sit in a different topic than in the ideal forest are drawn in red.
- **`step_browser(run)`**: an `ipywidgets` slider over the steps of a simulation run that redraws `step_view` for the chosen step.
- **`save_storyboard(run, path)`**: one PNG of `step_view` per step to `outputs/figures/<method>/step_XX.png`, so the group can flip through them outside Jupyter.

### 7.4 Where to use them

| Notebook | Visualizations |
|---|---|
| 01_data | The ideal forest; the ideal forest drawn after each of the first few arrival steps, to check the arrival order makes sense |
| 02_pipeline | `step_view` for the walkthrough step, once with the oracle judge and once with the LLM judge; one `step_view` per unit test case, saved as figures, so each outcome (a) to (e) can be seen |
| 03_simulation | `step_browser` for `ip` and `judge_argmax`; `save_storyboard` for both; `compare_view` (ideal, ip, judge_argmax) at the final step and at 2 steps where `ip` and `judge_argmax` differ; for the what-if step, one rendered forest per distinct action in the heatmap |
| ui_optimization | One `step_view` of the illustrative step, and `compare_view` of the final forests |

## 8. Phases

Each phase ends with a check that must pass before the next.

### Phase 0: Setup
- Pinned `requirements.txt`: `gurobipy`, `pydantic`, `pyyaml`, `numpy`, `pandas`, `matplotlib`, `ipywidgets`, `python-dotenv`, plus the LLM client library.
- API key from `.env` (git-ignored), with `.env.example`.
- **Check:** `gurobipy.Model()` runs.

### Phase 1: Data model and ideal forest (`01_data.ipynb`)
- `Forest` with groups, topics (with stored link fit), prompt assignments (with stored fit and creation step). `validate()` checks: each prompt in exactly one existing topic, each topic has an existing parent, no cycles, depth <= D, no empty topics or groups.
- Implement `viz.draw_forest` (Section 7.1) here, since every later phase uses it.
- Load `ideal_forest.yaml` into a `Forest`; render it; print the arrival order with intended outcomes.
- **Check:** the ideal forest validates; a forest with a cycle or empty topic fails with a clear message.

### Phase 2: Judge and IP for one step (`02_pipeline.ipynb`)
- Implement `OracleJudge` first, then `LLMJudge`.
- Implement `ip.py`.
- Tests in `tests/test_ip.py`, small hand-built forests with hand-set judge outputs, one per outcome:
  - (a) good fit to a topic with room -> add
  - (b) fit 4 to a full topic, proposed subtopic fit 5 -> new branch
  - (c) proposed topic with an existing group as parent -> new tree
  - (d) proposed topic under `NEW_GROUP` with low `lam_G` -> new group
  - (e) proposed "Training problems" with two topic moves under it and low `mu`/`nu`/`F` -> both moves adopted
  - (e) same with high `nu` -> no moves
  - a judge move with low fit and a recently used topic -> rejected while another move is adopted
  - an old topic left empty after moves -> deleted, `k` fires
- Implement the overlays and `step_view` (Sections 7.2, 7.3).
- Notebook: walk through one interesting step with the oracle and with the LLM judge: show `step_view`, the raw judge output, model size, solve time, decoded action, and adopted and rejected proposals.
- **Check:** all tests pass; one step solves in under 5 seconds and within the size limit.

### Phase 3: Simulation (`03_simulation.ipynb`)

**Methods:**

| Name | Description |
|---|---|
| `chronological` | No judge: one tree per 5 consecutive prompts, in arrival order (status quo of chat sidebars) |
| `judge_argmax` | Take the judge's highest-fit option for the new prompt, ignore restructure proposals, no IP |
| `ip` | Judge plus IP (our method) |

`chronological` and `judge_argmax` are the two required alternative designs.

Run each method over the arrival order from an empty forest. Run `judge_argmax` and `ip` once with `OracleJudge` and once with `LLMJudge`. Save a snapshot per step; run `validate()` after every step.

**Metrics per step:**
- agreement with the ideal forest: pairwise F1 on "same topic" over all prompt pairs, and on "same tree" (label-independent, so it works for the LLM judge too)
- disruption: moved prompts (weighted by `w`), moved topics, deleted categories; cumulative
- balance: topics above `U`, topics below `L`
- action taken per step, and the intended outcome from the arrival order next to it
- steps where `ip` differs from `judge_argmax` (must be above 0)
- model size and solve time

**What-if (with `OracleJudge`, since every parameter change gives a different trajectory and new LLM calls):**
- grid over `mu` and `F` (5 x 5, e.g. 0.05 to 2, log-spaced): final pair F1, total disruption, number of restructures. Heatmaps plus a scatter of F1 vs. disruption.
- one fixed step from the LLM run where several outcomes compete: re-solve only that step's IP (cached judge output, so no new calls) across the same grid and plot the chosen action as a categorical heatmap.

**Outputs:** comparison table, F1 and cumulative disruption over steps, the visualizations listed in Section 7.4, and the what-if figures. Save all figures to `outputs/figures/`.

**Check:** all methods complete with valid forests at every step.

### Phase 4: Submission notebook (`ui_optimization.ipynb`)

Clean, runnable top to bottom from cached data without an API key:
1. Problem and formulation (markdown, Sections 1 and 4)
2. Parameters with justification
3. One illustrative step
4. Full simulation, comparison table and plots
5. What-if results
6. Export of the final `ip` forest sequence (LLM judge run) as JSON for the prototype

**Check:** fresh environment, `pip install -r requirements.txt`, run all: no errors and no API calls.

## 9. Conventions

- Keep notebooks thin; logic lives in `forest/` with type hints.
- Every notebook starts with its question and ends with a "Findings" cell of 3 to 5 bullets describing only what the outputs show. The group edits the interpretation.
- Never call the LLM outside the cached wrapper. Print the number of calls before a batch run.
- Do not commit `.env` or `data/cache/`.
- Ask the user before choosing the LLM provider and model, or changing the formulation in Section 4.

## 10. Open decisions for the group

1. Which LLM provider and model to use for the judge, and the API budget.
2. Gurobi license: pip (size-limited) or ETH academic.
3. Review of the drafted ideal forest and arrival order.
4. The JSON format the prototype expects for the exported forests.
