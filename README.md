# Milestone 3 – UI Optimization: Topic Forest

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/UxAzhangxiaohua/hci_m3/blob/main/ui_optimization.ipynb)

When a student asks the AI a new question, our prototype decides where the question goes in the student's knowledge tree. It can add it to an existing topic, open a new topic, or also move related older questions into the new topic. We solve this decision as an integer program with Gurobi, once per question, over a scripted study session.

## Files

| File | What it is |
|---|---|
| `ui_optimization.ipynb` | The main notebook: model, results, comparison, what-if analysis |
| `session.py` | The scripted session: starting tree and the 8 questions in order |
| `judge_prompt.py` | Builds the LLM prompt for one new question (propose a new topic, then rate questions against topics) from a fixed template; reads the answer |
| `llm_steps/` | The step prompts and the LLM's answers (Claude Haiku 5.5) for every question |
| `visualization.py` | Drawing and animation of the trees, used by the notebook |
| `requirements.txt` | Python packages |

## How to run

**In Google Colab:** click the button above and run all cells. The first cell downloads this repository and installs Gurobi (its free size-limited license is enough). No API key is needed: the step answers are read from `llm_steps/`.

**Locally:** `pip install -r requirements.txt`, open `ui_optimization.ipynb`, run all cells.

## Where the proposals and scores come from

**Step by step, like the prototype.** For every new question, one prompt (`judge_prompt.step_prompt`: a fixed template filled with the current tree, the open proposals and the new question) asks the LLM to

1. **propose** at most one new topic (name and parent) if no existing topic fits the question well, and
2. **judge** the fit of the new question to every topic, and of earlier questions to the topics they have not been rated against yet (1–5).

Then Gurobi decides the step and the next question follows. The LLM only ever sees the past. Prompts and answers are kept in `llm_steps/`.

The notebook gets the answers in this order (Section 5a); it stops until every step has its answer:

| Source | When | What happens |
|---|---|---|
| Files | `llm_steps/<id>_answer.json` exists | the saved answer is used (this is what Colab does) |
| API | `ANTHROPIC_API_KEY` is set | the notebook calls `claude-haiku-5-5` for every step |
| Claude Code CLI | `claude` is installed and logged in | one fresh `claude -p` call per step (no tools, empty folder, no session kept), on the Claude subscription |
| Manual | none of the above | paste `llm_steps/<id>_prompt.txt` into a new chat (memory off), save the reply as `llm_steps/<id>_answer.json`, re-run (8 times) |

## The pipeline

1. **Session** (`session.py`): questions arrive one by one.
2. **Proposals and scores** (Section 5a, step by step): the LLM's proposed topics and its ratings (1–5), rescaled to a fit between 0 and 1. A proposal that is not created stays open for later questions.
3. **Optimization** (notebook, Section 4–5): for each new question, Gurobi picks the placement that maximizes

   *fit − cost of new topics − penalty for topics that are too full or too sparse − cost of moving old questions*

   The result becomes the tree for the next question.
4. **Visualization** (Section 6): the tree after every step, a step in detail, and animations.
5. **Comparison** (Section 7): the same session with two simple rules (always use an existing topic; always take the best proposal).
6. **What-if** (Section 8): re-run the session with different weights and see where the decisions change.

## What to change

| To change | Edit |
|---|---|
| Questions | `session.py`, then regenerate the prompt and the LLM answer |
| Weights (U, L, λ, β, µ, F) | `PARAMS` in the notebook, Section 3 |
| Look of the figures | `visualization.py` |
