import { describe, expect, it } from 'vitest';
import { draftShare } from './modes';

describe('draftShare', () => {
  it('leans to the student for a sure "own", to the AI for a sure "ai"', () => {
    expect(draftShare('own', 1)).toBe(1);
    expect(draftShare('ai', 1)).toBe(0);
    expect(draftShare('own', 0.7)).toBeCloseTo(0.85);
    expect(draftShare('ai', 0.7)).toBeCloseTo(0.15);
  });

  it('"together" and an unsure label sit in the middle', () => {
    expect(draftShare('together', 0.9)).toBe(0.5);
    expect(draftShare('own', 0)).toBe(0.5);
  });

  it('clamps a confidence outside 0..1', () => {
    expect(draftShare('own', 2)).toBe(1);
    expect(draftShare('ai', -1)).toBe(0.5);
  });
});
