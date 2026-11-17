import { describe, expect, it } from 'vitest';
import researchVectors from '../../../research/thinking-filter/out/vectors.json?raw';
import researchWeights from '../../../research/thinking-filter/out/weights.json?raw';
import { classify } from './classify';
import updateVectors from './filter/update.vectors.json';
import shippedVectors from './filter/vectors.json?raw';
import shippedWeights from './filter/weights.json?raw';
import { belief, capped, certainty, estimate, features, LEVELS, nothingLearned, reasonKey, shipped, tokens, update, withLearned, type Learned, type Weights } from './thinkingFilter';

/*
 * The port against the research's reference implementation (research/thinking-filter, nb.py): its
 * 40 test vectors (with per-word steps for five) and the learning step (update.vectors.json, made
 * by filter/make_update_vectors.py with nb.py), to 1e-6.
 */

interface Case {
  text: string;
  tutorAsked: boolean;
  linter: { mode: string; confidence: number; reasons: string[] };
  features: string[];
  belief: number[];
  estimate: number;
  certainty: number;
  steps?: Omit<Case, 'tutorAsked' | 'steps'>[];
}

const weights = JSON.parse(shippedWeights) as Weights;
const vectors = JSON.parse(shippedVectors) as { weightsVersion: string; tolerance: number; cases: Case[] };
const TOL = vectors.tolerance;
const model = shipped(weights);

function expectClose(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((x, i) => expect(Math.abs(x - expected[i])).toBeLessThan(TOL));
}

/** The case as the browser computes it: classify() of the draft, its features, the belief. */
function check(c: Omit<Case, 'tutorAsked' | 'steps'>, asked: boolean) {
  const lin = classify(c.text);
  expect({ mode: lin.mode, reasons: lin.reasons }).toEqual({ mode: c.linter.mode, reasons: c.linter.reasons });
  expect(Math.abs(lin.confidence - c.linter.confidence)).toBeLessThan(1e-12);
  const f = features(c.text, asked, lin);
  expect(f).toEqual(c.features);
  const b = belief(f, model);
  expectClose(b, c.belief);
  expect(Math.abs(estimate(b, model) - c.estimate)).toBeLessThan(TOL);
  expect(Math.abs(certainty(b) - c.certainty)).toBeLessThan(TOL);
}

describe('thinking filter: the shipped files', () => {
  it('are byte-equal copies of the research outputs (refit there, then copy)', () => {
    expect(shippedWeights).toBe(researchWeights);
    expect(shippedVectors).toBe(researchVectors);
  });

  it('weights and vectors belong together and fit this port', () => {
    expect(vectors.weightsVersion).toBe(weights.version);
    expect([weights.levels, weights.vocabSize, weights.levelWeights]).toEqual([LEVELS, model.counts.size, [0, 0.25, 0.5, 0.75, 1]]);
  });
});

describe('thinking filter: parity with nb.py', () => {
  it.each(vectors.cases.map((c, i) => [i, c.text, c] as const))('case %i %j', (_, __, c) => check(c, c.tutorAsked));

  it('every per-word step of the five drafts typed word by word', () => {
    const typed = vectors.cases.filter((c) => c.steps);
    expect(typed).toHaveLength(5);
    for (const c of typed) for (const s of c.steps!) check(s, c.tutorAsked);
    expect(typed.reduce((n, c) => n + c.steps!.length, 0)).toBeGreaterThan(50);
  });

  it('tokens and reasons follow featureSpec', () => {
    expect(tokens("Don’t 'quoted' x2, ÉTÉ—naïve")).toEqual(["don't", 'quoted', 'x2', 'été', 'naïve']);
    expect(reasonKey('Starts with “Write” — asks the AI to produce it')).toBe('starts with — asks the ai to produce it');
    expect(reasonKey('Shares your own view (“I think”)')).toBe('shares your own view');
  });

  it('a word that is also an Object property name is just an unknown word', () => {
    const b = belief(['constructor', '__proto__', 'tostring', 'hasownproperty'], model);
    expectClose(b, belief([], model));
  });
});

describe('thinking filter: learning (nb.update)', () => {
  const steps = updateVectors.learn;

  it('reproduces the reference after one and after three judged drafts', () => {
    let l: Learned = nothingLearned(weights.version);
    let done = 0;
    updateVectors.after.forEach((after, j) => {
      for (; done < updateVectors.afterSteps[j]; done++) l = update(l, steps[done].features, steps[done].distribution, steps[done].weight);
      const m = withLearned(model, l);
      expect(m.counts.size).toBe(after.vocabSize);
      expectClose(m.prior, after.prior);
      expectClose(m.totals, after.totals);
      vectors.cases.forEach((c, i) => {
        const b = belief(c.features, m);
        expectClose(b, after.cases[i].belief);
        expect(Math.abs(estimate(b, m) - after.cases[i].estimate)).toBeLessThan(TOL);
        expect(Math.abs(certainty(b) - after.cases[i].certainty)).toBeLessThan(TOL);
      });
    });
    expect(l.n).toBe(3);
  });

  it('leaves the shipped counts and the earlier learned counts untouched', () => {
    const before = JSON.stringify(weights.counts.no);
    const l1 = update(nothingLearned('v'), ['no', 'no'], [1, 0, 0, 0, 0], 1);
    const l2 = update(l1, ['no'], [0, 0, 0, 0, 1], 1);
    expect(l1.counts.get('no')).toEqual([2, 0, 0, 0, 0]);
    expect(l2.counts.get('no')).toEqual([2, 0, 0, 0, 1]);
    withLearned(model, l2);
    expect(JSON.stringify(model.counts.get('no'))).toBe(before);
    expect(withLearned(model, nothingLearned('v'))).toBe(model);
  });

  it('keeps at most the cap, dropping the features with the least mass', () => {
    let l = nothingLearned('v');
    for (let i = 0; i < 6; i++) l = update(l, Array.from({ length: i + 1 }, () => `w${i}`), [0.2, 0.2, 0.2, 0.2, 0.2], 1);
    const c = capped(l, 4);
    expect([...c.counts.keys()].sort()).toEqual(['w2', 'w3', 'w4', 'w5']);
    expect([c.n, c.prior]).toEqual([l.n, l.prior]);
    expect(capped(c, 4)).toBe(c);
    // Totals stay the column sums of what is kept.
    const m = withLearned(model, c);
    expectClose(m.totals, model.totals.map((t) => t + (3 + 4 + 5 + 6) * 0.2));
  });
});
