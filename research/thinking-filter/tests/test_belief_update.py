import math

import pytest

from thinking_filter import nb


def tiny() -> nb.Model:
    m = nb.Model(alpha=0.5, beta=0.1)
    nb.update(m, ["write", "essay", "^write"], [0.9, 0.1, 0, 0, 0])
    nb.update(m, ["i", "think", "^i"], [0, 0, 0.1, 0.7, 0.2])
    return m


def test_update_adds_weighted_soft_counts():
    m = tiny()
    nb.update(m, ["think", "think", "new"], [0, 0, 0, 0.5, 0.5], weight=3)
    assert m.prior == pytest.approx([0.9, 0.1, 0.1, 0.7 + 1.5, 0.2 + 1.5])
    assert m.counts["think"] == pytest.approx([0, 0, 0.1, 0.7 + 3.0, 0.2 + 3.0])  # twice in the message: added twice
    assert m.counts["new"] == pytest.approx([0, 0, 0, 1.5, 1.5])  # a new feature becomes a key
    for k in range(nb.LEVELS):
        assert m.totals[k] == pytest.approx(sum(c[k] for c in m.counts.values()))


def test_belief_matches_the_formula_by_hand():
    m = tiny()
    feats = ["think", "unknown", "write"]
    v = len(m.counts)
    expect = []
    for k in range(nb.LEVELS):
        ll = sum(math.log((m.counts[f][k] + m.beta) / (m.totals[k] + m.beta * v)) for f in ("think", "write"))
        expect.append(math.log(m.prior[k] / sum(m.prior)) + m.alpha * ll if m.prior[k] > 0 else -math.inf)
    top = max(expect)
    e = [math.exp(x - top) for x in expect]
    assert nb.belief(feats, m) == pytest.approx([x / sum(e) for x in e], abs=1e-12)


def test_unknown_features_are_skipped_and_alpha_tempers():
    m = tiny()
    m.prior = [1.0, 1.0, 1.0, 1.0, 1.0]
    assert nb.belief(["nothing", "known"], m) == pytest.approx([0.2] * 5)
    sharp = nb.belief(["write", "essay"], m)
    m.alpha = 0.1
    soft = nb.belief(["write", "essay"], m)
    assert sharp[0] > soft[0] > 0.2
    m.alpha = 0.0
    assert nb.belief(["write", "essay"], m) == pytest.approx([0.2] * 5)


def test_estimate_and_certainty():
    assert nb.estimate([0, 0, 0, 1, 0]) == 0.75
    assert nb.estimate([0.5, 0, 0, 0, 0.5]) == 0.5
    assert nb.certainty([0.2] * 5) == pytest.approx(0)
    assert nb.certainty([0, 0, 1, 0, 0]) == pytest.approx(1)
    assert 0 < nb.certainty([0.7, 0.3, 0, 0, 0]) < 1


def test_fit_equals_updates_then_prunes():
    feats = [["a", "b"], ["a", "c"], ["a"], ["d"]]
    dists = [[1, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 0, 1]]
    full = nb.fit(feats, dists, 0.3, 0.1)
    assert sorted(full.counts) == ["a", "b", "c", "d"]
    assert full.counts["a"] == [1, 1, 1, 0, 0]
    assert full.prior == [1, 1, 1, 0, 1]
    pruned = nb.fit(feats, dists, 0.3, 0.1, min_docs=2)
    assert list(pruned.counts) == ["a"] and pruned.totals == [1, 1, 1, 0, 0]
    top1 = nb.fit(feats, dists, 0.3, 0.1, top_k=1)
    assert len(top1.counts) == 1
