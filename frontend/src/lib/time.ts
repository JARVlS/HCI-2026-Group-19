/** Date helpers for ISO-8601 timestamps (domain dates are always ISO strings, see lib/domain.ts). */

const DAY_MS = 86_400_000;

export const nowIso = () => new Date().toISOString();

/** ISO timestamp `days` days before `now`. */
export const daysAgo = (days: number, now: number | Date) => new Date(+now - days * DAY_MS).toISOString();

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today", or a short local date like "Oct 28". */
export function shortDate(iso: string, now: number | Date = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  if (sameDay(d, new Date(now))) return 'Today';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export type DayGroup = 'Today' | 'This week' | 'Earlier';

/** Chat-list grouping: today, the last 7 days, earlier. */
export function dayGroup(iso: string, now: number | Date = Date.now()): DayGroup {
  const d = new Date(iso);
  if (sameDay(d, new Date(now))) return 'Today';
  return +now - +d < 7 * DAY_MS ? 'This week' : 'Earlier';
}
