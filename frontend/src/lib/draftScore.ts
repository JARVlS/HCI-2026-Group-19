import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Provider } from '../ai/provider';
import type { Message } from './domain';
import { draftShare, thinkingMode } from './modes';
import { scoreContext } from './turn';
import type { Classification, Mode, Score } from './types';

/*
 * The composer's live score from the fast model (fast and slow, ADR-6): while the student types,
 * the fast model rates the draft on the same "thought along" scale, with the same context, as the
 * turn rates a sent message (`Provider.score`, question `thinking`). The word rules (`classify.ts`)
 * still underline the words, and they decide the line until the model has answered, or when it
 * cannot (demo, scores off, a broken backend).
 * - One call per pause: DELAY_MS after the last keystroke, only for a draft of two words or more
 *   that is not a command, never twice in a row for the same text in the same context.
 * - A keystroke aborts the call in flight, and an answer for an older text is dropped.
 * - A call slower than TIMEOUT_MS is given up quietly (the fast model has a slow tail: about 1 in
 *   10 calls takes seconds); the line keeps what it showed.
 * - After MAX_FAILURES failed calls in a row the model is not asked again, so a broken backend is
 *   not called on every pause; the line stays on the word rules and says so.
 * A rating of exactly the text that is sent goes with the message (`SendInput.thinking`), so the
 * turn does not ask a second time.
 */

export type ScoreFn = NonNullable<Provider['score']>;
/** Earlier messages as context, oldest first (`scoreContext`). */
export type Recent = ReturnType<typeof scoreContext>;

export const DELAY_MS = 600;
export const TIMEOUT_MS = 5000;
export const MAX_FAILURES = 2;

/** The model's rating of one draft (trimmed, as it would be sent) in one context. */
interface Rating {
  text: string;
  context: string;
  score: Score;
}

export interface DraftScoreState {
  /** The last rating that came back. */
  rating: Rating | null;
  /** The model failed MAX_FAILURES times in a row: it is not asked again. */
  unavailable: boolean;
}

/** Worth a call: not a command, two words or more. */
export const ratable = (draft: string) => !draft.startsWith('/') && draft.trim().split(/\s+/).length >= 2;

const contextKey = (recent: Recent) => JSON.stringify(recent);

/** The context a draft would be sent with: the chat's finished messages, as the turn sees them at send. */
export const draftContext = (messages: Message[]): Recent => scoreContext(messages.filter((m) => !m.error && !m.streaming));

/** The provider's fast rating as a plain function; null when it has none (the scripted demo, own model with scores off). */
export const draftScoreFn = (provider: Provider): ScoreFn | null => (provider.score ? (input, signal) => provider.score!(input, signal) : null);

/** Rates the drafts of one composer. No React, so tests drive it with fake timers. */
export class DraftScorer {
  private state: DraftScoreState = { rating: null, unavailable: false };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: { text: string; context: string; controller: AbortController } | null = null;
  private failures = 0;

  constructor(private readonly score: ScoreFn) {}

  readonly snapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** The draft (or the chat it would go to) changed: rate it once typing pauses. */
  update(draft: string, recent: Recent) {
    const text = draft.trim();
    const context = contextKey(recent);
    clearTimeout(this.timer);
    if (this.inflight && (this.inflight.text !== text || this.inflight.context !== context)) this.abort();
    // An empty prompt (sent or cleared) starts afresh: the next draft is never shown an old rating.
    if (!text) return this.set({ rating: null });
    const r = this.state.rating;
    if (this.state.unavailable || this.inflight || !ratable(draft) || (r?.text === text && r.context === context)) return;
    this.timer = setTimeout(() => this.ask(text, context, recent), DELAY_MS);
  }

  /** Drop what is pending (the composer goes away); `update` starts again. */
  stop() {
    clearTimeout(this.timer);
    this.abort();
  }

  private abort() {
    this.inflight?.controller.abort();
    this.inflight = null;
  }

  private ask(text: string, context: string, recent: Recent) {
    const call = { text, context, controller: new AbortController() };
    this.inflight = call;
    let slow = false;
    const giveUp = setTimeout(() => {
      slow = true;
      call.controller.abort();
    }, TIMEOUT_MS);
    const settle = (apply: () => void) => {
      clearTimeout(giveUp);
      if (this.inflight !== call) return; // newer typing took over: dropped
      this.inflight = null;
      apply();
    };
    this.score({ question: 'thinking', text, recent }, call.controller.signal).then(
      ({ p, model }) =>
        settle(() => {
          this.failures = 0;
          this.set({ rating: { text, context, score: model ? { p, model } : { p } } });
        }),
      () =>
        settle(() => {
          // Too slow is not broken: the next pause asks again.
          if (!slow && ++this.failures >= MAX_FAILURES) this.set({ unavailable: true });
        }),
    );
  }

  private set(patch: Partial<DraftScoreState>) {
    const next = { ...this.state, ...patch };
    if (next.rating === this.state.rating && next.unavailable === this.state.unavailable) return;
    this.state = next;
    this.listeners.forEach((l) => l());
  }
}

/** What the composer knows about the model's rating of the draft it holds. */
export interface DraftView {
  /** The model's rating of exactly this draft in this chat: it decides the line and the veil, and goes with the message. */
  rated: Score | null;
  /** While this draft waits for its own rating: the model's rating of an earlier draft (shown dimmed). */
  earlier: Score | null;
  /** The provider can rate drafts (live mode with a fast model). False: the line looks as it always did. */
  canRate: boolean;
  /** The model failed MAX_FAILURES times in a row: the word rules decide for the rest of the visit. */
  unavailable: boolean;
}

export function draftView(s: DraftScoreState | null, draft: string, recent: Recent): DraftView {
  if (!s) return { rated: null, earlier: null, canRate: false, unavailable: false };
  const r = s.unavailable ? null : s.rating;
  const exact = r !== null && r.text === draft.trim() && r.context === contextKey(recent);
  return { rated: exact ? r.score : null, earlier: r && !exact && ratable(draft) ? r.score : null, canRate: true, unavailable: s.unavailable };
}

/** The score line: its label, how much of the thinking is the student's (0..1), and where that comes from. */
export interface DraftGauge {
  mode: Mode;
  you: number;
  from: 'model' | 'earlier' | 'rules';
}

/** The model's rating when there is one (labels by OWN_FROM and AI_UP_TO, as a sent message), else the word rules' split. */
export function draftGauge(c: Classification, v: DraftView): DraftGauge {
  const s = v.rated ?? v.earlier;
  if (!s) return { mode: c.mode, you: draftShare(c.mode, c.confidence), from: 'rules' };
  return { mode: thinkingMode(s.p), you: s.p, from: v.rated ? 'model' : 'earlier' };
}

/** The label at send (it decides the veil): the model's when it rated exactly this text, else the word rules', as before. */
export const sendMode = (c: Classification, v: DraftView): Mode => (v.rated ? thinkingMode(v.rated.p) : c.mode);

const noSubscribe = () => () => {};
const noState = () => null;

/** The live rating for the composer. `score` null: no calls, and the line looks as it always did. */
export function useDraftScore(score: ScoreFn | null, draft: string, messages: Message[]): DraftView {
  const scorer = useMemo(() => (score ? new DraftScorer(score) : null), [score]);
  const state = useSyncExternalStore(scorer?.subscribe ?? noSubscribe, scorer?.snapshot ?? noState);
  const recent = useMemo(() => draftContext(messages), [messages]);
  // `context` stands for `recent`: the effect runs when the draft or what it would be sent after changes.
  const context = contextKey(recent);
  useEffect(() => scorer?.update(draft, recent), [scorer, draft, context]);
  useEffect(() => () => scorer?.stop(), [scorer]);
  return draftView(state, draft, recent);
}
