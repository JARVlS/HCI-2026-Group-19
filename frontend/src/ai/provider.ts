import type { Id, Mode, ProviderKind } from '../lib/domain';
import type { Classification, NudgeLevel } from '../lib/types';
import type { TurnAnalysis } from './schemas/turnAnalysis';

/**
 * Where model calls go (IMPLEMENTATION_PLAN.md, ADR-4). The store and `lib/turn.ts` only ever
 * talk to a Provider, never to `fetch` or a model directly, so the scripted demo, the backend
 * relay (M3) and bring-your-own-key providers (M7) are interchangeable.
 *
 * Requests are structured, not prompt strings: an LLM provider renders them into prompts with
 * `src/ai/prompts/*` (M3/M4); the scripted provider reads the fields directly.
 */
export interface Provider {
  kind: ProviderKind;
  label: string;
  /** Stream an assistant reply. Resolves when the reply is complete; rejects on error or abort. */
  chat(req: ChatRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<ChatResult>;
  /** Structured output for one task (M1: `analyze`; M3/M4 add `tree` and `quiz`). */
  json<K extends JsonTask>(task: K, input: JsonTasks[K]['input'], signal: AbortSignal): Promise<JsonTasks[K]['output']>;
  /**
   * A yes/no question to a fast model, answered as a probability: P(yes) from the model's token
   * probabilities, G-Eval style (prompts in `ai/prompts/score.ts`). Optional: a provider whose
   * models return no token probabilities (Claude, the scripted demo) has none, and then the turn
   * analysis's own numbers stay.
   */
  score?(input: ScoreInput, signal: AbortSignal): Promise<ScoreResult>;
  models?(): Promise<string[]>;
  /** Can this provider quiz the user on that concept? (The scripted one only knows its script.) Default: yes. */
  canQuiz?(conceptId: Id): boolean;
  /** Is `text` an answer to the pending quiz question rather than a new question? Default: `looksLikeQuizAnswer`. */
  isQuizAnswer?(text: string, quizConceptId: Id): boolean;
  /** Prompts `tab` cycles through. Default: the ones of the loaded fixture (the scripted demo's). */
  demoPrompts?: string[];
}

/** What the assistant knows about the turn besides the transcript. */
export interface TurnContext {
  /** The linter's label for the prompt (who is thinking). Steers the tutor's reply. */
  mode: Mode;
  /** Concept id if the assistant just asked a quiz question. */
  pendingQuiz: Id | null;
  /** Concepts this chat has touched so far, with how much of the thinking was the user's (0..1). */
  known: { id: Id; label: string; score: number }[];
  /** How much Arbor steps in: the settings' nudge level, `off` while Arbor is paused. */
  nudge: NudgeLevel;
  /** The conversation is a study session (M5). */
  studyMode: boolean;
}

export interface ChatRequest {
  conversationId: Id;
  /** The transcript up to and including the new user message. */
  messages: { role: 'user' | 'assistant'; text: string }[];
  context: TurnContext;
}

export interface ChatResult {
  text: string;
  /** Concept the assistant just quizzed the user on (null clears a pending quiz). */
  pendingQuiz?: Id | null;
  /** Concept the "make it yours" actions should refer to. */
  reflectOn?: Id;
  model?: string;
}

/** Input of the `analyze` task: judge one user turn. */
export interface AnalyzeInput {
  conversationId: Id;
  /** The user message being judged. */
  text: string;
  /** What the linter said while the user typed (shown until the analysis lands). */
  linter: Classification;
  /** Recent turns for context, oldest first, excluding the message being judged. */
  recent: { role: 'user' | 'assistant'; text: string }[];
  context: TurnContext;
  /** The relevant part of the user's graph (ids, labels, hierarchy). */
  graph: { id: Id; label: string; kind: 'subject' | 'topic' | 'concept'; parentId: Id | null }[];
  /** The conversation's subject, if it has one. */
  subjectId: Id | null;
}

export interface JsonTasks {
  analyze: { input: AnalyzeInput; output: TurnAnalysis };
}

/** The questions `score` answers. */
export type ScoreInput =
  /** Did the student think along in `text`? `recent`: earlier turns, oldest first, as context. */
  | { question: 'thinking'; text: string; recent: { role: 'user' | 'assistant'; text: string }[] }
  /** Is the student's `statement` right, judged against `reference` (the tutor's answer)? */
  | { question: 'correct'; statement: string; reference: string };

export interface ScoreResult {
  /** Probability (0..1) of the positive answer: thought along, or right. */
  p: number;
  model?: string;
}
export type JsonTask = keyof JsonTasks;

/** A provider failure the UI can explain. `aborted` is the user pressing stop, not an error. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'network' | 'aborted' | 'budget_exceeded' | 'upstream' | 'invalid_output' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const isAbort = (e: unknown) =>
  (e instanceof ProviderError && e.code === 'aborted') || (e instanceof DOMException && e.name === 'AbortError');

/** Resolve after `ms`, or reject with an abort error as soon as `signal` fires. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError('stopped', 'aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ProviderError('stopped', 'aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
