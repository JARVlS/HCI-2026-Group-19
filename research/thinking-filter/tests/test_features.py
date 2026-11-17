import json
import subprocess

from thinking_filter import nb


def test_tokens_keep_inner_apostrophes_and_unicode():
    assert nb.tokens("Don’t you THINK it's ‘quoted’?") == ["don't", "you", "think", "it's", "quoted"]
    assert nb.tokens("Café straße ÜBER naïve_bayes") == ["café", "straße", "über", "naïve", "bayes"]
    assert nb.tokens("x² + 3.14 = dL/dw") == ["x²", "3", "14", "dl", "dw"]
    assert nb.tokens("rock'n'roll  ok'' 'tis") == ["rock'n'roll", "ok", "tis"]
    assert nb.tokens("  ...?! ") == []


def test_features_exact_order():
    feats = nb.features("Why does ice float? I think it's less dense", True)
    assert feats == [
        "why", "does", "ice", "float", "i", "think", "it's", "less", "dense",
        "why does", "does ice", "ice float", "float i", "i think", "think it's", "it's less", "less dense",
        "^why", "^why does",
        "#len:6-10",
        "@tutor_asked",
    ]


def test_question_mark_length_and_context():
    assert nb.features("ok?  ", False) == ["ok", "^ok", "?$", "#len:1-2"]
    assert nb.features("", True) == ["@tutor_asked"]
    assert nb.features("", False) == []
    assert [nb.length_bucket(n) for n in (1, 2, 3, 5, 6, 10, 11, 20, 21)] == ["1-2", "1-2", "3-5", "3-5", "6-10", "6-10", "11-20", "11-20", "21+"]
    assert nb.tutor_asked("What do you think? ") and not nb.tutor_asked("Good.") and not nb.tutor_asked(None)


def test_repeated_words_count_every_time():
    assert nb.features("no no", False) == ["no", "no", "no no", "^no", "^no no", "#len:1-2"]


def test_python_tokens_match_the_javascript_regex():
    """The port uses /[\\p{L}\\p{N}]+(?:'[\\p{L}\\p{N}]+)*/gu after the same normalisation."""
    texts = ["Don’t you THINK it's ‘quoted’?", "Ünïcödé café straße ẞ", "İstanbul ıi", "x² + 3.14 = dL/dw",
             "naïve_bayes", "emoji 😀 test", "日本語のテキスト", "rock'n'roll ok''", "l'été", "١٢٣ digits", "½ Ⅻ"]
    js = ("const t=JSON.parse(process.argv[1]);const re=/[\\p{L}\\p{N}]+(?:'[\\p{L}\\p{N}]+)*/gu;"
          "console.log(JSON.stringify(t.map(s=>s.replace(/[\\u2019\\u2018]/g,\"'\").toLowerCase().match(re)??[])))")
    out = subprocess.run(["node", "-e", js, json.dumps(texts)], capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == [nb.tokens(t) for t in texts]
