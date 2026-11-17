"""The judge must be asked exactly the app's question: what label.py sends equals what the frontend's
scorePrompt() renders, the request has the backend's fast-slot shape, and the stored labels were
made with the current prompt (if score.ts changes, these labels are stale and this test says so)."""
import hashlib

from thinking_filter import frontend, label, models
from thinking_filter.files import LABELS, read_jsonl

REQS = [
    {"id": "a", "cond": "without", "prefix": None, "text": "Write me a summary", "tutor": None},
    {"id": "b", "cond": "with", "prefix": None, "text": "the mitochondria?", "tutor": "Which organelle makes most of the ATP?"},
    {"id": "c", "cond": "without", "prefix": None, "text": "x" * 2000, "tutor": None},
]


def test_sent_prompt_equals_score_prompt():
    bodies, scale = label.bodies(REQS)
    rendered = frontend.score_prompts([frontend.thinking_input(r["text"], r["tutor"]) for r in REQS])
    assert scale == {"1": 0, "2": 0.25, "3": 0.5, "4": 0.75, "5": 1}
    for body, p in zip(bodies, rendered):
        assert body["messages"] == [{"role": "system", "content": p["system"]}, {"role": "user", "content": p["user"]}]
    # Anchors from frontend/src/ai/prompts/score.test.ts: the bridge really runs scorePrompt().
    assert bodies[0]["messages"][1]["content"] == "Student message:\nWrite me a summary\n\nRating (1 to 5):"
    assert bodies[1]["messages"][1]["content"] == (
        "Earlier in the conversation (context only):\ntutor: Which organelle makes most of the ATP?\n\n"
        "Student message:\nthe mitochondria?\n\nRating (1 to 5):")
    assert bodies[2]["messages"][1]["content"].endswith("x…\n\nRating (1 to 5):")  # cut at 1,500 characters


def test_request_has_the_backend_fast_slot_shape():
    body = label.bodies(REQS[:1])[0][0]
    assert {k: v for k, v in body.items() if k != "messages"} == {
        "model": "zai.glm-4.7", "max_tokens": 1, "temperature": 0, "logprobs": True, "top_logprobs": 20}


def test_option_probabilities_mirror_the_backend():
    import math
    top = [[" 4", math.log(0.5)], ["4", math.log(0.1)], ["5", math.log(0.2)], ["<|user|>", math.log(0.2)]]
    probs, mass = models.option_probabilities(top, ["1", "2", "3", "4", "5"])
    assert abs(mass - 0.8) < 1e-12
    assert abs(probs["4"] - 0.75) < 1e-12 and abs(probs["5"] - 0.25) < 1e-12 and probs["1"] == 0
    try:
        models.option_probabilities([["The", math.log(0.9)], ["1", math.log(0.1)]], ["1", "2"])
    except models.JudgeRejected:
        pass
    else:
        raise AssertionError("mass below 0.5 must be rejected")


def test_labels_were_made_with_the_current_prompt():
    system = frontend.score_prompts([frontend.thinking_input("x", None)])[0]["system"]
    current = hashlib.sha256(system.encode()).hexdigest()[:12]
    stale = {r["prompt"] for r in read_jsonl(LABELS)} - {current}
    assert not stale, f"data/labels.jsonl was made with another system prompt ({stale}); rerun thinking_filter.label"
