"""The scripted study session used in ui_optimization.ipynb.

Single source of truth: the notebook optimizes over exactly these questions and builds one LLM prompt per
question from them (judge.step_prompt). After editing the session, delete llm_steps/*_answer.json
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
    "NN": dict(label="Neural networks",  parent="G1"),
    "GD": dict(label="Gradient descent", parent="G1"),
}

# questions asked before the session: id -> text, current topic. The student has used the app before, while the
# forest was still coarse: "Gradient descent" has grown long and holds two questions about the learning rate.
INITIAL_PROMPTS = {
    "p0": dict(text="What does an activation function do?", topic="NN"),
    "p1": dict(text="Why does a neural network need hidden layers?", topic="NN"),
    "p2": dict(text="What is gradient descent?", topic="GD"),
    "p3": dict(text="How do I pick a good learning rate?", topic="GD"),
    "p4": dict(text="Why does my loss explode when the learning rate is too high?", topic="GD"),
    "p5": dict(text="What is the difference between a local and a global minimum?", topic="GD"),
}

# the session: the questions in the order the student asks them. The student studies deep learning, switches to a
# linear algebra exercise in between (n3, n7, n10) and comes back. Chosen so that every outcome (a)-(e) can occur:
# a long topic that may be split (n1), themes whose first question may wait for a second one (activation
# functions: n2, n6; optimizers: n8, n9), a new subject (n3) and new trees in existing groups (n4, n10, n11).
SESSION = [
    dict(id="n1",  text="What does the learning rate do?"),
    dict(id="n2",  text="Why is ReLU used instead of sigmoid?"),
    dict(id="n3",  text="How do I find the eigenvalues of a 2x2 matrix?"),
    dict(id="n4",  text="How does backpropagation compute the gradients?"),
    dict(id="n5",  text="Chain rule through a 2-layer network"),
    dict(id="n6",  text="What does the softmax function output?"),
    dict(id="n7",  text="If a matrix has an eigenvalue 0, is it still invertible?"),
    dict(id="n8",  text="How does Adam adapt the learning rate?"),
    dict(id="n9",  text="What is momentum in SGD?"),
    dict(id="n10", text="How is the SVD used for a low-rank approximation?"),
    dict(id="n11", text="How does dropout reduce overfitting?"),
]

# The ideal forest, used only for evaluation (pairwise F1, notebook Section 7), never shown to the LLM
# or the solver: question -> (group, tree, topic), i.e. how the authors would sort the questions by hand.
# Written before the LLM answers were collected; the labels only need to be consistent, not to match the
# LLM's topic names, because F1 compares which questions share a topic, not what the topic is called.
IDEAL = {
    "p0":  ("Deep learning", "Neural networks",  "Activation functions"),
    "p1":  ("Deep learning", "Neural networks",  "Neural networks"),
    "p2":  ("Deep learning", "Gradient descent", "Gradient descent"),
    "p3":  ("Deep learning", "Gradient descent", "Learning rate"),
    "p4":  ("Deep learning", "Gradient descent", "Learning rate"),
    "p5":  ("Deep learning", "Gradient descent", "Gradient descent"),
    "n1":  ("Deep learning", "Gradient descent", "Learning rate"),
    "n2":  ("Deep learning", "Neural networks",  "Activation functions"),
    "n3":  ("Linear algebra", "Eigenvalues",     "Eigenvalues"),
    "n4":  ("Deep learning", "Backpropagation",  "Backpropagation"),
    "n5":  ("Deep learning", "Backpropagation",  "Backpropagation"),
    "n6":  ("Deep learning", "Neural networks",  "Activation functions"),
    "n7":  ("Linear algebra", "Eigenvalues",     "Eigenvalues"),
    "n8":  ("Deep learning", "Gradient descent", "Optimizers"),
    "n9":  ("Deep learning", "Gradient descent", "Optimizers"),
    "n10": ("Linear algebra", "SVD",             "SVD"),
    "n11": ("Deep learning", "Regularization",   "Regularization"),
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
