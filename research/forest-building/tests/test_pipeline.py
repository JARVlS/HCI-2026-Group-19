"""End to end with the offline judge (needs the embedding cache in data/frozen or data/cache)."""
import pytest

from forest import config
from forest.baselines import forest_from_restructure
from forest.export import to_app
from forest.io import SESSION_IDS, load_gold, load_session
from forest.judge import RestructureOut, RestructureTopic
from forest.model import Forest, Group, Prompt, Topic
from forest.simulate import ALL_METHODS, make_context, run


@pytest.fixture(scope="module")
def ctx():
    cfg = config.load()
    assert cfg["judge"]["backend"] == "offline", "tests never call a live judge"
    return make_context(cfg)


@pytest.mark.parametrize("sid", SESSION_IDS)
@pytest.mark.parametrize("method", ALL_METHODS)
def test_every_method_keeps_the_forest_valid(ctx, sid, method):
    s = load_session(sid)
    df, forests = run(method, s, ctx, gold=load_gold(sid), upto=10)
    assert len(forests) == 10
    for f in forests:
        f.validate(ctx.params.D)
    assert set(df["action"]) <= set("abcde")
    if method in ("ip", "ip_full_recluster"):
        assert (df["vars"] < 2000).all() and (df["constrs"] < 2000).all()


def test_restructure_answer_becomes_a_valid_forest():
    old = Forest(step=3)
    old.groups["g1"] = Group("g1", "Deep Learning")
    old.topics["t1"] = Topic("t1", "Backpropagation", "g1", "group")
    for i in range(1, 4):
        old.prompts[f"p{i}"] = Prompt(f"p{i}", f"text {i}", i, "s")
        old.assignment[f"p{i}"] = "t1"
    out = RestructureOut(groups=["Deep Learning"], topics=[
        RestructureTopic(name="Backpropagation", parent="GROUP:Deep Learning", prompt_ids=["p1"]),
        RestructureTopic(name="Chain rule", parent="Backpropagation", prompt_ids=["p2", "nope"]),
        RestructureTopic(name="Ghost", parent="Nowhere", prompt_ids=[]),
    ])
    f = forest_from_restructure(out, old, D=3, tag="03").validate(3)
    assert f.assignment["p1"] == "t1"            # label match keeps the old id
    assert f.assignment["p3"] == "t1"            # forgotten prompt keeps its old topic
    assert "Ghost" not in {t.label for t in f.topics.values()}  # empty topics are dropped


def test_app_export_shape():
    f = Forest(step=2)
    f.groups["g1"] = Group("g1", "Deep Learning")
    f.topics["t1"] = Topic("t1", "Backpropagation", "g1", "group")
    f.topics["t2"] = Topic("t2", "Vanishing gradients", "t1", "topic")
    f.prompts["p1"] = Prompt("p1", "x", 1, "s1", "c1")
    f.assignment["p1"] = "t2"
    app = to_app(f)
    kinds = {c["id"]: c["kind"] for c in app["concepts"]}
    assert kinds == {"g1": "subject", "t1": "topic", "t2": "concept"}
    assert app["trees"] == [{"id": "t:t1", "rootConceptId": "t1", "title": "Backpropagation", "groveId": "g1",
                             "createdAt": app["trees"][0]["createdAt"], "updatedAt": app["trees"][0]["updatedAt"]}]
    assert app["attempts"][0]["conceptId"] == "t2" and app["attempts"][0]["conversationId"] == "s1:c1"
