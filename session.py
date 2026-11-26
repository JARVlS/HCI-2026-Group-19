"""The scripted study session used in ui_optimization.ipynb.

Single source of truth: the notebook optimizes over exactly these questions, and the LLM prompt
(judge_prompt.py -> judge_prompt.txt) is built from them. The LLM proposes the new topics and rates
every question against every topic; its answer is stored as judge_scores.json. After editing the session:
    python judge_prompt.py > judge_prompt.txt
then send judge_prompt.txt to the model, save its JSON answer as judge_scores.json and re-run the notebook.
"""

SUBJECT = "deep learning"

# tree at the start of the session: topic id -> label and parent (the subject or another topic)
INITIAL_TOPICS = {
    "DLB": dict(label="Deep learning basics", parent=SUBJECT),
    "GD":  dict(label="Gradient descent",     parent=SUBJECT),
}

# questions asked before the session: id -> text, current topic, move weight w
INITIAL_PROMPTS = {
    "p0": dict(text="Explain what deep learning is", topic="DLB", w=1.0),
    "p1": dict(text="What is gradient descent?",     topic="GD",  w=1.0),
}

# the session: the questions in the order the student asks them
SESSION = [
    dict(id="n1", text="What does the learning rate do?", w=1.0),
    dict(id="n2", text="How does backpropagation compute the gradients?", w=1.0),
    dict(id="n3", text="Chain rule through a 2-layer network", w=1.0),
    dict(id="n4", text="SGD vs. mini-batch gradient descent", w=1.0),
    dict(id="n5", text="How does Adam adapt the learning rate?", w=1.0),
    dict(id="n6", text="Why do gradients vanish in deep networks?", w=1.0),
    dict(id="n7", text="Does the gradient shrink layer by layer with sigmoid?", w=1.0),
    dict(id="n8", text="What is momentum in SGD?", w=1.0),
]


def all_prompts():
    """Every question of the session in order: id -> text."""
    return {**{p: d["text"] for p, d in INITIAL_PROMPTS.items()},
            **{s["id"]: s["text"] for s in SESSION}}


# ------------------------------------------------------------------ fallback (no LLM output yet)
# Proposals and scores written by the authors, used only if judge_scores.json does not exist or
# contains scores only. Same format as the LLM output: question id -> proposed topic (or nothing).
AUTHOR_PROPOSALS = {
    "n1": dict(id="LR",   label="Learning rate",       parent="GD"),
    "n2": dict(id="BP",   label="Backpropagation",     parent=SUBJECT),
    "n4": dict(id="SGDV", label="SGD variants",        parent="GD"),
    "n5": dict(id="OPT",  label="Optimizers",          parent="GD"),
    "n6": dict(id="VG",   label="Vanishing gradients", parent="BP"),
}

AUTHOR_SCORES = {   # 1-5, missing pairs = 1
    "p0": {"DLB": 5, "GD": 2, "BP": 2, "VG": 2},
    "p1": {"GD": 5, "DLB": 2, "OPT": 3, "BP": 2, "SGDV": 3, "LR": 2},
    "n1": {"GD": 4, "LR": 5, "OPT": 3},
    "n2": {"BP": 5, "GD": 3, "DLB": 2, "VG": 3},
    "n3": {"BP": 5, "GD": 2, "VG": 2},
    "n4": {"GD": 4, "SGDV": 5, "OPT": 4},
    "n5": {"OPT": 5, "GD": 3, "LR": 3, "SGDV": 2},
    "n6": {"VG": 5, "BP": 4, "GD": 2, "DLB": 2},
    "n7": {"VG": 5, "BP": 4, "DLB": 2},
    "n8": {"OPT": 5, "GD": 4, "SGDV": 3},
}


def topic_path(topic_id, topics):
    """'deep learning > Gradient descent > Optimizers'"""
    parts, node = [], topic_id
    while node in topics:
        parts.append(topics[node]["label"])
        node = topics[node]["parent"]
    return " > ".join([node] + parts[::-1])
