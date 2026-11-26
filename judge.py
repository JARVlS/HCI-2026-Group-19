"""LLM judge for the semantic fit s_pc used in ui_optimization.ipynb.

For every prompt of the session (session.py) the judge rates how well the prompt fits every topic
that exists or is proposed during the session, on a 1-5 rubric. Each prompt is judged in `--runs`
independent calls with the topics in a new random order and with opaque ids, so neither the order
nor the abbreviations can influence the score. The median over the runs is the score used by the
notebook. Everything needed to report and reproduce the scores is stored in judge_scores.json:
model, provider, date, settings, the full prompt text, every raw response and the per-run scores.

Usage (from this folder):
    export ANTHROPIC_API_KEY=...            # or OPENAI_API_KEY for --provider openai
    python judge.py                         # Anthropic, claude-sonnet-5-5, 3 runs -> judge_scores.json
    python judge.py --provider openai --model gpt-4.1-mini
    python judge.py --provider openai --base-url https://openrouter.ai/api/v1 --model openai/gpt-4.1-mini
    python judge.py --show-prompt           # print the request for one prompt, no API call
    python judge.py --rating-sheet human_ratings.csv   # blank sheet for the human check

Only the Python standard library is needed.
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import random
import re
import statistics
import sys
import time
import urllib.error
import urllib.request

from session import SUBJECT, all_prompts, all_topics, topic_path

PROMPT_VERSION = "v1"

SYSTEM_PROMPT = """You grade how well a student's question fits topics of a knowledge tree.

A study tool sorts every question a student asks an AI tutor into a tree of topics. For one question
you get a list of topics, each with its path in the tree. Rate EACH topic independently with this rubric:

5 = the question is squarely about this topic; this is where a student would look for it.
4 = the question belongs to a more specific subtopic of this topic, and that subtopic is NOT in the list.
3 = same broader area (same subject or a neighbouring topic), but a different topic.
2 = loosely related: shares some terms or background knowledge.
1 = unrelated.

Rules:
- Rate every topic in the list exactly once. Several topics may get the same score.
- Judge the meaning of the question, not shared words.
- If a more specific topic in the list fits exactly, give it 5; its parent then usually gets 3 or 4,
  never 5 for the same reason.
- Answer with JSON only, no other text, in exactly this form:
{"scores": [{"topic": "<topic id>", "score": <1-5>, "reason": "<at most 12 words>"}]}"""

USER_TEMPLATE = """Subject: {subject}

Question: "{question}"

Topics:
{topics}"""


# ------------------------------------------------------------------ requests
def build_request(prompt_text, topics, rng):
    """User message with the topics in random order under opaque ids; returns (message, id -> topic)."""
    order = list(topics)
    rng.shuffle(order)
    ids = {f"t{i + 1}": c for i, c in enumerate(order)}
    lines = "\n".join(f'- {tid}: "{topics[c]["label"]}"   (path: {topic_path(c, topics)})' for tid, c in ids.items())
    return USER_TEMPLATE.format(subject=SUBJECT, question=prompt_text, topics=lines), ids


def _post(url, body, headers, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def call_anthropic(args, user):
    key = os.environ.get("ANTHROPIC_API_KEY") or sys.exit("Set ANTHROPIC_API_KEY first.")
    out = _post(f"{args.base_url or 'https://api.anthropic.com'}/v1/messages",
                {"model": args.model, "max_tokens": 1500, "temperature": args.temperature,
                 "system": SYSTEM_PROMPT, "messages": [{"role": "user", "content": user}]},
                {"x-api-key": key, "anthropic-version": "2023-06-01"})
    return "".join(b.get("text", "") for b in out["content"])


def call_openai(args, user):
    key = os.environ.get("OPENAI_API_KEY", "")
    headers = {"authorization": f"Bearer {key}"} if key else {}
    out = _post(f"{(args.base_url or 'https://api.openai.com/v1').rstrip('/')}/chat/completions",
                {"model": args.model, "temperature": args.temperature,
                 "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]},
                headers)
    return out["choices"][0]["message"]["content"]


def parse_scores(text, ids):
    """Parse the judge's JSON answer into {topic: score}; raises ValueError if anything is off."""
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("no JSON object in the answer")
    items = json.loads(match.group(0))["scores"]
    scores = {}
    for it in items:
        tid, score = str(it["topic"]).strip(), int(it["score"])
        if tid not in ids or not 1 <= score <= 5:
            raise ValueError(f"bad item {it}")
        scores[ids[tid]] = score
    missing = set(ids.values()) - set(scores)
    if missing:
        raise ValueError(f"topics not rated: {sorted(missing)}")
    return scores


def judge_once(call, args, prompt_text, topics, rng, retries=2):
    for attempt in range(retries + 1):
        user, ids = build_request(prompt_text, topics, rng)
        try:
            raw = call(args, user)
            return parse_scores(raw, ids), raw, user
        except (ValueError, KeyError, json.JSONDecodeError, urllib.error.URLError) as e:
            print(f"    attempt {attempt + 1} failed: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    sys.exit("The judge did not return a valid answer; see the errors above.")


# ------------------------------------------------------------------ main
def run(args, call=None):
    call = call or {"anthropic": call_anthropic, "openai": call_openai}[args.provider]
    topics, prompts = all_topics(), all_prompts()
    rng = random.Random(args.seed)
    runs, raw, requests = {}, {}, {}
    for p, text in prompts.items():
        print(f"{p}: {text}")
        runs[p], raw[p], requests[p] = [], [], []
        for r in range(args.runs):
            scores, answer, user = judge_once(call, args, text, topics, rng)
            runs[p].append(scores)
            raw[p].append(answer)
            requests[p].append(user)
            print(f"    run {r + 1}: " + ", ".join(f"{c}={scores[c]}" for c in topics))

    median = {p: {c: int(statistics.median(run[c] for run in runs[p])) for c in topics} for p in prompts}
    pairs = [(p, c) for p in prompts for c in topics]
    identical = sum(len({run[c] for run in runs[p]}) == 1 for p, c in pairs)
    within_one = sum(max(run[c] for run in runs[p]) - min(run[c] for run in runs[p]) <= 1 for p, c in pairs)

    result = {
        "meta": {
            "provider": args.provider,
            "base_url": args.base_url or ("https://api.anthropic.com" if args.provider == "anthropic"
                                          else "https://api.openai.com/v1"),
            "model": args.model,
            "date_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "temperature": args.temperature,
            "runs_per_prompt": args.runs,
            "aggregation": "median over runs",
            "topic_order": "shuffled per call, opaque ids t1..tn",
            "seed": args.seed,
            "prompt_version": PROMPT_VERSION,
            "prompt_sha256": hashlib.sha256((SYSTEM_PROMPT + USER_TEMPLATE).encode()).hexdigest()[:16],
            "system_prompt": SYSTEM_PROMPT,
            "user_template": USER_TEMPLATE,
        },
        "run_agreement": {"pairs": len(pairs), "identical_in_all_runs": identical,
                          "max_minus_min_at_most_1": within_one},
        "topics": {c: {"label": t["label"], "parent": t["parent"], "path": topic_path(c, topics)} for c, t in topics.items()},
        "prompts": prompts,
        "scores": median,
        "runs": runs,
        "requests": requests,
        "raw_responses": raw,
    }
    with open(args.out, "w") as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    print(f"\nwrote {args.out}: {len(prompts)} prompts x {len(topics)} topics, {args.runs} runs each; "
          f"identical in all runs: {identical}/{len(pairs)} pairs")
    return result


def rating_sheet(path, seed=7):
    """Blank sheet for two group members to rate every pair with the same rubric, without seeing the judge."""
    topics, prompts = all_topics(), all_prompts()
    rows = [(p, prompts[p], c, topic_path(c, topics)) for p in prompts for c in topics]
    random.Random(seed).shuffle(rows)
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["prompt_id", "prompt", "topic_id", "topic_path", "rater_A", "rater_B"])
        for r in rows:
            w.writerow([*r, "", ""])
    print(f"wrote {path}: {len(rows)} pairs. Each rater fills one column (1-5) using the rubric in judge.py,"
          " independently and without looking at judge_scores.json.")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", choices=["anthropic", "openai"], default="anthropic",
                    help="'openai' = any OpenAI-compatible API (OpenAI, OpenRouter, Groq, Ollama, ...)")
    ap.add_argument("--model", default=None, help="default: claude-sonnet-5-5 / gpt-4.1-mini")
    ap.add_argument("--base-url", default=None)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--temperature", type=float, default=0.0)
    ap.add_argument("--seed", type=int, default=0, help="seed for the topic order")
    ap.add_argument("--out", default="judge_scores.json")
    ap.add_argument("--show-prompt", action="store_true", help="print one request and exit")
    ap.add_argument("--rating-sheet", metavar="CSV", help="write a blank human rating sheet and exit")
    args = ap.parse_args(argv)
    args.model = args.model or ("claude-sonnet-5-5" if args.provider == "anthropic" else "gpt-4.1-mini")

    if args.rating_sheet:
        return rating_sheet(args.rating_sheet)
    if args.show_prompt:
        p, text = next(iter(all_prompts().items()))
        user, _ = build_request(text, all_topics(), random.Random(args.seed))
        print("=== system ===\n" + SYSTEM_PROMPT + "\n\n=== user ===\n" + user)
        return
    return run(args)


if __name__ == "__main__":
    main()
