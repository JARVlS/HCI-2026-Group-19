# Milestone 3 – UI Optimization: Topic Forest

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/UxAzhangxiaohua/hci_m3/blob/main/ui_optimization.ipynb)

When a student asks the AI a new question, our prototype sorts it into the student's knowledge forest: groups (one per subject) hold trees of topics, and every question sits in one topic. After every question the system decides one of five outcomes: (a) add to an existing topic, (b) new branch, (c) new tree, (d) new group, (e) restructure (older questions move; a topic left empty is deleted). We solve this decision as an integer program with Gurobi, once per question, over a scripted study session of 11 questions. The objective is the time the student spends finding earlier questions again, predicted by a user model of the tree view, plus the one-time cost of getting used to changes.

```
new prompt + current forest -> [LLM judge] -> proposal and scores -> [integer program, Gurobi] -> new forest + outcome
```

## Files

| File | What it is |
|---|---|
| `ui_optimization.ipynb` | The main notebook: model, results, comparison, what-if analysis |
| `session.py` | The scripted session: starting forest (with an overloaded topic), the 11 questions in order, and the hand-made ideal forest used only for evaluation |
| `judge.py` | The LLM judge: builds the prompt for one new question (propose a new topic, then rate questions against topics) from a fixed template, reads the JSON answer, and gets the answer of a step (`judge.answer`: the saved one, or a new one from Claude Haiku 5.5 through the Anthropic API or the Claude Code CLI) |
| `llm_steps/` | The prompt and the LLM's answer for every question, and which model answered (`answered_by.json`) |
| `forest.py` | Bookkeeping of the forest: states, open proposals, applying a decision, naming the outcome (a)–(e), the chronological baseline H0, replaying the LLM answers along the IP's path, and the export |
| `visualization.py` | Figures, animations and tables of the notebook |
| `export/ip_forest_sequence.json` | The forest after every step of the IP run, for the prototype (Milestone 4) |
| `requirements.txt` | Python packages |

## How to run

No API key or login is needed: the LLM answers are read from `llm_steps/`. The free size-limited Gurobi license that comes with `pip install gurobipy` is enough.

**Locally (the default).** Tested with Python 3.12, 3.13 and 3.14 (identical results). In this folder:

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt    # pinned to the versions of our .venv; includes ipykernel for VS Code
```

Open `ui_optimization.ipynb` in VS Code, choose the kernel of `.venv` (*Select Kernel → Python Environments → .venv*) and run all cells. For Jupyter Lab instead, also `pip install jupyterlab` and run `jupyter lab ui_optimization.ipynb`. The notebook needs `session.py`, `judge.py`, `visualization.py` and `llm_steps/` next to it; locally it never downloads anything, and the first cell stops with a clear error if one of them is missing.

In VS Code, choose the `.venv` kernel again after re-creating the environment: a kernel that points to an old or another project's environment fails with "notebook controller is DISPOSED".

**In Google Colab (optional).** Click the button above and run all cells. In Colab only, the first cell downloads this repository from GitHub and installs Gurobi; everything else is the same as locally.

## Where the proposals and scores come from

**Step by step, like the prototype.** For every new question, one prompt (`judge.step_prompt`: a fixed template filled with the current forest, the open proposals and the new question) asks the LLM to

1. **propose** at most one new topic (name and parent: a topic, a group, or a new group) if no existing topic fits the question well, and
2. **judge** the fit of the new question to every topic, and of earlier questions to the topics they have not been rated against yet (1–5).

Then Gurobi decides the step and the next question follows. The LLM only ever sees the past.

The LLM is **Claude Haiku 5.5** (`claude-haiku-5-5`), one fresh conversation per question that answers with one JSON object. `judge.ask` calls it through the Anthropic API if `ANTHROPIC_API_KEY` is set (temperature 0), otherwise through the Claude Code CLI on a logged-in Claude subscription (one fresh `claude -p` process: no tools, no project context, no saved session, an empty working folder; no temperature setting). The saved answers were collected with the CLI. A saved answer is always reused, so the results are reproducible.

**The notebook is a simulation from these frozen answers.** They were collected once (27 Nov 2026). Every run replays them: at each step the prompt is rebuilt from the forest the IP produced and must equal the saved prompt, so the replay follows exactly the path on which the answers were given. No LLM is called; the baselines and the what-if runs reuse the same answers.

To collect new answers (only after changing the questions or the parameters): delete `llm_steps/*_answer.json`, set `ANTHROPIC_API_KEY` or log in to Claude Code once (`claude`), and run the notebook. Section 5a asks Haiku for every step in order and saves the answers.

## The pipeline

1. **Session** (`session.py`): questions arrive one by one.
2. **Proposals and scores** (Section 5a): the LLM's proposed topics and its ratings (1–5), rescaled to a fit between 0 and 1. A proposal that is not created stays open for later questions.
3. **User model** (Section 4a): the time to look up a question in the tree view, in seconds: choosing a branch at every level (Hick–Hyman law), reading the questions of its topic one by one, and scanning the whole history if the question is misfiled.
4. **Optimization** (Sections 4b–5): for each new question, Gurobi picks the decision that minimizes

   *H × (lookup time of every question) + reading new labels once + moved questions looked for in their old place + re-orientation after a restructure*

   a mixed-integer linear program (the products in the lookup time are linearized). The result becomes the forest for the next question.
5. **Visualization** (Section 6): the forest after every step, a step in detail, animations, and why each decision was taken (with the second-best decision and the margin).
6. **Comparison** (Section 7): the same session with three simple rules (chronological list; always use an existing topic; always take the best option), measured by the user model (lookup time) and against a hand-made ideal forest (pairwise F1).
7. **What-if** (Section 8): re-run the session with different parameters (H, F, R, a) and see where the decisions change.
8. **Export** (Section 10): the IP's forest sequence as JSON for the prototype.

## What to change

| To change | Edit |
|---|---|
| Questions | `session.py`, then delete `llm_steps/*_answer.json` and re-run |
| Parameters (H, a, b, R, λ, λ_G, F) | `PARAMS` in the notebook, Section 3. This changes the IP's path and thus the prompts, so delete `llm_steps/*_answer.json` and re-run; the what-if runs (Section 8) instead reuse the saved answers |
| Look of the figures | `visualization.py` |
