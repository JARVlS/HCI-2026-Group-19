# Implementation Plan: Prompt Forest Optimization Notebooks

> Kept here as written (Claude desktop, Nov 2026) because the code and notebooks cite it. Where the
> implementation deviates, `README.md` ("Deviations from the plan") says how and why. The plan's
> `optimization/` folder is this folder.

This plan is written for a coding agent (Claude in VS Code). It describes what to build, in which order, and how to check each step. It contains everything needed; no other context is assumed.

## 1. Context

### 1.1 The project

HCI 2026 course project at ETH Zurich, theme "Studying with AI". Our prototype organizes the prompts a student sends to an LLM into a **forest**:

```
Forest
├── Group: Deep Learning
│   ├── Tree: Neural networks
│   │   ├── Backpropagation        <- prompts 3, 7, 12
│   │   │   └── Vanishing gradients <- prompts 15, 18
│   │   └── Activation functions   <- prompts 4, 9
│   └── Tree: Optimizers
│       └── Adam vs SGD            <- prompts 11, 14
└── Group: Linear Algebra
    └── Tree: Eigenvalues
        └── ...
```

- **Groups** sit directly under the forest.
- **Topics** are tree nodes. A topic whose parent is a group is a tree root; otherwise its parent is another topic.
- **Prompts** are attached to topics. Several prompts can share a topic.

When a new prompt arrives, the system decides one of five outcomes:

| Outcome | Meaning |
|---|---|
| (a) add | Prompt goes into an existing topic |
| (b) new branch | New topic under an existing topic |
| (c) new tree | New topic directly under an existing group |
| (d) new group | New group containing a new tree |
| (e) rebalance | Existing prompts or topics move, merge, split, get deleted or renamed |

### 1.2 Course requirements this must satisfy (Milestone 3)

- The optimization must be an **Integer Program solved with Gurobi** in a Jupyter notebook.
- Final submission files go to `Deliverables/UIOptimization/`:
  - `ui_optimization.ipynb` (the optimization code)
  - `requirements.txt`
  - a PDF report (written by the group, not part of this plan)
- The pip version of Gurobi is limited to **2000 variables and 2000 constraints**. Stay under it, or document that the academic license is used.
- The problem must not be trivial: if a simple rule (e.g. "attach to best match") finds the same result, the formulation needs a real trade-off. We must show cases where the IP differs from simple rules.
- The report needs **at least 2 human-made alternative designs** to compare against, and **one what-if analysis** (change a parameter, re-solve, show how the result changes).
- LLM-derived estimates are allowed but must be cited (model name and version).
- The optimal result is implemented in the prototype and used as one variant in the Milestone 4 A/B test, so the notebook must **export the resulting forests** in a format the prototype can load.
- Deadline: Thursday, 3 December 2026, 23:59.

### 1.3 Architecture of one placement step

```
new prompt -> [1. shortlist (embeddings)] -> [2. judge LLM (scores + candidate names)]
           -> [3. integer program (Gurobi)] -> [4. new forest + action label]
                         ^ current forest (old state)
```

- The **judge** never decides placement. It outputs scores and proposes candidate categories.
- The **IP** decides structure: which categories exist, where they hang, where each prompt goes, and whether to rebalance.

## 2. The integer program (reference formulation)

Implement exactly this. Constraint IDs (C1 to C18, R1 to R5) must appear as comments in the code.

### 2.1 Sets

- `P`: prompts. `n` is the new prompt. `P_old = P \ {n}`.
- `C_G = C_G_old ∪ C_G_new`: groups (existing plus judge-proposed).
- `C_T = C_T_old ∪ C_T_new`: topics (existing plus judge-proposed).
- `R ⊆ C_T_new`: rename candidates. Each `r ∈ R` has `orig(r) ∈ C_T_old`.

### 2.2 Parameters

| Symbol | Meaning | Source |
|---|---|---|
| `s[p,c]` in [0,1] | Fit of prompt p to topic c | gamma * judge + (1 - gamma) * cosine |
| `h[c1,c]` in [0,1] | Fit of topic c as subtopic of topic c1 | Judge |
| `hg[g,c]` in [0,1] | Fit of tree rooted at c to group g | Judge |
| `c0[p]` | Previous topic of old prompt p | Current forest |
| `pi0[c]` | Previous parent of old topic c (topic or group) | Current forest |
| `w[p]`, `v[c]` | Disruption weight of moving p or c | Recency of access (Section 5.4) |
| `L`, `U` | Preferred min / max content per topic | Config |
| `B` | Max subtopics per topic | Config |
| `D` | Max tree depth | Config |
| `K_T`, `K_G` | Max trees per group, max groups | Config |
| `alpha, alpha_G, lam, lam_G, beta, mu, nu, F, rho` | Objective weights | Config |
| `tau` | Pruning threshold | Config |

### 2.3 Variables

| Variable | Domain | Meaning |
|---|---|---|
| `y[c]` | binary, c in C_G ∪ C_T | category exists |
| `q[p,c]` | binary, c in C_T | prompt p in topic c |
| `x[c1,c]` | binary, c1, c in C_T | c1 is parent of c |
| `xg[g,c]` | binary, g in C_G, c in C_T | c is a tree root in group g |
| `d[c]` | integer 0..D-1 | depth of topic c |
| `m[p]` | binary, p in P_old | prompt p moved |
| `k[c]` | binary, c in C_T_old ∪ C_G_old | category re-parented or removed |
| `z` | binary | any rebalance happened |
| `o[c], u[c], b[c]` | continuous >= 0 | slack: too full, too sparse, too many children |

Only create `q`, `x`, `xg` for pairs that survive pruning (C18). This is essential for the size limit.

### 2.4 Objective (maximize)

```
  sum s[p,c] q[p,c]
+ alpha   * sum h[c1,c] x[c1,c]
+ alpha_G * sum hg[g,c] xg[g,c]
- lam     * sum_{c in C_T_new \ R} y[c]
- lam_G   * sum_{g in C_G_new} y[g]
- beta    * sum_c (o[c] + u[c] + b[c])
- mu      * sum_{p in P_old} w[p] m[p]
- nu      * sum_c v[c] k[c]
- rho     * sum_{r in R} v[orig(r)] y[r]
- F       * z
```

### 2.5 Constraints

Assignment and existence:
- **C1** `sum_c q[p,c] = 1` for all p
- **C2** `q[p,c] <= y[c]` for all p, c (alternative if size is tight: `sum_p q[p,c] <= |P| * y[c]`)

Forest structure:
- **C3** `sum_c1 x[c1,c] + sum_g xg[g,c] = y[c]` for all c in C_T
- **C4** `x[c1,c] <= y[c1]`, `xg[g,c] <= y[g]`
- **C5** `y[c] <= sum_p q[p,c] + sum_c2 x[c,c2]` for c in C_T (no empty topics)
- **C6** `y[g] <= sum_c xg[g,c]` for g in C_G (no empty groups)

Depth and acyclicity:
- **C7** `d[c] >= d[c1] + 1 - D * (1 - x[c1,c])` for each existing x variable
- **C8** `d[c] <= (D - 1) * (1 - sum_g xg[g,c])`

Balance:
- **C9** `sum_p q[p,c] <= U + o[c]`
- **C10** `sum_p q[p,c] + sum_c2 x[c,c2] >= L * y[c] - u[c]`
- **C11** `sum_c2 x[c,c2] <= B + b[c]`

Screen space:
- **C12** `sum_c xg[g,c] <= K_T` for each g
- **C13** `sum_g y[g] <= K_G`

Stability (without renames):
- **C14** `m[p] >= 1 - q[p, c0[p]]`
- **C15** `k[c] >= 1 - x[pi0[c], c]` (or `xg` if the old parent was a group)
- **C16** `k[g] >= 1 - y[g]` for old groups
- **C17** `m[p] <= z`, `k[c] <= z`

Pruning:
- **C18** do not create `q[p,c]` if `s[p,c] < tau`; same for `x` with `h`, `xg` with `hg`. Always keep `q[p, c0[p]]` and the old parent link of every old topic, so the "change nothing" solution is always feasible.

Rename extension (implement as an optional flag, `use_renames`):
- **R1** `y[orig(r)] + y[r] <= 1`
- **R2** replace C15 for orig(r): `k[orig] >= 1 - x[pi0[orig], orig] - x[pi0[orig], r]`
- **R3** replace C14 for prompts in orig(r): `m[p] >= 1 - q[p, orig] - q[p, r]`
- **R4** for each child c2 with `pi0[c2] = orig`: `k[c2] >= 1 - x[orig, c2] - x[r, c2]`
- **R5** `y[r] <= z`

### 2.6 Reading off the action for prompt n

Let `c*` be the topic with `q[n, c*] = 1`.

| Condition | Action |
|---|---|
| `z = 1` | (e) rebalance (report which `m`, `k`, renames fired) |
| `c*` old | (a) add |
| `c*` new, parent is a topic | (b) new branch |
| `c*` new, parent is an old group | (c) new tree |
| `c*` new, parent is a new group | (d) new group |

`z = 1` takes priority but the report should also say where n went.

## 3. Repository layout

Keep logic in a Python package and keep notebooks thin. Notebooks import from `forest/`.

```
optimization/
├── README.md
├── requirements.txt
├── config/
│   └── default.yaml            # all weights, limits, model names, paths
├── data/
│   ├── sessions/               # scripted prompt sessions (input)
│   ├── gold/                   # human labels for evaluation
│   └── cache/                  # embedding and LLM responses (git-ignored)
├── outputs/
│   ├── forests/                # forest snapshots per step, per method (JSON)
│   ├── metrics/                # CSV per experiment
│   └── figures/
├── forest/
│   ├── __init__.py
│   ├── model.py                # dataclasses: Prompt, Topic, Group, Forest
│   ├── io.py                   # load/save sessions and forests
│   ├── embed.py                # embeddings + shortlist
│   ├── judge.py                # LLM judge calls, prompts, parsing, caching
│   ├── scores.py               # assemble s, h, hg; pruning
│   ├── ip.py                   # Gurobi model build, solve, decode
│   ├── baselines.py            # non-IP placement methods
│   ├── simulate.py             # run a method over a whole session
│   ├── metrics.py
│   └── viz.py                  # forest rendering, plots
├── notebooks/
│   ├── 01_data.ipynb
│   ├── 02_shortlist.ipynb
│   ├── 03_judge.ipynb
│   ├── 04_ip.ipynb
│   ├── 05_simulation_and_baselines.ipynb
│   └── 06_whatif.ipynb
├── tests/
│   ├── test_model.py
│   └── test_ip.py
└── ui_optimization.ipynb       # final, self-contained submission notebook
```

## 4. Phases

Build in this order. Each phase ends with a check that must pass before moving on.

### Phase 0: Setup

- `requirements.txt` with pinned versions: `gurobipy`, `numpy`, `pandas`, `pyyaml`, `pydantic`, `matplotlib`, `networkx`, `tqdm`, `python-dotenv`, plus the embedding and LLM client libraries chosen in Phases 2 and 3.
- API keys come from a `.env` file (git-ignored). Never hard-code keys. Add `.env.example`.
- `config/default.yaml` holds every parameter from Section 2.2 plus model names, `k` for the shortlist, `gamma`, `tau`, random seed.
- Disk cache for every embedding and LLM call, keyed by a hash of (model, prompt text, template version). Re-running a notebook must not call the API again unless the template changes.
- Add a cost guard: print the estimated number of LLM calls before running a batch, and stop if it exceeds a configurable limit.

**Check:** `python -c "import gurobipy; gurobipy.Model()"` works; a dummy cached call returns from cache the second time.

### Phase 1: Data model and sessions (`01_data.ipynb`)

**Data model (`forest/model.py`):**
- `Prompt(id, text, step, session_id)`
- `Topic(id, label, parent_id, parent_kind: "topic"|"group")`
- `Group(id, label)`
- `Forest(groups, topics, assignment: prompt_id -> topic_id, access_log)`
- `Forest.validate()` checks: every prompt in exactly one existing topic, every topic has an existing parent, no cycles, depth <= D, no empty topics or groups. Run it after every step.
- JSON round-trip (`to_json`, `from_json`). This JSON is also the export format for the prototype.

**Sessions (`data/sessions/*.json`):** create 3 scripted sessions of realistic student prompts. Each prompt has `id`, `text`, `step`. Also include `access_events` (which earlier prompt the user re-opened at which step), used for `w[p]`.

| Session | Purpose | Size |
|---|---|---|
| `s1_focused` | One course (e.g. neural networks exercise sheet), many prompts on one concept, so topics overflow and splits become worthwhile | ~30 prompts |
| `s2_mixed` | Two or three subjects interleaved, so new trees and new groups are needed | ~30 prompts |
| `s3_drift` | Starts broad, then narrows into a subtopic, so renames and re-parenting are worthwhile | ~25 prompts |

The agent may draft these prompts, but mark the files as drafts. The group must review them for realism before results are reported.

**Gold labels (`data/gold/`):** a template CSV where group members assign each prompt a topic label and a parent path by hand. Used to evaluate the shortlist and the judge. The agent creates the template; humans fill it in.

**Check:** sessions load, a hand-built forest validates, and an invalid one (cycle, empty topic) fails validation with a clear message.

### Phase 2: Embeddings and shortlist (`02_shortlist.ipynb`)

- `embed.py`: `embed(texts) -> np.ndarray` with a pluggable backend. Compare at least:
  - one local model (e.g. a `sentence-transformers` model)
  - one API embedding model
- Topic vector options:
  - `centroid`: mean of prompt embeddings in the topic
  - `label`: embedding of the topic label
  - `mix`: average of the two cosine scores
- `shortlist(prompt, forest, k) -> list[topic_id]`. Also add the parents of the top hits (flag `include_parents`).

**Experiment:** using gold labels, compute recall@k for k in {3, 5, 8} for each backend and topic-vector option. Recall@k = share of prompts whose gold topic is in the shortlist.

**Output:** a table and a line plot of recall@k. Choose backend, vector option and k; write the choice into `config/default.yaml` with a one-line reason in the notebook.

**Check:** recall@k is computed on at least one session; the chosen setting is recorded.

Note: at our scale (10 to 20 topics) the shortlist can be skipped and all topics scored. Keep a flag `shortlist.enabled` and report both.

### Phase 3: Judge LLM (`03_judge.ipynb`)

**Templates (`forest/judge.py`)**, each versioned (`TEMPLATE_VERSION`) and returning validated Pydantic objects:

1. **Placement call** (one per new prompt). Input: new prompt, shortlisted topics with their path and 2 to 3 example prompts each. Output:
   - `existing`: list of `{topic_id, fit: 1..5}`
   - `proposed`: up to 2 new topics `{name, fit, parents: [{id_or_group, fit}]}`, where a parent can be an existing topic, an existing group, or `"NEW_GROUP:<name>"`
   - `renames`: optional `{topic_id, new_name, fit}`
   - Scale: 5 exactly this topic; 4 a subtopic of it that does not exist yet; 3 same broader area; 2 loosely related; 1 unrelated. Propose new topics if any score is 4 or no score is 5.
   - No "decision" field. The judge only scores.
2. **Neighbourhood call** (only when new topics are proposed). Input: old prompts in the parent topic and sibling topics, plus the proposed topics. Output: fit 1..5 for each (old prompt, proposed topic) pair. Fills `s` for rebalancing.
3. **Hierarchy call**. Fit of each proposed topic under each candidate parent, and of each tree root to each group (`h`, `hg`). Can be merged into call 1 if quality holds.
4. **Full restructure call** (optional, for a baseline only). Input: entire forest. Output: a complete proposed forest in the same JSON format as `Forest`.

Settings: temperature 0, candidate order shuffled with a fixed seed, JSON schema enforced, retry once on parse failure, log every failure.

**Experiments:**
- **Model comparison:** at least two models from the providers we have access to (e.g. a small fast model and a larger one). For each, report:
  - agreement with gold labels (top-1 accuracy, Spearman correlation of fit scores with human ratings on a sampled set)
  - position bias: run the same input with two different candidate orders; report the share of changed top-1 choices
  - consistency: run twice; report share of identical outputs
  - parse failure rate, mean latency, total cost
- **Human validation sample:** export 40 random (prompt, topic) pairs with the judge's score hidden to `data/gold/judge_validation.csv` for two group members to rate. Notebook computes Cohen's kappa (weighted) once filled in.

**Output:** a comparison table, the chosen model written into config with exact model name and version (needed for the citation in the report).

**Check:** the chosen model parses on 100% of cached calls (after retry) for at least one full session.

### Phase 4: Score assembly and the IP (`04_ip.ipynb`)

**`forest/scores.py`:**
- Rescale judge fits: `(fit - 1) / 4`.
- `s[p,c] = gamma * judge + (1 - gamma) * cosine`. For pairs without a judge score, use cosine only and flag them.
- Build candidate sets `C_T_new`, `C_G_new`, `R` from judge proposals; deduplicate near-identical names (cosine of label embeddings above a threshold).
- Apply pruning with `tau`, but keep old links (C18 note).

**`forest/ip.py`:**
- `build_model(forest, new_prompt, candidates, scores, params) -> (gp.Model, VarHandles)`
- `solve(model) -> Solution` with a time limit from config; on infeasibility call `computeIIS()` and print the violated constraint IDs.
- `decode(solution, forest) -> (new_forest, action, diff)` where `diff` lists moved prompts, moved/deleted/renamed topics and groups.
- `model_size(model)` returns variable and constraint counts. Assert they are below 2000 when `config.gurobi.size_limited = true`.
- Name every constraint with its ID, e.g. `C9[topic_backprop]`.

**Unit tests (`tests/test_ip.py`)** with tiny hand-built forests (3 to 6 topics) and hand-set scores, one test per outcome:
- (a) high fit to an existing topic with room -> add
- (b) fit 4 to a full topic and a proposed subtopic with fit 5 -> new branch
- (c) no good existing fit, proposed topic with an existing group as parent -> new tree
- (d) proposed new group with high fit, `lam_G` low enough -> new group
- (e) full topic, proposed subtopic, two old prompts with high fit to it, low `mu` and `F` -> rebalance with exactly those two prompts moved
- (e) same as above with high `mu` -> no rebalance
- rename: proposed rename with higher fit and low `rho` -> rename, and the renamed topic's prompts count as not moved
- deletion: an old topic that loses all prompts is removed and its `k` fires
- feasibility: "change nothing plus add n somewhere" is always feasible

**Notebook content:** walk through one step on `s1_focused` with printed scores, model size, solve time, decoded action, and a before/after forest plot.

**Check:** all tests pass; one real step solves in under 5 seconds and fits the size limit.

### Phase 5: Simulation and baselines (`05_simulation_and_baselines.ipynb`)

**`forest/simulate.py`:** `run(method, session, config) -> list[StepRecord]`. Each step: take the current forest, place the next prompt with the method, validate, save the forest snapshot to `outputs/forests/<session>/<method>/step_XX.json`, record metrics. Start from an empty forest; the first prompt always creates a group and a tree.

**Methods (`forest/baselines.py` plus the IP):**

| Name | Description |
|---|---|
| `chronological` | One tree per chat, prompts in order (status quo in chat sidebars) |
| `greedy` | Attach to highest-`s` existing topic if `s >= tau_greedy`, else create the judge's top proposed topic under its top parent |
| `judge_argmax` | Take the judge's highest-scored option directly, no IP |
| `judge_restructure` | Every N prompts, apply the judge's full restructure call (Phase 3, call 4); otherwise `judge_argmax` |
| `ip_full_recluster` | The IP with `mu = nu = F = rho = 0` |
| `ip` | The IP with configured weights (our method) |

`greedy` and `chronological` are the two required human-made alternatives; the others strengthen the comparison.

**Metrics (`forest/metrics.py`)**, per step and cumulative:
- total prompt fit `sum s[p, topic(p)]` using the same scores for all methods
- hierarchy fit (sum of `h` over edges)
- imbalance: topics above `U`, below `L`, above `B`; size distribution
- disruption: moved prompts, weighted by `w`; moved, deleted and renamed categories; number of steps with any change
- structure: number of groups, trees, topics; max and mean depth
- constraint violations (for non-IP methods, count violations of the hard limits)
- agreement with gold labels (if filled in)
- `ip_differs_from_judge_argmax`: share of steps where the IP placement differs. This number argues that the problem is non-trivial; it must be above 0.
- solve time per step

**Output:** one comparison table per session, line plots of fit and cumulative disruption over steps, a scatter plot of final fit vs total disruption (one point per method), and side-by-side forest renderings at 2 to 3 interesting steps where `ip` and `judge_argmax` differ.

**Check:** all methods run on all sessions with `Forest.validate()` passing at every step.

### Phase 6: What-if analysis (`06_whatif.ipynb`)

- **Grid sweep** over `mu` and `F` (e.g. 6 x 6 values, log-spaced) on `s1_focused`. For each cell, record final fit, total disruption, and number of rebalances. Plot heatmaps and the Pareto frontier of fit vs disruption.
- **Single-step flip:** pick one step where options (a), (b) and (e) compete (the "Vanishing gradients" type case). Show which action the IP chooses across the `mu` x `F` grid as a categorical heatmap.
- **Capacity sweep:** vary `U` (e.g. 3 to 10) and `K_T`; show how number of topics and rebalances change.
- **Judge sensitivity:** re-run the main result with `gamma` in {0, 0.5, 1} (embeddings only, mixed, judge only).

**Output:** figures saved to `outputs/figures/` with descriptive file names, ready for the report.

### Phase 7: Final submission notebook (`ui_optimization.ipynb`)

A clean, self-contained notebook for graders, runnable top to bottom from cached data without API keys:
1. Problem description (markdown, mirrors Section 1 and 2 of this plan)
2. Parameters and their justification (table)
3. Load cached scores for the chosen session
4. Build and solve the IP for one illustrative step; print model size and the decoded action
5. Run the full session with `ip` and the two required baselines; comparison table
6. What-if result (one sweep and one flip heatmap)
7. Export the final forest sequence for the prototype

Include all needed code inline or import from `forest/` and ship `forest/` alongside it. `requirements.txt` must list every dependency.

**Check:** fresh virtual environment, `pip install -r requirements.txt`, restart kernel, run all: no errors, no API calls.

## 5. Defaults and modelling details

### 5.1 Starting parameter values

These are starting points; tune them in Phase 6 and record the final values with a justification.

| Param | Start | Rationale to document |
|---|---|---|
| `L` | 2 | A topic with one prompt is barely a category |
| `U` | 6 | Roughly what can be scanned without scrolling in the sidebar |
| `B` | 5 | Sibling lists stay scannable |
| `D` | 3 | Deeper trees make navigation slow |
| `K_T` | 4 | Trees per group visible at once |
| `K_G` | 5 | Groups visible at once |
| `alpha`, `alpha_G` | 0.5 | Hierarchy matters, but less than prompt placement |
| `lam` | 0.4 | A new topic must gain 0.4 fit points |
| `lam_G` | 1.0 | New groups are the most visible change |
| `beta` | 0.3 | Per unit of imbalance |
| `mu` | 0.3 | Per weighted moved prompt |
| `nu` | 0.5 | Moving a topic moves its whole subtree |
| `rho` | 0.15 | A rename is cheaper than a move |
| `F` | 0.5 | Fixed cost of any visible reorganization |
| `gamma` | 0.7 | Judge weighted above cosine |
| `tau` | 0.2 | Pruning threshold |
| shortlist `k` | 5 | Revisit after Phase 2 |

### 5.2 Weights must create real trade-offs

After Phase 5, if `ip_differs_from_judge_argmax` is 0 or rebalance never happens, tighten `U` or lower `mu`/`F` until it does in at least one session, and report that sensitivity honestly.

### 5.3 Size budget

Estimate before building: `|P| * |C_T|` assignment pairs before pruning. With 30 prompts and 20 topics that is 600; pruning should remove most. Log the counts at every step. If a step exceeds 2000, reduce candidates (smaller `k`, stricter `tau`) or switch C2 to the aggregated form.

### 5.4 Disruption weights

- `w[p] = 1 + a * exp(-(t_now - t_last_access[p]) / T)`, where `t` is the step index, `t_last_access` is the step the prompt was created or last opened (from `access_events`), `a = 2`, `T = 5`.
- `v[c]` = max of `w` over prompts in the subtree of c, so moving a topic the user just used is expensive.

## 6. Conventions for the agent

- Keep notebooks thin. All reusable logic goes into `forest/` with type hints and docstrings.
- Every notebook starts with a markdown cell stating its question and ends with a "Findings" cell summarizing results in 3 to 5 bullet points. Leave the interpretation for the group to edit.
- Seed everything (`random`, `numpy`, candidate shuffling) from config.
- Never call an LLM or embedding API outside the cached wrappers.
- Do not invent results or numbers in markdown cells; only describe outputs the code produced.
- Commit small steps with descriptive messages. Do not commit `.env`, `data/cache/`, or large outputs.
- Ask the user before: choosing which LLM providers to call, spending more than the configured cost limit, or changing the formulation in Section 2.

## 7. Open decisions for the group

1. Which LLM providers and API keys are available for the judge, and the budget.
2. Gurobi license: pip (size-limited) or ETH academic license.
3. Whether the three scripted sessions are drafted by the agent and reviewed, or written by the group.
4. Who fills in the gold labels and the judge validation sample.
5. Which session and which baseline become the Milestone 4 A/B comparison.
6. The export format the prototype expects (adapt `Forest.to_json` if the frontend already has a schema).
