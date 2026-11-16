import { describe, expect, it } from 'vitest';
import type { TurnAnalysis } from '../ai/schemas/turnAnalysis';
import { concept, graph } from '../test/build';
import { mergeAnalysis, slugify } from './graph';

describe('slugify', () => {
  it('normalizes case, accents, punctuation and plurals', () => {
    expect(slugify('Activation functions')).toBe('activation-function');
    expect(slugify('  Bayes’ theorem ')).toBe(slugify('bayes theorem'));
    expect(slugify('Weights & biases')).toBe(slugify('weight and biases'));
    expect(slugify('Régression linéaire')).toBe('regression-lineaire');
    expect(slugify('Loss')).toBe('loss');
  });

  it('gives singular and plural the same slug', () => {
    expect(slugify('Hash tables')).toBe(slugify('hash table'));
  });
});

const concepts = graph(concept('s', null, 'subject', 'Machine learning'), concept('t', 's', 'topic', 'Training'), concept('gd', 't', 'concept', 'Gradient descent'));
let n = 0;
const ctx = { conversationId: 'c', messageId: 'm', text: 'I think gradient descent walks downhill', now: '2026-11-01T00:00:00Z', newId: () => `new${++n}`, source: 'prompt' as const, fallbackParentId: 't' };

const judgement = (ref: TurnAnalysis['concepts'][number]['ref'], extra = {}) => ({ ref, mode: 'own' as const, independence: 1, correctness: null, confidence: 0.9, reason: 'r', ...extra });
const analysis = (concepts: TurnAnalysis['concepts'], subject?: TurnAnalysis['subject']): TurnAnalysis => ({
  message: { mode: 'own', confidence: 0.9, reasons: [], evidence: [] },
  subject,
  concepts,
});
const node = (label: string, parent: { existingId?: string; newLabel?: string } = {}) => ({ newNode: { label, kind: 'concept' as const, parent, description: '' } });

describe('mergeAnalysis', () => {
  it('uses existing ids and makes one attempt per concept', () => {
    const r = mergeAnalysis(concepts, analysis([judgement({ existingId: 'gd' }, { evidenceQuote: 'gradient descent' }), judgement({ existingId: 'gd' })]), ctx);
    expect(r.created).toEqual([]);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ conceptId: 'gd', mode: 'own', independence: 1, source: 'prompt', messageId: 'm', conversationId: 'c' });
    expect(r.attempts[0].evidence).toEqual([{ start: 8, end: 24, mode: 'own', reason: 'r' }]);
  });

  it('skips unknown existing ids', () => {
    expect(mergeAnalysis(concepts, analysis([judgement({ existingId: 'nope' })]), ctx).attempts).toEqual([]);
  });

  it('dedupes a "new" node against an existing one by slug', () => {
    const r = mergeAnalysis(concepts, analysis([judgement(node('gradient  Descents'))]), ctx);
    expect(r.created).toEqual([]);
    expect(r.attempts[0].conceptId).toBe('gd');
  });

  it('creates new nodes under the given parent, or the fallback, or a new parent topic', () => {
    const r = mergeAnalysis(
      concepts,
      analysis([judgement(node('Momentum', { existingId: 't' })), judgement(node('Adam')), judgement(node('Dropout', { newLabel: 'Regularization' }))]),
      { ...ctx, maxNew: 10 },
    );
    const byLabel = Object.fromEntries(r.created.map((c) => [c.label, c]));
    expect(byLabel.Momentum.parentId).toBe('t');
    expect(byLabel.Adam.parentId).toBe('t');
    expect(byLabel.Regularization).toMatchObject({ kind: 'topic', parentId: 't' });
    expect(byLabel.Dropout.parentId).toBe(byLabel.Regularization.id);
  });

  it('caps new nodes per turn', () => {
    const r = mergeAnalysis(concepts, analysis(['A', 'B', 'C', 'D'].map((l) => judgement(node(l)))), ctx);
    expect(r.created.map((c) => c.label)).toEqual(['A', 'B', 'C']);
    expect(r.attempts).toHaveLength(3);
  });

  it('picks or creates the subject', () => {
    expect(mergeAnalysis(concepts, analysis([], { existingId: 's' }), ctx).subjectId).toBe('s');
    expect(mergeAnalysis(concepts, analysis([], { newLabel: 'machine-learning' }), ctx).subjectId).toBe('s');
    const r = mergeAnalysis(concepts, analysis([], { newLabel: 'Biology' }), ctx);
    expect(r.created).toEqual([expect.objectContaining({ label: 'Biology', kind: 'subject', parentId: null })]);
  });

  it('clamps scores into 0..1', () => {
    const r = mergeAnalysis(concepts, analysis([judgement({ existingId: 'gd' }, { independence: 3, confidence: -1, correctness: 2 })]), ctx);
    expect(r.attempts[0]).toMatchObject({ independence: 1, confidence: 0, correctness: 1 });
  });
});
