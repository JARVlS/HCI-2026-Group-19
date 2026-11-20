import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Provider, ScoreResult } from '../ai/provider';
import type { Message } from './domain';
import type { UsageEvent } from './events';
import { draftShare, pct, thinkingMode } from './modes';
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
 * In live mode the word filter (`liveFilter.ts`) is the instant tier below it: it rates every
 * finished word, and while newer words follow a rated text it moves the model's number by what it
 * thinks those words changed (`draftGauge`).
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
  score: ScoreResult;
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

  /** `onRated`: the model's rating of a draft landed (the usage log's `draft_rated`). */
  constructor(
    private readonly score: ScoreFn,
    private readonly onRated?: (text: string, score: ScoreResult) => void,
  ) {}

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
      (score) =>
        settle(() => {
          this.failures = 0;
          this.set({ rating: { text, context, score } });
          this.onRated?.(text, score);
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
  rated: ScoreResult | null;
  /** While this draft waits for its own rating: the model's rating of an earlier draft (shown dimmed without the word filter). */
  earlier: Score | null;
  /** The last rating while the draft still starts with the text it rated, in the same chat: the word filter moves its number (`draftGauge`). */
  anchor: { text: string; score: Score } | null;
  /** The provider can rate drafts (live mode with a fast model). False: the line looks as it always did. */
  canRate: boolean;
  /** The model failed MAX_FAILURES times in a row: the word rules decide for the rest of the visit. */
  unavailable: boolean;
}

export function draftView(s: DraftScoreState | null, draft: string, recent: Recent): DraftView {
  if (!s) return { rated: null, earlier: null, anchor: null, canRate: false, unavailable: false };
  const r = s.unavailable ? null : s.rating;
  const text = draft.trim();
  const here = r !== null && r.context === contextKey(recent);
  const exact = here && r.text === text;
  return {
    rated: exact ? r.score : null,
    earlier: r && !exact && ratable(draft) ? r.score : null,
    anchor: here && !exact && text.startsWith(r.text) ? { text: r.text, score: r.score } : null,
    canRate: true,
    unavailable: s.unavailable,
  };
}

/** The word filter's reading of the draft (the instant tier, `liveFilter.ts`). */
export interface FilterView {
  /** How much of the thinking is the student's (0..1), from the words up to the last finished one. */
  you: number;
  /** The filter is not sure (its certainty is low): the line is dimmed and says so. */
  unsure: boolean;
  /** The filter's number for the anchor's text (`DraftView.anchor`); null without an anchor. */
  anchorYou: number | null;
}

/** The score line: its label, how much of the thinking is the student's (0..1), and where that comes from. */
export interface DraftGauge {
  mode: Mode;
  you: number;
  from: 'model' | 'adjusted' | 'filter' | 'earlier' | 'rules';
  /** From the word filter, and it is not sure. */
  unsure?: boolean;
}

/** The model's number for a text P, moved by what the word filter thinks the words typed since P changed. */
export const adjusted = (rated: number, filterNow: number, filterAtRated: number) => Math.min(1, Math.max(0, rated + filterNow - filterAtRated));

/**
 * Labels by OWN_FROM and AI_UP_TO, as a sent message. The model's rating of exactly this draft
 * wins. Else, with the word filter (live mode): the model's last rating adjusted for the words
 * since (while the draft starts with the rated text), or the filter alone. Without the filter (its
 * weights load or failed): the model's earlier rating (dimmed), else the word rules' split.
 */
export function draftGauge(c: Classification, v: DraftView, f: FilterView | null = null): DraftGauge {
  if (v.rated) return { mode: thinkingMode(v.rated.p), you: v.rated.p, from: 'model' };
  if (f && v.anchor && f.anchorYou !== null) {
    const you = adjusted(v.anchor.score.p, f.you, f.anchorYou);
    return { mode: thinkingMode(you), you, from: 'adjusted' };
  }
  if (f) return { mode: thinkingMode(f.you), you: f.you, from: 'filter', unsure: f.unsure };
  if (v.earlier) return { mode: thinkingMode(v.earlier.p), you: v.earlier.p, from: 'earlier' };
  return { mode: c.mode, you: draftShare(c.mode, c.confidence), from: 'rules' };
}

/** The label the line shows, and a new label waiting for its second word update in a row. */
export interface Steady {
  shown: Mode;
  waiting: Mode | null;
}

/**
 * Calm while typing (ADR-15): the number may move with every word, but the label changes only once
 * a new label has held for two word updates in a row. The first label of a draft shows at once, and
 * so does the model's rating of exactly the draft (`now`).
 */
export function steadyMode(prev: Steady | null, raw: Mode, now = false): Steady {
  if (!prev || now || raw === prev.shown || raw === prev.waiting) return { shown: raw, waiting: null };
  return { shown: prev.shown, waiting: raw };
}

/** Only the model's and the filter's labels are steadied; the word rules' label shows as it always did. */
const steadied = (g: DraftGauge | null): g is DraftGauge => g !== null && g.from !== 'rules' && g.from !== 'earlier';

/**
 * The label at send (it decides the veil): the model's when it rated exactly this text; else, with
 * the word filter, the line's steady label, after one more word update with the whole draft when its
 * last word was not finished (`whole`: the gauge of the whole draft); else the word rules', as before.
 */
export function sendMode(c: Classification, v: DraftView, whole: { gauge: DraftGauge; steady: Steady | null; newWord: boolean } | null = null): Mode {
  if (v.rated) return thinkingMode(v.rated.p);
  if (!whole || !steadied(whole.gauge)) return c.mode;
  return whole.newWord || !whole.steady ? steadyMode(whole.steady, whole.gauge.mode).shown : whole.steady.shown;
}

/**
 * `steadyMode` over the word updates of one draft. `step`: the draft's finished words, so a letter
 * of an unfinished word is no update; a new model rating of exactly the draft is one.
 */
export function useSteady(step: string, g: DraftGauge | null): Steady | null {
  const key = !steadied(g) ? null : g.from === 'model' ? `model\u0000${g.you}\u0000${step}` : `words\u0000${step}`;
  const [s, setS] = useState<{ key: string | null; steady: Steady | null }>({ key: null, steady: null });
  if (key === s.key) return s.steady;
  // Adjusting state while rendering (React's pattern for "state from changed props"): no extra paint.
  const steady = steadied(g) ? steadyMode(s.steady, g.mode, g.from === 'model') : null;
  setS({ key, steady });
  return steady;
}

/** The usage log's record of a rating: numbers and the draft's length, never its text. */
export const draftRated = (text: string, s: ScoreResult): UsageEvent => ({
  type: 'draft_rated',
  payload: { percent: pct(s.p), mode: thinkingMode(s.p), model: s.model ?? null, chars: text.length },
});

const noSubscribe = () => () => {};
const noState = () => null;

/**
 * The live rating for the composer. `score` null: no calls, and the line looks as it always did.
 * `track` (stable, `useStore().track`) logs every rating that lands.
 */
export function useDraftScore(score: ScoreFn | null, draft: string, messages: Message[], track?: (e: UsageEvent) => void): DraftView {
  const scorer = useMemo(() => (score ? new DraftScorer(score, track && ((text, s) => track(draftRated(text, s)))) : null), [score, track]);
  const state = useSyncExternalStore(scorer?.subscribe ?? noSubscribe, scorer?.snapshot ?? noState);
  const recent = useMemo(() => draftContext(messages), [messages]);
  // `context` stands for `recent`: the effect runs when the draft or what it would be sent after changes.
  const context = contextKey(recent);
  useEffect(() => scorer?.update(draft, recent), [scorer, draft, context]);
  useEffect(() => () => scorer?.stop(), [scorer]);
  return draftView(state, draft, recent);
}
