"""The shipped weights load and reproduce the test vectors (what the TypeScript port is tested against),
and the vectorised CV code computes the same beliefs as the reference implementation."""
import json

import numpy as np
import pytest

from thinking_filter import cv, frontend, nb
from thinking_filter.files import VECTORS, WEIGHTS


@pytest.fixture(scope="module")
def model() -> nb.Model:
    return nb.load(WEIGHTS)


def test_weights_file_shape_and_size(model):
    d = json.loads(WEIGHTS.read_text())
    assert WEIGHTS.stat().st_size < 150_000
    assert d["levels"] == 5 and d["levelWeights"] == [0, 0.25, 0.5, 0.75, 1]
    assert d["vocabSize"] == len(d["counts"]) and all(len(c) == 5 for c in d["counts"].values())
    assert 0 < d["alpha"] <= 1 and d["beta"] > 0 and "featureSpec" in d
    for k in range(5):
        assert d["totals"][k] == pytest.approx(sum(c[k] for c in d["counts"].values()), abs=1e-9)


def test_weights_reproduce_the_vectors(model):
    v = json.loads(VECTORS.read_text())
    assert v["weightsVersion"] == json.loads(WEIGHTS.read_text())["version"]
    assert len(v["cases"]) == 40 and sum("steps" in c for c in v["cases"]) == 5
    for c in v["cases"]:
        feats = nb.features(c["text"], c["tutorAsked"], c["linter"])
        assert feats == c["features"]
        b = nb.belief(feats, model)
        assert b == pytest.approx(c["belief"], abs=1e-12)
        assert nb.estimate(b) == pytest.approx(c["estimate"], abs=1e-12)
        assert nb.certainty(b) == pytest.approx(c["certainty"], abs=1e-12)
        for s in c.get("steps", []):
            assert nb.features(s["text"], c["tutorAsked"], s["linter"]) == s["features"]
            assert nb.belief(s["features"], model) == pytest.approx(s["belief"], abs=1e-12)


def test_vectors_linter_is_todays_classify():
    """The rule features depend on classify.ts: if its labels or reasons change, refit (cv.py) and
    rebuild the vectors."""
    v = json.loads(VECTORS.read_text())
    drafts = [c for c in v["cases"]] + [s for c in v["cases"] for s in c.get("steps", [])]
    now = frontend.word_rules([d["text"] for d in drafts])
    assert [{k: x[k] for k in ("mode", "confidence", "reasons")} for x in now] == [d["linter"] for d in drafts]


def test_vectorised_cv_matches_the_reference():
    items, q = cv.training_set()
    fl = cv.item_features(items[:300])
    enc = cv.Encoded(fl)
    train, test = np.arange(0, 200), np.arange(200, 300)
    for min_docs, top_k in [(1, None), (2, 300)]:
        counts, keep, prior = cv.fold_counts(enc, q[:300], train, min_docs, top_k)
        got = cv.fold_beliefs(enc, test, counts, keep, prior, 0.3, 0.1)
        m = nb.fit([fl[i] for i in train], [list(q[i]) for i in train], 0.3, 0.1, min_docs, top_k)
        assert len(m.counts) == keep.sum()
        assert got == pytest.approx(np.array([nb.belief(fl[i], m) for i in test]), abs=1e-9)
