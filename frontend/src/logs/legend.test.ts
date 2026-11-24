import { describe, expect, it } from 'vitest';
import { GROUPS, groupOf, isNoise, LEGEND, NEVER_LOGGED, whatIs } from './legend';

describe('legend', () => {
  it('has one plain lowercase sentence and a known group for every event type', () => {
    const types = Object.keys(LEGEND);
    expect(types.length).toBeGreaterThan(55);
    for (const t of types) {
      const line = LEGEND[t as keyof typeof LEGEND];
      expect(GROUPS, t).toContain(line.group);
      expect(line.what, t).toMatch(/^[a-z"].*\.$/);
    }
  });

  it('every group has events', () => {
    for (const g of GROUPS) expect(Object.values(LEGEND).some((l) => l.group === g), g).toBe(true);
  });

  it('noise is the frequent, rarely read events, and nothing else', () => {
    const noise = Object.keys(LEGEND).filter(isNoise).sort();
    expect(noise).toEqual(['click', 'filter_rated', 'hint_hover', 'hover', 'idle_end', 'idle_start', 'message_rest', 'resize']);
  });

  it('an unknown type is "other", not noise, and says it is not in the catalogue', () => {
    expect(groupOf('nope')).toBe('other');
    expect(isNoise('nope')).toBe(false);
    expect(whatIs('nope')).toMatch(/not in the catalogue/);
    // Not fooled by the object's prototype.
    expect(groupOf('constructor')).toBe('other');
    expect(groupOf('toString')).toBe('other');
  });

  it('names what is never logged', () => {
    const text = NEVER_LOGGED.join(' ');
    for (const word of ['session token', 'passwords', 'own-model keys', 'username', 'endpoint urls']) expect(text).toContain(word);
  });
});
