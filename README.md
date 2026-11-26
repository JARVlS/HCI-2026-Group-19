# Milestone 3 – UI Optimization: Topic Forest

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/UxAzhangxiaohua/hci_m3/blob/main/ui_optimization.ipynb)

When a student asks the AI a new question, our prototype decides where the question goes in the student's knowledge tree. It can add it to an existing topic, open a new topic, or also move related older questions into the new topic. We solve this decision as an integer program with Gurobi, once per question, over a scripted study session.

## Files

| File | What it is |
|---|---|
| `ui_optimization.ipynb` | The main notebook: model, results, comparison, what-if analysis |
| `session.py` | The scripted session: starting tree, 8 questions, proposed new topics |
| `judge.py` | Asks an LLM to score how well each question fits each topic |
| `visualization.py` | Drawing and animation of the trees, used by the notebook |
| `judge_scores.json` | Created by `judge.py`: the scores plus model, date, prompt and raw answers |
| `human_ratings.csv` | Optional: the same pairs rated by two group members, to check the judge |
| `requirements.txt` | Python packages |

## How to run

**In Google Colab:** click the button above and run all cells. The first cell downloads this repository and installs Gurobi (its free size-limited license is enough). The judge scores are read from `judge_scores.json` in the repository, so no API key is needed.

**Locally:**

```bash
pip install -r requirements.txt

# 1. Score the session with the LLM judge (once)
export ANTHROPIC_API_KEY=...
python judge.py                  # writes judge_scores.json (commit it, so Colab uses the same scores)

# 2. Optional: check the judge against humans
python judge.py --rating-sheet human_ratings.csv
#    two group members fill the columns rater_A and rater_B (1-5) independently

# 3. Open ui_optimization.ipynb and run all cells
```

Without `judge_scores.json` the notebook still runs, using scores written by the authors (`AUTHOR_SCORES` in `session.py`), and says so.

## The pipeline

1. **Session** (`session.py`): questions arrive one by one. For some, the analysis step proposes a new topic and where it would go in the tree.
2. **Scores** (`judge.py`): the LLM rates every question against every topic from 1 to 5 (3 runs, median). The notebook rescales this to a fit between 0 and 1.
3. **Optimization** (notebook, Section 4–5): for each new question, Gurobi picks the placement that maximizes

   *fit − cost of new topics − penalty for topics that are too full or too sparse − cost of moving old questions*

   The result becomes the tree for the next question.
4. **Visualization** (Section 6): the tree after every step, a step in detail, and animations.
5. **Comparison** (Section 7): the same session with two simple rules (always use an existing topic; always take the best proposal).
6. **What-if** (Section 8): re-run the session with different weights and see where the decisions change.

## What to change

| To change | Edit |
|---|---|
| Questions or proposed topics | `session.py`, then re-run `judge.py` |
| Weights (U, L, λ, β, µ, F) | `PARAMS` in the notebook, Section 3 |
| Look of the figures | `visualization.py` |

## Never commit API keys

`judge.py` reads the key from the environment variable `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`). In Colab, store it under *Secrets* (key icon on the left) and load it with `from google.colab import userdata; os.environ["ANTHROPIC_API_KEY"] = userdata.get("ANTHROPIC_API_KEY")`.
