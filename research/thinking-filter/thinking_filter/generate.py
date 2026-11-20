"""Step 2: the synthetic set. Student messages from Claude Sonnet 5, written to a spec grid (kind x
target level x subject x length x style x reply) so every level and every hard case is covered on
purpose. The generator only aims; the judge decides the label (label.py).

Round 1 (1,000 specs): 14 kinds, English. Round 2 (350 specs): the gaps found on Leon's prompt set
(bare commands, short fact questions, solve requests without an own attempt, quiz requests as
commands, very short messages) and 80 German messages across all five levels. Round 2 is written
from kind descriptions only, never from Leon's prompts; a generated text that equals one of them
(lower case, punctuation stripped) is dropped, and tests/test_no_leak.py checks the result.

  uv run python -m thinking_filter.generate          # data/synthetic.jsonl and data/habit.jsonl
"""
import random
import re
import sys

from . import linter_set, models
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


# --- round 2 ---------------------------------------------------------------------------------------

KINDS2: dict[str, tuple[int, bool, int, str]] = {
    "bare_command": (1, True, 70, "a bare command that orders the tutor to produce something: a definition, a list, a summary, a table, an outline, a translation, an essay, code. No please, no 'for me', no own idea (e.g. 'Name the bones of the inner ear.', 'Outline the plot of act 2 in three points.')"),
    "short_fact": (1, True, 50, "a short question for one bare fact: a date, a name, a number, a unit, what an abbreviation means (e.g. 'Who painted the Night Watch?', 'boiling point of ethanol?')"),
    "solve_request": (1, True, 60, "asks the tutor to calculate, solve, simplify, differentiate, integrate, prove or code something, with the maths or code written in the message, but with NO own attempt and NO own idea (e.g. 'Solve 4x - 7 = 2x + 9', 'differentiate ln(x^2+1)')"),
    "quiz_command": (3, True, 40, "asks to be quizzed or tested, or for a hint only, phrased as a command (e.g. 'Ask me five questions on the Krebs cycle.', 'Hint only, no answer: question 3b.')"),
    "very_short": (0, True, 50, "a very short message of 1 to 4 words at the target level: 1 hands work over ('solution pls'), 2 asks why or how ('how come?'), 3 asks for a hint or quiz ('hint?'), 4 a bare own guess ('is it osmosis'), 5 a tiny own reasoning ('heavier so faster?')"),
}
VERY_SHORT_LEVELS = [1] * 15 + [2] * 10 + [3] * 10 + [4] * 12 + [5] * 3
REPLY_SHARE2 = {"very_short": 0.5, "quiz_command": 0.2}
DEFAULT_REPLY_SHARE2 = 0.15
LENGTH_WEIGHTS2 = {
    "bare_command": [.3, .6, .1, 0, 0],
    "short_fact": [.5, .5, 0, 0, 0],
    "solve_request": [.15, .55, .3, 0, 0],
    "quiz_command": [.2, .6, .2, 0, 0],
    "very_short": [1, 0, 0, 0, 0],
}
# A bare command or a fact question is not polite or chatty by definition.
PLAIN_STYLES = ["clean full sentences", "all lower case, little punctuation", "typos and missing apostrophes", "terse, keywords only", "non-native English, slightly odd grammar"]
GERMAN = 80  # 16 per level, kinds of that level from both rounds
GERMAN_KINDS = {1: ["delegate", "fact", "bare_command", "polite_delegation", "solve_request"], 2: ["why_how"],
                3: ["hint_quiz", "vague", "quiz_command", "mixed"], 4: ["claim", "wrong_claim", "claim_question", "answer"],
                5: ["reasoning", "attempt"]}
# Round 1's description of claim_question quoted an example that is also in Leon's set; round 2 does not.
ALL_KINDS2 = {**{k: v for k, v in KINDS.items()},
              "claim_question": (4, True, 0, "states an own claim but phrased as a question ('is it because ...?', 'isn't it ...?', '..., right?'); right or wrong"),
              **KINDS2}

SYSTEM2 = f"""You write realistic messages that students send to an AI tutor in a study chat, for a research data set.
Each line of the request is one spec: number | language | subject | kind | target level | length in words | style | first message or reply.
Write exactly one student message per spec, in the language of the spec.

Kinds (what the message does):
{chr(10).join(f'- {k}: {v[3]}' for k, v in ALL_KINDS2.items())}

Target level, how much of the thinking is the student's own:
{SCALE}

Rules:
- The message does what its kind says; aim for the target level, but write it the way a real student would.
- Keep to the length and the style. Real students write in lower case, make typos and write half sentences; only be polished when the style says so.
- Vary the wording and the topics across the batch: do not open several messages the same way, and avoid textbook examples everybody uses.
- For a reply, also write the tutor's previous message ("tutor"), in the same language: one or two sentences on the subject, usually ending with a question to the student; the student's message answers or reacts to it. For a first message, "tutor" is an empty string.
- Content fits the subject and level (school or university); wrong claims are common misconceptions."""


def specs2(rng: random.Random) -> list[dict]:
    rows = []
    style_names, style_w = list(STYLES), list(STYLES.values())
    for kind, (level, hard, count, _) in KINDS2.items():
        n_reply = round(count * REPLY_SHARE2.get(kind, DEFAULT_REPLY_SHARE2))
        for i in range(count):
            target = VERY_SHORT_LEVELS[i] if kind == "very_short" else level
            style = rng.choice(PLAIN_STYLES) if kind in ("bare_command", "short_fact", "solve_request") else rng.choices(style_names, style_w)[0]
            rows.append({"kind": kind, "target": target, "hard": hard, "reply": i < n_reply, "lang": "en", "subject": rng.choice(SUBJECTS),
                         "length": rng.choices(LENGTHS, LENGTH_WEIGHTS2[kind])[0], "style": style})
    for i in range(GERMAN):
        level = i % 5 + 1
        kind = rng.choice(GERMAN_KINDS[level])
        weights = LENGTH_WEIGHTS2.get(kind) or LENGTH_WEIGHTS[kind]
        rows.append({"kind": kind, "target": level, "hard": ALL_KINDS2[kind][1], "reply": rng.random() < 0.2, "lang": "de",
                     "subject": rng.choice(SUBJECTS), "length": rng.choices(LENGTHS, weights)[0], "style": rng.choices(style_names, style_w)[0]})
    rng.shuffle(rows)
    for i, row in enumerate(rows, 1001):
        row["id"] = f"s{i:04d}"
    return rows


def spec_line2(n: int, s: dict) -> str:
    where = "reply" if s["reply"] else "first message"
    lang = "German" if s["lang"] == "de" else "English"
    return f"{n} | {lang} | {s['subject']} | {s['kind']} | {s['target']} | {s['length']} | {s['style']} | {where}"


def spec_line(n: int, s: dict) -> str:
    where = "reply" if s["reply"] else "first message"
    return f"{n} | {s['subject']} | {s['kind']} | {s['target']} | {s['length']} | {s['style']} | {where}"


def generate_batch(batch: list[dict], extra: str = "", round_: int = 1) -> list[dict]:
    line, system = (spec_line, SYSTEM) if round_ == 1 else (spec_line2, SYSTEM2)
    user = (extra + "\n\n" if extra else "") + "Specs:\n" + "\n".join(line(n, s) for n, s in enumerate(batch, 1))
    body = models.claude_body(system, user, SCHEMA, max_tokens=8000)
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
                     "subject": s["subject"], "kind": s["kind"], "hard": s["hard"], "length": s["length"], "style": s["style"],
                     "lang": s.get("lang", "en"), "round": round_})
    return rows


def norm_text(text: str) -> str:
    """Lower case, punctuation stripped: the key for duplicates and for the leak check against Leon's set."""
    return re.sub(r"\W+", " ", text.lower()).strip()


def drop_duplicates(rows: list[dict], banned: set[str] = frozenset()) -> tuple[list[dict], int]:
    """Exact duplicates (same words, ignoring case and punctuation) would leak across CV folds; a text
    in `banned` (Leon's prompts) is dropped too."""
    seen, kept = set(banned), []
    for r in rows:
        k = norm_text(r["text"])
        if k not in seen:
            seen.add(k)
            kept.append(r)
    return kept, len(rows) - len(kept)


def run_batches(grid: list[dict], extra: str = "", label: str = "", round_: int = 1) -> list[dict]:
    first = FIRST_BATCH if round_ == 1 else BATCH
    batches = [grid[:first]] + [grid[i:i + BATCH] for i in range(first, len(grid), BATCH)]
    results = models.parallel(lambda b: generate_batch(b, extra, round_), batches, workers=4, label=label)
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
    rows1 = run_batches(grid, label="synthetic round 1")
    rows2 = run_batches(specs2(random.Random(23)), label="synthetic round 2", round_=2)
    banned = {norm_text(c["text"]) for c in linter_set.load()}
    rows, dropped = drop_duplicates(rows1 + rows2, banned)
    write_jsonl(SYNTHETIC, rows)
    print(f"synthetic: {len(rows)} items ({sum(r['round'] == 2 for r in rows)} of round 2), {sum(r['tutor'] is not None for r in rows)} replies,"
          f" {dropped} dropped as duplicates or equal to one of Leon's prompts", file=sys.stderr)

    habit_grid = habit_specs(random.Random(41))
    extra = (f"All of these messages come from ONE student with a strong personal habit: the student {HABIT_STYLE}. "
             "Keep that habit in every message, whatever the kind.")
    habit = run_batches(habit_grid, extra=extra, label="habit")
    write_jsonl(HABIT, habit)
    print(f"habit: {len(habit)} items", file=sys.stderr)
    print(f"Claude so far: {models.LEDGER.claude_calls} calls, {models.LEDGER.claude_tokens} tokens", file=sys.stderr)


if __name__ == "__main__":
    main()
