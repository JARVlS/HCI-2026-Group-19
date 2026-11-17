import type { ScoreInput } from '../provider';

/**
 * The fast model's rating scales (Provider.score), G-Eval style: the model answers with one digit
 * of a scale, the backend returns how likely each digit was as that answer, and the score is the
 * sum of p(digit) × the digit's weight. A scale, not a yes/no question: a good model answers yes/no
 * with 0 or 1 and leaves no percent, and a weak one gives its uncertainty, not a degree (it put
 * short wrong claims at 0.18 to 0.5 for "did the student think along?").
 * The prompt must make a single digit the only sensible answer.
 */

/** A rating scale: each answer option (a digit) and what it is worth, 0..1. */
export type Scale = Record<string, number>;

/** How much of the thinking is the student's own: 1 = none … 5 = all. */
export const THINKING_SCALE: Scale = { '1': 0, '2': 0.25, '3': 0.5, '4': 0.75, '5': 1 };
/** Is it right: 1 = right, 2 = partly right, 3 = wrong or no answer. */
export const CORRECT_SCALE: Scale = { '1': 1, '2': 0.5, '3': 0 };

/** The steps of THINKING_SCALE, shared by the message and the guess question. */
const THINKING_STEPS = [
  'Rate on this scale:',
  '1 = none: the student hands the work over and wants a finished product or a bare fact (a summary, a solution, a text, a rewrite, a definition).',
  '2 = little: the student asks to have something explained (a why or how question) but brings no idea of their own.',
  '3 = some: the student wants to do the thinking but has not started (asks for a hint, asks to be quizzed), or only hints at a vague idea.',
  '4 = much: the student states an own claim, guess or prediction, with little or no reasoning.',
  '5 = all: the student gives own reasoning, an explanation in their own words or a worked attempt.',
  "Whether the student is right does not matter: a wrong claim or a misconception is still the student's own thinking.",
];

export const THINKING_SYSTEM = [
  "You rate one message that a student wrote to an AI tutor. Question: how much of the thinking in this message is the student's own?",
  ...THINKING_STEPS,
  'Earlier turns are context only: rate the student message at the end.',
  'Answer with a single digit from 1 to 5 and nothing else.',
].join(' ');

export const GUESS_SYSTEM = [
  "You rate a guess that a student typed before reading the AI tutor's answer to their question. Question: how much of the thinking in this guess is the student's own?",
  ...THINKING_STEPS,
  'An empty guess, "no idea", "idk" or "just tell me" is 1. A vague guess, even one with a question mark, is 3.',
  'Answer with a single digit from 1 to 5 and nothing else.',
].join(' ');

export const CORRECT_SYSTEM = [
  "You compare a student's statement with the tutor's answer to the same question. Question: is the student's statement right?",
  "Judge only against the tutor's answer; wording may differ, and a statement that is right but leaves out details still counts as right.",
  '1 = right. 2 = partly right: one part matches the tutor\'s answer, another part is missing or wrong. 3 = wrong: it contradicts the tutor\'s answer, or it is no answer at all ("idk", "no idea", a question back).',
  'Answer with a single digit from 1 to 3 and nothing else.',
].join(' ');

/** Long texts are cut: the rating needs the gist, and the call stays small and fast. */
const MAX_CHARS = 1500;
const MAX_CONTEXT_CHARS = 400;
const cut = (t: string, max = MAX_CHARS) => (t.length > max ? `${t.slice(0, max)}…` : t);

const cue = (scale: Scale) => `Rating (1 to ${Object.keys(scale).length}):`;

export interface ScorePrompt {
  system: string;
  /** One user message: context first, the rating cue last. */
  messages: { role: 'user'; content: string }[];
  /** The answer options are its keys. */
  scale: Scale;
}

const prompt = (system: string, lines: string[], scale: Scale): ScorePrompt => ({ system, messages: [{ role: 'user', content: lines.join('\n') }], scale });

export function scorePrompt(input: ScoreInput): ScorePrompt {
  switch (input.question) {
    case 'correct':
      // The tutor's answer first: it often ends with a question to the student, which the model
      // would answer instead if it came right before the cue (live check: 0.88 → 0.002 for a wrong claim).
      return prompt(
        CORRECT_SYSTEM,
        ["Tutor's answer:", cut(input.reference), '', "Student's statement:", cut(input.statement), '', `Is the student's statement right? ${cue(CORRECT_SCALE)}`],
        CORRECT_SCALE,
      );
    case 'guess':
      return prompt(
        GUESS_SYSTEM,
        ["The student's question:", cut(input.prompt, MAX_CONTEXT_CHARS), '', "The student's guess, before reading the answer:", cut(input.guess), '', cue(THINKING_SCALE)],
        THINKING_SCALE,
      );
    case 'thinking': {
      const context = input.recent.length
        ? ['Earlier in the conversation (context only):', ...input.recent.map((m) => `${m.role === 'user' ? 'student' : 'tutor'}: ${cut(m.text, MAX_CONTEXT_CHARS)}`), '']
        : [];
      return prompt(THINKING_SYSTEM, [...context, 'Student message:', cut(input.text), '', cue(THINKING_SCALE)], THINKING_SCALE);
    }
  }
}

/**
 * The score: the sum of each option's probability times its weight (G-Eval's expected value).
 * `probabilities` must have every option of the scale (the backend returns them summing to 1);
 * null when it does not, so the caller can fail loudly.
 */
export function scaleScore(probabilities: Record<string, unknown>, scale: Scale): number | null {
  let sum = 0;
  for (const [option, weight] of Object.entries(scale)) {
    const p = probabilities[option];
    if (typeof p !== 'number' || !(p >= 0 && p <= 1)) return null;
    sum += p * weight;
  }
  return Math.min(1, Math.max(0, sum));
}
