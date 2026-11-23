"""The IP on tiny hand-built forests with hand-set scores, one test per outcome (plan Phase 4)."""
import random

import pytest

from forest.config import IPParams
from forest.ip import IPInput, NewGroup, NewTopic, place
from forest.model import Forest, Group, Prompt, Topic

BASE = IPParams(size_limited=True)


def forest_with(topics: dict[str, tuple[str, str, str]], prompts: dict[str, str], groups=None) -> Forest:
    """topics: id -> (label, parent id, parent kind); prompts: id -> topic id."""
    f = Forest(step=len(prompts))
    for g, label in (groups or {"g1": "Deep Learning"}).items():
        f.groups[g] = Group(g, label)
    for t, (label, pid, kind) in topics.items():
        f.topics[t] = Topic(t, label, pid, kind)
    for i, (p, t) in enumerate(prompts.items(), 1):
        f.prompts[p] = Prompt(p, f"text of {p}", i, "test")
        f.assignment[p] = t
        f.access_log[p] = i
    return f.validate(3)


def make_input(f: Forest, s=None, h=None, hg=None, new_topics=(), new_groups=(), stay_fit=0.9) -> IPInput:
    n = Prompt("n", "new prompt", f.step + 1, "test")
    s = dict(s or {})
    for p, c in f.assignment.items():
        s.setdefault((p, c), stay_fit)
    h = dict(h or {})
    hg = dict(hg or {})
    for c, t in f.topics.items():
        (h if t.parent_kind == "topic" else hg).setdefault((t.parent_id, c), 0.8)
    return IPInput(
        forest=f, n=n,
        new_topics={t.id: t for t in new_topics}, new_groups={g.id: g for g in new_groups},
        s=s, h=h, hg=hg, w={p: 1.0 for p in f.prompts}, v={c: 1.0 for c in [*f.topics, *f.groups]})


def two_trees(n_backprop=2):
    prompts = {f"p{i}": "t1" for i in range(1, n_backprop + 1)}
    prompts.update({"q1": "t2", "q2": "t2"})
    return forest_with({"t1": ("Backpropagation", "g1", "group"), "t2": ("Optimizers", "g1", "group")}, prompts)


def test_a_add_to_existing_topic_with_room():
    f = two_trees()
    r = place(make_input(f, s={("n", "t1"): 0.9, ("n", "t2"): 0.1}), BASE)
    assert (r.action, r.topic_of_n) == ("a", "t1")
    assert r.diff["moved_prompts"] == [] and r.solution.z == 0


def test_b_new_branch_under_full_topic():
    f = two_trees(n_backprop=6)  # t1 is at U = 6
    nt = NewTopic("N1", "Vanishing gradients")
    r = place(make_input(f, s={("n", "t1"): 0.75, ("n", "N1"): 1.0}, h={("t1", "N1"): 1.0}, new_topics=[nt]), BASE)
    assert r.action == "b"
    assert r.forest.topics["N1"].parent_id == "t1"
    assert r.forest.assignment["n"] == "N1"


def test_c_new_tree_in_existing_group():
    f = two_trees()
    nt = NewTopic("N1", "Activation functions")
    r = place(make_input(f, s={("n", "t1"): 0.25, ("n", "t2"): 0.2, ("n", "N1"): 1.0},
                         hg={("g1", "N1"): 0.9}, new_topics=[nt]), BASE)
    assert r.action == "c"
    assert (r.forest.topics["N1"].parent_id, r.forest.topics["N1"].parent_kind) == ("g1", "group")


def test_d_new_group_when_lam_G_low():
    f = two_trees()
    nt, ng = NewTopic("N1", "Eigenvalues"), NewGroup("G1", "Linear Algebra")
    inp = make_input(f, s={("n", "t1"): 0.25, ("n", "t2"): 0.2, ("n", "N1"): 1.0},
                     hg={("G1", "N1"): 1.0, ("g1", "N1"): 0.1}, new_topics=[nt], new_groups=[ng])
    r = place(inp, BASE.replace(lam_G=0.2))
    assert r.action == "d"
    assert r.forest.topics["N1"].parent_id == "G1" and "G1" in r.forest.groups
    # with the default lam_G = 1.0 the new group is too expensive: n joins an existing topic instead
    assert place(inp, BASE).action == "a"


def rebalance_input():
    f = two_trees(n_backprop=6)
    nt = NewTopic("N1", "Vanishing gradients")
    s = {("n", "t1"): 0.75, ("n", "N1"): 1.0, ("p5", "N1"): 1.0, ("p6", "N1"): 1.0, ("p5", "t1"): 0.6, ("p6", "t1"): 0.6}
    s.update({(p, "N1"): 0.1 for p in ["p1", "p2", "p3", "p4"]})
    return make_input(f, s=s, h={("t1", "N1"): 1.0}, new_topics=[nt])


def test_e_rebalance_moves_exactly_the_two_fitting_prompts():
    r = place(rebalance_input(), BASE.replace(mu=0.05, F=0.05))
    assert r.action == "e" and r.placement == "b"
    assert r.diff["moved_prompts"] == ["p5", "p6"]
    assert r.diff["m_fired"] == ["p5", "p6"]
    assert {p for p, c in r.forest.assignment.items() if c == "N1"} == {"n", "p5", "p6"}


def test_e_high_mu_means_no_rebalance():
    r = place(rebalance_input(), BASE.replace(mu=2.0, F=0.05))
    assert r.action == "b" and r.solution.z == 0
    assert r.diff["moved_prompts"] == []


def test_rename_keeps_id_and_counts_no_moves():
    f = forest_with({"t1": ("Neural networks", "g1", "group"), "t2": ("Optimizers", "g1", "group")},
                    {"p1": "t1", "p2": "t1", "p3": "t1", "q1": "t2", "q2": "t2"})
    r_ = NewTopic("R1", "Backpropagation", rename_of="t1")
    s = {(p, "t1"): 0.5 for p in ["p1", "p2", "p3", "n"]}
    s.update({(p, "R1"): 0.9 for p in ["p1", "p2", "p3", "n"]})
    inp = make_input(f, s=s, hg={("g1", "R1"): 0.8}, new_topics=[r_])
    r = place(inp, BASE.replace(rho=0.05, F=0.05))
    assert r.action == "e"
    assert r.diff["renamed_topics"] == {"t1": {"from": "Neural networks", "to": "Backpropagation"}}
    assert r.forest.topics["t1"].label == "Backpropagation"
    assert r.diff["moved_prompts"] == [] and r.diff["m_fired"] == []
    assert r.diff["k_fired"] == [] and r.diff["deleted_topics"] == []
    # without the rename extension the same input keeps the old name
    r2 = place(inp, BASE.replace(rho=0.05, F=0.05, use_renames=False))
    assert r2.forest.topics["t1"].label == "Neural networks"


def test_deleted_topic_fires_k():
    f = forest_with({"t1": ("Backpropagation", "g1", "group"), "t2": ("Optimizers", "g1", "group"),
                     "t3": ("Misc", "g1", "group")},
                    {"p1": "t1", "p2": "t1", "q1": "t2", "q2": "t2", "r1": "t3"})
    s = {("r1", "t3"): 0.3, ("r1", "t1"): 0.9, ("n", "t1"): 0.9}
    r = place(make_input(f, s=s), BASE.replace(mu=0.05, nu=0.05, F=0.05))
    assert r.action == "e"
    assert r.diff["deleted_topics"] == ["t3"] and "t3" in r.diff["k_fired"]
    assert r.forest.assignment["r1"] == "t1"


def test_change_nothing_is_always_feasible():
    """Huge stability costs and a new prompt that fits nothing: n still lands in an old topic."""
    rng = random.Random(0)
    f = two_trees(n_backprop=4)
    s = {(p, c): rng.random() for p in [*f.prompts, "n"] for c in f.topics}
    s[("n", "t1")] = s[("n", "t2")] = 0.01
    big = BASE.replace(mu=100, nu=100, F=100, K_T=2, K_G=1)
    r = place(make_input(f, s=s, stay_fit=0.0), big)
    assert r.solution.z == 0 and r.action == "a"
    assert all(r.forest.assignment[p] == f.assignment[p] for p in f.prompts)


def test_depth_limit_blocks_a_too_deep_branch():
    f = forest_with({"t1": ("Backpropagation", "g1", "group"), "t2": ("Chain rule", "t1", "topic")},
                    {"p1": "t1", "p2": "t1", "p3": "t2", "p4": "t2"})
    nt = NewTopic("N1", "Jacobians")
    inp = make_input(f, s={("n", "t2"): 0.6, ("n", "N1"): 1.0}, h={("t2", "N1"): 1.0}, new_topics=[nt])
    assert place(inp, BASE.replace(lam=0.0, beta=0.0)).action == "b"       # depth 2 allowed at D = 3
    assert place(inp, BASE.replace(lam=0.0, beta=0.0, D=2)).action == "a"  # not at D = 2


def test_group_limit_is_hard():
    f = two_trees()
    nt, ng = NewTopic("N1", "Eigenvalues"), NewGroup("G1", "Linear Algebra")
    inp = make_input(f, s={("n", "t1"): 0.25, ("n", "N1"): 1.0}, hg={("G1", "N1"): 1.0},
                     new_topics=[nt], new_groups=[ng])
    assert place(inp, BASE.replace(lam_G=0.0)).action == "d"
    assert place(inp, BASE.replace(lam_G=0.0, K_G=1)).action == "a"


def test_first_prompt_creates_group_and_tree():
    f = Forest(step=0)
    nt, ng = NewTopic("N1", "Backpropagation"), NewGroup("G1", "Deep Learning")
    inp = IPInput(forest=f, n=Prompt("n", "x", 1, "test"), new_topics={"N1": nt}, new_groups={"G1": ng},
                  s={("n", "N1"): 1.0}, h={}, hg={("G1", "N1"): 1.0}, w={}, v={})
    r = place(inp, BASE)
    assert r.action == "d" and r.forest.path("N1") == "Deep Learning > Backpropagation"


@pytest.mark.parametrize("seed", range(5))
def test_random_instances_stay_valid_and_small(seed):
    rng = random.Random(seed)
    topics = {f"t{i}": (f"T{i}", "g1", "group") for i in range(4)}
    topics.update({f"t{i}": (f"T{i}", f"t{i - 4}", "topic") for i in range(4, 8)})
    prompts = {f"p{i}": f"t{rng.randrange(8)}" for i in range(24)}
    for c in topics:  # no empty topics
        prompts[f"x{c}"] = c
    f = forest_with(topics, prompts)
    news = [NewTopic(f"N{i}", f"New {i}") for i in range(2)]
    s = {(p, c): rng.random() for p in [*f.prompts, "n"] for c in [*f.topics, "N0", "N1"]}
    h = {(a, b): rng.random() for a in f.topics for b in [*f.topics, "N0", "N1"] if a != b}
    hg = {("g1", c): rng.random() for c in [*f.topics, "N0", "N1"]}
    r = place(make_input(f, s=s, h=h, hg=hg, new_topics=news), BASE.replace(mu=0.1, F=0.1))
    r.forest.validate(3)
    assert r.size["vars"] < 2000 and r.size["constrs"] < 2000
    assert len(r.forest.prompts) == len(f.prompts) + 1
