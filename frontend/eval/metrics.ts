import type { Mode } from '../src/lib/types';

/**
 * Agreement between two labelings of the same texts (ADR-15): accuracy, Cohen's kappa (plain and
 * linearly weighted, since own > together > ai is an order), per-class precision, recall and F1.
 * Pure, so `metrics.test.ts` checks it with hand-computed numbers.
 */

export const ORDER: Mode[] = ['own', 'together', 'ai'];

/** Rows: the reference label, columns: the predicted one, both in ORDER. */
export function confusion(gold: Mode[], pred: Mode[]): number[][] {
  if (gold.length !== pred.length) throw new Error('gold and pred differ in length');
  const m = ORDER.map(() => ORDER.map(() => 0));
  gold.forEach((g, i) => m[ORDER.indexOf(g)][ORDER.indexOf(pred[i])]++);
  return m;
}

const total = (m: number[][]) => m.flat().reduce((a, b) => a + b, 0);

export function accuracy(m: number[][]): number {
  const n = total(m);
  return n ? m.reduce((a, row, i) => a + row[i], 0) / n : 0;
}

/**
 * Cohen's kappa: agreement beyond chance, 1 = perfect, 0 = chance level. `linear` weighs a miss by
 * distance (own vs ai counts double own vs together). Common reading (Landis & Koch): below 0.2
 * slight, 0.2 to 0.4 fair, 0.4 to 0.6 moderate, 0.6 to 0.8 substantial, above 0.8 almost perfect.
 */
export function kappa(m: number[][], weights: 'none' | 'linear' = 'none'): number {
  const n = total(m);
  if (!n) return 0;
  const k = m.length;
  const w = (i: number, j: number) => (weights === 'linear' ? 1 - Math.abs(i - j) / (k - 1) : i === j ? 1 : 0);
  const rows = m.map((r) => r.reduce((a, b) => a + b, 0) / n);
  const cols = m[0].map((_, j) => m.reduce((a, r) => a + r[j], 0) / n);
  let po = 0;
  let pe = 0;
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      po += (w(i, j) * m[i][j]) / n;
      pe += w(i, j) * rows[i] * cols[j];
    }
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

export interface ClassScores {
  mode: Mode;
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export function perClass(m: number[][]): ClassScores[] {
  return ORDER.map((mode, i) => {
    const tp = m[i][i];
    const predicted = m.reduce((a, r) => a + r[i], 0);
    const support = m[i].reduce((a, b) => a + b, 0);
    const precision = predicted ? tp / predicted : 0;
    const recall = support ? tp / support : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { mode, precision, recall, f1, support };
  });
}

export const macroF1 = (m: number[][]) => perClass(m).reduce((a, c) => a + c.f1, 0) / ORDER.length;

/** One line per labeling: n, accuracy, kappa, weighted kappa, macro F1. */
export function summary(m: number[][]) {
  return { n: total(m), accuracy: accuracy(m), kappa: kappa(m), weightedKappa: kappa(m, 'linear'), macroF1: macroF1(m) };
}
