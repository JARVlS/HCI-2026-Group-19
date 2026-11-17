"""Leon's 136 prompts are an outside check: no generated text may equal one of them (lower case,
punctuation stripped), and the filter never trains on them."""
from thinking_filter import generate, linter_set
from thinking_filter.files import HABIT, SYNTHETIC, read_jsonl


def test_no_generated_text_equals_one_of_leons_prompts():
    leon = {generate.norm_text(c["text"]) for c in linter_set.load()}
    assert len(leon) == 136
    generated = read_jsonl(SYNTHETIC) + read_jsonl(HABIT)
    same = [g["text"] for g in generated if generate.norm_text(g["text"]) in leon]
    assert not same, same


def test_norm_text_ignores_case_and_punctuation():
    assert generate.norm_text("Define  Entropy!") == generate.norm_text("define entropy") == "define entropy"
