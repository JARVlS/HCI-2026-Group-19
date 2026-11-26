"""The scripted study session used in ui_optimization.ipynb.

Single source of truth: the notebook optimizes over exactly these questions and builds one LLM prompt per
question from them (judge_prompt.step_prompt). After editing the session, delete llm_steps/*_answer.json
and collect the answers again (notebook Section 5a).
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


def topic_path(topic_id, topics):
    """'deep learning > Gradient descent > Optimizers'"""
    parts, node = [], topic_id
    while node in topics:
        parts.append(topics[node]["label"])
        node = topics[node]["parent"]
    return " > ".join([node] + parts[::-1])
