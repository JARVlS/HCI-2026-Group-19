"""Step 2: the synthetic set. About 1,000 student messages from Claude Sonnet 5, written to a spec grid
(kind x target level x subject x length x style x reply) so every level and every hard case is
covered on purpose. The generator only aims; the judge decides the label (label.py).

  uv run python -m thinking_filter.generate          # data/synthetic.jsonl and data/habit.jsonl
"""
import random
import re
import sys

from . import models
from .files import HABIT, SYNTHETIC, write_jsonl

# kind: (target level, hard case, count, what the message does)
KINDS: dict[str, tuple[int, bool, int, str]] = {
    "delegate": (1, False, 100, "asks the tutor to produce a finished product: a summary, essay, notes, a solution, code, a translation or a rewrite"),
    "fact": (1, False, 55, "asks for a bare fact or a definition (what is, who was, when did, define)"),
    "polite_delegation": (1, True, 75, "hands the whole work over, but politely or wrapped in 'I think', 'I feel like', 'maybe you could', or says they will do nothing themselves (e.g. 'I think you could just write the essay for me', 'I will do nothing myself')"),
    "meta": (1, True, 55, "is about the chat, not the subject: thanks, ok, continue, go on, next, yes, got it, more, shorter please"),
    "why_how": (2, True, 105, "a plain why or how question, or 'explain X', with no idea of their own"),
    "hint_quiz": (3, True, 85, "asks for a hint or a nudge, to be quizzed or tested, or to be checked without stating anything yet"),
    "vague": (3, False, 55, "hints at a vague, half-formed idea and is unsure (e.g. 'something with the blood?', 'maybe it has to do with energy or so')"),
    "mixed": (3, True, 60, "states an own idea and then asks the tutor to do the rest (e.g. 'my thesis is X ... now write it up for me')"),
    "claim": (4, False, 75, "states an own claim, guess or prediction that is right, with little or no reasoning"),
    "wrong_claim": (4, True, 75, "states an own claim, guess or prediction that is wrong (a common misconception), with little or no reasoning"),
    "claim_question": (4, True, 70, "states an own claim but phrased as a question ('the moon makes its own light, right?', 'is it because ...?', 'isn't it ...?'); right or wrong"),
    "reasoning": (5, False, 85, "gives own reasoning: explains in their own words why something is so, step by step; may be partly wrong"),
    "attempt": (5, False, 55, "shows a worked attempt (own calculation, derivation, draft sentence or code) and asks whether it is right"),
    "answer": (4, False, 50, "answers the tutor's question with an own short answer, right or wrong (e.g. 'the mitochondria', 'because it is heavier?')"),
}
REPLY_ONLY = {"answer"}
REPLY_SHARE = {"meta": 0.6}  # meta messages mostly follow a tutor message
DEFAULT_REPLY_SHARE = 0.24  # so that about 30 % of all items are replies

LENGTHS = ["1-4", "5-12", "13-25", "26-45", "46-60"]
LENGTH_WEIGHTS = {
    "meta": [1, 0, 0, 0, 0],
    "fact": [.4, .5, .1, 0, 0],
    "delegate": [.15, .4, .3, .15, 0],
    "polite_delegation": [0, .4, .4, .2, 0],
    "why_how": [.2, .5, .25, .05, 0],
    "hint_quiz": [.2, .5, .3, 0, 0],
    "vague": [.35, .45, .2, 0, 0],
    "mixed": [0, 0, .45, .4, .15],
    "claim": [.15, .45, .3, .1, 0],
    "wrong_claim": [.15, .45, .3, .1, 0],
    "claim_question": [.1, .5, .35, .05, 0],
    "reasoning": [0, 0, .3, .45, .25],
    "attempt": [0, 0, .35, .45, .2],
    "answer": [.55, .35, .1, 0, 0],
}
STYLES = {
    "clean full sentences": .22,
    "all lower case, little punctuation": .2,
    "typos and missing apostrophes": .15,
    "a half sentence or fragment": .1,
    "casual and chatty": .1,
    "formal and very polite": .08,
    "non-native English, slightly odd grammar": .1,
    "terse, keywords only": .05,
}
SUBJECTS = [
    "biology (school)", "chemistry (school)", "physics (school)", "algebra (school)", "world history (school)",
    "geography (school)", "English literature (school)", "French as a foreign language (school)", "astronomy (school)",
    "music theory (school)", "calculus (university)", "linear algebra (university)", "statistics (university)",
    "machine learning (university)", "programming in Python (university)", "economics (university)",
    "psychology (university)", "philosophy (university)", "organic chemistry (university)",
    "physiology and medicine (university)", "law (university)", "environmental science (university)",
]
SCALE = """1 = none: hands the work over, wants a finished product or a bare fact
2 = little: asks to have something explained (why or how) without an own idea
3 = some: wants to think but has not started (hint, quiz) or only a vague idea
4 = much: an own claim, guess or prediction, little or no reasoning
5 = all: own reasoning, own words, or a worked attempt"""

SYSTEM = f"""You write realistic messages that students send to an AI tutor in a study chat, for a research data set.
Each line of the request is one spec: number | subject | kind | target level | length in words | style | first message or reply.
Write exactly one student message per spec.

Kinds (what the message does):
{chr(10).join(f'- {k}: {v[3]}' for k, v in KINDS.items())}

Target level, how much of the thinking is the student's own:
{SCALE}

Rules:
- The message does what its kind says; aim for the target level, but write it the way a real student would.
- Keep to the length and the style. Real students write in lower case, make typos and write half sentences; only be polished when the style says so.
- Vary the wording across the batch: do not open several messages the same way, and do not start every claim with "I think".
- For a reply, also write the tutor's previous message ("tutor"): one or two sentences on the subject, usually ending with a question to the student; the student's message answers or reacts to it. For a first message, "tutor" is an empty string.
- Content fits the subject and level (school or university); wrong claims are common misconceptions.
- English only."""

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"n": {"type": "integer"}, "tutor": {"type": "string"}, "text": {"type": "string"}},
                "required": ["n", "tutor", "text"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

# Specs per Claude call. The first call is smaller: it was the probe of cost and quality, and its
# cached answer is reused. 40 + 16 x 60 = 1,000.
FIRST_BATCH, BATCH = 40, 60

HABIT_STYLE = ("always opens with 'pls' or 'pls check' or 'pls help', writes lower case shorthand with arrows (->), "
               "'bc', 'w/', 'smth', 'tho', and ends almost every message with '??', even when stating an own idea")
HABIT_KINDS = {"reasoning": 8, "claim": 8, "claim_question": 6, "attempt": 4, "hint_quiz": 4, "why_how": 4, "delegate": 4, "meta": 2}
HABIT_SUBJECTS = ["biology (school)", "chemistry (school)"]


def specs(rng: random.Random) -> list[dict]:
    """The grid: per kind its count, a reply quota, and a random subject, length and style each."""
    rows = []
    style_names, style_w = list(STYLES), list(STYLES.values())
    for kind, (level, hard, count, _) in KINDS.items():
        share = 1.0 if kind in REPLY_ONLY else REPLY_SHARE.get(kind, DEFAULT_REPLY_SHARE)
        n_reply = round(count * share)
        for i in range(count):
            rows.append({
                "kind": kind, "target": level, "hard": hard, "reply": i < n_reply,
                "subject": rng.choice(SUBJECTS),
                "length": rng.choices(LENGTHS, LENGTH_WEIGHTS[kind])[0],
                "style": rng.choices(style_names, style_w)[0],
            })
    rng.shuffle(rows)
    for i, row in enumerate(rows, 1):
        row["id"] = f"s{i:04d}"
    return rows


def spec_line(n: int, s: dict) -> str:
    where = "reply" if s["reply"] else "first message"
    return f"{n} | {s['subject']} | {s['kind']} | {s['target']} | {s['length']} | {s['style']} | {where}"


def generate_batch(batch: list[dict], extra: str = "") -> list[dict]:
    user = (extra + "\n\n" if extra else "") + "Specs:\n" + "\n".join(spec_line(n, s) for n, s in enumerate(batch, 1))
    body = models.claude_body(SYSTEM, user, SCHEMA, max_tokens=8000)
    answer = models.claude_json(body)["items"]
    by_n = {a["n"]: a for a in answer}
    if sorted(by_n) != list(range(1, len(batch) + 1)):
        raise ValueError(f"generator returned items {sorted(by_n)} for {len(batch)} specs")
    rows = []
    for n, s in enumerate(batch, 1):
        a = by_n[n]
        text, tutor = a["text"].strip(), a["tutor"].strip()
        if not text:
            raise ValueError(f"spec {n} ({s['id']}): empty text")
        # An item is a reply when the generator wrote a tutor message (3 of 1,000 specs came back
        # the other way round; their texts read naturally as written).
        rows.append({"id": s["id"], "text": text, "tutor": tutor or None, "target": s["target"],
                     "subject": s["subject"], "kind": s["kind"], "hard": s["hard"], "length": s["length"], "style": s["style"]})
    return rows


def drop_duplicates(rows: list[dict]) -> tuple[list[dict], int]:
    """Exact duplicates (same words, ignoring case and punctuation) would leak across CV folds."""
    seen, kept = set(), []
    for r in rows:
        k = re.sub(r"\W+", " ", r["text"].lower()).strip()
        if k not in seen:
            seen.add(k)
            kept.append(r)
    return kept, len(rows) - len(kept)


def run_batches(grid: list[dict], extra: str = "", label: str = "") -> list[dict]:
    batches = [grid[:FIRST_BATCH]] + [grid[i:i + BATCH] for i in range(FIRST_BATCH, len(grid), BATCH)]
    results = models.parallel(lambda b: generate_batch(b, extra), batches, workers=4, label=label)
    failed = [r for r in results if isinstance(r, Exception)]
    if failed:
        raise RuntimeError(f"{len(failed)} of {len(batches)} batches failed, first: {failed[0]!r}")
    return [row for rows in results for row in rows]


def habit_specs(rng: random.Random) -> list[dict]:
    rows = []
    for kind, count in HABIT_KINDS.items():
        level, hard = KINDS[kind][0], KINDS[kind][1]
        for _ in range(count):
            rows.append({"kind": kind, "target": level, "hard": hard, "reply": False, "subject": rng.choice(HABIT_SUBJECTS),
                         "length": rng.choices(LENGTHS[1:4], [.4, .45, .15])[0], "style": "the student's habit (see above)"})
    rng.shuffle(rows)
    for i, row in enumerate(rows, 1):
        row["id"] = f"h{i:02d}"
    return rows


def main() -> None:
    rng = random.Random(17)
    grid = specs(rng)
    rows, dupes = drop_duplicates(run_batches(grid, label="synthetic"))
    write_jsonl(SYNTHETIC, rows)
    print(f"synthetic: {len(rows)} items, {sum(r['tutor'] is not None for r in rows)} replies, {dupes} duplicates dropped", file=sys.stderr)

    habit_grid = habit_specs(random.Random(41))
    extra = (f"All of these messages come from ONE student with a strong personal habit: the student {HABIT_STYLE}. "
             "Keep that habit in every message, whatever the kind.")
    habit = run_batches(habit_grid, extra=extra, label="habit")
    write_jsonl(HABIT, habit)
    print(f"habit: {len(habit)} items", file=sys.stderr)
    print(f"Claude so far: {models.LEDGER.claude_calls} calls, {models.LEDGER.claude_tokens} tokens", file=sys.stderr)


if __name__ == "__main__":
    main()
