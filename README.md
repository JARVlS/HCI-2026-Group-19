# Milestone 3 – UI Optimization: Topic Forest

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/UxAzhangxiaohua/hci_m3/blob/main/ui_optimization.ipynb)

When a student asks the AI a new question, our prototype sorts it into the student's knowledge forest: groups (one per subject) hold trees of topics, and every question sits in one topic. After every question the system decides one of five outcomes: (a) add to an existing topic, (b) new branch, (c) new tree, (d) new group, (e) restructure (older questions move; a topic left empty is deleted). We solve this decision as an integer program with Gurobi, once per question, over a scripted study session of 11 questions.

```
new prompt + current forest -> [LLM judge] -> proposal and scores -> [integer program, Gurobi] -> new forest + outcome
```

## Files

| File | What it is |
|---|---|
| `ui_optimization.ipynb` | The main notebook: model, results, comparison, what-if analysis |
| `session.py` | The scripted session: starting forest, the 11 questions in order, and the hand-made ideal forest used only for evaluation |
| `judge_prompt.py` | Builds the LLM prompt for one new question (propose a new topic, then rate questions against topics) from a fixed template; reads the answer |
| `llm_steps/` | The prompt and the LLM's answer for every question, and which model answered (`answered_by.json`) |
| `visualization.py` | Drawing and animation of the forests, used by the notebook |
| `export/ip_forest_sequence.json` | The forest after every step of the IP run, for the prototype (Milestone 4) |
| `requirements.txt` | Python packages |

## How to run

**In Google Colab:** click the button above and run all cells. The first cell downloads this repository and installs Gurobi (its free size-limited license is enough). No API key or login is needed: the LLM answers are read from `llm_steps/`.

**Locally:** `pip install -r requirements.txt`, open `ui_optimization.ipynb`, run all cells.

## Where the proposals and scores come from

**Step by step, like the prototype.** For every new question, one prompt (`judge_prompt.step_prompt`: a fixed template filled with the current forest, the open proposals and the new question) asks the LLM to

1. **propose** at most one new topic (name and parent: a topic, a group, or a new group) if no existing topic fits the question well, and
2. **judge** the fit of the new question to every topic, and of earlier questions to the topics they have not been rated against yet (1–5).

Then Gurobi decides the step and the next question follows. The LLM only ever sees the past.

The LLM is **Claude Haiku 5.5** (`claude-haiku-5-5`), called through the Claude Code CLI on a Claude subscription: one fresh `claude -p` process per question, with no tools, no project context (`--safe-mode`), no saved session and an empty working folder. The answers are saved in `llm_steps/`; a saved answer is always reused, so the results are reproducible even though the CLI has no temperature setting.

To collect new answers (after changing the questions or the weights): delete `llm_steps/*_answer.json`, log in to Claude Code once (`claude`), and run Section 5a of the notebook. It calls the CLI for every step in order.

## The pipeline

1. **Session** (`session.py`): questions arrive one by one.
2. **Proposals and scores** (Section 5a): the LLM's proposed topics and its ratings (1–5), rescaled to a fit between 0 and 1. A proposal that is not created stays open for later questions.
3. **Optimization** (Sections 4–5): for each new question, Gurobi picks the decision that maximizes

   *fit − cost of new topics and groups − penalty for topics that are too full or too sparse − cost of moving old questions*

   The result becomes the forest for the next question.
4. **Visualization** (Section 6): the forest after every step, a step in detail, animations, and why each decision was taken (with the second-best decision and the margin).
5. **Comparison** (Section 7): the same session with three simple rules (chronological list; always use an existing topic; always take the best option), measured against a hand-made ideal forest (pairwise F1).
6. **What-if** (Section 8): re-run the session with different weights and see where the decisions change.
7. **Export** (Section 10): the IP's forest sequence as JSON for the prototype.

## What to change

| To change | Edit |
|---|---|
| Questions | `session.py`, then delete `llm_steps/*_answer.json` and re-run |
| Weights (U, L, λ, λ_G, β, µ, F) | `PARAMS` in the notebook, Section 3. This changes the IP's path and thus the prompts, so delete `llm_steps/*_answer.json` and re-run; the what-if runs (Section 8) instead reuse the saved answers |
| Look of the figures | `visualization.py` |
