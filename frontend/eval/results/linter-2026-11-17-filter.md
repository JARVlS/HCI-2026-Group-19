<!-- npm run eval:linter, 17 Nov 2026, branch live-filter: the word filter (src/lib/thinkingFilter.ts, weights 2026-11-17.2, fitted on synthetic messages only) added as a judge; it reproduces research/thinking-filter/out/report.md (83.8 %, kappa 0.76). Labels are Claude's draft. The fast model was not run. -->

## Linter eval, 2026-11-17

136 prompts (46 own, 42 together, 48 ai), labels: Claude's draft (not yet rated by the team).
Fast model: not run (set VITE_API_URL to include it).

| judge | n | accuracy | kappa | weighted kappa | macro F1 |
|---|---|---|---|---|---|
| rules (classify.ts, today) | 136 | 68 % | 0.52 | 0.58 | 0.67 |
| naive Bayes, leave-one-out | 136 | 57 % | 0.35 | 0.41 | 0.56 |
| word filter (synthetic only, live tier 0) | 136 | 84 % | 0.76 | 0.79 | 0.84 |

**By tag** (accuracy)

| tag | n | rules | bayes | filter |
|---|---|---|---|---|
| (all) | 136 | 68 % | 57 % | 84 % |
| (no tag) | 73 | 73 % | 62 % | 89 % |
| boundary | 15 | 67 % | 47 % | 80 % |
| code | 5 | 100 % | 60 % | 100 % |
| de | 12 | 42 % | 50 % | 75 % |
| hedge | 13 | 31 % | 54 % | 62 % |
| hint | 6 | 83 % | 0 % | 83 % |
| negation | 9 | 67 % | 33 % | 78 % |
| polite | 4 | 75 % | 75 % | 100 % |
| quiz | 6 | 83 % | 33 % | 100 % |
| short | 7 | 71 % | 71 % | 71 % |
| typo | 1 | 100 % | 100 % | 100 % |

**rules** (rows: label, columns: predicted)

| | own | together | ai | recall | precision |
|---|---|---|---|---|---|
| own | 21 | 23 | 2 | 46 % | 78 % |
| together | 3 | 34 | 5 | 81 % | 52 % |
| ai | 3 | 8 | 37 | 77 % | 84 % |

**word filter** (rows: label, columns: predicted)

| | own | together | ai | recall | precision |
|---|---|---|---|---|---|
| own | 40 | 6 | 0 | 87 % | 89 % |
| together | 1 | 36 | 5 | 86 % | 75 % |
| ai | 4 | 6 | 38 | 79 % | 88 % |

**Typing stability (rules):** 0.68 label changes per prompt on average, checked at every word end; 63 % of prompts change label at least once, 0 % more than twice.

**Typing stability (word filter):** 1.04 label changes per prompt on average, checked at every word end; 61 % of prompts change label at least once, 10 % more than twice.

**Typing stability (word filter as the line shows it, a new label after two words):** 0.77 label changes per prompt on average, checked at every word end; 58 % of prompts change label at least once, 3 % more than twice.

**Cases with a miss**

| label | rules | bayes | filter | text |
|---|---|---|---|---|
| own | own | **ai** | own | I believe a neural network with more layers always performs better. |
| own | own | own | **together** | The moon makes its own light, right? |
| own | **together** | own | own | Photosynthesis turns sunlight into sugar, and oxygen is just a by-product? |
| own | **together** | own | own | I would expect the pendulum to swing faster if it is heavier. |
| own | **together** | own | own | Probably inflation goes up when the central bank prints more money. |
| own | **together** | own | own | Mitochondria make energy for the cell, that is why muscle cells have so many of them. |
| own | **together** | **ai** | own | Isn’t the derivative of x squared just 2x? |
| own | own | **ai** | own | I’d say the French revolution started mainly because people were starving. |
| own | **together** | own | own | Overfitting = the model learns the noise in the training data, not the signal. |
| own | **together** | own | own | Water boils at a lower temperature on a mountain because the air pressure is lower, correc |
| own | **together** | own | own | Rome fell because the empire got too big to defend. |
| own | **together** | own | own | Dropout is basically like training many smaller networks and averaging them. |
| own | **together** | **together** | own | If I double the sample size the standard error should halve. |
| own | **together** | **together** | own | pretty sure recursion needs a base case otherwise it never stops |
| own | **ai** | own | **together** | The answer is probably O(n log n) since we sort first. |
| own | **together** | own | own | Electrons flow from minus to plus, the current direction is just a convention. |
| own | **together** | own | own | Supply goes down so price goes up, that is why rents are so high in Zurich. |
| own | own | **together** | own | I tried the chain rule on this and got dL/dw = dL/da * da/dz * dz/dw. Did I set it up corr |
| own | **together** | **ai** | own | I solved it with integration by parts, u = x and dv = e^x dx, and got x e^x - e^x. Can you |
| own | own | **ai** | **together** | My explanation for the exam: vaccines show the body a harmless part of the germ so memory  |
| own | **together** | **together** | own | So if gradient descent moves against the gradient, a too big step jumps over the minimum a |
| own | **together** | own | own | The derivative is zero at the top, so the max is where 2x - 4 = 0, so x = 2. |
| own | **ai** | **ai** | **together** | Here is my summary of the chapter, tell me what I missed: cells divide by mitosis, chromos |
| own | **together** | **together** | own | I compared both: quicksort is faster on average but mergesort is stable, so for linked lis |
| own | **together** | own | own | Let me try: the far side of the earth bulges because the earth is pulled away from that wa |
| own | own | **together** | **together** | Why does a smaller learning rate help? Is it because big steps overshoot? |
| own | **together** | own | own | I don’t think that’s right, the tilt of the axis matters more than the distance. |
| own | **together** | **together** | own | Ich glaube, die Jahreszeiten kommen von der Neigung der Erdachse. |
| own | **together** | own | own | Meine Vermutung: der Algorithmus ist O(n^2), weil zwei Schleifen ineinander laufen. |
| own | **together** | own | own | Ich habe die Kettenregel angewendet und bekomme 2x·cos(x²). Stimmt das? |
| own | **together** | own | **together** | Mit meinen Worten: Overfitting heisst, das Modell lernt die Trainingsdaten auswendig. |
| together | **ai** | together | together | How does backpropagation work? |
| together | together | **own** | together | How come the far side of the earth also has a high tide? |
| together | together | **own** | together | What happens to the loss if the learning rate is too small? |
| together | together | **own** | together | Why is mergesort stable but quicksort is not? |
| together | together | **ai** | **ai** | What is the difference between mitosis and meiosis? |
| together | together | **own** | together | Why would a bank raise interest rates when inflation is high? |
| together | together | **own** | together | What would happen if there was no base case? |
| together | **ai** | together | together | how so? |
| together | together | together | **ai** | What do you mean by a hidden layer? |
| together | **own** | **ai** | together | Can you explain why my answer to 2a was wrong? |
| together | together | **own** | together | Where does the 1/2 in the formula come from? |
| together | together | **ai** | together | Give me a hint how the chain rule shows up in backprop, don't tell me the answer. |
| together | together | **ai** | together | Quiz me on the causes of World War I. |
| together | together | **ai** | together | Test me with three questions about cell biology. |
| together | together | **ai** | together | Just a small hint please, I want to solve it myself. |
| together | together | **ai** | together | Don’t give me the solution, only tell me which rule to use. |
| together | **ai** | **ai** | **ai** | What is the first step for solving a recurrence like this? |
| together | together | **ai** | together | Can you ask me questions until I understand recursion? |
| together | together | **ai** | **ai** | Let’s go through it step by step, you ask and I answer. |
| together | together | **ai** | together | Which concept should I review first for the exam? |
| together | together | **own** | together | Is there a trick to remember the order of the planets? |
| together | **own** | **ai** | together | Could you check my understanding by asking me something about entropy? |
| together | **ai** | **ai** | **ai** | Give me a similar exercise so I can practise. |
| together | together | **ai** | together | Point me to the part of my code that is wrong, but don’t fix it. |
| together | **own** | **own** | **own** | I think I need a hint for this one. |
| together | **ai** | **own** | together | Warum ist der Himmel blau? |
| together | together | **ai** | together | Gib mir einen Tipp für Aufgabe 2, aber nicht die Lösung. |
| together | together | **own** | together | Wie fange ich mit diesem Beweis an? |
| ai | ai | **own** | **together** | Make this paragraph sound more academic: the model learns stuff from data. |
| ai | ai | **own** | ai | Translate this into English: Die Zelle teilt sich durch Mitose. |
| ai | ai | **own** | ai | Fix my code: for i in range(len(a)+1): print(a[i]) |
| ai | ai | **own** | ai | Rewrite my introduction so it sounds better. |
| ai | ai | **together** | ai | Do my homework: questions 1 to 5 on the attached sheet. |
| ai | **together** | **own** | **own** | Prove that the square root of 2 is irrational. |
| ai | ai | **own** | ai | Calculate the integral of x e^x from 0 to 1. |
| ai | ai | **together** | ai | Draft an email to my professor asking for an extension. |
| ai | ai | **together** | ai | When did World War II end? |
| ai | ai | **together** | ai | Define entropy. |
| ai | ai | **together** | ai | Tell me everything about photosynthesis. |
| ai | ai | **together** | ai | What does ATP stand for? |
| ai | ai | **together** | ai | Explain recursion like I am five. |
| ai | ai | **together** | **together** | just give me the answer |
| ai | ai | ai | **together** | idk, what is it? |
| ai | **together** | **together** | **together** | skip the questions and tell me the solution |
| ai | **together** | **together** | **together** | I don’t care about the explanation, what is the result? |
| ai | **own** | ai | ai | I think you should just write the summary for me. |
| ai | **own** | **own** | **own** | I believe it would be fastest if you solved it. |
| ai | **together** | ai | ai | I want to understand recursion, so write me a full explanation with examples. |
| ai | **own** | **own** | **own** | I tried but I can’t, so please just do it. |
| ai | **together** | **together** | ai | In my opinion the best thing is a complete solution, step by step. |
| ai | **together** | ai | ai | I’m thinking about my essay, can you write the first paragraph? |
| ai | **together** | ai | **together** | Schreib mir eine Zusammenfassung von Kapitel 3. |
| ai | ai | **together** | ai | Löse Aufgabe 4 für mich. |
| ai | **together** | **together** | **own** | Was ist die Hauptstadt von Australien? |
