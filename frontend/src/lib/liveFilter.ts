import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { THINKING_SCALE } from '../ai/prompts/score';
import { save, stored } from './app';
import { classify } from './classify';
import type { Message } from './domain';
import { draftContext, type FilterView, type Recent } from './draftScore';
import type { KeyValue } from './sync';
import { capped, features, LEVELS, nothingLearned, rate, shipped, tokens, update, withLearned, type Learned, type Model, type Weights } from './thinkingFilter';
import type { ThinkingInput } from './turn';

/*
 * The word filter in the browser (live mode): its weights, loaded on first use, and what it learned
 * from this student. The judge's distribution for every sent message (`TurnDeps.judged`) is added to
 * the counts (`update`, weight 1 as the research recommends), kept in localStorage per browser on
 * top of the shipped weights, never sent anywhere. `/filter reset` forgets it.
 */

/** The learned counts in localStorage: `{ version, n, prior, counts }`, version = the weights they were learned on. */
export const LEARNED_KEY = 'arbor.filter.v1';
/** How much one judged message counts (research report, section 7: weight 1 helps, 10 overreacts). */
export const LEARN_WEIGHT = 1;
/** At most this many learned features are kept (the ones with the least mass go first). */
export const MAX_LEARNED = 500;
/**
 * Below this certainty the line says "unsure": the lower tertile of the filter's certainty on held-out
 * messages (research/thinking-filter/out/results.json, filter.certainty.tertiles[0] = 0.835), where its
 * percent is 0.16 off the judge on average, against 0.055 and 0.017 in the upper two thirds.
 */
export const UNSURE_BELOW = 0.835;

const loadWeights = async () => (await import('./filter/weights.json')).default as unknown as Weights;

export type FilterState =
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  /** `learned`: from how many of the student's messages (0: the shipped weights). */
  | { status: 'ready'; model: Model; learned: number };

/** The tutor's last message asked something (feature `@tutor_asked`). */
export function tutorAsked(recent: Recent): boolean {
  const last = recent.at(-1);
  return last?.role === 'assistant' && last.text.trimEnd().endsWith('?');
}

/** The draft up to its last finished word: a word is finished by a space, punctuation or a line break. */
export const finishedWords = (draft: string) => draft.replace(/[\p{L}\p{N}'’‘]+$/u, '');

function forget(storage: KeyValue | null) {
  try {
    storage?.removeItem(LEARNED_KEY);
  } catch {
    /* storage unavailable: nothing was kept */
  }
}

function readLearned(storage: KeyValue | null, version: string): Learned {
  const raw = stored(storage, LEARNED_KEY);
  if (raw === null) return nothingLearned(version);
  try {
    const d = JSON.parse(raw) as { version: string; n: number; prior: number[]; counts: Record<string, number[]> };
    // Learned on other weights: those counts mean nothing on these.
    if (d.version !== version) {
      forget(storage);
      return nothingLearned(version);
    }
    if (!Number.isInteger(d.n) || d.prior.length !== LEVELS) throw new Error('not the learned counts');
    return { version, n: d.n, prior: d.prior, counts: new Map(Object.entries(d.counts)) };
  } catch (e) {
    console.error(`${LEARNED_KEY} could not be read, the word filter starts from its shipped weights`, e);
    return nothingLearned(version);
  }
}

const writeLearned = (storage: KeyValue | null, l: Learned) =>
  save(storage, LEARNED_KEY, JSON.stringify({ version: l.version, n: l.n, prior: l.prior, counts: Object.fromEntries(l.counts) }));

/** One per app. No React, so tests drive it with a fake loader and storage. */
export class LiveFilter {
  private state: FilterState | null = null;
  private base: Model | null = null;
  private learned: Learned | null = null;
  private loading: Promise<void> | null = null;
  /** Texts learned from in this visit: never twice from the same one. */
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: KeyValue | null,
    private readonly load: () => Promise<Weights> = loadWeights,
  ) {}

  readonly snapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Load the weights, once. The composer starts it in live mode, so the demo never downloads them. */
  start(): Promise<void> {
    this.loading ??= (async () => {
      this.set({ status: 'loading' });
      try {
        const w = await this.load();
        if (w.levels !== LEVELS || w.levelWeights.join() !== Object.values(THINKING_SCALE).join() || w.vocabSize !== Object.keys(w.counts).length) {
          throw new Error(`weights ${w.version} do not fit the thinking scale`);
        }
        this.base = shipped(w);
        this.learned = readLearned(this.storage, w.version);
        this.publish();
      } catch (e) {
        console.error('the word filter could not load', e);
        this.set({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return this.loading;
  }

  /** The judge rated a sent message (`TurnDeps.judged`): learn from its distribution over the scale. */
  readonly learn = (input: ThinkingInput, distribution: Record<string, number>) => {
    void this.start().then(() => {
      if (!this.base || !this.learned || this.seen.has(input.text)) return; // not loaded (the line says so), or learned already
      const levels = Object.keys(THINKING_SCALE).map((option) => distribution[option]);
      // The providers return every option; anything else is a bug, reported here and not learned.
      if (levels.some((p) => typeof p !== 'number')) return console.error('a thinking score without every option of the scale, not learned:', distribution);
      this.seen.add(input.text);
      const asked = tutorAsked(input.recent);
      this.learned = capped(update(this.learned, features(input.text, asked, classify(input.text)), levels, LEARN_WEIGHT), MAX_LEARNED);
      writeLearned(this.storage, this.learned);
      this.publish();
    });
  };

  /** Forget what was learned in this browser (`/filter reset`). */
  reset() {
    this.seen.clear();
    forget(this.storage);
    if (!this.learned) return;
    this.learned = nothingLearned(this.learned.version);
    this.publish();
  }

  private publish() {
    this.set({ status: 'ready', model: withLearned(this.base!, this.learned!), learned: this.learned!.n });
  }

  private set(next: FilterState) {
    this.state = next;
    this.listeners.forEach((l) => l());
  }
}

/** The filter's reading of `text` (null before its first finished word); `anchor`: the text the model rated last, if the draft builds on it. */
export function filterView(m: Model, text: string, asked: boolean, anchor: string | null): FilterView | null {
  if (!tokens(text).length) return null;
  const r = rate(m, text, asked, classify(text));
  return { you: r.estimate, unsure: r.certainty < UNSURE_BELOW, anchorYou: anchor === null ? null : rate(m, anchor, asked, classify(anchor)).estimate };
}

const noSubscribe = () => () => {};
const noState = () => null;

/**
 * The instant tier for the composer: the filter's reading of the draft up to its last finished word
 * (`view`, null while the weights load or failed, or before the first word), and of the whole draft
 * at send (`whole`). `filter` null: off (demo), nothing is downloaded.
 */
export function useFilterView(filter: LiveFilter | null, draft: string, messages: Message[], anchor: string | null) {
  useEffect(() => void filter?.start(), [filter]);
  const state = useSyncExternalStore(filter?.subscribe ?? noSubscribe, filter?.snapshot ?? noState);
  const asked = useMemo(() => tutorAsked(draftContext(messages)), [messages]);
  const step = finishedWords(draft);
  const model = state?.status === 'ready' ? state.model : null;
  const view = useMemo(() => (model ? filterView(model, step, asked, anchor) : null), [model, step, asked, anchor]);
  return {
    step,
    view,
    whole: (text: string) => (model ? filterView(model, text.trim(), asked, anchor) : null),
    learned: state?.status === 'ready' ? state.learned : 0,
    failed: state?.status === 'failed',
  };
}
