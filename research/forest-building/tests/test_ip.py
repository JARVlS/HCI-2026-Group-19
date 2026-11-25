"""One test per outcome (plan Phase 2): tiny hand-built forests with hand-set judge outputs.

CASES is also used by notebooks/02_pipeline.ipynb to draw one step_view per case.
"""
from dataclasses import dataclass
from typing import Callable

import pytest

from forest.ip import Params, solve
from forest.judge import ExistingFit, JudgeOutput, Move, OracleJudge, ParentFit, Proposed
from forest.model import Forest, ForestError, Group, Placement, Prompt, Topic, load_ideal

BASE = Params()


def make(topics: dict, prompts: dict, groups=None) -> Forest:
    """topics: id -> (label, parent, kind[, stored fit]); prompts: id -> topic (created 1, 2, ...)."""
    f = Forest(step=len(prompts))
    for g, label in (groups or {"g_dl": "Deep Learning"}).items():
        f.groups[g] = Group(g, label)
    for t, spec in topics.items():
        f.topics[t] = Topic(t, spec[0], spec[1], spec[2], spec[3] if len(spec) > 3 else 1.0)
    for i, (p, t) in enumerate(prompts.items(), 1):
        f.prompts[p] = Prompt(p, f"question {p}")
        f.placement[p] = Placement(t, 1.0, i)
    return f.validate(3)


def out(existing: dict, proposed=(), moves=()) -> JudgeOutput:
    return JudgeOutput(existing=[ExistingFit(topic_id=t, fit=v) for t, v in existing.items()],
                       proposed=[Proposed(name=n, fit=f, parents=[ParentFit(parent=p, fit=pf) for p, pf in ps])
                                 for n, f, ps in proposed],
                       restructure=[Move(kind=k, id=i, to=to, fit=fit) for k, i, to, fit in moves])


@dataclass
class Case:
    before: Forest
    prompt: Prompt
    judge: JudgeOutput
    params: Params
    check: Callable  # (after, decision) -> None

    def run(self):
        return solve(self.before, self.prompt, self.judge, self.before.step + 1, self.params)


NN = {"t_nn": ("Neural networks", "g_dl", "group"), "t_bp": ("Backpropagation", "t_nn", "topic")}


def case_a():
    f = make(NN, {"p1": "t_nn", "p2": "t_nn", "p3": "t_bp", "p4": "t_bp"})
    def check(after, dec):
        assert dec.action == "a" and after.placement["n"].topic == "t_bp"
    return Case(f, Prompt("n", "How does the chain rule apply in backprop?"), out({"t_bp": 5, "t_nn": 4}), BASE, check)


def case_b():
    f = make(NN, {"p1": "t_nn", "p2": "t_nn", **{f"b{i}": "t_bp" for i in range(5)}})  # Backpropagation is full
    j = out({"t_bp": 4, "t_nn": 3}, proposed=[("Vanishing gradients", 5, [("t_bp", 5)])])
    def check(after, dec):
        assert dec.action == "b" and after.topics[after.placement["n"].topic].parent == "t_bp"
    return Case(f, Prompt("n", "Why does the gradient vanish in deep sigmoid nets?"), j, BASE, check)


def case_c():
    f = make(NN, {"p1": "t_nn", "p2": "t_nn", "p3": "t_bp", "p4": "t_bp"})
    j = out({"t_bp": 2, "t_nn": 2}, proposed=[("Optimizers", 5, [("g_dl", 5)])])
    def check(after, dec):
        t = after.topics[after.placement["n"].topic]
        assert dec.action == "c" and (t.parent, t.parent_kind) == ("g_dl", "group")
    return Case(f, Prompt("n", "Should I use SGD or Adam?"), j, BASE, check)


def case_d():
    f = make(NN, {"p1": "t_nn", "p2": "t_nn", "p3": "t_bp", "p4": "t_bp"})
    j = out({"t_bp": 1, "t_nn": 1}, proposed=[("Eigenvalues", 5, [("NEW_GROUP:Linear Algebra", 5)])])
    def check(after, dec):
        assert dec.action == "d" and "Linear Algebra" in {g.label for g in after.groups.values()}
    return Case(f, Prompt("n", "How do I find the eigenvalues of a 2x2 matrix?"), j, BASE.replace(lam_G=0.2), check)


def training_problems(nu: float, vg_fit: int = 5, of_fit: int = 5):
    """Vanishing gradients and Overfitting hang under Neural networks with stored fit 0.5 (fit 3);
    the judge proposes Training problems and moving both under it."""
    f = make({"t_nn": ("Neural networks", "g_dl", "group"),
              "t_vg": ("Vanishing gradients", "t_nn", "topic", 0.5),
              "t_of": ("Overfitting", "t_nn", "topic", 0.5)},
             {"p1": "t_nn", "p2": "t_nn", "p3": "t_vg", "p4": "t_vg", "p5": "t_of", "p6": "t_of"})
    j = out({"t_nn": 4, "t_vg": 3, "t_of": 3}, proposed=[("Training problems", 5, [("t_nn", 5)])],
            moves=[("topic", "t_vg", "Training problems", vg_fit), ("topic", "t_of", "Training problems", of_fit)])
    return f, Prompt("n", "What usually goes wrong when training a deep network?"), j, BASE.replace(mu=0.05, nu=nu, F=0.05)


def case_e():
    f, n, j, P = training_problems(nu=0.05)
    def check(after, dec):
        tp = after.placement["n"].topic
        assert dec.action == "e" and after.topics["t_vg"].parent == tp and after.topics["t_of"].parent == tp
        assert [ok for _, ok in dec.moves] == [True, True]
    return Case(f, n, j, P, check)


def case_e_high_nu():
    f, n, j, P = training_problems(nu=5.0)
    def check(after, dec):
        assert dec.action != "e" and dec.diff["moved_topics"] == [] and [ok for _, ok in dec.moves] == [False, False]
    return Case(f, n, j, P, check)


def case_reject_one():
    f, n, j, P = training_problems(nu=0.05, of_fit=2)  # moving Overfitting is a poor fit, and it was just used
    def check(after, dec):
        assert [ok for _, ok in dec.moves] == [True, False]
        assert after.topics["t_of"].parent == "t_nn"
    return Case(f, n, j, P, check)


def case_delete():
    f = make({**NN, "t_misc": ("Misc", "g_dl", "group", 1.0)},
             {"p1": "t_nn", "p2": "t_nn", "p3": "t_bp", "p4": "t_bp", "p5": "t_misc"})
    f.placement["p5"].fit = 0.25
    j = out({"t_bp": 5, "t_nn": 4, "t_misc": 1}, moves=[("prompt", "p5", "t_bp", 5)])
    def check(after, dec):
        assert dec.action == "e" and dec.diff["deleted_topics"] == ["t_misc"] and after.placement["p5"].topic == "t_bp"
    return Case(f, Prompt("n", "What are the local gradients in f = (x + y) * z?"), j,
                BASE.replace(mu=0.05, nu=0.05, F=0.05), check)


CASES = {
    "(a) add": case_a,
    "(b) new branch": case_b,
    "(c) new tree": case_c,
    "(d) new group": case_d,
    "(e) both moves adopted": case_e,
    "(e) high nu: no moves": case_e_high_nu,
    "weak move rejected, other adopted": case_reject_one,
    "emptied topic deleted": case_delete,
}


@pytest.mark.parametrize("name", CASES)
def test_case(name):
    case = CASES[name]()
    after, dec = case.run()
    case.check(after, dec)
    assert dec.size["vars"] < 2000 and dec.size["constrs"] < 2000


def test_new_group_impossible_at_plan_lam_G():
    """With lam_G = 1.0 (plan start) a new group costs 1.7 and gains at most 1.5."""
    case = case_d()
    _, dec = solve(case.before, case.prompt, case.judge, case.before.step + 1, BASE.replace(lam_G=1.0))
    assert dec.action == "a"


def test_ideal_forest_validates_and_bad_forests_fail():
    ideal = load_ideal()
    ideal.forest.validate(3)
    f = make(NN, {"p1": "t_nn", "p2": "t_bp"})
    f.topics["t_nn"].parent, f.topics["t_nn"].parent_kind = "t_bp", "topic"
    with pytest.raises(ForestError, match="cycle"):
        f.validate()
    g = make(NN, {"p1": "t_nn", "p2": "t_bp"})
    g.topics["t_x"] = Topic("t_x", "Empty", "g_dl", "group", 1.0)
    with pytest.raises(ForestError, match="empty"):
        g.validate()


def test_oracle_chains_missing_topics():
    """At the first prompt everything is missing: the oracle proposes the tree root under a new
    group, and the next topic of the chain under it."""
    ideal = load_ideal()
    j = OracleJudge(ideal)(Forest(), Prompt("p10", ideal.forest.prompts["p10"].text), 1)
    assert [p.name for p in j.proposed] == ["Neural networks", "Training problems"]
    assert j.proposed[0].parents[0].parent == "NEW_GROUP:Deep Learning"
    assert j.proposed[1].parents[0].parent == "Neural networks"
