import type { Classification } from './types';

/*
 * The thinking filter: the instant tier of the composer's score line (ADR-15). A naive Bayes over
 * the words of the draft and the word rules' verdict, on the five steps of the "thought along" scale,
 * fitted on synthetic messages that the fast model (the judge) rated. It runs on every finished word
 * with no network call, and it keeps learning from the judge (`learn`).
 *
 * A TypeScript port of research/thinking-filter/thinking_filter/nb.py; `featureSpec` in the weights
 * file is the exact recipe, and thinkingFilter.test.ts checks this file against the research's test
 * vectors. Pure: no React, no storage (`liveFilter.ts` has those).
 */

export const LEVELS = 5;
/** `rule:<label>:sure` from this confidence of the word rules on (nb.RULE_SURE). */
const RULE_SURE = 0.7;
const LENGTH_BANDS: [number, string][] = [
  [2, '1-2'],
  [5, '3-5'],
  [10, '6-10'],
  [20, '11-20'],
];

/** The shipped weights (research/thinking-filter/out/weights.json, copied to ./filter/weights.json). */
export interface Weights {
  version: string;
  levels: number;
  levelWeights: number[];
  alpha: number;
  beta: number;
  vocabSize: number;
  prior: number[];
  totals: number[];
  counts: Record<string, number[]>;
  featureSpec: string;
}

/**
 * What the filter learned in this browser, on top of the shipped weights: soft counts as nb.update
 * adds them. `n`: from how many judged messages.
 */
export interface Learned {
  version: string;
  n: number;
  prior: number[];
  counts: Map<string, number[]>;
}

/** The filter as `belief` reads it. A Map, so a word like "constructor" is never an Object key. */
export interface Model {
  alpha: number;
  beta: number;
  levelWeights: number[];
  prior: number[];
  totals: number[];
  counts: Map<string, number[]>;
}

/** The judge's verdict on a draft as the filter reads it: the word rules' result (`classify`, no quiz context). */
export type Linter = Pick<Classification, 'mode' | 'confidence' | 'reasons'>;

const TOKEN = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
const QUOTED = /“[^”]*”/g;

/** Curly single quotes become ', then lower case: nothing else. */
const normalise = (text: string) => text.replace(/[’‘]/g, "'").toLowerCase();

export const tokens = (text: string): string[] => normalise(text).match(TOKEN) ?? [];

const lengthBand = (n: number) => LENGTH_BANDS.find(([upper]) => n <= upper)?.[1] ?? '21+';

/** A reason of the word rules without the words it quotes, so one rule gives one feature (nb.reason_key). */
export const reasonKey = (reason: string) => reason.replace(QUOTED, '').replaceAll('()', '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');

/** The features of a draft, in the order of `featureSpec`. Recomputed from the whole draft every time. */
export function features(text: string, tutorAsked: boolean, linter: Linter): string[] {
  const t = tokens(text);
  const out = [...t];
  for (let i = 1; i < t.length; i++) out.push(`${t[i - 1]} ${t[i]}`);
  if (t.length) out.push(`^${t[0]}`);
  if (t.length > 1) out.push(`^${t[0]} ${t[1]}`);
  if (text.trimEnd().endsWith('?')) out.push('?$');
  if (t.length) out.push(`#len:${lengthBand(t.length)}`);
  if (tutorAsked) out.push('@tutor_asked');
  out.push(`rule:${linter.mode}`);
  if (linter.confidence >= RULE_SURE) out.push(`rule:${linter.mode}:sure`);
  for (const r of linter.reasons) out.push(`rule:${reasonKey(r)}`);
  return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * The belief over the levels 1..5: log b[k] = ln(prior[k] / sum(prior)) + alpha * the sum over known
 * features f of ln((counts[f][k] + beta) / (totals[k] + beta * V)), V = the number of features, then
 * normalised. Unknown features are skipped; a level without prior mass stays at 0.
 */
export function belief(feats: string[], m: Model): number[] {
  const pSum = sum(m.prior);
  const denom = m.totals.map((t) => t + m.beta * m.counts.size);
  const ll = new Array<number>(LEVELS).fill(0);
  for (const f of feats) {
    const c = m.counts.get(f);
    if (!c) continue;
    for (let k = 0; k < LEVELS; k++) ll[k] += Math.log((c[k] + m.beta) / denom[k]);
  }
  const z = m.prior.map((p, k) => (p > 0 ? Math.log(p / pSum) + m.alpha * ll[k] : -Infinity));
  const top = Math.max(...z);
  const e = z.map((x) => Math.exp(x - top));
  const s = sum(e);
  return e.map((x) => x / s);
}

/** How much of the thinking is the student's own, 0..1: the belief-weighted level weights. */
export const estimate = (b: number[], m: Model) => sum(b.map((p, k) => p * m.levelWeights[k]));

/** 1 - entropy / ln 5: 0 when every level is as likely, 1 when one level holds everything. */
export const certainty = (b: number[]) => 1 + sum(b.map((p) => (p > 0 ? p * Math.log(p) : 0))) / Math.log(LEVELS);

export interface FilterRating {
  estimate: number;
  certainty: number;
}

export function rate(m: Model, text: string, tutorAsked: boolean, linter: Linter): FilterRating {
  const b = belief(features(text, tutorAsked, linter), m);
  return { estimate: estimate(b, m), certainty: certainty(b) };
}

/** The shipped filter, ready for `belief`. */
export function shipped(w: Weights): Model {
  return { alpha: w.alpha, beta: w.beta, levelWeights: w.levelWeights, prior: w.prior, totals: w.totals, counts: new Map(Object.entries(w.counts)) };
}

export const nothingLearned = (version: string): Learned => ({ version, n: 0, prior: new Array<number>(LEVELS).fill(0), counts: new Map() });

/**
 * Learn from one judged message (nb.update): weight × the judge's distribution over the levels goes
 * to the prior and to the counts of every feature occurrence (new features become keys). Returns
 * the new learned counts; the old ones are not changed.
 */
export function update(l: Learned, feats: string[], distribution: number[], weight: number): Learned {
  const add = distribution.map((p) => weight * p);
  const counts = new Map(l.counts);
  for (const f of feats) {
    const c = counts.get(f) ?? new Array<number>(LEVELS).fill(0);
    counts.set(f, c.map((x, k) => x + add[k]));
  }
  return { version: l.version, n: l.n + 1, prior: l.prior.map((x, k) => x + add[k]), counts };
}

/** At most `max` learned features: the ones with the least mass go first (ties: by name), so storage stays small. */
export function capped(l: Learned, max: number): Learned {
  if (l.counts.size <= max) return l;
  const kept = [...l.counts].sort(([fa, a], [fb, b]) => sum(b) - sum(a) || (fa < fb ? -1 : 1)).slice(0, max);
  return { ...l, counts: new Map(kept) };
}

/**
 * The shipped filter plus what was learned: prior and counts added, totals the shipped totals plus
 * the column sums of the learned counts (as nb.update keeps them), V the number of keys of both.
 */
export function withLearned(base: Model, l: Learned): Model {
  if (!l.n) return base;
  const counts = new Map(base.counts);
  const totals = [...base.totals];
  for (const [f, c] of l.counts) {
    const b = counts.get(f);
    counts.set(f, b ? b.map((x, k) => x + c[k]) : c);
    for (let k = 0; k < LEVELS; k++) totals[k] += c[k];
  }
  return { ...base, prior: base.prior.map((x, k) => x + l.prior[k]), totals, counts };
}
