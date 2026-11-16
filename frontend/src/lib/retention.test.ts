import { describe, expect, it } from 'vitest';
import {
  FALLEN,
  TIME_MAX,
  TIME_TICKS,
  daysAt,
  ageDays,
  eroded,
  formatDays,
  hash01,
  posOf,
  retention,
  stability,
} from './retention';

describe('ageDays', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');

  it('counts whole days back from now', () => {
    expect(ageDays('2026-11-07T08:00:00Z', now)).toBe(0);
    expect(ageDays('2026-10-28T12:00:00Z', now)).toBe(10);
    expect(ageDays('2026-09-30T12:00:00Z', new Date(now))).toBe(38);
  });

  it('clamps future dates to 0', () => {
    expect(ageDays('2026-12-01T00:00:00Z', now)).toBe(0);
  });

  it('returns 0 for timestamps it cannot parse', () => {
    for (const iso of ['', 'Today', 'Oct 28']) expect(ageDays(iso, now)).toBe(0);
  });
});

describe('stability and retention', () => {
  it('stability grows with the "you" score and with visits', () => {
    expect(stability(0)).toBe(9);
    expect(stability(1)).toBe(54);
    expect(stability(0.5)).toBeGreaterThan(stability(0));
    expect(stability(0.5, 3)).toBe(stability(0.5) * 2);
    expect(stability(0.5, 0)).toBe(stability(0.5, 1));
  });

  it('retention is full at age 0 and falls with age', () => {
    expect(retention(0, 0)).toBe(1);
    expect(retention(0, -5)).toBe(1);
    expect(retention(0.5, 7)).toBeLessThan(retention(0.5, 1));
    expect(retention(0, 9)).toBeCloseTo(Math.exp(-1));
  });

  it('own thinking is retained longer than delegated thinking', () => {
    for (const days of [1, 7, 30, 90]) {
      expect(retention(1, days)).toBeGreaterThan(retention(0.5, days));
      expect(retention(0.5, days)).toBeGreaterThan(retention(0, days));
    }
  });

  it('a delegated leaf falls within the scrubber range, an own one does not', () => {
    expect(retention(0, TIME_MAX)).toBeLessThan(FALLEN);
    expect(retention(1, 30)).toBeGreaterThan(FALLEN);
  });
});

describe('time scrubber', () => {
  it('daysAt and posOf round-trip at the tick days', () => {
    for (const { days } of TIME_TICKS) expect(daysAt(posOf(days))).toBe(days);
  });

  it('maps the ends of the track to now and TIME_MAX', () => {
    expect(daysAt(0)).toBe(0);
    expect(daysAt(1)).toBe(TIME_MAX);
    expect(daysAt(-1)).toBe(0);
    expect(daysAt(2)).toBe(TIME_MAX);
  });

  it('formats offsets in days, weeks and months', () => {
    expect(formatDays(0)).toBe('now');
    expect(formatDays(-3)).toBe('now');
    expect(formatDays(1)).toBe('+1 day');
    expect(formatDays(6)).toBe('+6 days');
    expect(formatDays(7)).toBe('+1 week');
    expect(formatDays(29)).toBe('+4 weeks');
    expect(formatDays(30)).toBe('+1 month');
    expect(formatDays(90)).toBe('+3 months');
  });
});

describe('hash01 and eroded', () => {
  it('hash01 is stable and in [0, 1)', () => {
    for (const s of ['', 'a', 'sql-b0-l1:3', 'backprop']) {
      const h = hash01(s);
      expect(h).toBe(hash01(s));
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  const label = 'gradient descent';
  const id = 'gd';

  it('erases nothing at full retention', () => {
    expect(eroded(label, id, 1)).toEqual([...label].map(() => false));
  });

  it('never erases the first letter or spaces', () => {
    const e = eroded(label, id, 0);
    expect(e).toHaveLength(label.length);
    expect(e[0]).toBe(false);
    expect(e[label.indexOf(' ')]).toBe(false);
    expect(e.filter(Boolean).length).toBeGreaterThan(0);
  });

  it('drops letters monotonically as retention falls', () => {
    let prev = eroded(label, id, 1);
    for (const r of [0.9, 0.7, 0.5, 0.3, 0.1, 0]) {
      const next = eroded(label, id, r);
      prev.forEach((gone, i) => gone && expect(next[i]).toBe(true));
      prev = next;
    }
  });
});
