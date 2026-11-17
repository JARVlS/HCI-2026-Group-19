"""Pure logic in scoring.py: the OpenAI-style request body and the logprob scoring."""

import math

import pytest
from fake_anthropic import SCORE_TOP, completion_json
from fakes import make_env

import scoring
from config import Settings
from errors import ApiError
from schemas import ScoreRequest

SETTINGS = Settings.from_env(make_env())


def request(**fields):
    base = {"system": "Answer 1 or 2.", "messages": [{"role": "user", "content": "I think it is 4."}],
            "options": ["1", "2"]}
    return ScoreRequest.model_validate({**base, **fields})


def test_body_headers_and_url():
    assert scoring.build_body(request(), SETTINGS) == {
        "model": "fast-model",
        "messages": [{"role": "system", "content": "Answer 1 or 2."}, {"role": "user", "content": "I think it is 4."}],
        "max_tokens": 1,
        "temperature": 0,
        "logprobs": True,
        "top_logprobs": 20,
    }
    assert scoring.request_headers("k") == {"authorization": "Bearer k", "content-type": "application/json"}
    assert scoring.completions_url(SETTINGS) == "https://fast.test/v1/chat/completions"  # trailing / stripped


def test_body_keeps_the_conversation_and_leaves_out_an_empty_system():
    messages = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}, {"role": "user", "content": "c"}]
    assert scoring.build_body(request(system="", messages=messages), SETTINGS)["messages"] == messages


def test_usage():
    usage = scoring.usage_from({"prompt_tokens": 212, "completion_tokens": 1, "total_tokens": 213})
    assert (usage.input_tokens, usage.output_tokens) == (212, 1)
    assert scoring.usage_from({}).total == 0


def test_probabilities_merge_whitespace_tokens_and_normalize():
    probabilities, mass = scoring.option_probabilities(completion_json(SCORE_TOP), ["1", "2"])
    assert mass == pytest.approx(0.95)  # "Sure" (0.05) is not an option
    assert probabilities == pytest.approx({"1": 0.8 / 0.95, "2": 0.15 / 0.95})  # "1" and " 1" together
    assert list(probabilities) == ["1", "2"]  # in the order of the options


def test_option_the_model_did_not_list_gets_zero():
    top = {"no": 0.7, " yes": 0.25, "Maybe": 0.03}  # matching is case-sensitive: "Maybe" is not "maybe"
    probabilities, mass = scoring.option_probabilities(completion_json(top), ["yes", "no", "maybe"])
    assert mass == pytest.approx(0.95)
    assert probabilities == pytest.approx({"yes": 0.25 / 0.95, "no": 0.7 / 0.95, "maybe": 0.0})
    assert sum(probabilities.values()) == pytest.approx(1.0)


def test_mass_never_exceeds_one():
    data = completion_json({"1": 0.5, " 1": 0.5})
    data["choices"][0]["logprobs"]["content"][0]["top_logprobs"][0]["logprob"] = math.log(0.5000001)
    probabilities, mass = scoring.option_probabilities(data, ["1", "2"])
    assert mass == 1.0 and probabilities["1"] == pytest.approx(1.0) and probabilities["2"] == 0.0


def test_low_mass_names_the_likeliest_token():
    with pytest.raises(ApiError) as caught:
        scoring.option_probabilities(completion_json({"Sure": 0.6, "1": 0.3, "2": 0.09}), ["1", "2"])
    assert (caught.value.status, caught.value.code) == (502, "invalid_model_output")
    assert "did not answer with one of the options" in caught.value.message
    assert "39%" in caught.value.message and "'Sure'" in caught.value.message


def test_mass_of_exactly_half_is_enough():
    _, mass = scoring.option_probabilities(completion_json({"1": 0.25, "2": 0.25, "x": 0.5}), ["1", "2"])
    assert mass == pytest.approx(0.5)


def no_logprobs_variants():
    missing = completion_json(None)
    del missing["choices"][0]["logprobs"]
    empty_content = completion_json({})
    empty_top = completion_json({"1": 1.0})
    empty_top["choices"][0]["logprobs"]["content"][0]["top_logprobs"] = []
    return [completion_json(None), missing, empty_content, empty_top, {"choices": []}, {}]


@pytest.mark.parametrize("data", no_logprobs_variants())
def test_no_logprobs(data):
    with pytest.raises(ApiError) as caught:
        scoring.option_probabilities(data, ["1", "2"])
    assert (caught.value.status, caught.value.code) == (502, "invalid_model_output")
    assert "no logprobs" in caught.value.message
