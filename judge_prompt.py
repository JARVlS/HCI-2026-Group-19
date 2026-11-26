"""The LLM prompt that PROPOSES new topics and then JUDGES the fit of questions to topics.

One prompt, two tasks:
  1. propose  - for a question, suggest at most one new topic (name + parent) if no topic fits it well;
  2. judge    - rate how well questions fit topics (1-5, rubric below), including the new proposals.

step_prompt(subject, topics, placed, questions, question) builds the prompt for one new question: what
the prototype sends through the LLM API every time the student asks something. It shows only the tree so
far and the new question, never a later one. Answers are read back with parse_step.

    topics:    {topic_id: {"label": str, "parent": subject or topic_id}}
    questions: {question_id: text}
    placed:    {question_id: topic_id} for questions already in the tree
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
(b) each earlier question against the topics listed for it here, plus against NEW if you propose one:
{missing}

Topics in the tree and open proposals (id: name, path, questions it contains):
{topics}

Earlier questions (id: text):
{earlier}

NEW question: "{question}"

Answer with one JSON object only, no other text, in exactly this form:
{{"proposal": {{"id": "NEW", "name": "<1-3 words>", "parent": "<topic id or ROOT>"}} or null,
 "new_question": {{{example}, "NEW": <1-5>}},
 "earlier_questions": {{"<question id>": {{"<listed topic id>": <1-5>, ..., "NEW": <1-5>}}, ...}}}}"""


def format_missing(placed, missing):
    lines = []
    for q in placed:
        listed = (missing or {}).get(q, [])
        lines.append(f"- {q}: {', '.join(listed)}" if listed else f"- {q}: (only NEW, if you propose one)")
    return "\n".join(lines)


def step_prompt(subject, topics, placed, questions, question, open_ids=(), missing=None):
    """topics: the tree's topics plus open (not yet created) proposals, whose ids are open_ids;
    placed: question -> topic for the earlier questions; questions: their texts; question: the text of
    the new question; missing: earlier question -> topic ids it has not been rated against yet
    (in the prototype usually empty after the first step: then only NEW is asked)."""
    return STEP_TEMPLATE.format(
        context=CONTEXT.format(subject=subject),
        propose_rules=PROPOSE_RULES.format(subject=subject),
        rubric=RUBRIC, judge_rules=JUDGE_RULES,
        topics=format_topics(topics, placed, open_ids),
        earlier=format_questions({q: questions[q] for q in placed}),
        question=question,
        missing=format_missing(placed, missing),
        example=", ".join(f'"{c}": <1-5>' for c in topics))


def parse_step(text, subject, topics, placed, missing=None):
    """-> (proposal or None, scores of the new question {topic: 1..5},
    scores of earlier questions {question: {topic: 1..5}} for their missing topics and NEW)."""
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
    rows = data.get("earlier_questions") or {}
    earlier = {}
    for q in placed:
        wanted = list((missing or {}).get(q, [])) + (["NEW"] if proposal else [])
        if wanted:
            earlier[q] = _check_row(rows.get(q, {}), {c: None for c in wanted}, f"earlier question {q}")
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

