/**
 * An illustrative forgetting model (Ebbinghaus-style curve), not a measurement.
 *
 * Retention falls as e^(−age / stability). Stability grows with how much of the thinking was
 * yours (the generation effect: what you work out yourself sticks longer) and with every
 * further time you came back to the concept (spacing). Designs use it to let ideas fade over
 * time, so the long-term cost of delegating becomes visible today.
 */

const DAY_MS = 86_400_000;

/** Whole days from an ISO timestamp to `now` (ms since epoch or a Date). Future dates and bad input → 0. */
export function ageDays(iso: string, now: number | Date): number {
  const then = /^\d{4}-\d{2}-\d{2}/.test(iso) ? Date.parse(iso) : NaN;
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.round((+now - then) / DAY_MS));
}

/** Time constant in days (retention falls to ~37%) for a concept with this "you" score (0..1) and number of visits. */
export function stability(score: number, visits = 1): number {
  return 9 * 6 ** score * (1 + 0.5 * Math.max(0, visits - 1));
}

/** Share likely still remembered, 0..1. */
export function retention(score: number, ageDays: number, visits = 1): number {
  if (ageDays <= 0) return 1;
  return Math.exp(-ageDays / stability(score, visits));
}

/** Below this, a leaf counts as forgotten: it falls from the tree. */
export const FALLEN = 0.2;

/** Stable pseudo-random number in [0, 1) for a string. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Which characters of a label survive at a given retention. Each character has its own fixed
 * threshold, so as time passes letters drop out one by one, always in the same order.
 */
export function eroded(label: string, id: string, r: number): boolean[] {
  const keep = r >= 0.999 ? 2 : Math.sqrt(r);
  return [...label].map((ch, i) => ch !== ' ' && i > 0 && hash01(`${id}:${i}`) > keep);
}

/** Positions of a log-scaled time scrubber: 0 = now, 1 = TIME_MAX days later. */
export const TIME_MAX = 90;
export const daysAt = (p: number) => Math.round((TIME_MAX + 1) ** Math.max(0, Math.min(1, p)) - 1);
export const posOf = (days: number) => Math.log(days + 1) / Math.log(TIME_MAX + 1);

export const TIME_TICKS: { days: number; label: string }[] = [
  { days: 0, label: 'now' },
  { days: 1, label: '1d' },
  { days: 7, label: '1w' },
  { days: 30, label: '1m' },
  { days: 90, label: '3m' },
];

export function formatDays(d: number): string {
  if (d <= 0) return 'now';
  if (d < 7) return `+${d} day${d === 1 ? '' : 's'}`;
  if (d < 30) {
    const w = Math.round(d / 7);
    return `+${w} week${w === 1 ? '' : 's'}`;
  }
  const m = Math.round(d / 30);
  return `+${m} month${m === 1 ? '' : 's'}`;
}
