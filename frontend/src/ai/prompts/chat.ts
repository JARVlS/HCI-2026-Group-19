import { looksLikeQuizAnswer } from '../../lib/classify';
import type { Mode } from '../../lib/types';
import type { ChatRequest } from '../provider';

/**
 * The tutor's system prompt for one turn (IMPLEMENTATION_PLAN.md M3). It replaces the scripted
 * engine's reply variants: the linter's label for the prompt (who is thinking) picks how the tutor
 * answers, the nudge level how much it coaches, study mode how much it checks. A pure function, so
 * every variant is a test.
 */

const ROLE =
  'You are the tutor in Arbor, a study chat. The goal is that the student understands and learns, ' +
  'not that they get text to copy.';

/** How to answer, by who is doing the thinking in the student's message. */
export const BY_MODE: Record<Mode, string> = {
  own:
    'The student brings their own reasoning. React to it first: say what is right, correct what is ' +
    'wrong or missing, then add what helps. Do not just repeat their idea back.',
  together: 'The student is exploring. Explain in plain words, step by step, then hand one short question back so they take the next step themselves.',
  ai: 'The student asks you to do it. Give the complete answer, clearly and concisely. Do not hold it back.',
};

export const HINT = 'The student asked for a hint. Give one hint that points the way. Do not give the answer or the full solution.';

export const QUIZ_ANSWER = 'The student is answering your quiz question. Say plainly whether it is right, then correct or complete it. Do not ask a new question.';

/** Arbor paused or nudges off: the plain assistant (the baseline condition of a user test). */
export const PLAIN = 'Answer the student directly and helpfully, like a normal assistant. Do not coach.';

export const ACTIVE = 'Where it fits, end with one short question that makes the student think one step further.';

export const STUDY = 'This is a study session: prefer short checks of understanding over long explanations.';

const OWN_TAKE = 'If the message contains the student\'s own guess or attempt, start by reacting to it.';

const QUIZ_ON_REQUEST = 'If the student asks to be quizzed, ask one short question and wait for the answer.';

const LENGTH = 'Keep every answer under 120 words unless the student asks for a longer one: cut detail, not the core idea. Answer in the language the student writes in.';

/** The chat shows only this markdown subset (`designs/ascii/Md.tsx`, `designs/classic/components/Markdown.tsx`). */
export const FORMAT =
  'The chat shows only paragraphs, "- " lists (with an empty line before the list), **bold** and *italic*. ' +
  'No headings, tables, numbered lists, code blocks or LaTeX. Write formulas in plain text without underscores, e.g. a^2 + b^2 = c^2.';

const isHint = (text: string) => /\bhint\b/i.test(text);

export function chatSystem(req: ChatRequest): string {
  const { mode, nudge, studyMode, pendingQuiz } = req.context;
  const text = req.messages.at(-1)?.text ?? '';
  const how =
    pendingQuiz && looksLikeQuizAnswer(text, pendingQuiz)
      ? [QUIZ_ANSWER]
      : nudge === 'off'
        ? [PLAIN]
        : [isHint(text) ? HINT : BY_MODE[mode], OWN_TAKE, ...(nudge === 'active' && !isHint(text) ? [ACTIVE] : [])];
  return [ROLE, ...how, ...(studyMode ? [STUDY] : []), QUIZ_ON_REQUEST, LENGTH, FORMAT].join('\n');
}

/** The transcript in the backend's shape; empty messages are left out (the API rejects them). */
export const chatMessages = (req: ChatRequest) =>
  req.messages.filter((m) => m.text.trim()).map((m) => ({ role: m.role, content: m.text }));
