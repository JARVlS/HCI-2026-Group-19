import { describe, expect, it } from 'vitest';
import type { Mode } from '../src/lib/types';
import { leaveOneOut, tokens, trainBayes } from './bayes';
import { LINTER_SET } from './linter-set';
import { accuracy, confusion, kappa, macroF1, perClass } from './metrics';

describe('agreement metrics', () => {
  it('perfect agreement is accuracy 1 and kappa 1', () => {
    const g: Mode[] = ['own', 'together', 'ai', 'own'];
    const m = confusion(g, g);
    expect(accuracy(m)).toBe(1);
    expect(kappa(m)).toBe(1);
    expect(kappa(m, 'linear')).toBe(1);
    expect(macroF1(m)).toBe(1);
  });

  it('matches a hand-computed kappa', () => {
    // 10 cases: own→own 4, own→ai 1, together→together 2, together→own 1, ai→ai 2.
    const gold: Mode[] = ['own', 'own', 'own', 'own', 'own', 'together', 'together', 'together', 'ai', 'ai'];
    const pred: Mode[] = ['own', 'own', 'own', 'own', 'ai', 'together', 'together', 'own', 'ai', 'ai'];
    const m = confusion(gold, pred);
    expect(m).toEqual([
      [4, 0, 1],
      [1, 2, 0],
      [0, 0, 2],
    ]);
    expect(accuracy(m)).toBeCloseTo(0.8);
    // po = .8; rows .5 .3 .2; cols .5 .2 .3; pe = .25 + .06 + .06 = .37; kappa = .43 / .63
    expect(kappa(m)).toBeCloseTo(0.43 / 0.63);
    // linear weights: own→ai counts 0, together→own 0.5. po_w = .8 + .05 = .85;
    // pe_w = .37 + 0.5 * (.5*.2 + .3*.5 + .3*.3 + .2*.2) = .37 + .19 = .56; kappa_w = .29 / .44
    expect(kappa(m, 'linear')).toBeCloseTo(0.29 / 0.44);
    expect(perClass(m)[0]).toMatchObject({ mode: 'own', precision: 0.8, recall: 0.8, support: 5 });
  });

  it('chance-level labels give a kappa near 0', () => {
    const gold: Mode[] = ['own', 'own', 'ai', 'ai'];
    const pred: Mode[] = ['own', 'ai', 'own', 'ai'];
    expect(kappa(confusion(gold, pred))).toBeCloseTo(0);
  });
});

describe('naive Bayes baseline', () => {
  it('uses words and word pairs', () => {
    expect(tokens('I think it’s fine')).toEqual(['i', 'think', "it's", 'fine', 'i_think', "think_it's", "it's_fine"]);
  });

  it('learns an obvious split and returns probabilities that sum to 1', () => {
    const nb = trainBayes([
      { text: 'write me a summary', label: 'ai' },
      { text: 'write my essay', label: 'ai' },
      { text: 'i think it is because', label: 'own' },
      { text: 'my guess is that', label: 'own' },
      { text: 'why does it', label: 'together' },
    ]);
    const r = nb.predict('write a summary please');
    expect(r.mode).toBe('ai');
    expect(r.p.own + r.p.together + r.p.ai).toBeCloseTo(1);
    expect(nb.predict('i think so').mode).toBe('own');
  });

  it('leave-one-out never sees the case it predicts', () => {
    expect(leaveOneOut(LINTER_SET.slice(0, 12))).toHaveLength(12);
  });
});

describe('linter set', () => {
  it('every class has cases and no text is there twice', () => {
    for (const m of ['own', 'together', 'ai'] as Mode[]) expect(LINTER_SET.filter((c) => c.label === m).length).toBeGreaterThan(30);
    expect(new Set(LINTER_SET.map((c) => c.text)).size).toBe(LINTER_SET.length);
  });
});
