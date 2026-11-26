"""The LLM prompt that PROPOSES a new topic and JUDGES the fit of questions to topics.

One prompt per new question, two tasks:
  1. propose  - suggest at most one new topic (name + parent) if no topic fits the new question well; the
                parent is an existing topic (new branch), an existing group (new tree) or a new group;
  2. judge    - rate how well questions fit topics (1-5, rubric below), including the new proposal.

step_prompt(...) builds the prompt for one new question: what the prototype sends to the LLM every time the
student asks something. It shows only the forest so far and the new question, never a later one. Answers are
read back with parse_step.

    groups:    {group_id: label}                                   groups that exist
    topics:    {topic_id: {"label": str, "parent": group_id or topic_id}}
               the forest's topics plus the open proposals (ids in open_ids)
    questions: {question_id: text}
    placed:    {question_id: topic_id} for questions already in the forest
"""
import json
import re

NEW_GROUP = "NEW_GROUP:"   # parent prefix of a proposal that opens a new group

# ------------------------------------------------------------------ parts
CONTEXT = ("You help a study tool that sorts the questions a student asks an AI tutor into a knowledge forest: "
           "groups (one per subject) hold trees of topics, and every question sits in one topic.")

RUBRIC = """5 = the question is squarely about this topic; this is where a student would look for it.
4 = the question belongs to a more specific subtopic of this topic, and that subtopic is NOT in the list.
3 = same broader area (same subject or a neighbouring topic), but a different topic.
2 = loosely related: shares some terms or background knowledge.
1 = unrelated."""

PROPOSE_RULES = """- Propose a new topic only if the question would get 5 for it and at most 4 for every topic listed
  below (including the open proposals). Otherwise propose nothing (null).
- At most one new topic. Name it in 1-3 words, as a student would label a folder.
- Choose its parent:
  * the most specific fitting topic id from "Topics in the forest" (a new branch), or
  * a group id, to start a new tree in that subject, or
  * "NEW_GROUP: <subject name>" if the question belongs to a subject that has no group yet.
  An open proposal cannot be a parent.
- Never propose a topic that already exists or was already proposed (same meaning, other words)."""

JUDGE_RULES = """- Judge the meaning of the question, not shared words.
- If a more specific topic in the list fits exactly, give it 5; its parent then usually gets 3 or 4,
  never 5 for the same reason.
- Several topics may get the same score."""


# ------------------------------------------------------------------ helpers
def topic_path(topic_id, topics, groups):
    """'Deep learning > Gradient descent > Learning rate'"""
    parts, node = [], topic_id
    while node in topics:
        parts.append(topics[node]["label"])
        node = topics[node]["parent"]
    return " > ".join([groups.get(node, node)] + parts[::-1])


def format_groups(groups):
    return "\n".join(f'- {g}: "{label}"' for g, label in groups.items())


def format_topics(topics, groups, placed, open_ids=()):
    lines = []
    for c, t in topics.items():
        if c in open_ids:
            continue
        inside = [q for q, tc in placed.items() if tc == c]
        lines.append(f'- {c}: "{t["label"]}"   (path: {topic_path(c, topics, groups)})'
                     f"   contains: {', '.join(inside) if inside else '-'}")
    return "\n".join(lines)


def format_open(topics, groups, open_ids):
    lines = [f'- {c}: "{topics[c]["label"]}"   (would be: {topic_path(c, topics, groups)})' for c in open_ids]
    return "\n".join(lines) if lines else "(none)"


def format_questions(questions):
    return "\n".join(f'- {q}: "{text}"' for q, text in questions.items())


def format_missing(placed, missing):
    lines = []
    for q in placed:
        listed = (missing or {}).get(q, [])
        lines.append(f"- {q}: {', '.join(listed)}, NEW" if listed else f"- {q}: NEW")
    return "\n".join(lines)


# ------------------------------------------------------------------ step: one new question
STEP_TEMPLATE = """{context}
A new question arrived. Do two tasks.

TASK 1 - PROPOSE
Decide whether the forest needs a new topic for the NEW question.
{propose_rules}
- Use the id NEW for your proposal.

TASK 2 - RATE with this rubric:

{rubric}

Rules:
{judge_rules}

Rate (a) the NEW question against EVERY topic and open proposal below and against your proposal NEW (if
any), and (b) each earlier question against the ids listed for it here (NEW only if you propose one):
{missing}

Groups (id: subject):
{groups}

Topics in the forest (id: name, path, questions it contains):
{topics}

Open proposals (id: name, where it would go; not in the forest yet, cannot be a parent):
{open}

Earlier questions (id: text):
{earlier}

NEW question: "{question}"

Answer with one JSON object only, no other text, in exactly this form:
{{"proposal": {{"id": "NEW", "name": "<1-3 words>", "parent": "<topic id, group id or NEW_GROUP: <subject>>"}} or null,
 "new_question": {{{example}, "NEW": <1-5>}},
 "earlier_questions": {{"<question id>": {{"<listed id>": <1-5>, ..., "NEW": <1-5>}}, ...}}}}"""


def step_prompt(groups, topics, placed, questions, question, open_ids=(), missing=None, all_groups=None):
    """groups: the groups that exist; all_groups: also the groups that open proposals would create (only
    used to print their paths); topics: the forest's topics plus the open proposals (ids in open_ids);
    placed: question -> topic for the earlier questions; questions: their texts; question: the text of the
    new question; missing: earlier question -> topic ids it has not been rated against yet."""
    return STEP_TEMPLATE.format(
        context=CONTEXT,
        propose_rules=PROPOSE_RULES,
        rubric=RUBRIC, judge_rules=JUDGE_RULES,
        groups=format_groups(groups),
        topics=format_topics(topics, all_groups or groups, placed, open_ids),
        open=format_open(topics, all_groups or groups, open_ids),
        earlier=format_questions({q: questions[q] for q in placed}),
        question=question,
        missing=format_missing(placed, missing),
        example=", ".join(f'"{c}": <1-5>' for c in topics))


def parse_step(text, groups, topics, placed, missing=None, open_ids=()):
    """-> (proposal or None, scores of the new question {topic: 1..5},
    scores of earlier questions {question: {topic: 1..5}} for their missing topics and NEW).
    proposal = {"label", "parent", "kind"}: kind "topic" (new branch), "group" (new tree in an existing
    group) or "new_group" (parent is then the new group's label)."""
    data = _json_object(text)
    p = data.get("proposal")
    proposal, known = None, dict(topics)
    if p:
        parent = str(p["parent"]).strip()
        if parent.upper().startswith(NEW_GROUP.rstrip(":")):
            label = parent.split(":", 1)[1].strip() if ":" in parent else ""
            if not label:
                raise ValueError(f"new group without a name: {parent}")
            if label.lower() in {g.lower() for g in groups.values()}:      # an existing group, named
                parent, kind = next(g for g, l in groups.items() if l.lower() == label.lower()), "group"
            else:
                parent, kind = label, "new_group"
        elif parent in groups:
            kind = "group"
        elif parent in topics and parent not in open_ids:
            kind = "topic"
        else:
            raise ValueError(f"unknown or open parent {parent}")
        proposal = dict(label=str(p["name"]), parent=parent, kind=kind)
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
