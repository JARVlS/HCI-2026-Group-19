import type { ConceptAttempt } from './domain';
import { MODE_SCORE, thinkingMode } from './modes';
import type { ChatMessage, Classification, MessageScores, Score, ScoreState } from './types';

/**
 * Fast and slow judging (IMPLEMENTATION_PLAN.md ADR-6): a scored user message takes its numbers
 * from the fast model's probability scores, while the slow turn analysis still says which concepts
 * it is about, with reasons and quotes. These pure functions apply the scores; the reducer calls
 * them whenever a score or the analysis lands. Applying them again changes nothing, so the end
 * state is the same whatever lands first.
 */

export const isScore = (s: ScoreState | undefined): s is Score => typeof s === 'object';

/** A guess was revealed and scored (or is being scored): the exchange counts as predict → reveal. */
const revealed = (s: MessageScores) => s.guess !== undefined;

/**
 * One attempt of a scored message:
 * - independence = the message's thinking score (else the analysis's number), raised by the
 *   revealed guess's thinking score (a guess never lowers it); mode follows from it by the
 *   thresholds whenever a score set it;
 * - correctness = the correct score: for a revealed guess on every attempt, for an own claim on
 *   the attempts the analysis found gradable;
 * - a relabel by the user (source `override`) keeps its mode and independence.
 * Returns the same object when nothing changes.
 */
export function scoredAttempt(a: ConceptAttempt, s: MessageScores): ConceptAttempt {
  let { mode, independence, correctness, source } = a;
  if (source !== 'override') {
    const base = isScore(s.thinking) ? s.thinking.p : a.independence;
    const raised = isScore(s.guess) ? Math.max(base, s.guess.p) : base;
    if (isScore(s.thinking) || raised > a.independence) [independence, mode] = [raised, thinkingMode(raised)];
  }
  if (isScore(s.correct) && (revealed(s) || a.correctness !== null)) correctness = s.correct.p;
  if (source === 'prompt' && revealed(s) && (isScore(s.guess) || isScore(s.correct))) source = 'reveal';
  const same = mode === a.mode && independence === a.independence && correctness === a.correctness && source === a.source;
  return same ? a : { ...a, mode, independence, correctness, source };
}

/** The live attempts of one message with its scores applied. Same array when nothing changes. */
export function scoredAttempts(attempts: ConceptAttempt[], messageId: string, s: MessageScores): ConceptAttempt[] {
  let changed = false;
  const out = attempts.map((a) => {
    if (a.messageId !== messageId || a.supersededBy) return a;
    const b = scoredAttempt(a, s);
    changed ||= b !== a;
    return b;
  });
  return changed ? out : attempts;
}

/**
 * The message's label: the thresholds on its thinking score, raised by a revealed guess. Without
 * a thinking score (still on its way, or failed) a guess can only raise the label it has. A user
 * relabel always wins.
 */
export function scoredLabel(c: Classification, s: MessageScores): Classification {
  if (c.overridden) return c;
  const guess = isScore(s.guess) ? s.guess.p : null;
  let mode = c.mode;
  if (isScore(s.thinking)) mode = thinkingMode(Math.max(s.thinking.p, guess ?? 0));
  else if (guess !== null && guess > MODE_SCORE[c.mode]) mode = thinkingMode(guess);
  return mode === c.mode ? c : { ...c, mode };
}

/** A score as the designs show it: a number (0..1), on its way, failed, or not asked for. */
export type ScoreShown = number | 'pending' | 'failed' | null;

const shown = (s: ScoreState | undefined): ScoreShown => (s === undefined ? null : isScore(s) ? s.p : s);

/** What the designs show for a message's scores (both styles word it their own way). */
export interface ScoreView {
  /** How much the student thought along in the message (raised by a revealed guess). null: not scored (demo). */
  thought: ScoreShown;
  /** A revealed guess raised `thought` so far that the label changed. */
  byGuess: boolean;
  /** How much the revealed guess on its own thought along. */
  guess: ScoreShown;
  /** How right the guess (if one was revealed) or the message's own claim is. null: not graded. */
  right: ScoreShown;
}

export function scoreView(s: MessageScores | undefined): ScoreView {
  if (!s) return { thought: null, byGuess: false, guess: null, right: null };
  const t = isScore(s.thinking) ? s.thinking.p : null;
  const g = isScore(s.guess) ? s.guess.p : null;
  const raised = t !== null && g !== null && g > t;
  // "with your guess" only when the guess changed the label, not for every small raise.
  const byGuess = raised && thinkingMode(g) !== thinkingMode(t);
  return { thought: raised ? g : shown(s.thinking), byGuess, guess: shown(s.guess), right: shown(s.correct) };
}

/**
 * How much of the thinking a user message was the student's (0..1), for the "who's thinking" bar,
 * trail and status line: its "thought along" percent when it has one (live), else its label's value
 * (demo, a score still on its way or failed, a relabel by the user).
 */
export function thinkingShare(m: ChatMessage): number {
  const thought = scoreView(m.scores).thought;
  const c = m.classification;
  if (typeof thought === 'number' && !c?.overridden) return thought;
  return MODE_SCORE[c?.mode ?? 'together'];
}

/*
 * The words, in one place for both designs (the ASCII style lower-cases them). Plain language:
 * no "probability", no model names. On its way: "…"; failed: "not checked", quiet but visible.
 */
/** One part of a score line. `quiet`: on its way or failed (the designs dim it). */
export interface ScoreWord {
  text: string;
  quiet: boolean;
}

const percent = (x: number) => `${Math.round(x * 100)}%`;

function word(what: string, s: ScoreShown, suffix = ''): ScoreWord | null {
  if (s === null) return null;
  if (s === 'pending') return { text: `${what} …`, quiet: true };
  if (s === 'failed') return { text: `${what}: not checked`, quiet: true };
  return { text: `${what} ${percent(s)}${suffix}`, quiet: false };
}

const present = (xs: (ScoreWord | null)[]) => xs.filter((x): x is ScoreWord => x !== null);

/** The "why" of a user message: e.g. "Thought along 83%", "Right 91%". Thought along is left out after a relabel (the user's label decides). */
export function messageScoreWords(v: ScoreView, overridden = false): ScoreWord[] {
  return present([
    overridden ? null : word('Thought along', v.thought, v.byGuess ? ' with your guess' : ''),
    word(v.guess === null ? 'Right' : 'Your guess: right', v.right),
  ]);
}

/** Under a revealed answer: how right the guess was, and how much the student thought along in it. */
export function guessScoreWords(v: ScoreView): ScoreWord[] {
  if (v.right === 'pending' || v.guess === 'pending') return [{ text: 'Checking your guess …', quiet: true }];
  return present([word('Right', v.right), word('Thought along', v.guess)]);
}
