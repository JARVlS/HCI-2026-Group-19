"""The knowledge forest as data, for ui_optimization.ipynb (HCI 2026, Group 19, Milestone 3).

Bookkeeping only: the user model and the integer program are in the notebook.

    state   = {"groups": {group: label}, "topics": {topic: {"label", "parent"}},
               "assign": {question: topic}}                                       the forest at one moment
    history = [{"k", "step", "before", "after", "action", "missing", "parts", "params"}, ...]   one dict per step

The LLM's inputs are filled by collect_llm_answers. They are updated in place, so `from forest import JUDGE`
in the notebook always sees the current scores:
    PROPOSALS   {question: {"id", "label", "parent", "kind"}}   the topic the LLM proposed for that question
    JUDGE       {question: {topic: 1..5}}                         the LLM's scores
    ALL_TOPICS, ALL_LABELS, ALL_GROUPS                           starting topics and groups plus all proposals
"""
import json
import os

import judge
from session import INITIAL_GROUPS, INITIAL_TOPICS, INITIAL_PROMPTS, SESSION, all_prompts

STEP_K = {st["id"]: k for k, st in enumerate(SESSION, start=1)}       # question -> step at which it arrives
ROOT = "ROOT"                                                          # the top of the tree view
PROPOSALS, JUDGE, ALL_TOPICS, ALL_LABELS, ALL_GROUPS = {}, {}, {}, {}, {}
SOURCE = (f"LLM, step by step (Claude Haiku 5.5 ({judge.MODEL}), one fresh conversation per question that sees "
          f"only that step's prompt); answers in {judge.STEP_DIR}/")


# ------------------------------------------------------------------ the LLM's inputs
def set_llm_data(proposals, scores, groups):
    """Make these the current inputs: proposals {question: {...}}, scores {question: {topic: 1..5}},
    groups {group: label} (including the groups that proposals would create)."""
    for d in (PROPOSALS, JUDGE, ALL_TOPICS, ALL_LABELS, ALL_GROUPS):
        d.clear()
    PROPOSALS.update(proposals)
    JUDGE.update(scores)
    ALL_GROUPS.update(groups)
    ALL_TOPICS.update(INITIAL_TOPICS)
    ALL_TOPICS.update({t["id"]: dict(label=t["label"], parent=t["parent"]) for t in proposals.values()})
    ALL_LABELS.update({c: t["label"] for c, t in ALL_TOPICS.items()})


def collect_llm_answers(decide):
    """Walk through the session like the prototype: at step k, build the prompt from the forest after step k-1
    and the k-th question, get the LLM's answer (judge.answer: the saved one, or a new one), record its proposal
    and scores, let decide(state, step) -> {question: topic} place the questions, and go on."""
    state = initial_state()
    proposals, groups = {}, dict(INITIAL_GROUPS)
    scores = {p: {} for p in all_prompts()}
    for step in SESSION:
        n = step["id"]
        set_llm_data(proposals, scores, groups)                # only what is known before this step
        open_now = candidates_of(state, step)
        topics_now = {**state["topics"], **open_now}
        placed = state["assign"]
        missing = {q: [c for c in topics_now if c not in scores[q]] for q in placed}
        prompt = judge.step_prompt(state["groups"], topics_now, placed, all_prompts(), step["text"],
                                   open_ids=open_now, missing=missing, all_groups=groups)
        read = lambda text: judge.parse_step(text, state["groups"], topics_now, placed, missing, open_ids=open_now)
        proposal, new_scores, earlier = read(judge.answer(n, prompt, check=read))
        tid = f"T{len(proposals) + 1}"
        if proposal:
            parent = proposal["parent"]
            if proposal["kind"] == "new_group":                # reuse a pending group with the same name
                parent = next((g for g, l in groups.items() if l.lower() == parent.lower()), None) \
                         or f"G{len(groups) + 1}"
                groups.setdefault(parent, proposal["parent"])
            proposals[n] = dict(id=tid, label=proposal["label"], parent=parent, kind=proposal["kind"])
        for q, row in [(n, new_scores)] + list(earlier.items()):
            for c, v in row.items():
                scores[q][tid if c == "NEW" else c] = v
        set_llm_data(proposals, scores, groups)
        state = apply(state, step, decide(state, step))
    set_llm_data(proposals, scores, groups)


# ------------------------------------------------------------------ states and steps
def initial_state():
    return dict(groups=dict(INITIAL_GROUPS),
                topics={c: dict(t) for c, t in INITIAL_TOPICS.items()},
                assign={p: d["topic"] for p, d in INITIAL_PROMPTS.items()})


def candidates_of(state, step):
    """Open proposals: proposed for this question or an earlier one, not created yet, and the parent exists
    (a topic or group of the forest) or is a group the proposal itself would create."""
    k = STEP_K[step["id"]]
    return {t["id"]: dict(label=t["label"], parent=t["parent"]) for q, t in PROPOSALS.items()
            if STEP_K[q] <= k and t["id"] not in state["topics"]
            and (t["parent"] in state["topics"] or t["parent"] in ALL_GROUPS)}


def structure(state, step):
    """The sets of the IP: old topics, open proposals, parent of each, subtopics, new groups."""
    cands = candidates_of(state, step)
    C_old, C_new = list(state["topics"]), list(cands)
    parent = {c: (state["topics"].get(c) or cands[c])["parent"] for c in C_old + C_new}
    kids = {c: [k for k in parent if parent[k] == c] for c in parent}
    G_new = sorted({parent[c] for c in C_new if parent[c] not in state["groups"] and parent[c] not in parent})
    return C_old, C_new, parent, kids, G_new


def choice_points(parent, c):
    """Where the student chooses on the way to topic c: the forest (a group), the group of c (a tree), and
    every topic above c (a branch); parent: {topic: topic or group}."""
    above = []
    while parent[c] in parent:
        c = parent[c]
        above.append(c)
    return [ROOT, parent[c]] + above[::-1]


def apply(state, step, new_assign):
    """The forest after a decision {question: topic}: proposals that received a question are created (with
    their new group), old topics left without questions and subtopics are deleted."""
    used = set(new_assign.values())
    groups, topics = dict(state["groups"]), {c: dict(t) for c, t in state["topics"].items()}
    for c, t in candidates_of(state, step).items():
        if c in used:
            topics[c] = dict(t)
            if t["parent"] not in topics and t["parent"] not in groups:
                groups[t["parent"]] = ALL_GROUPS[t["parent"]]                    # (d) the new group
    while True:                                                                    # delete empty topics
        empty = [c for c in topics if c not in used and not any(t["parent"] == c for t in topics.values())]
        if not empty:
            break
        for c in empty:
            del topics[c]
    return dict(groups=groups, topics=topics, assign=dict(new_assign))


def changes(state, after):
    """-> (moved questions, created topics, deleted topics, new groups)"""
    moved = [p for p in state["assign"] if after["assign"][p] != state["assign"][p]]
    created = [c for c in after["topics"] if c not in state["topics"]]
    deleted = [c for c in state["topics"] if c not in after["topics"]]
    new_groups = [g for g in after["groups"] if g not in state["groups"]]
    return moved, created, deleted, new_groups


def action(state, step, new_assign):
    """The outcome (a)-(e) of a decision, in words."""
    after = apply(state, step, new_assign)
    moved, created, deleted, new_groups = changes(state, after)
    c = new_assign[step["id"]]
    if c in state["topics"]:
        base = "(a) add to existing topic"
    elif after["topics"][c]["parent"] in after["topics"]:
        base = "(b) new branch"
    elif after["topics"][c]["parent"] in state["groups"]:
        base = "(c) new tree"
    else:
        base = "(d) new group"
    if not (moved or deleted):
        return base
    what = [f"move {', '.join(moved)}"] if moved else []
    what += [f"delete {', '.join(state['topics'][d]['label'] for d in deleted)}"] if deleted else []
    return f"(e) restructure: {'; '.join(what)} + {base[4:]}"


def code_of(act):
    """Short letter of an outcome: a, b, c, d or e."""
    return act[1]


def describe(state, step, assign):
    """The outcome, and where the new question and every moved question go."""
    moved = changes(state, apply(state, step, assign))[0]
    where = ", ".join(f"{p} → {ALL_LABELS[assign[p]]}" for p in [step["id"], *moved])
    return f"({code_of(action(state, step, assign))}) {where}"


def missing_scores(state, step):
    """(question, topic) pairs this step can use that the LLM never rated (they count as unrelated). Zero along
    the IP's own path, on which the answers were collected; other designs may meet some."""
    C = list(state["topics"]) + list(candidates_of(state, step))
    return sum(c not in JUDGE[p] for p in list(state["assign"]) + [step["id"]] for c in C)


def tree_of(state, c):
    """The root topic of the tree that holds topic c."""
    while state["topics"][c]["parent"] in state["topics"]:
        c = state["topics"][c]["parent"]
    return c


# ------------------------------------------------------------------ baseline H0 and export
def chronological(params, block=3):
    """Baseline H0, the status quo of chat sidebars: the new questions in arrival order, `block` per topic, in
    one group "Chat history". Its labels are blocks of time (informative=False for the user model)."""
    state, history = initial_state(), []
    for k, step in enumerate(SESSION, start=1):
        i = (k - 1) // block
        c = f"CH{i + 1}"
        first, last = SESSION[i * block]["id"], SESSION[min(len(SESSION), (i + 1) * block) - 1]["id"]
        after = dict(groups={**state["groups"], "CHAT": "Chat history"},
                     topics={**state["topics"], c: dict(label=f"Chat {i + 1}: {first}–{last}", parent="CHAT")},
                     assign={**state["assign"], step["id"]: c})
        act = "(a) add to existing topic" if c in state["topics"] else (
              "(c) new tree" if "CHAT" in state["groups"] else "(d) new group")
        history.append(dict(k=k, step=step, before=state, after=after, action=act, missing=0, parts=None,
                            params=params, informative=False))
        state = after
    return history


def export_sequence(history, params, path="export/ip_forest_sequence.json"):
    """The forest after every step, as JSON for the prototype (Milestone 4)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    seq = {"source": SOURCE, "params": params,
           "start": {k: initial_state()[k] for k in ("groups", "topics", "assign")},
           "steps": [{"step": h["k"], "question": h["step"]["id"], "text": h["step"]["text"], "outcome": h["action"],
                      "groups": h["after"]["groups"], "topics": h["after"]["topics"], "assign": h["after"]["assign"]}
                     for h in history]}
    with open(path, "w") as f:
        json.dump(seq, f, indent=1, ensure_ascii=False)
    print("saved", path, "with", len(seq["steps"]), "steps")
