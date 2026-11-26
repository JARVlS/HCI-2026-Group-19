"""The scripted study session used in ui_optimization.ipynb and scored by judge.py.

Single source of truth: the notebook optimizes over exactly these prompts and topics, and judge.py
asks the LLM judge to score exactly these texts. Edit the session here, then re-run judge.py and
the notebook.
"""

SUBJECT = "deep learning"

# tree at the start of the session: topic id -> label and parent (the subject or another topic)
INITIAL_TOPICS = {
    "DLB": dict(label="Deep learning basics", parent=SUBJECT),
    "GD":  dict(label="Gradient descent",     parent=SUBJECT),
}

# prompts asked before the session: id -> text, current topic, move weight w
INITIAL_PROMPTS = {
    "p0": dict(text="Explain what deep learning is", topic="DLB", w=1.0),
    "p1": dict(text="What is gradient descent?",     topic="GD",  w=1.0),
}

# the session: one entry per new prompt, with the candidate topics proposed for it by the
# analysis step of the prototype (newNode in turnAnalysis.ts), each with the parent it would hang under
SESSION = [
    dict(id="n1", text="What does the learning rate do?", w=1.0,
         candidates={"LR": dict(label="Learning rate", parent="GD")}),
    dict(id="n2", text="How does backpropagation compute the gradients?", w=1.0,
         candidates={"BP": dict(label="Backpropagation", parent=SUBJECT)}),
    dict(id="n3", text="Chain rule through a 2-layer network", w=1.0, candidates={}),
    dict(id="n4", text="SGD vs. mini-batch gradient descent", w=1.0,
         candidates={"SGDV": dict(label="SGD variants", parent="GD")}),
    dict(id="n5", text="How does Adam adapt the learning rate?", w=1.0,
         candidates={"OPT": dict(label="Optimizers", parent="GD")}),
    dict(id="n6", text="Why do gradients vanish in deep networks?", w=1.0,
         candidates={"VG": dict(label="Vanishing gradients", parent="BP")}),
    dict(id="n7", text="Does the gradient shrink layer by layer with sigmoid?", w=1.0,
         candidates={"VG": dict(label="Vanishing gradients", parent="BP")}),
    dict(id="n8", text="What is momentum in SGD?", w=1.0, candidates={}),
]

# Author-assigned scores (1-5, same rubric as the judge). Used only if judge_scores.json does not
# exist, e.g. before the judge has been run. Missing pairs count as 1.
AUTHOR_SCORES = {
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


# ------------------------------------------------------------------ helpers
def all_topics():
    """Every topic that exists at the start or is proposed at some step: id -> label, parent."""
    topics = {c: dict(t) for c, t in INITIAL_TOPICS.items()}
    for step in SESSION:
        for c, t in step["candidates"].items():
            topics.setdefault(c, dict(t))
    return topics


def all_prompts():
    """Every prompt of the session in order: id -> text."""
    return {**{p: d["text"] for p, d in INITIAL_PROMPTS.items()},
            **{s["id"]: s["text"] for s in SESSION}}


def topic_path(topic_id, topics=None):
    """'deep learning > Gradient descent > Optimizers'"""
    topics = topics or all_topics()
    parts, node = [], topic_id
    while node in topics:
        parts.append(topics[node]["label"])
        node = topics[node]["parent"]
    return " > ".join([node] + parts[::-1])
