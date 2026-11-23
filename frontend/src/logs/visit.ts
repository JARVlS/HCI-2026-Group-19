import { groupOf, isNoise, type Group } from './legend';

/**
 * The pure parts of the logs page: the shapes of `GET /api/admin/visits` and `/api/admin/events`
 * (backend/docs/api.md), the order of a visit, times, who a visit was, the filters, and what the
 * header of a visit says (browser, window, time per pane view).
 */

export interface AdminVisit {
  /** null: the user's events without a visit (logged before 20 Nov 2026). */
  visit: string | null;
  userId: string;
  participantId: string | null;
  condition: string | null;
  /** null: a guest. */
  username: string | null;
  design: string | null;
  /** Earliest and latest clientTs. */
  first: string;
  last: string;
  lastServerTs: string;
  events: number;
  turns: number;
}

export interface AdminEvent {
  id: string;
  userId: string;
  condition: string | null;
  type: string;
  /** `{ _raw }` when the stored payload is not a JSON object. */
  payload: Record<string, unknown>;
  clientTs: string;
  serverTs: string;
}

export const visitKey = (v: Pick<AdminVisit, 'userId' | 'visit'>) => `${v.userId} ${v.visit ?? ''}`;

const seqOf = (e: AdminEvent) => (typeof e.payload.seq === 'number' ? e.payload.seq : Infinity);

/** A visit's events in the order they happened: by `seq`, then client time (older events have no seq), then id. */
export const inOrder = (events: readonly AdminEvent[]) =>
  [...events].sort((a, b) => seqOf(a) - seqOf(b) || a.clientTs.localeCompare(b.clientTs) || a.id.localeCompare(b.id));

const pad = (n: number) => String(n).padStart(2, '0');

/** mm:ss since the start of the visit (minutes go past 59). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** How long something lasted, in words: `42 s`, `12 min`, `1 h 05 min`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${pad(min % 60)} min`;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A time in the reader's time zone, same width everywhere: `sat 21 nov 18:07`. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const lasted = (v: Pick<AdminVisit, 'first' | 'last'>) => duration(Date.parse(v.last) - Date.parse(v.first));

/** Who the visit was: the username, else the participant id, else the start of the user id. */
export function who(v: Pick<AdminVisit, 'username' | 'participantId' | 'userId'>): { name: string; guest: boolean } {
  return { name: v.username ?? v.participantId ?? v.userId.slice(0, 8), guest: v.username === null };
}

export function matchesUser(v: AdminVisit, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [v.username, v.participantId, v.userId].some((s) => s?.toLowerCase().includes(q));
}

/** A short name for a user agent: `chrome 131 · macos`; the user agent itself if neither is known. */
export function browserOf(ua: string): string {
  const browser = (
    [
      [/Edg\/(\d+)/, 'edge'],
      [/OPR\/(\d+)/, 'opera'],
      [/CriOS\/(\d+)/, 'chrome'],
      [/FxiOS\/(\d+)/, 'firefox'],
      [/Firefox\/(\d+)/, 'firefox'],
      [/Chrome\/(\d+)/, 'chrome'],
      [/Version\/(\d+).*Safari\//, 'safari'],
    ] as const
  ).flatMap(([re, name]) => {
    const m = re.exec(ua);
    return m ? [`${name} ${m[1]}`] : [];
  })[0];
  const system = ([
    [/iPhone|iPad/, 'ios'],
    [/Android/, 'android'],
    [/CrOS/, 'chromeos'],
    [/Mac OS X/, 'macos'],
    [/Windows/, 'windows'],
    [/Linux/, 'linux'],
  ] as const).find(([re]) => re.test(ua))?.[1];
  return browser || system ? [browser, system].filter(Boolean).join(' · ') : ua;
}

/* ---------- filters ---------- */

export interface Filter {
  groups: ReadonlySet<Group>;
  /** One type, or '' for all. A type ignores the groups and the noise switch. */
  type: string;
  query: string;
  hideNoise: boolean;
}

/** What the text search looks through: the type and every value of the payload, lower case. */
export function haystackOf(e: AdminEvent): string {
  const values = Object.values(e.payload).flatMap((v) => (Array.isArray(v) ? v : [v]));
  return [e.type, ...values.map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)))].join('\n').toLowerCase();
}

export function passes(e: AdminEvent, haystack: string, f: Filter): boolean {
  const q = f.query.trim().toLowerCase();
  if (q && !haystack.includes(q)) return false;
  if (f.type) return e.type === f.type;
  return f.groups.has(groupOf(e.type)) && !(f.hideNoise && isNoise(e.type));
}

/* ---------- the header of a visit ---------- */

export type PaneView = 'tree' | 'outline';

/**
 * Milliseconds the knowledge pane was on screen in each view: counted only while the ASCII pane is
 * open, the forest is closed, the tab is visible and the visitor is not idle (between `idle_start`
 * and `idle_end`; idle starts after 60 s without input). Each stretch runs from one event to the
 * next, so time after the visit's last event is not counted. Sheets over the pane are not taken
 * out. null when the log cannot say: no `view_start` (the classic design, older events), or no
 * `session_start`, whose url parameters give the pane's and the forest's state at the start.
 */
export function paneTime(events: readonly AdminEvent[]): Record<PaneView, number> | null {
  const ordered = inOrder(events);
  const start = ordered.find((e) => e.type === 'session_start');
  if (!start || !ordered.some((e) => e.type === 'view_start')) return null;
  const params = new URLSearchParams(typeof start.payload.search === 'string' ? start.payload.search : '');
  let panel = params.get('panel') !== '0';
  let forest = params.get('view') === 'forest';
  // The tab's state at the start is not logged, only its changes: a first `page_visible` means it began hidden.
  let visible = ordered.find((e) => e.type === 'page_hidden' || e.type === 'page_visible')?.type !== 'page_visible';
  let idle = false;
  let view: PaneView | null = null;
  let at: number | null = null;
  const out: Record<PaneView, number> = { tree: 0, outline: 0 };
  const asView = (v: unknown): PaneView | null => (v === 'tree' || v === 'outline' ? v : null);
  for (const e of ordered) {
    const t = Date.parse(e.clientTs);
    if (at !== null && view && panel && !forest && visible && !idle) out[view] += Math.max(0, t - at);
    at = t;
    const p = e.payload;
    if (e.type === 'view_start') view = asView(p.view);
    else if (e.type === 'view_change') view = asView(p.to);
    else if (e.type === 'panel') panel = p.open === true;
    else if (e.type === 'forest_open' || e.type === 'forest_close') forest = e.type === 'forest_open';
    else if (e.type === 'page_hidden' || e.type === 'page_visible') visible = e.type === 'page_visible';
    else if (e.type === 'idle_start' || e.type === 'idle_end') idle = e.type === 'idle_start';
    // The classic design has no pane; switching back to ASCII logs a new `view_start`.
    else if (e.type === 'setting_changed' && p.key === 'design' && p.value !== 'ascii') view = null;
  }
  return out;
}

/** The facts for the header of a visit, as label and value, from its `session_start` and the rest. */
export function facts(events: readonly AdminEvent[]): [string, string][] {
  const ordered = inOrder(events);
  const p = ordered.find((e) => e.type === 'session_start')?.payload ?? {};
  const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
  const size = (w: unknown, h: unknown) => (typeof w === 'number' && typeof h === 'number' ? `${w}×${h}` : null);
  const resizes = ordered.filter((e) => e.type === 'resize');
  const last = resizes.length ? resizes[resizes.length - 1].payload : null;
  const win = size(p.width, p.height);
  const resized = last && size(last.width, last.height);
  const screen = size(p.screenWidth, p.screenHeight);
  const pane = paneTime(ordered);
  const paneMs = pane ? pane.tree + pane.outline : 0;
  const rows: [string, string | null][] = [
    ['browser', str(p.userAgent) && browserOf(p.userAgent as string)],
    ['window', win && (resized && resized !== win ? `${win}, last ${resized}` : win)],
    ['screen', screen && `${screen}${typeof p.pixelRatio === 'number' ? ` @${p.pixelRatio}x` : ''}${p.touch === true ? ' · touch' : ''}`],
    ['language', [str(p.language), str(p.timeZone)].filter(Boolean).join(' · ') || null],
    ['answers', str(p.provider)],
    ['theme', str(p.theme)],
    ['account', p.signedIn === true ? 'signed in' : p.signedIn === false ? 'guest' : null],
    ['url', str(p.search) && `?${p.search}`],
    ['came from', str(p.referrer)],
    ['turns', String(ordered.filter((e) => e.type === 'turn_sent').length)],
    ['pane', pane && (paneMs ? `tree ${Math.round((pane.tree / paneMs) * 100)}% · outline ${Math.round((pane.outline / paneMs) * 100)}% of ${duration(paneMs)}` : 'not on screen')],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== null);
}
