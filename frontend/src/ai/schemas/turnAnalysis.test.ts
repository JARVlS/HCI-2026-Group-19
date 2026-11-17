import { describe, expect, it } from 'vitest';
import { ProviderError } from '../provider';
import { TURN_ANALYSIS_SCHEMA, toTurnAnalysis } from './turnAnalysis';

/** A valid wire answer; tests override parts of it. */
const wire = (over: Record<string, unknown> = {}) => ({
  mode: 'together',
  confidence: 0.8,
  reasons: ['Asks why it works'],
  evidence: [{ quote: 'why does', mode: 'together', reason: 'Asks why' }],
  subject: null,
  concepts: [],
  ...over,
});

const concept = (over: Record<string, unknown> = {}) => ({
  existingId: null,
  newLabel: null,
  newKind: null,
  parentId: null,
  parentLabel: null,
  description: null,
  mode: 'own',
  independence: 1,
  correctness: null,
  confidence: 0.9,
  reason: 'Explains it',
  evidenceQuote: null,
  ...over,
});

const convert = (raw: unknown, hasSubject = false) => toTurnAnalysis(raw, { hasSubject });

describe('turn analysis wire schema', () => {
  it('is closed everywhere: every object lists all its properties as required', () => {
    const objects: Record<string, unknown>[] = [];
    const walk = (s: unknown) => {
      if (Array.isArray(s)) return s.forEach(walk);
      if (!s || typeof s !== 'object') return;
      const o = s as Record<string, unknown>;
      if (o.type === 'object') objects.push(o);
      Object.values(o).forEach(walk);
    };
    walk(TURN_ANALYSIS_SCHEMA);
    expect(objects.length).toBe(4);
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false);
      expect(o.required).toEqual(Object.keys(o.properties as object));
    }
    expect(JSON.stringify(TURN_ANALYSIS_SCHEMA)).not.toMatch(/minimum|maximum|minLength|maxLength/);
  });
});

describe('toTurnAnalysis', () => {
  it('keeps the message label, reasons and evidence quotes', () => {
    expect(convert(wire()).message).toEqual({
      mode: 'together',
      confidence: 0.8,
      reasons: ['Asks why it works'],
      evidence: [{ quote: 'why does', mode: 'together', reason: 'Asks why' }],
    });
  });

  it('an existing id wins over a new label; a new node carries its parent and kind', () => {
    const a = convert(
      wire({
        concepts: [
          concept({ existingId: 'gradient', newLabel: 'Gradient descent' }),
          concept({ newLabel: 'Momentum', newKind: 'concept', parentId: 'learning', description: 'Speeds up descent.', evidenceQuote: 'momentum' }),
          concept({ newLabel: 'Optimizers', newKind: 'topic', parentLabel: 'Training' }),
        ],
      }),
    );
    expect(a.concepts.map((c) => c.ref)).toEqual([
      { existingId: 'gradient' },
      { newNode: { label: 'Momentum', kind: 'concept', parent: { existingId: 'learning' }, description: 'Speeds up descent.' } },
      { newNode: { label: 'Optimizers', kind: 'topic', parent: { newLabel: 'Training' }, description: '' } },
    ]);
    expect(a.concepts[1].evidenceQuote).toBe('momentum');
    expect('evidenceQuote' in a.concepts[0]).toBe(false);
  });

  it('clamps numbers to 0..1 and keeps null correctness', () => {
    const a = convert(wire({ confidence: 1.4, concepts: [concept({ existingId: 'x', independence: -0.2, correctness: 3, confidence: 0.5 }), concept({ existingId: 'y' })] }));
    expect(a.message.confidence).toBe(1);
    expect(a.concepts.map((c) => [c.independence, c.correctness, c.confidence])).toEqual([
      [0, 1, 0.5],
      [1, null, 0.9],
    ]);
  });

  it('keeps at most 3 reasons and 3 concepts; empty text counts as missing', () => {
    const a = convert(wire({ reasons: ['a', ' ', 'b', 'c', 'd'], concepts: ['p', 'q', 'r', 's'].map((id) => concept({ existingId: id, evidenceQuote: '' })) }));
    expect(a.message.reasons).toEqual(['a', 'b', 'c']);
    expect(a.concepts.map((c) => c.ref)).toEqual([{ existingId: 'p' }, { existingId: 'q' }, { existingId: 'r' }]);
    expect(a.concepts.every((c) => c.evidenceQuote === undefined)).toBe(true);
  });

  it('a subject only counts while the conversation has none', () => {
    expect(convert(wire({ subject: { existingId: null, newLabel: 'Biology' } })).subject).toEqual({ newLabel: 'Biology' });
    expect(convert(wire({ subject: { existingId: 'cs', newLabel: 'CS' } })).subject).toEqual({ existingId: 'cs' });
    expect(convert(wire({ subject: { existingId: null, newLabel: 'Biology' } }), true).subject).toBeUndefined();
    expect(convert(wire({ subject: { existingId: null, newLabel: null } })).subject).toBeUndefined();
  });

  it.each([
    ['not an object', 'Sure! Here is the analysis.'],
    ['an unknown mode', wire({ mode: 'mostly-ai' })],
    ['a missing list', wire({ concepts: undefined })],
    ['a number as text', wire({ confidence: '0.9' })],
    ['a concept that names nothing', wire({ concepts: [concept()] })],
    ['an unknown kind', wire({ concepts: [concept({ newLabel: 'X', newKind: 'subject' })] })],
    ['a missing subject', { ...wire(), subject: undefined }],
  ])('rejects %s as invalid output', (_, raw) => {
    expect(() => convert(raw)).toThrow(ProviderError);
    try {
      convert(raw);
    } catch (e) {
      expect((e as ProviderError).code).toBe('invalid_output');
    }
  });
});
