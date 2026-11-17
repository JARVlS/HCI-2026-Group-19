"""Fixed choices of the experiment: CV folds, samples, prefixes, which judge condition the filter learns from.
All seeded, so every step sees the same split."""
import random
import re
from collections import defaultdict

FOLDS = 5
# The judge condition the filter learns from (step 4 decides, see out/report.md): "with" = the tutor's
# previous message is sent as history (`recent`), as the app does today; for first messages both
# conditions are the same prompt.
TRAIN_CONDITION = "with"


def condition_for(item: dict) -> str:
    """The label condition used for training and evaluation of this item."""
    return TRAIN_CONDITION if item.get("tutor") else "without"


def folds(items: list[dict], seed: int = 0) -> list[int]:
    """Fold 0..4 per item, stratified by kind and reply."""
    strata = defaultdict(list)
    for i, it in enumerate(items):
        strata[(it["kind"], bool(it.get("tutor")))].append(i)
    rng = random.Random(seed)
    out, pos = [0] * len(items), 0
    for key in sorted(strata):
        idx = strata[key]
        rng.shuffle(idx)
        for i in idx:
            out[i] = pos % FOLDS
            pos += 1
    return out


def stratified_sample(items: list[dict], n: int, seed: int, eligible=lambda i: True) -> list[int]:
    """n item indices, round-robin over kinds, random within a kind. `eligible` gets the index."""
    by_kind = defaultdict(list)
    for i, it in enumerate(items):
        if eligible(i):
            by_kind[it["kind"]].append(i)
    rng = random.Random(seed)
    for idx in by_kind.values():
        rng.shuffle(idx)
    picked, kinds = [], sorted(by_kind)
    while len(picked) < n and any(by_kind.values()):
        for k in kinds:
            if by_kind[k] and len(picked) < n:
                picked.append(by_kind[k].pop())
    return sorted(picked)


def chunk_ends(text: str) -> list[int]:
    """Where each whitespace-separated chunk ends: the live filter updates at every space, so the
    draft after word n is text[:chunk_ends(text)[n-1]]."""
    return [m.end() for m in re.finditer(r"\S+", text)]


def prefixes(text: str) -> dict[str, str]:
    """About a third and two thirds of the words (rounded, at least one word)."""
    ends = chunk_ends(text)
    n = len(ends)
    return {"1/3": text[:ends[max(1, round(n / 3)) - 1]], "2/3": text[:ends[max(1, round(2 * n / 3)) - 1]]}


def word_by_word_sample(items: list[dict]) -> list[int]:
    """150 items for the word-by-word curves."""
    return stratified_sample(items, 150, seed=7)


def prefix_sample(items: list[dict]) -> list[int]:
    """60 of the word-by-word items with at least 6 words, for judge labels on prefixes."""
    wbw = set(word_by_word_sample(items))
    return stratified_sample(items, 60, seed=11, eligible=lambda i: i in wbw and len(chunk_ends(items[i]["text"])) >= 6)
