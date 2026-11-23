import pytest

from forest.io import SESSION_IDS, gold_forest, load_gold, load_session
from forest.model import Forest, ForestError, Group, Prompt, Topic


def small_forest() -> Forest:
    f = Forest(step=3)
    f.groups["g1"] = Group("g1", "Deep Learning")
    f.topics["t1"] = Topic("t1", "Backpropagation", "g1", "group")
    f.topics["t2"] = Topic("t2", "Vanishing gradients", "t1", "topic")
    for i, t in [(1, "t1"), (2, "t1"), (3, "t2")]:
        p = Prompt(f"p{i}", f"prompt {i}", i, "s")
        f.prompts[p.id] = p
        f.assignment[p.id] = t
        f.access_log[p.id] = i
    return f


def test_hand_built_forest_validates():
    f = small_forest().validate(D=3)
    assert f.path("t2") == "Deep Learning > Backpropagation > Vanishing gradients"
    assert f.depth("t2") == 1
    assert f.subtree_prompts("t1") == ["p1", "p2", "p3"]
    assert f.group_of("t2") == "g1"


def test_json_round_trip():
    f = small_forest()
    assert Forest.from_json(f.to_json()).to_json() == f.to_json()


def test_cycle_fails_with_clear_message():
    f = small_forest()
    f.topics["t1"] = Topic("t1", "Backpropagation", "t2", "topic")
    with pytest.raises(ForestError) as e:
        f.validate()
    assert any("cycle" in p for p in e.value.problems)


def test_empty_topic_and_group_fail():
    f = small_forest()
    f.topics["t3"] = Topic("t3", "Optimizers", "g1", "group")
    f.groups["g2"] = Group("g2", "Linear Algebra")
    with pytest.raises(ForestError) as e:
        f.validate()
    msgs = "\n".join(e.value.problems)
    assert "t3 ('Optimizers') is empty" in msgs
    assert "g2 ('Linear Algebra') is empty" in msgs


def test_depth_limit():
    f = small_forest()
    f.topics["t3"] = Topic("t3", "Sigmoid", "t2", "topic")
    f.assignment["p3"] = "t3"
    f.validate(D=3)
    with pytest.raises(ForestError, match="deeper than"):
        f.validate(D=2)


def test_unassigned_prompt_and_unknown_parent():
    f = small_forest()
    f.prompts["p9"] = Prompt("p9", "x", 9, "s")
    f.topics["t2"] = Topic("t2", "Vanishing gradients", "nope", "topic")
    with pytest.raises(ForestError) as e:
        f.validate()
    msgs = "\n".join(e.value.problems)
    assert "p9 is in no topic" in msgs and "unknown topic nope" in msgs


@pytest.mark.parametrize("sid", SESSION_IDS)
def test_sessions_load_and_gold_forest_is_valid(sid):
    s = load_session(sid)
    gold = load_gold(sid)
    assert set(gold) == {p.id for p in s.prompts}
    f = gold_forest(s, gold, upto_step=len(s.prompts) + 1)
    f.validate(D=3)
    assert len(f.prompts) == len(s.prompts)
