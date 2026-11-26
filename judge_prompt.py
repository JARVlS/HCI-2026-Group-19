"""The LLM-judge prompt, built from reusable parts.

The judge rates how well a student's question fits each topic of the knowledge tree (1-5). The prompt
is assembled from the same parts in two variants:

    batch_prompt(subject, topics, questions)   all questions at once. This exact text produced
                                               judge_scores.json (saved as judge_prompt.txt).
    single_prompt(subject, topics, question)   one new question: what the prototype sends through
                                               the LLM API every time the student asks something.

and the answers are read back with parse_batch / parse_single.

    topics:    {topic_id: {"label": str, "parent": subject or topic_id}}
    questions: {question_id: text}

Run `python judge_prompt.py > judge_prompt.txt` to regenerate the batch prompt for session.py.
"""
import json
import re

# ------------------------------------------------------------------ parts
ROLE = "You grade how well a student's {what} topics of a knowledge tree."

CONTEXT = ("A study tool sorts every question a student asks an AI tutor into a tree of topics about "
           '"{subject}".')

RUBRIC = """5 = the question is squarely about this topic; this is where a student would look for it.
4 = the question belongs to a more specific subtopic of this topic, and that subtopic is NOT in the list.
3 = same broader area (same subject or a neighbouring topic), but a different topic.
2 = loosely related: shares some terms or background knowledge.
1 = unrelated."""

RULES = [
    "Rate every topic{for_every} exactly once. Several topics may get the same score.",
    "Judge the meaning of the question, not shared words.",
    "If a more specific topic in the list fits exactly, give it 5; its parent then usually gets 3 or 4,\n"
    "  never 5 for the same reason.",
]
RULE_BATCH = "Rate each question on its own; ignore the other questions."

OUTPUT_BATCH = """Answer with one JSON object only, no other text. Use the ids above, include every question and every
topic, and give integer scores from 1 to 5:
{{{example}, ...}}"""

OUTPUT_SINGLE = """Answer with one JSON object only, no other text. Use the topic ids above, include every topic, and give
integer scores from 1 to 5:
{{{example}}}"""


# ------------------------------------------------------------------ helpers
def topic_path(topic_id, topics):
    """'deep learning > Gradient descent > Optimizers'"""
    parts, node = [], topic_id
    while node in topics:
        parts.append(topics[node]["label"])
        node = topics[node]["parent"]
    return " > ".join([node] + parts[::-1])


def format_topics(topics):
    return "\n".join(f'- {c}: "{t["label"]}"   (path: {topic_path(c, topics)})' for c, t in topics.items())


def format_questions(questions):
    return "\n".join(f'- {q}: "{text}"' for q, text in questions.items())


def format_rules(batch):
    rules = [r.format(for_every=" for every question" if batch else "") for r in RULES]
    if batch:
        rules.append(RULE_BATCH)
    return "\n".join(f"- {r}" for r in rules)


def _example(topics):
    return ", ".join(f'"{c}": <1-5>' for c in topics)


# ------------------------------------------------------------------ prompts
def batch_prompt(subject, topics, questions):
    """All questions at once (the prompt that produced judge_scores.json)."""
    first = next(iter(questions))
    return "\n".join([
        ROLE.format(what="questions fit"),
        "",
        CONTEXT.format(subject=subject),
        "For EACH question below, rate EACH topic independently with this rubric:",
        "",
        RUBRIC,
        "",
        "Rules:",
        format_rules(batch=True),
        "",
        "Topics (id: name, path in the tree):",
        format_topics(topics),
        "",
        "Questions (id: text):",
        format_questions(questions),
        "",
        OUTPUT_BATCH.format(example=f'"{first}": {{{_example(topics)}}}'),
    ])


def single_prompt(subject, topics, question):
    """One new question (what the prototype sends through the API for every new question)."""
    return "\n".join([
        ROLE.format(what="question fits"),
        "",
        CONTEXT.format(subject=subject),
        "Rate EACH topic below independently for this question with this rubric:",
        "",
        RUBRIC,
        "",
        "Rules:",
        format_rules(batch=False),
        "",
        f'Question: "{question}"',
        "",
        "Topics (id: name, path in the tree):",
        format_topics(topics),
        "",
        OUTPUT_SINGLE.format(example=_example(topics)),
    ])


# ------------------------------------------------------------------ answers
def _json_object(text):
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("no JSON object in the answer")
    data = json.loads(match.group(0))
    return data.get("scores", data)


def _check_row(row, topics, where):
    out = {}
    for c in topics:
        v = row.get(c)
        if v is None or not 1 <= int(v) <= 5:
            raise ValueError(f"{where}: bad or missing score for topic {c}: {v}")
        out[c] = int(v)
    return out


def parse_batch(text, questions, topics):
    """{question_id: {topic_id: score}} from the answer to batch_prompt."""
    data = _json_object(text)
    return {q: _check_row(data.get(q, {}), topics, f"question {q}") for q in questions}


def parse_single(text, topics):
    """{topic_id: score} from the answer to single_prompt."""
    return _check_row(_json_object(text), topics, "answer")


if __name__ == "__main__":
    from session import SUBJECT, all_topics, all_prompts
    print(batch_prompt(SUBJECT, all_topics(), all_prompts()))
