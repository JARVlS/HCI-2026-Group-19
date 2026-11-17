import type { ScoreInput } from '../provider';

/**
 * The fast model's two yes/no questions (Provider.score). The model answers with one digit; the
 * provider reads the token probabilities of both digits, and P(yes) / (P(yes) + P(no)) is the score
 * (G-Eval style). So the prompt must make a single digit the only sensible answer.
 */

/** The answer options: YES is the positive one (thought along, right). */
export const YES = '1';
export const NO = '2';

export const THINKING_SYSTEM = [
  'You judge one message that a student wrote to an AI tutor. Question: did the student think along?',
  "Thinking along means the message contains the student's own reasoning, claim, prediction, guess, attempt or a specific idea they want checked, even if it is wrong.",
  'Not thinking along means the student hands the work to the AI: asks for a finished answer, summary, solution or text without any idea of their own, or only says they have no idea.',
  'Earlier turns are context only: judge the student message at the end.',
  `Answer with a single digit and nothing else: ${YES} = the student thought along, ${NO} = the student did not.`,
].join(' ');

export const CORRECT_SYSTEM = [
  "You compare a student's statement with the tutor's answer to the same question. Question: is the student's statement right?",
  "Judge only against the tutor's answer; wording may differ.",
  'A statement that says nothing about the question, such as "I don\'t know", "no idea" or a question back, is wrong.',
  `Answer with a single digit and nothing else: ${YES} = right, ${NO} = wrong.`,
].join(' ');

/** Long texts are cut: the question needs the gist, and the call stays small and fast. */
const MAX_CHARS = 1500;
const MAX_CONTEXT_CHARS = 400;
const cut = (t: string, max = MAX_CHARS) => (t.length > max ? `${t.slice(0, max)}…` : t);

const ANSWER = `Answer (${YES} or ${NO}):`;

/** The request of one score call: a system prompt and one user message (context first, the answer cue last). */
export function scorePrompt(input: ScoreInput): { system: string; messages: { role: 'user'; content: string }[] } {
  if (input.question === 'correct') {
    const content = ["Student's statement:", cut(input.statement), '', "Tutor's answer:", cut(input.reference), '', ANSWER].join('\n');
    return { system: CORRECT_SYSTEM, messages: [{ role: 'user', content }] };
  }
  const context = input.recent.length
    ? ['Earlier in the conversation (context only):', ...input.recent.map((m) => `${m.role === 'user' ? 'student' : 'tutor'}: ${cut(m.text, MAX_CONTEXT_CHARS)}`), '']
    : [];
  const content = [...context, 'Student message:', cut(input.text), '', ANSWER].join('\n');
  return { system: THINKING_SYSTEM, messages: [{ role: 'user', content }] };
}
