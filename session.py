"""The scripted study session used in ui_optimization.ipynb.

Single source of truth: the notebook optimizes over exactly these questions and builds one LLM prompt per
question from them (judge_prompt.step_prompt). After editing the session, delete llm_steps/*_answer.json
and collect the answers again (notebook Section 5a).

The knowledge forest: groups (subjects) hold trees of topics, every question sits in one topic.
A topic's parent is a group (the topic is the root of a tree) or another topic (a branch).
"""

# groups at the start of the session: group id -> label
INITIAL_GROUPS = {
    "G1": "Deep learning",
}

# topics at the start of the session: topic id -> label and parent (a group id or a topic id)
INITIAL_TOPICS = {
    "DLB": dict(label="Deep learning basics", parent="G1"),
    "GD":  dict(label="Gradient descent",     parent="G1"),
}

# questions asked before the session: id -> text, current topic, move weight w
INITIAL_PROMPTS = {
    "p0": dict(text="Explain what deep learning is", topic="DLB", w=1.0),
    "p1": dict(text="What is gradient descent?",     topic="GD",  w=1.0),
}

# the session: the questions in the order the student asks them. The student studies deep learning,
# switches to a linear algebra exercise in between (n5, n8, n11) and comes back.
SESSION = [
    dict(id="n1",  text="What does the learning rate do?", w=1.0),
    dict(id="n2",  text="How does backpropagation compute the gradients?", w=1.0),
    dict(id="n3",  text="Chain rule through a 2-layer network", w=1.0),
    dict(id="n4",  text="SGD vs. mini-batch gradient descent", w=1.0),
    dict(id="n5",  text="How do I find the eigenvalues of a 2x2 matrix?", w=1.0),
    dict(id="n6",  text="How does Adam adapt the learning rate?", w=1.0),
    dict(id="n7",  text="Why do gradients vanish in deep networks?", w=1.0),
    dict(id="n8",  text="If a matrix has an eigenvalue 0, is it still invertible?", w=1.0),
    dict(id="n9",  text="Does the gradient shrink layer by layer with sigmoid?", w=1.0),
    dict(id="n10", text="What is momentum in SGD?", w=1.0),
    dict(id="n11", text="How is the SVD used for a low-rank approximation?", w=1.0),
]

# The ideal forest, used only for evaluation (pairwise F1, notebook Section 7), never shown to the LLM
# or the solver: question -> (group, tree, topic), i.e. how the authors would sort the questions by hand.
# Drafted before the LLM answers were collected; the labels only need to be consistent, not to match the
# LLM's topic names, because F1 compares which questions share a topic, not what the topic is called.
IDEAL = {
    "p0":  ("Deep learning", "Deep learning basics", "Deep learning basics"),
    "p1":  ("Deep learning", "Gradient descent",     "Gradient descent"),
    "n1":  ("Deep learning", "Gradient descent",     "Optimizers and learning rate"),
    "n2":  ("Deep learning", "Backpropagation",      "Backpropagation"),
    "n3":  ("Deep learning", "Backpropagation",      "Backpropagation"),
    "n4":  ("Deep learning", "Gradient descent",     "Gradient descent"),
    "n5":  ("Linear algebra", "Eigenvalues",         "Eigenvalues"),
    "n6":  ("Deep learning", "Gradient descent",     "Optimizers and learning rate"),
    "n7":  ("Deep learning", "Backpropagation",      "Vanishing gradients"),
    "n8":  ("Linear algebra", "Eigenvalues",         "Eigenvalues"),
    "n9":  ("Deep learning", "Backpropagation",      "Vanishing gradients"),
    "n10": ("Deep learning", "Gradient descent",     "Optimizers and learning rate"),
    "n11": ("Linear algebra", "SVD",                 "SVD"),
}


def all_prompts():
    """Every question of the session in order: id -> text."""
    return {**{p: d["text"] for p, d in INITIAL_PROMPTS.items()},
            **{s["id"]: s["text"] for s in SESSION}}


def topic_path(topic_id, topics, groups):
    """'Deep learning > Gradient descent > Learning rate'"""
    parts, node = [], topic_id
    while node in topics:
        parts.append(topics[node]["label"])
        node = topics[node]["parent"]
    return " > ".join([groups.get(node, node)] + parts[::-1])
