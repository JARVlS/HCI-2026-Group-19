import type { AdminEvent } from './visit';

/**
 * The pure parts of the heatmap (`Heatmap.tsx`): clicks and hovers read from the usage log
 * (`click`, `hover`; `lib/events.ts`), the clicks that follow each other closely enough to belong
 * together (chains), how people move between parts of the page, how long they stay on
 * hover-driven places, and which radial option they rest on before choosing. Payloads are read
 * defensively: a broken row is skipped, never thrown on.
 */

export interface ClickPoint {
  id: string;
  /** `userId visit`: clicks only chain within one visit. */
  visit: string;
  /** Client time (ms since epoch). */
  at: number;
  seq: number;
  x: number;
  y: number;
  width: number;
  height: number;
  region: string;
  target: string;
  view: string;
  pointer: string;
  sincePrev: number | null;
  typed: boolean;
  condition: string | null;
}

export interface HoverPoint {
  id: string;
  visit: string;
  /** Client time the hover ended (when it was logged). */
  at: number;
  name: string;
  /** The message, leaf, tree or radial option. */
  item: string | null;
  ms: number;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  view: string;
  condition: string | null;
}

/** A radial choice (`nav` via the radial menu): when, in which visit. */
export interface RadialPick {
  visit: string;
  at: number;
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const str = (x: unknown, or = '') => (typeof x === 'string' ? x : or);
const visitOf = (e: AdminEvent) => `${e.userId} ${str(e.payload.visit)}`;

/** Clicks, hovers and radial choices of these events, each in time order. */
export function pointsOf(events: readonly AdminEvent[]): { clicks: ClickPoint[]; hovers: HoverPoint[]; picks: RadialPick[] } {
  const clicks: ClickPoint[] = [];
  const hovers: HoverPoint[] = [];
  const picks: RadialPick[] = [];
  for (const e of events) {
    const p = e.payload;
    const at = Date.parse(e.clientTs);
    if (!Number.isFinite(at)) continue;
    if (e.type === 'click' && num(p.x) && num(p.y) && num(p.width) && num(p.height)) {
      clicks.push({
        id: e.id,
        visit: visitOf(e),
        at,
        seq: num(p.seq) ? p.seq : 0,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        region: str(p.region, 'other'),
        target: str(p.target),
        view: str(p.view, 'chat'),
        pointer: str(p.pointer, 'mouse'),
        sincePrev: num(p.sincePrev) ? p.sincePrev : null,
        typed: p.typed === true,
        condition: e.condition,
      });
    } else if (e.type === 'hover' && num(p.ms) && typeof p.name === 'string') {
      hovers.push({
        id: e.id,
        visit: visitOf(e),
        at,
        name: p.name,
        item: typeof p.id === 'string' ? p.id : null,
        ms: p.ms,
        x: num(p.x) ? p.x : null,
        y: num(p.y) ? p.y : null,
        width: num(p.width) ? p.width : null,
        height: num(p.height) ? p.height : null,
        view: str(p.view, 'chat'),
        condition: e.condition,
      });
    } else if (e.type === 'nav' && (p.via === 'radial' || p.via === 'radial_flick')) {
      picks.push({ visit: visitOf(e), at });
    }
  }
  const byTime = <T extends { visit: string; at: number }>(a: T, b: T) => a.visit.localeCompare(b.visit) || a.at - b.at;
  clicks.sort((a, b) => byTime(a, b) || a.seq - b.seq);
  hovers.sort(byTime);
  picks.sort(byTime);
  return { clicks, hovers, picks };
}

export interface Chain {
  from: ClickPoint;
  to: ClickPoint;
  ms: number;
}

/**
 * Pairs of clicks that follow each other in one visit within `maxMs` (the later one's `sincePrev`,
 * which the browser measured; null past 10 s). `noTyping`: leave out pairs with typing between.
 */
export function chains(clicks: readonly ClickPoint[], maxMs: number, noTyping = false): Chain[] {
  const out: Chain[] = [];
  for (let i = 1; i < clicks.length; i++) {
    const [from, to] = [clicks[i - 1], clicks[i]];
    if (from.visit !== to.visit || to.sincePrev === null || to.sincePrev > maxMs || (noTyping && to.typed)) continue;
    out.push({ from, to, ms: to.sincePrev });
  }
  return out;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface Transition {
  from: string;
  to: string;
  count: number;
  /** Median ms between the two clicks. */
  median: number;
}

/** How people move between parts of the page: region → region, most frequent first. */
export function transitions(cs: readonly Chain[]): Transition[] {
  const groups = new Map<string, { from: string; to: string; ms: number[] }>();
  for (const c of cs) {
    const key = `${c.from.region}\u0000${c.to.region}`;
    const g = groups.get(key) ?? { from: c.from.region, to: c.to.region, ms: [] };
    g.ms.push(c.ms);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ from: g.from, to: g.to, count: g.ms.length, median: median(g.ms) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.median - b.median);
}

export interface HoverStat {
  name: string;
  count: number;
  median: number;
  total: number;
  /** Share of hovers with a click while the pointer was there (0..1). */
  clicked: number;
}

/** Per hover-driven place: how often, how long, and how often a click followed while there. */
export function hoverStats(hovers: readonly HoverPoint[], clicks: readonly ClickPoint[]): HoverStat[] {
  const byVisit = new Map<string, number[]>();
  for (const c of clicks) byVisit.set(c.visit, [...(byVisit.get(c.visit) ?? []), c.at]);
  const groups = new Map<string, { ms: number[]; clicked: number }>();
  for (const h of hovers) {
    const g = groups.get(h.name) ?? { ms: [], clicked: 0 };
    g.ms.push(h.ms);
    if ((byVisit.get(h.visit) ?? []).some((at) => at >= h.at - h.ms && at <= h.at)) g.clicked++;
    groups.set(h.name, g);
  }
  return [...groups]
    .map(([name, g]) => ({ name, count: g.ms.length, median: median(g.ms) ?? 0, total: g.ms.reduce((a, b) => a + b, 0), clicked: g.clicked / g.ms.length }))
    .sort((a, b) => b.total - a.total);
}

export interface RadialStat {
  option: string;
  /** Times the menu pointed at it. */
  pointed: number;
  median: number;
  /** Times it was the option the menu was let go on (a `nav` via the radial menu right after). */
  chosen: number;
}

/** A radial choice is logged this soon after the last option's hover ends. */
export const PICK_MS = 500;

/** Per radial option: how often and how long it was pointed at, and how often it was chosen. */
export function radialStats(hovers: readonly HoverPoint[], picks: readonly RadialPick[]): RadialStat[] {
  const radial = hovers.filter((h): h is HoverPoint & { item: string } => h.name === 'radial' && h.item !== null);
  const stats = new Map<string, { ms: number[]; chosen: number }>();
  for (const h of radial) {
    const s = stats.get(h.item) ?? { ms: [], chosen: 0 };
    s.ms.push(h.ms);
    stats.set(h.item, s);
  }
  // Each choice goes to the last option pointed at before it (the menu closes on the choice, which ends that hover).
  for (const p of picks) {
    let last: (typeof radial)[number] | undefined;
    for (const h of radial) if (h.visit === p.visit && h.at <= p.at && p.at - h.at <= PICK_MS && (!last || h.at >= last.at)) last = h;
    if (last) stats.get(last.item)!.chosen++;
  }
  return [...stats]
    .map(([option, s]) => ({ option, pointed: s.ms.length, median: median(s.ms) ?? 0, chosen: s.chosen }))
    .sort((a, b) => b.pointed - a.pointed);
}

export interface Size {
  width: number;
  height: number;
}

const STEP = 50;
/** A point is drawn when its window is within this share of the reference size, in each direction. */
export const SIZE_TOLERANCE = 0.15;
const round = (n: number) => Math.round(n / STEP) * STEP;

/** The window size most points were recorded in (rounded to 50 px): the drawing's frame. */
export function reference(sizes: readonly Size[]): Size | null {
  const counts = new Map<string, { size: Size; n: number }>();
  for (const s of sizes) {
    const size = { width: round(s.width), height: round(s.height) };
    const key = `${size.width}x${size.height}`;
    counts.set(key, { size, n: (counts.get(key)?.n ?? 0) + 1 });
  }
  let best: { size: Size; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.size ?? null;
}

/** Was this point recorded in a window close enough to `ref` to be drawn in it? */
export const fits = (s: Size, ref: Size) =>
  Math.abs(s.width - ref.width) <= ref.width * SIZE_TOLERANCE && Math.abs(s.height - ref.height) <= ref.height * SIZE_TOLERANCE;
