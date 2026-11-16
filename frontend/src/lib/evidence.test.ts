import { describe, expect, it } from 'vitest';
import { quotesOf, resolveEvidence, resolveQuote } from './evidence';

const text = 'Write me a  Summary of\nbackprop, please';

describe('resolveQuote', () => {
  it('finds an exact quote', () => {
    expect(resolveQuote(text, 'Write')).toEqual({ start: 0, end: 5 });
  });

  it('falls back to case- and whitespace-insensitive matching, with offsets into the original', () => {
    const r = resolveQuote(text, 'a summary of backprop')!;
    expect(text.slice(r.start, r.end)).toBe('a  Summary of\nbackprop');
  });

  it('returns null for a quote that is not there, or an empty one', () => {
    expect(resolveQuote(text, 'gradient')).toBeNull();
    expect(resolveQuote(text, '   ')).toBeNull();
  });
});

describe('resolveEvidence / quotesOf', () => {
  it('drops unresolvable quotes', () => {
    expect(
      resolveEvidence(text, [
        { quote: 'Write', mode: 'ai', reason: 'a' },
        { quote: 'nope', mode: 'ai', reason: 'b' },
      ]),
    ).toEqual([{ start: 0, end: 5, mode: 'ai', reason: 'a' }]);
  });

  it('round-trips offsets → quotes → offsets', () => {
    const ev = [{ start: 12, end: 19, mode: 'ai' as const, reason: 'r' }];
    expect(resolveEvidence(text, quotesOf(text, ev))).toEqual(ev);
  });
});
