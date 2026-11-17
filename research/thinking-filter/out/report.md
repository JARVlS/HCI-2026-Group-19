# A word filter for "thought along" while typing: findings (17 Nov 2026)

Research package for the live label in Arbor's composer. All numbers come from `out/results.json` and `out/selection.json` (rerun: see `../README.md`). Synthetic data only: no real student wrote any of these messages.

## Verdict
- **The filter works on data like its training data, and it is cheap.**
  - A naive Bayes over words, start words and word pairs, trained on 989 synthetic messages that the app's judge labelled, agrees with the judge's label on **83.6 %** of held-out messages (κ 0.75, error 0.083 on the 0 to 1 scale).
  - Today's word rules reach **66.4 %** (κ 0.49; error of `draftShare` 0.223). Always guessing the prior: 27.5 %.
  - The shipped file is 105 KB; the update after a word is a few dozen additions.
- **On Leon's 136 hand-made prompts the lead disappears.**
  - Filter 66.2 % (κ 0.50), rules 67.6 % (κ 0.52), Leon's naive Bayes trained on the 136 themselves 57 % (κ 0.35).
  - Judge 97.1 % (κ 0.96), but the labels are Claude's draft from the judge's own rubric, so that number is not independent.
  - The filter finds own thinking far better than the rules (recall 83 % vs 46 %). It misses plain short commands ("Define entropy.", "List the steps of mitosis."): it catches only 40 % of delegations (rules 77 %). The synthetic set has too few of those (section 8).
- **Keep the history for the judge after sending** (as the app does now).
  - With the tutor's last message, 28 of 287 replies (9.8 %) change label, 24 of them upward.
  - Nearly all of those are short answers to the tutor's question ("shakespeare?" to "who wrote hamlet": 0 % without history, 62 % with). Without the question they look like fact lookups.
- **The judge is good, with two blind spots.**
  - Against Claude Sonnet 5 on 200 items: same level 81.5 %, within one level 93.5 %, Pearson r 0.92, same label 84.5 % (κ 0.75).
  - They part on messages with an own idea followed by "now write it up for me" (the rubric has no step for that).
  - They also part on claims phrased as questions, where Sonnet reads the rubric better.
- **Learning from the judge after each message helps a little; use weight 1.**
  - Error with no updates 0.094; weight 1: 0.087; weight 3: 0.086; weight 10: 0.091 (worse at first).
  - For one student with a strong habit, the error on their next messages falls from 0.089 to 0.075 after 10 of their messages.
- **While typing:**
  - The estimate stays within 0.2 of its final value from word 2 on (median), and for 79 % of messages by word 5.
  - On drafts cut at a third of their words the filter is 0.148 off the judge, at two thirds 0.093.
  - Where the judge moves, the filter moves the same way in 87 % of the drafts (rules 45 %).

## 1. What was built
- **Judge** = the app's fast score.
  - The prompt is `scorePrompt()` from `frontend/src/ai/prompts/score.ts`, rendered by the frontend's own code through `bridge.ts`. A test asserts that the request equals what `scorePrompt()` renders.
  - The model is `zai.glm-4.7`: one token with its top 20 logprobs. Each digit's share of the five digits' mass is its probability, as in `backend/src/scoring.py`.
  - Percent = Σ p × (0, 0.25, 0.5, 0.75, 1). Labels: own from 0.67, ai up to 0.2, together in between.
  - All 1,572 judge requests gave a usable answer: the five digits held at least 0.998 of the first token's probability.
- **Filter** = a multinomial naive Bayes over the five levels, fitted with soft labels: each message adds the judge's distribution as fractional counts.
  - Belief = prior × Π p(feature | level)^α, normalised.
  - Estimate = the belief-weighted level weights. Certainty = 1 − entropy / ln 5.
  - Reference implementation: `thinking_filter/nb.py`. The exact recipe is in `weights.json` → `featureSpec`.

## 2. The synthetic set
- **Size and grid:** 989 messages from Claude Sonnet 5 (1,000 generated, 11 duplicates dropped). Spec grid: 14 kinds, 22 subjects, 8 styles, 5 length bands, and a target level per item. The judge decides the label, not the target.
- **Replies:** 287 (29 %) come with the tutor's previous message.
- **Hard cases:** 325 in the five tricky kinds:
  - polite or "I think" delegation (75)
  - wrong own claims (75)
  - claims as questions (70)
  - own idea + "write it up" (60)
  - meta (45)

  Plus 105 plain why/how questions and 85 hint or quiz requests.
- **Lengths:** 1 to 124 words, median 16. 32 items are over 60 words; they were kept.
- **What the judge made of it:**
  - Top level per item: 271 / 126 / 126 / 292 / 174 for levels 1 to 5.
  - Labels: 448 own, 272 together, 269 ai.
  - The judge's top level holds 0.90 of the probability on average.
  - The judge's label matches the generator's target 88.4 % of the time.

## 3. With or without history? (287 replies)
- Mean absolute change of the percent: 0.059. History raises the score on average (+0.040).
- Changes over 0.1: 19.2 %. Over 0.25: 4.9 %.
- Label flips: 28 (9.8 %): ai→together 7, ai→own 3, together→own 14, own→together 4.

Biggest flips:

| without | with | tutor | student | reading |
|---|---|---|---|---|
| 0.06 | 0.75 | what element distinguishes murder from manslaughter? | mens rea? intent? | an own answer: with is right |
| 0.06 | 0.72 | what does the green light symbolize for gatsby? | his hope. dreams. | with is right |
| 0.00 | 0.62 | who wrote hamlet | shakespeare? | with is right |
| 0.75 | 0.56 | More data always fixes overfitting, right? | more data = no overfitting, always | the student echoes the tutor: with is defensible |
| 0.07 | 0.21 | What do you think causes confirmation bias? | i dont realy kno, could u just explane it | a delegation: without is right |

**Recommendation: send the tutor's last message to the judge after sending.**
- Without it, a short answer to the tutor's question reads as a bare fact request. That is the case the tool must never punish.
- The cost:
  - 2 of 17 hedged delegations after a question move just over the 0.2 line (to 0.21 and 0.23).
  - About 40 more input tokens per call.
- Even with history, some one-word answers stay low ("sqrt of variance" 0.10, "false positive" 0.31). The rubric lines proposed in section 4 would fix that.
- The generator's targets agree slightly better with the no-history labels (84 % vs 80.5 %). On reading the items, that is because the generator kept the spec's target ("fact", "hint") for texts that are really answers to the tutor.
- The filter learns the with-history labels.

## 4. The judge vs Claude Sonnet 5
200 items, 14 or 15 per kind. Sonnet got the same system prompt and message as the judge (66 of the 200 with history) and answered with one integer through a JSON schema.

| measure | value |
|---|---|
| same level (κ) | 81.5 % (0.755) |
| within one level | 93.5 % |
| Pearson / Spearman r of the percents | 0.923 / 0.858 |
| mean absolute difference of the percents | 0.071 (the judge 0.038 lower on average) |
| same three-way label (κ) | 84.5 % (0.75) |

Confusion (rows: the judge's top level, columns: Sonnet's rating):

| judge \ Sonnet | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 1 | 47 | 4 | 0 | 4 | 0 |
| 2 | 1 | 14 | 2 | 9 | 0 |
| 3 | 0 | 0 | 12 | 11 | 0 |
| 4 | 0 | 0 | 0 | 59 | 0 |
| 5 | 0 | 0 | 0 | 6 | 31 |

- In 30 of the 37 disagreements Sonnet answered 4.
- They agree on the label in 93 to 100 % for 9 kinds. They part on:
  - own idea + "write it up": 36 %
  - vague ideas: 36 %
  - polite delegation: 71 %
  - fact requests: 79 %
  - claims as questions: 80 %

The 15 largest disagreements (judge percent and top level → Sonnet):
1. 0.00 (1) → 4. An own account of HCl + NaOH, then "write up the full balanced equation … for my lab report". **Neither** is right: an own idea plus a hand-over; 3 would fit.
2. 0.10 (1) → 4. "sqrt of variance", answering "what's the formula for standard deviation again?". **Sonnet** is right: an own answer.
3. 0.20 (2) → 4. "i think i should use welch's t-test … can you just set up the whole test for me". **Neither** (own idea + hand-over).
4. 0.26 (1) → 4. An own French sentence, then "can u fix the rest of the paragraph". **Neither** (own idea + hand-over).
5. 0.26 (2) → 4. An own rule for the imperfect, then "write out the full conjugation table". **Neither** (own idea + hand-over).
6. 0.30 (2) → 4. An own claim about the supply curve, then "set up the equations for me". **Neither** (own idea + hand-over).
7. 0.31 (1) → 4. "false positive", answering "what is a type I error called?". **Sonnet** is right.
8. 0.32 (2) → 4. An own idea on erosion, then "can you fill in the rest". **Neither** (own idea + hand-over).
9. 0.34 (2) → 4. "i think its the cell membrane but … just explain the whole thing". **Neither** (own idea + hand-over).
10. 0.34 (2) → 4. An own cause of coral bleaching, then "write a full paragraph". **Neither** (own idea + hand-over).
11. 0.36 (2) → 4. An own palindrome idea (`s == s[::-1]`), then "can u finish it". **Neither** (own idea + hand-over).
12. 0.38 (2) → 4. "isn't a contract only valid if its written down somewhere?". **Sonnet** is right: an own claim as a question.
13. 0.46 (2) → 4. "isn't a contract void if one party was a minor …?". **Sonnet** is right.
14. 0.47 (3) → 4. "Something about the symbolism of the green light, but I'm not sure …". **The judge** is right: a vague idea is 3 by the rubric.
15. 0.50 (3) → 4. "somthin about jurisdiction maybe? not sure". **The judge** is right.

In short: Sonnet is right in 4 of the 15, the judge in 2, and 9 fall into the rubric's gap. Proposed rubric lines for `score.ts` (a decision for the team): "An own answer to the tutor's question is 4, even one word. A claim phrased as a question ('isn't it X?') is 4. An own idea followed by a request to do the rest is 3." The filter learns whatever the judge says, so a rubric fix also fixes the filter's training labels.

## 5. Features and tuning
**Features of a draft:**
- lower-cased words (Unicode letters and digits, apostrophes inside words kept)
- adjacent word pairs
- the first word and the first pair, marked as start
- `?$` when the text ends with a question mark
- the length band of the word count
- `@tutor_asked` when the tutor's last message ended with a question

Unknown features are skipped.

**How it was tuned:**
- 5-fold cross-validation, folds stratified by kind and reply.
- The objective is the **Brier score** of the belief against the judge's distribution. Like cross-entropy it rewards a calibrated belief, but a few confident mistakes do not decide everything.
- Picked on cross-entropy instead, the filter would take α 0.2, and its label agreement would drop to 81.6 %.

Feature groups (features seen in at least 3 messages; α and β tuned per row):

| features | kept | Brier | labels | error |
|---|---|---|---|---|
| **all (shipped)** | 2,244 | **0.192** | 84.3 % | 0.080 |
| without word pairs | 1,160 | 0.197 | 83.0 % | 0.085 |
| without start words | 2,137 | 0.213 | 82.0 % | 0.094 |
| without `?$` | 2,243 | 0.194 | 84.5 % | 0.080 |
| without length band | 2,239 | 0.203 | 84.2 % | 0.082 |
| without `@tutor_asked` | 2,243 | 0.192 | 84.2 % | 0.081 |
| words only | 1,046 | 0.265 | 78.3 % | 0.117 |

- Start words and the length band matter most. The question mark and the context feature add little but cost nothing.
- Vocabulary: keeping features seen in at least 3 messages (2,244 of 15,704) gave the best Brier score. Capping to the 300 to 1,500 most informative features cost 0.005 to 0.013 Brier. Word pairs seen only once are noise.
- **Shipped:** α 0.35, β 1.0, 105 KB. Held-out Brier 0.191, cross-entropy 0.743 (the judge's own entropy is 0.268).

**α is the one real trade-off.**
- At α 0.35 the belief is calibrated: its top level holds 0.814 of the probability on average and is right 81.7 % of the time.
- At α 1 (no tempering):
  - Labels are better: 88.1 % vs 83.6 % held out, error 0.070 vs 0.083; on Leon's set 69.1 % vs 66.2 %.
  - But the belief is overconfident: it holds 0.927 and is right only 81.3 % of the time.
- **Keep 0.35 if the UI uses the certainty**, for example to fade the live label when unsure. The certainty is meaningful at 0.35: the error is 0.152 in the least certain third of messages and 0.023 in the most certain third.
- Set α to 1 if only the label is shown.
- Neither setting is jumpier while typing: 0.93 label changes per message at α 1, 1.0 at 0.35.

## 6. Accuracy against the judge (5-fold, held out, 989 messages)

| | error | RMSE | labels | κ |
|---|---|---|---|---|
| **filter** | **0.083** | 0.138 | **83.6 %** | **0.75** |
| rules via `draftShare()` and the thresholds | 0.223 | 0.293 | 63.2 % | 0.44 |
| rules, the linter's own label | | | 66.4 % | 0.49 |
| prior (about 0.50) | 0.325 | 0.365 | 27.5 % | 0.00 |

Filter confusion (rows: the judge's label; columns ai / together / own):
- ai: 228 / 39 / 2
- together: 16 / 219 / 37
- own: 1 / 67 / 380

The filter almost never confuses own with ai: its misses are one step.

By kind:

| kind | n | filter error | rules error | filter labels | rules labels |
|---|---|---|---|---|---|
| delegate | 100 | 0.028 | 0.280 | 96 % | 68 % |
| polite or "I think" delegation | 75 | 0.037 | 0.480 | 91 % | 41 % |
| attempt | 55 | 0.043 | 0.162 | 100 % | 84 % |
| hint or quiz | 85 | 0.051 | 0.069 | 92 % | 85 % |
| reasoning | 85 | 0.052 | 0.216 | 100 % | 75 % |
| why / how | 105 | 0.065 | 0.222 | 93 % | 77 % |
| wrong own claim | 75 | 0.066 | 0.161 | 88 % | 60 % |
| vague idea | 55 | 0.084 | 0.133 | 69 % | 58 % |
| own claim | 75 | 0.092 | 0.161 | 84 % | 68 % |
| answer to the tutor | 50 | 0.117 | 0.222 | 68 % | 56 % |
| meta | 45 | 0.141 | 0.266 | 67 % | 84 % |
| claim as a question | 70 | 0.143 | 0.207 | 64 % | 47 % |
| own idea + write it up | 60 | 0.172 | 0.312 | 60 % | 45 % |
| fact request | 54 | 0.181 | 0.231 | 65 % | 76 % |

- First messages: error 0.077, labels 85.9 %. Replies: 0.099, 78.0 %.

## 7. While typing, and learning on the way
**Word by word** (150 held-out messages, median 14.5 words):
- The estimate stays within 0.2 of its final value from word 2 on (median; mean 4.3).
- Share of messages settled by word 1 / 2 / 3 / 5 / 8: 43 / 59 / 66 / 79 / 87 %.
- Distance to the final estimate at a third of the words: 0.109; at two thirds: 0.061.
- Certainty: 0.16 after word 1, 0.45 at a third, 0.58 at two thirds, 0.67 at the end.
- Label changes per message while typing:
  - filter: 1.00 (73 % of messages change at least once, 9 % more than twice)
  - rules: 0.96 (79 % at least once, 2 % more than twice)

  The composer should smooth the label in both cases (ADR-15 already says so).

**Half-typed drafts the judge also rated** (60 messages, 120 extra calls):

| | 1/3 of the words | 2/3 | full |
|---|---|---|---|
| judge mean | 0.41 | 0.47 | 0.50 |
| filter error vs judge | 0.148 | 0.093 | 0.087 |
| rules error vs judge | 0.233 | 0.211 | 0.241 |
| filter labels = judge | 65 % | 80 % | 85 % |
| rules labels = judge | 55 % | 65 % | 58 % |

- In the 31 drafts where the judge moves by 0.1 or more, the filter moves the same way in 87 % (rules 45 %). The correlation of the two changes is 0.52 (rules 0.20).
- The filter's blind spot is a late turn: "so i think inflation is … can you write up the full explanation" goes from 0.75 to 0.25 for the judge, but only from 0.78 to 0.72 for the filter.

**Learning online** (fit on half of the messages; the other half arrives one at a time, predict then update; mean of 5 random splits and orders):

| messages seen | 1-100 | 101-200 | 201-300 | 301-400 | 401-499 | all |
|---|---|---|---|---|---|---|
| no updates | 0.094 | 0.098 | 0.093 | 0.087 | 0.098 | 0.094 |
| weight 1 | 0.095 | 0.094 | 0.084 | 0.079 | 0.085 | 0.087 |
| weight 3 | 0.097 | 0.093 | 0.079 | 0.076 | 0.082 | 0.086 |
| weight 10 | 0.105 | 0.101 | 0.083 | 0.080 | 0.086 | 0.091 |

**One student with a habit:** 40 messages that all open with "pls" or "pls check", use arrows and shorthand ("bc", "w/", "smth") and end with "??" (judge: 23 own, 11 together, 6 ai). The filter was fitted on all 989 messages, then fed this student's messages one by one (20 random orders).

| | msgs 1-10 | 11-20 | 21-30 | 31-40 | all |
|---|---|---|---|---|---|
| no updates | 0.086 | 0.087 | 0.084 | 0.100 | 0.089 |
| weight 1 | 0.077 | 0.068 | 0.062 | 0.074 | 0.070 |
| weight 3 | 0.075 | 0.072 | 0.064 | 0.075 | 0.072 |
| weight 10 | 0.080 | 0.076 | 0.068 | 0.077 | 0.075 |

- With weight 1, the error on the student's not yet seen messages falls from 0.089 (0 updates) to 0.080 (5), 0.075 (10) and 0.074 (20).
- The habit did not fool the filter much to begin with (0.089; the rules 0.166).

**Recommendation: weight 1.**
- Weight 3 is as good on the stream and slightly worse for the habit. Weight 10 overreacts early.
- Weight 1 also limits the pull of one wrong judge label. The judge and Sonnet disagree on 15 % of labels.

## 8. Leon's 136 hand-made prompts (`frontend/eval/linter-set.ts`, PR #16)
- **The labels are Claude's draft, not yet rated by the team.** They come from the judge's own rubric, so the judge's agreement with them is not independent.
- The filter never trained on these prompts.
- Metrics are computed as in `frontend/eval/metrics.ts`. The rules numbers match Leon's file exactly.

| | accuracy | κ | weighted κ | recall own / together / ai | English only (124) | German (12) |
|---|---|---|---|---|---|---|
| rules | 67.6 % | 0.52 | 0.58 | 46 / 81 / 77 % | 70.2 % (κ 0.56) | 42 % |
| naive Bayes, Leon (leave-one-out, his number) | 57 % | 0.35 | 0.41 | | | |
| **filter (synthetic only)** | 66.2 % | 0.50 | 0.57 | 83 / 79 / 40 % | 68.5 % (κ 0.53) | 42 % |
| filter, α 1 | 69.1 % | 0.54 | 0.61 | 91 / 62 / 54 % | 71.8 % (κ 0.58) | 42 % |
| judge `zai.glm-4.7` | 97.1 % | 0.96 | 0.97 | 98 / 95 / 98 % | 96.8 % (κ 0.95) | 100 % |

Accuracy per tag:

| tag | n | rules | filter | judge |
|---|---|---|---|---|
| (no tag) | 73 | 73 % | 73 % | 100 % |
| boundary | 15 | 67 % | 47 % | 80 % |
| code | 5 | 100 % | 80 % | 100 % |
| de | 12 | 42 % | 42 % | 100 % |
| hedge | 13 | 31 % | 69 % | 100 % |
| hint | 6 | 83 % | 100 % | 100 % |
| negation | 9 | 67 % | 78 % | 100 % |
| polite | 4 | 75 % | 75 % | 100 % |
| quiz | 6 | 83 % | 67 % | 100 % |
| short | 7 | 71 % | 57 % | 86 % |

What this says:
- **Data, not method.** Trained on 989 judge-labelled messages, the filter beats a naive Bayes trained on the 136 by 9 points. Leon's "500+ labelled prompts first" holds up: the data was missing, not the method.
- **It does not beat the rules on this set.**
  - It falls from 84 % on held-out synthetic messages to 66 % here: a shift between the two sets.
  - It is strong where the rules are weak: own thinking without "I think", hedged delegation.
  - It is weak on bare commands and fact questions, which it leaves near the middle: "Define entropy." 0.40, "List the steps of mitosis." 0.42, "When did World War II end?" 0.52, "Summarize chapter 4 in bullet points." 0.56.
  - "Calculate the integral of x e^x from 0 to 1." even lands at 0.88 (own): maths words go with worked attempts in the synthetic set.
  - Its error against the judge's percent is 0.196 here, against 0.083 on synthetic messages.
- **German:** the filter has never seen German; 5 of 12 right.
- **The judge:** median 0.43 s per call through the local stand-in, with 2 % of calls over 5 s. If the team-rated labels confirm the draft, ADR-15's rule (beat the rules by 10 points, stay under 1 s) would pick it.

## 9. What the filter cannot do
It sees words, not meaning. Where it fails most:
- **Own idea + hand-over:** error 0.172, labels 60 %.
- **Short fact requests and bare commands:** 0.181, 65 %; on Leon's set it catches 40 % of delegations.
- **Claims phrased as questions:** 0.143, 64 %.
- **Meta messages:** 0.141, 67 %; the rules do better here (84 %).
- **Short answers to the tutor:** 0.117, 68 %.
- **German**, and phrasings far from the synthetic set.

It inherits the judge's errors. Its training texts come from one generator and its labels from one judge, both synthetic, so these numbers are an upper bound for real students.

## 10. Next steps
1. **Port `nb.py` to TypeScript** and test it against `out/vectors.json`.
   - Update at every space, with the draft up to the last space.
   - When the judge's score lands, call `update(features(sent text), distribution, 1)`.
   - Keep the counts per user in localStorage.
2. **Generate about 300 more synthetic items** aimed at the gaps: bare commands, fact questions, quiz requests phrased as commands, German. Refit and re-score on the 136.
3. **Add the rubric lines from section 4** to `score.ts`, relabel and refit.
4. **Rerun section 8** after the team has rated the 136 prompts.

## Cost
- **Claude Sonnet 5:** 243,087 tokens in 218 calls, of a 250,000 budget.
  - Generation: 18 calls, 64,231 tokens in and 62,444 out.
  - Ratings: 200 calls, 114,414 in and 1,998 out.
- **Judge:** 1,602 HTTP attempts for 1,572 requests (30 retried), 430,542 input tokens, of a 3,000-call budget.
- `cache/` (1.5 MB) holds every answer, so a rerun costs nothing.
