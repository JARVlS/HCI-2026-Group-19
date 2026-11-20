# Thinking filter (research)

A small naive Bayes word filter that estimates, live while a student types, how much of the thinking
in the draft is the student's own, on the app's 5-step *thought along* scale. It runs in the browser
after every typed word, with no network call, and it learns from the slower judge that rates every
message after sending (the fast model `zai.glm-4.7`, G-Eval style, `frontend/src/ai/prompts/score.ts`).
Since round 2 it also reads the word rules' verdict on the same draft (`classify()`), which runs in the
browser anyway, as evidence.

Findings, numbers and the recommendations are in [`out/report.md`](out/report.md). This file says how
to rerun everything.

## What is here

| Path | What |
|---|---|
| `thinking_filter/nb.py` | The filter, reference implementation: `features()`, `belief()`, `update()`, `fit()`, the weights file format. The frontend mirrors this file. |
| `bridge.ts` | Runs the app's own `scorePrompt()`, `classify()` (label, confidence, reasons) and `draftShare()` from `frontend/src` (Node type stripping, read-only), so the judge prompt, the rule features and the word-rule baseline never drift from the app. |
| `thinking_filter/generate.py` | Step 2: the synthetic set from Claude Sonnet 5. Round 1: spec grid of 14 kinds, 22 subjects, 8 styles, 5 length bands, about 30 % replies. Round 2: bare commands, short fact questions, solve requests without an attempt, quiz requests as commands, very short messages, and 80 German messages. Plus 40 messages of one student with a habit. |
| `thinking_filter/label.py` | Step 3: judge labels (five option probabilities, mass, percent) with and without the tutor's message as history, for prefixes, for the habit set. |
| `thinking_filter/sonnet.py` | Step 5: Claude Sonnet 5 rates 200 stratified items with the same rubric (one integer). |
| `thinking_filter/cv.py` | Step 6: feature groups (words and rule features), vocabulary cap by 5-fold CV on the Brier score; `alpha`, `beta` by CV label agreement; writes `out/weights.json` and `out/selection.json`. |
| `thinking_filter/vectors.py` | 40 test vectors for the TypeScript port (`out/vectors.json`). |
| `thinking_filter/linter_set.py` | Exports Leon's 136 hand-made prompts (`frontend/eval/linter-set.ts` at commit 058f289, labels: Claude's draft) to `data/linter-set.json`, and the metrics of `frontend/eval/metrics.ts` (accuracy, Cohen's kappa plain and linearly weighted). The filter never trains on them. |
| `thinking_filter/evaluate.py` | Steps 4, 5, 7: every number of the report (`out/results.json`). |
| `thinking_filter/models.py` | Model calls through the local stand-in, disk cache, hard budgets. |
| `thinking_filter/design.py` | Fixed choices: folds, samples, prefixes, `TRAIN_CONDITION`. |
| `data/synthetic.jsonl` | 1,336 synthetic student messages (989 of round 1, 347 of round 2): `id, text, tutor` (null for a first message), `target` (generator's aim, 1 to 5), `subject, kind, hard, length, style, lang` (`en`, `de`), `round`. Synthetic only, no real student data; none equals one of Leon's prompts (`tests/test_no_leak.py`). |
| `data/habit.jsonl` | 40 messages of one student with one unusual style (same fields). |
| `data/labels.jsonl` | Judge labels: `id, cond` (`without` or `with` history), `prefix` (null, `1/3`, `2/3`), `text`, `probs` (levels 1..5), `mass`, `percent`, `prompt` (hash of the system prompt), or `error`. |
| `data/sonnet.jsonl` | Sonnet's ratings: `id, cond, rating`. |
| `data/linter-set.json` | Leon's 136 prompts: `id` (L001..), `text`, `label`, `tags`. |
| `out/selection.json` | Every configuration of the CV search with its Brier score, cross-entropy, error and label agreement. |
| `out/results.json` | Every number of the report. |
| `out/weights.json` | The shipped filter (counts, so the browser can keep learning). |
| `out/vectors.json` | Test vectors for the port. |
| `cache/` | Every model answer (`judge.jsonl`, `claude.jsonl`, keyed by a hash of the request) and every HTTP attempt (`ledger.jsonl`). A rerun with the cache costs nothing. |

## Rerun

Needs `uv`, Node 22.18+ (type stripping) and `npm ci` in `frontend/` once (the bridge imports the
frontend's TypeScript, no packages; `npm ci` is only needed for the frontend's own tests).

```bash
cd research/thinking-filter
uv sync
# Model calls (only for answers not in cache/): an OpenAI- and Anthropic-compatible endpoint on
# PROXY_URL (default http://127.0.0.1:8790), e.g. the Bedrock stand-in byok_proxy.py. With a full
# cache, steps 2, 3 and 5 make no calls and need no endpoint.
uv run python -m thinking_filter.generate    # step 2  -> data/synthetic.jsonl, data/habit.jsonl
uv run python -m thinking_filter.linter_set  #         -> data/linter-set.json (needs commit 058f289 in git)
uv run python -m thinking_filter.label       # step 3  -> data/labels.jsonl
uv run python -m thinking_filter.sonnet      # step 5  -> data/sonnet.jsonl
uv run python -m thinking_filter.cv          # step 6  -> out/weights.json, out/selection.json
uv run python -m thinking_filter.vectors     #         -> out/vectors.json
uv run python -m thinking_filter.evaluate    # 4, 5, 7 -> out/results.json
uv run pytest -q                             # tests
```

`models.py` refuses a call that would go over the package budget (cumulative caps in `models.py`),
counting every attempt in `cache/ledger.jsonl`. Used on 17 Nov: round 1, 1,602 judge calls and 243,087
Claude tokens; round 2, 438 judge calls and 43,178 Claude tokens. With the cache in git a rerun costs
nothing; a fresh run of steps 2 to 5 costs the same again.

Labels for the filter: the judge WITH the tutor's last message as history for replies
(`design.TRAIN_CONDITION = "with"`), as the app sends it. Feature groups and vocabulary: chosen by the
Brier score of the belief against the judge's distribution; rule features only if they also help on
Leon's set. `alpha` and `beta`: the best cross-validated label agreement (the instant tier's output is
the label), and among settings within half a point of it the lowest Brier score (`cv.py`). Samples
(word by word, prefixes, Sonnet) are drawn from round 1 only, so round 2 reuses their judge labels.

## The weights file and the port

`out/weights.json`: `{ version, levels: 5, levelWeights, alpha, beta, vocabSize, prior: [5], totals: [5],
counts: { "<feature>": [5] }, featureSpec }`. `featureSpec` is the exact recipe from a draft to its
features (also in `nb.py`, `FEATURE_SPEC`). The port computes `features(draft, tutorAsked,
classify(draft))`: since version `2026-11-17.2` the last features come from the word rules' result on
the same draft (`rule:<label>`, `rule:<label>:sure` at confidence 0.7 or more, one `rule:<reason
without the quoted words>` per reason). They change with every word and can disappear again, as can
`?$` and the length band, so the belief is recomputed from the current draft's features at every
space (a few dozen additions), never multiplied in step by step. If `classify.ts` changes its labels or
reasons, refit (`tests/test_weights_vectors.py` fails until then). The belief:

```
log b[k] = ln(prior[k] / sum(prior)) + alpha * sum over features f in counts of ln((counts[f][k] + beta) / (totals[k] + beta * vocabSize))
b = softmax(log b);  estimate = sum(b[k] * levelWeights[k]);  certainty = 1 - H(b) / ln 5
```

Learning from one judged message (`update`): add `weight * judgeDistribution` to `prior`, to `totals`
once per feature occurrence, and to `counts[f]` for every feature occurrence (new features become keys;
`vocabSize` is then the new number of keys).

`out/vectors.json` has 40 drafts (`text`, `tutorAsked`, `linter` = classify() of the draft: `mode`,
`confidence`, `reasons`; `features`, `belief`, `estimate`, `certainty`; five also have `steps`, the same
after each whitespace-separated word). A port is right when it reproduces them to 1e-6, and when its
classify() gives the same `linter`.
