"""The LLM prompt that PROPOSES new topics and then JUDGES the fit of questions to topics.

One prompt, two tasks:
  1. propose  - for a question, suggest at most one new topic (name + parent) if no topic fits it well;
  2. judge    - rate how well questions fit topics (1-5, rubric below), including the new proposals.

Two variants built from the same parts:
    batch_prompt(subject, topics, questions, placed)   the whole scripted session at once. This exact
                                                       text produced judge_scores.json (judge_prompt.txt).
    step_prompt(subject, topics, placed, questions, question)
                                                       one new question: what the prototype sends through
                                                       the LLM API every time the student asks something.
Answers are read back with parse_batch / parse_step.

    topics:    {topic_id: {"label": str, "parent": subject or topic_id}}
    questions: {question_id: text}
    placed:    {question_id: topic_id} for questions already in the tree

Run `python judge_prompt.py > judge_prompt.txt` to regenerate the batch prompt for session.py.
"""
import json
import re

ROOT = "ROOT"          # parent id meaning "directly under the subject"

# ------------------------------------------------------------------ parts
CONTEXT = ('You help a study tool that sorts the questions a student asks an AI tutor into a knowledge tree '
           'about "{subject}".')

RUBRIC = """5 = the question is squarely about this topic; this is where a student would look for it.
4 = the question belongs to a more specific subtopic of this topic, and that subtopic is NOT in the list.
3 = same broader area (same subject or a neighbouring topic), but a different topic.
2 = loosely related: shares some terms or background knowledge.
1 = unrelated."""

PROPOSE_RULES = """- Propose a new topic only if the question would get 5 for it and at most 4 for every topic that
  exists at that point. Otherwise propose nothing (null).
- At most one new topic per question. Name it in 1-3 words, as a student would label a folder.
- Choose the most specific fitting parent: an existing topic id, or ROOT to put it directly under
  "{subject}".
- Never propose a topic that already exists or was already proposed (same meaning, other words)."""

JUDGE_RULES = """- Judge the meaning of the question, not shared words.
- If a more specific topic in the list fits exactly, give it 5; its parent then usually gets 3 or 4,
  never 5 for the same reason.
- Several topics may get the same score."""


# ------------------------------------------------------------------ helpers
def topic_path(topic_id, topics):
    """'deep learning > Gradient descent > Optimizers'"""
    parts, node = [], topic_id
    while node in topics:
        parts.append(topics[node]["label"])
        node = topics[node]["parent"]
    return " > ".join([node] + parts[::-1])


def format_topics(topics, placed=None, open_ids=()):
    lines = []
    for c, t in topics.items():
        line = f'- {c}: "{t["label"]}"   (path: {topic_path(c, topics)})'
        if c in open_ids:
            line += "   open proposal, not in the tree yet"
        elif placed is not None:
            inside = [q for q, tc in placed.items() if tc == c]
            line += f"   contains: {', '.join(inside) if inside else '-'}"
        lines.append(line)
    return "\n".join(lines)


def format_questions(questions, placed=None):
    out = []
    for q, text in questions.items():
        where = f"   (already in the tree, in {placed[q]})" if placed and q in placed else ""
        out.append(f'- {q}: "{text}"{where}')
    return "\n".join(out)


# ------------------------------------------------------------------ batch: the whole session
BATCH_TEMPLATE = """{context}
The student asks the questions below one after another. Do two tasks.

TASK 1 - PROPOSE NEW TOPICS
Go through the NEW questions in order (the ones not already in the tree). For each one, decide whether
the tree needs a new topic for it. When deciding, use only that question and the topics that exist at
that point: the starting topics plus the topics you proposed for EARLIER questions (later questions
do not exist yet).
{propose_rules}
- Give the proposed topics the ids T1, T2, ... in the order you propose them. A proposed topic may have
  an earlier proposed topic as parent.

TASK 2 - RATE
Rate EVERY question (including the ones already in the tree) against EVERY topic (the starting topics
and all topics you proposed) with this rubric:

{rubric}

Rules:
{judge_rules}
- Rate each question on its own; ignore the other questions.

Starting topics (id: name, path in the tree):
{topics}

Questions in the order they are asked (id: text):
{questions}

Answer with one JSON object only, no other text, in exactly this form:
{{"proposals": {{"{first_new}": {{"id": "T1", "name": "<1-3 words>", "parent": "<topic id or ROOT>"}}, "{second_new}": null, ...}},
 "scores": {{"{first}": {{{example}, "T1": <1-5>, ...}}, ...}}}}
Include every new question in "proposals" (null if no new topic) and every question with every topic
(starting and proposed) in "scores"; scores are integers from 1 to 5."""


def batch_prompt(subject, topics, questions, placed):
    new = [q for q in questions if q not in placed]
    return BATCH_TEMPLATE.format(
        context=CONTEXT.format(subject=subject),
        propose_rules=PROPOSE_RULES.format(subject=subject),
        rubric=RUBRIC, judge_rules=JUDGE_RULES,
        topics=format_topics(topics),
        questions=format_questions(questions, placed),
        first_new=new[0], second_new=new[1] if len(new) > 1 else new[0],
        first=next(iter(questions)),
        example=", ".join(f'"{c}": <1-5>' for c in topics))


def parse_batch(text, subject, topics, questions, placed):
    """-> (proposals {question: {"id","label","parent"}}, scores {question: {topic: 1..5}}).
    Proposed parents are mapped from ROOT to the subject; every pair must be rated."""
    data = _json_object(text)
    proposals, known = {}, dict(topics)
    for q in questions:
        if q in placed:
            continue
        p = (data.get("proposals") or {}).get(q)
        if p:
            pid, parent = str(p["id"]), str(p["parent"])
            parent = subject if parent == ROOT else parent
            if pid in known:
                raise ValueError(f"proposal for {q}: id {pid} already used")
            if parent != subject and parent not in known:
                raise ValueError(f"proposal for {q}: unknown parent {parent}")
            proposals[q] = dict(id=pid, label=str(p["name"]), parent=parent)
            known[pid] = dict(label=str(p["name"]), parent=parent)
    scores = {q: _check_row((data.get("scores") or {}).get(q, {}), known, f"question {q}") for q in questions}
    return proposals, scores


# ------------------------------------------------------------------ step: one new question (prototype)
STEP_TEMPLATE = """{context}
A new question arrived. Do two tasks.

TASK 1 - PROPOSE
Decide whether the tree needs a new topic for the NEW question.
{propose_rules}
- Use the id NEW for your proposal.

TASK 2 - RATE with this rubric:

{rubric}

Rules:
{judge_rules}

Rate (a) the NEW question against EVERY topic below and against your proposal NEW (if any), and
(b) EVERY earlier question against your proposal NEW only (skip (b) if you propose nothing).

Topics in the tree and open proposals (id: name, path, questions it contains):
{topics}

Earlier questions (id: text):
{earlier}

NEW question: "{question}"

Answer with one JSON object only, no other text, in exactly this form:
{{"proposal": {{"id": "NEW", "name": "<1-3 words>", "parent": "<topic id or ROOT>"}} or null,
 "new_question": {{{example}, "NEW": <1-5>}},
 "earlier_questions": {{"<question id>": {{"NEW": <1-5>}}, ...}}}}"""


def step_prompt(subject, topics, placed, questions, question, open_ids=()):
    """topics: the tree's topics plus open (not yet created) proposals, whose ids are open_ids;
    placed: question -> topic for the earlier questions; questions: their texts; question: the text of
    the new question."""
    return STEP_TEMPLATE.format(
        context=CONTEXT.format(subject=subject),
        propose_rules=PROPOSE_RULES.format(subject=subject),
        rubric=RUBRIC, judge_rules=JUDGE_RULES,
        topics=format_topics(topics, placed, open_ids),
        earlier=format_questions({q: questions[q] for q in placed}),
        question=question,
        example=", ".join(f'"{c}": <1-5>' for c in topics))


def parse_step(text, subject, topics, placed):
    """-> (proposal or None, scores of the new question {topic: 1..5}, scores of earlier questions
    for the proposal {question: 1..5})."""
    data = _json_object(text)
    p = data.get("proposal")
    proposal, known = None, dict(topics)
    if p:
        parent = subject if str(p["parent"]) == ROOT else str(p["parent"])
        if parent != subject and parent not in topics:
            raise ValueError(f"unknown parent {parent}")
        proposal = dict(id="NEW", label=str(p["name"]), parent=parent)
        known["NEW"] = proposal
    new_scores = _check_row(data.get("new_question", {}), known, "new question")
    earlier = {}
    if proposal:
        rows = data.get("earlier_questions", {})
        earlier = {q: _check_row(rows.get(q, {}), {"NEW": None}, f"earlier question {q}")["NEW"] for q in placed}
    return proposal, new_scores, earlier


# ------------------------------------------------------------------ answers
def _json_object(text):
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("no JSON object in the answer")
    return json.loads(match.group(0))


def _check_row(row, topics, where):
    out = {}
    for c in topics:
        v = row.get(c)
        if v is None or not 1 <= int(v) <= 5:
            raise ValueError(f"{where}: bad or missing score for topic {c}: {v}")
        out[c] = int(v)
    return out


if __name__ == "__main__":
    from session import SUBJECT, INITIAL_TOPICS, INITIAL_PROMPTS, all_prompts
    print(batch_prompt(SUBJECT, INITIAL_TOPICS, all_prompts(), {p: d["topic"] for p, d in INITIAL_PROMPTS.items()}))
