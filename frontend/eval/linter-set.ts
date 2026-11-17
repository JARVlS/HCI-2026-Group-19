import type { Mode } from '../src/lib/types';

/**
 * Labelled student prompts for the linter eval (`npm run eval:linter`, ADR-15).
 *
 * STATUS: draft labels, written by Claude on 17 Nov 2026 from the rubric below. Before the numbers
 * go into the report, two team members label the texts independently (without looking at these
 * labels), we compute their agreement (Cohen's kappa) and settle the disagreements; the settled
 * label replaces `label`, and `rater` records who settled it. Until then every agreement number of
 * the eval is "against Claude's draft labels".
 *
 * Rubric (the same as `src/lib/modes.ts` and the fast model's scale in `src/ai/prompts/score.ts`):
 *   own       the message holds the student's own claim, guess, prediction, attempt or explanation
 *             in their own words. Right or wrong does not matter; a question at the end does not
 *             change it ("I think X, right?").                      (scale 4 to 5)
 *   together  the student wants to work on it but brings nothing of their own yet: a specific why
 *             or how question, a hint or a quiz request, a question about the approach, a
 *             clarification.                                         (scale 2 to 3)
 *   ai        the student hands the work over: a finished product (summary, solution, essay, code,
 *             rewrite, translation), a bare fact, a full explanation of a whole topic ("explain X"),
 *             or "just tell me".                                     (scale 1)
 *
 * Tags name what makes a case easy or hard for rules: `boundary` (raters may well disagree),
 * `hedge` (own-sounding words around a delegation, or the reverse), `negation`, `polite`,
 * `short`, `code`, `de` (German), `typo`, `quiz`, `hint`.
 */
export interface LinterCase {
  text: string;
  label: Mode;
  tags?: string[];
  /** Who settled the label after independent rating (empty while it is Claude's draft). */
  rater?: string;
}

const c = (label: Mode, text: string, tags: string[] = []): LinterCase => ({ label, text, tags });

export const LINTER_SET: LinterCase[] = [
  // ── own: claims, guesses, predictions (right or wrong) ─────────────────────────────────────
  c('own', 'I think the seasons happen because the earth is closer to the sun in summer.'),
  c('own', 'I think heavier objects fall faster than light ones.'),
  c('own', 'My guess is that antibiotics kill viruses.'),
  c('own', 'I believe a neural network with more layers always performs better.'),
  c('own', 'The moon makes its own light, right?', ['hedge']),
  c('own', 'So basically evolution means animals change because they want to.'),
  c('own', 'Photosynthesis turns sunlight into sugar, and oxygen is just a by-product?'),
  c('own', 'I would expect the pendulum to swing faster if it is heavier.'),
  c('own', 'Probably inflation goes up when the central bank prints more money.'),
  c('own', 'Mitochondria make energy for the cell, that is why muscle cells have so many of them.'),
  c('own', 'Isn’t the derivative of x squared just 2x?', ['hedge']),
  c('own', 'I’d say the French revolution started mainly because people were starving.'),
  c('own', 'Overfitting = the model learns the noise in the training data, not the signal.', ['short']),
  c('own', 'My hunch: batch norm helps because the inputs to each layer stay in a similar range.'),
  c('own', 'Water boils at a lower temperature on a mountain because the air pressure is lower, correct?'),
  c('own', 'I guess the answer to 3b is 42 because the two forces cancel out.'),
  c('own', 'Rome fell because the empire got too big to defend.'),
  c('own', 'Dropout is basically like training many smaller networks and averaging them.'),
  c('own', 'If I double the sample size the standard error should halve.'),
  c('own', 'pretty sure recursion needs a base case otherwise it never stops'),
  c('own', 'I think its because the enzymes denature at high temperature', ['typo']),
  c('own', 'The answer is probably O(n log n) since we sort first.'),
  c('own', 'Electrons flow from minus to plus, the current direction is just a convention.'),
  c('own', 'Supply goes down so price goes up, that is why rents are so high in Zurich.'),
  // ── own: reasoning, worked attempts, explanations in own words ──────────────────────────────
  c('own', 'I think dropout works because it forces the network to not rely on single neurons, is that right?'),
  c('own', 'In my own words: overfitting is when the model memorises the training data instead of the pattern.'),
  c('own', 'I tried the chain rule on this and got dL/dw = dL/da * da/dz * dz/dw. Did I set it up correctly?'),
  c('own', 'Here is my attempt: the loop runs n times and the inner one n/2 times, so it is O(n^2). Where did I go wrong?'),
  c('own', 'I solved it with integration by parts, u = x and dv = e^x dx, and got x e^x - e^x. Can you check?'),
  c('own', 'My explanation for the exam: vaccines show the body a harmless part of the germ so memory cells are ready later.'),
  c('own', 'So if gradient descent moves against the gradient, a too big step jumps over the minimum and the loss gets worse.'),
  c('own', 'def fib(n): return n if n < 2 else fib(n-1) + fib(n-2)  # this is exponential because it recomputes, right?', ['code']),
  c('own', 'My code throws an IndexError, I think because range(len(a)+1) goes one too far.', ['code']),
  c('own', 'The derivative is zero at the top, so the max is where 2x - 4 = 0, so x = 2.'),
  c('own', 'Here is my summary of the chapter, tell me what I missed: cells divide by mitosis, chromosomes copy first, then split.'),
  c('own', 'I compared both: quicksort is faster on average but mergesort is stable, so for linked lists I would take mergesort.'),
  c('own', 'Let me try: the far side of the earth bulges because the earth is pulled away from that water.'),
  c('own', 'I think the trick is that the series is geometric with r = 1/2, so the sum is 2. Is that the idea?'),
  c('own', 'Why does a smaller learning rate help? Is it because big steps overshoot?', ['boundary']),
  c('own', 'I wrote this proof by induction, base case n=1 holds, then I assume n and show n+1. Is the step valid?'),
  c('own', 'I don’t think that’s right, the tilt of the axis matters more than the distance.', ['negation']),
  c('own', 'No, I think the price falls because demand drops, not because supply rises.', ['negation']),
  // ── own: German ─────────────────────────────────────────────────────────────────────────────
  c('own', 'Ich glaube, die Jahreszeiten kommen von der Neigung der Erdachse.', ['de']),
  c('own', 'Meine Vermutung: der Algorithmus ist O(n^2), weil zwei Schleifen ineinander laufen.', ['de']),
  c('own', 'Ich habe die Kettenregel angewendet und bekomme 2x·cos(x²). Stimmt das?', ['de']),
  c('own', 'Mit meinen Worten: Overfitting heisst, das Modell lernt die Trainingsdaten auswendig.', ['de']),
  // ── together: specific why / how questions without an own idea ─────────────────────────────
  c('together', 'Why is the sky blue?', ['boundary']),
  c('together', 'How does backpropagation work?', ['boundary']),
  c('together', 'Why do we need a non-linear activation function?'),
  c('together', 'How does the immune system remember a germ?'),
  c('together', 'Why does ice float?'),
  c('together', 'Why do some vaccines need a booster?'),
  c('together', 'How come the far side of the earth also has a high tide?'),
  c('together', 'Why does the learning rate matter so much?'),
  c('together', 'What happens to the loss if the learning rate is too small?'),
  c('together', 'Why is mergesort stable but quicksort is not?'),
  c('together', 'What is the difference between mitosis and meiosis?', ['boundary']),
  c('together', 'Why would a bank raise interest rates when inflation is high?'),
  c('together', 'How do I know when to use integration by parts?'),
  c('together', 'What would happen if there was no base case?'),
  c('together', 'why?', ['short']),
  c('together', 'how so?', ['short']),
  c('together', 'Wait, why does the gradient point uphill?'),
  c('together', 'What do you mean by a hidden layer?'),
  c('together', 'Can you explain why my answer to 2a was wrong?', ['boundary']),
  c('together', 'Where does the 1/2 in the formula come from?'),
  // ── together: hints, quizzes, approach, practice ────────────────────────────────────────────
  c('together', "Give me a hint how the chain rule shows up in backprop, don't tell me the answer.", ['hint', 'negation']),
  c('together', 'Can you quiz me on gradient descent?', ['quiz']),
  c('together', 'Quiz me on the causes of World War I.', ['quiz']),
  c('together', 'Test me with three questions about cell biology.', ['quiz']),
  c('together', 'Just a small hint please, I want to solve it myself.', ['hint']),
  c('together', 'Don’t give me the solution, only tell me which rule to use.', ['hint', 'negation']),
  c('together', 'How should I approach this proof?'),
  c('together', 'What is the first step for solving a recurrence like this?'),
  c('together', 'Can you ask me questions until I understand recursion?', ['quiz']),
  c('together', 'Let’s go through it step by step, you ask and I answer.'),
  c('together', 'Which concept should I review first for the exam?', ['boundary']),
  c('together', 'Is there a trick to remember the order of the planets?', ['boundary']),
  c('together', 'Could you check my understanding by asking me something about entropy?', ['quiz', 'polite']),
  c('together', 'Give me a similar exercise so I can practise.'),
  c('together', 'Point me to the part of my code that is wrong, but don’t fix it.', ['code', 'negation', 'hint']),
  c('together', 'I’m stuck on 3b. Where should I start?', ['hedge']),
  c('together', 'I don’t get why the second derivative tells us about concavity.', ['negation', 'hedge']),
  c('together', 'I think I need a hint for this one.', ['hedge', 'hint']),
  // ── together: German ────────────────────────────────────────────────────────────────────────
  c('together', 'Warum ist der Himmel blau?', ['de', 'boundary']),
  c('together', 'Gib mir einen Tipp für Aufgabe 2, aber nicht die Lösung.', ['de', 'hint', 'negation']),
  c('together', 'Kannst du mich zu Gradient Descent abfragen?', ['de', 'quiz']),
  c('together', 'Wie fange ich mit diesem Beweis an?', ['de']),
  // ── ai: finished products ───────────────────────────────────────────────────────────────────
  c('ai', 'Write me a summary of backpropagation for my exam.'),
  c('ai', 'Write me a short summary of how vaccines train the immune system'),
  c('ai', 'Solve exercise 3 for me and give me the final answer.'),
  c('ai', 'Make this paragraph sound more academic: the model learns stuff from data.'),
  c('ai', 'Write a 500 word essay on the causes of the French revolution.'),
  c('ai', 'Translate this into English: Die Zelle teilt sich durch Mitose.'),
  c('ai', 'Write a Python function that sorts a list with mergesort.', ['code']),
  c('ai', 'Fix my code: for i in range(len(a)+1): print(a[i])', ['code']),
  c('ai', 'Summarize chapter 4 in bullet points.'),
  c('ai', 'Create flashcards for the whole lecture on enzymes.'),
  c('ai', 'Rewrite my introduction so it sounds better.'),
  c('ai', 'Do my homework: questions 1 to 5 on the attached sheet.'),
  c('ai', 'Generate the solutions for the practice exam.'),
  c('ai', 'Write the conclusion of my lab report.'),
  c('ai', 'Prove that the square root of 2 is irrational.', ['boundary']),
  c('ai', 'Calculate the integral of x e^x from 0 to 1.'),
  c('ai', 'Draft an email to my professor asking for an extension.'),
  // ── ai: bare facts and full explanations of a topic ─────────────────────────────────────────
  c('ai', 'Explain neural networks.', ['boundary']),
  c('ai', 'What is the capital of Australia?'),
  c('ai', 'When did World War II end?'),
  c('ai', 'What is the formula for the area of a circle?'),
  c('ai', 'Define entropy.'),
  c('ai', 'Tell me everything about photosynthesis.'),
  c('ai', 'Explain the French revolution to me.', ['boundary']),
  c('ai', 'What is the time complexity of quicksort?'),
  c('ai', 'Give me the definition of a derivative.'),
  c('ai', 'List the steps of mitosis.'),
  c('ai', 'What does ATP stand for?', ['short']),
  c('ai', 'Explain recursion like I am five.', ['boundary']),
  // ── ai: "just tell me" ──────────────────────────────────────────────────────────────────────
  c('ai', 'no idea, just tell me', ['short']),
  c('ai', 'just give me the answer', ['short']),
  c('ai', 'idk, what is it?', ['short']),
  c('ai', 'skip the questions and tell me the solution', ['negation']),
  c('ai', 'I don’t care about the explanation, what is the result?', ['negation', 'hedge']),
  // ── ai: hedged or polite delegation (own-sounding words, but the work is handed over) ───────
  c('ai', 'I think you should just write the summary for me.', ['hedge']),
  c('ai', 'I believe it would be fastest if you solved it.', ['hedge']),
  c('ai', 'Could you please write my essay introduction?', ['polite']),
  c('ai', 'Would you mind solving question 4 for me?', ['polite']),
  c('ai', 'I want to understand recursion, so write me a full explanation with examples.', ['hedge', 'boundary']),
  c('ai', 'I tried but I can’t, so please just do it.', ['hedge']),
  c('ai', 'My teacher said I should understand this, can you summarize it for me?', ['hedge']),
  c('ai', 'In my opinion the best thing is a complete solution, step by step.', ['hedge']),
  c('ai', 'I’m thinking about my essay, can you write the first paragraph?', ['hedge']),
  c('ai', 'Can you explain the whole topic of neural networks?', ['polite', 'boundary']),
  // ── ai: German ──────────────────────────────────────────────────────────────────────────────
  c('ai', 'Schreib mir eine Zusammenfassung von Kapitel 3.', ['de']),
  c('ai', 'Löse Aufgabe 4 für mich.', ['de']),
  c('ai', 'Was ist die Hauptstadt von Australien?', ['de']),
  c('ai', 'Erklär mir neuronale Netze.', ['de', 'boundary']),
];
