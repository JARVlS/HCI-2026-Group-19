import { describe, expect, it } from 'vitest';
import { GROUPS, type Group } from './legend';
import { browserOf, clock, duration, facts, haystackOf, inOrder, localTime, matchesUser, paneTime, passes, who, type AdminEvent, type AdminVisit, type Filter } from './visit';

const T0 = Date.parse('2026-11-21T10:00:00.000Z');
let n = 0;
/** An event `s` seconds into the visit, with the next seq. */
const at = (s: number, type: string, payload: Record<string, unknown> = {}): AdminEvent => {
  n += 1;
  return { id: `e${n}`, userId: 'u1', condition: 'A', type, payload: { visit: 'v1', seq: n, design: 'ascii', ...payload }, clientTs: new Date(T0 + s * 1000).toISOString(), serverTs: '' };
};
const start = (search = '', s = 0) => at(s, 'session_start', { search, userAgent: 'x', width: 1400, height: 900 });

const visit = (fields: Partial<AdminVisit> = {}): AdminVisit => ({
  visit: 'v1',
  userId: '6b0c1f2e-aaaa-bbbb',
  participantId: null,
  condition: null,
  username: null,
  design: 'ascii',
  first: '2026-11-21T10:00:00.000Z',
  last: '2026-11-21T10:12:30.000Z',
  lastServerTs: '',
  events: 1,
  turns: 0,
  ...fields,
});

describe('times', () => {
  it('clock is mm:ss since the start, minutes past 59', () => {
    expect(clock(0)).toBe('00:00');
    expect(clock(65_400)).toBe('01:05');
    expect(clock(75 * 60_000 + 2000)).toBe('75:02');
    expect(clock(-5)).toBe('00:00');
  });

  it('local time, the same width in every locale', () => {
    expect(localTime(new Date(2026, 10, 21, 18, 7).toISOString())).toBe('sat 21 nov 18:07');
    expect(localTime(new Date(2026, 0, 4, 9, 5).toISOString())).toBe('sun 4 jan 09:05');
  });

  it('duration in words', () => {
    expect(duration(42_000)).toBe('42 s');
    expect(duration(12 * 60_000 + 29_000)).toBe('12 min');
    expect(duration(65 * 60_000)).toBe('1 h 05 min');
  });
});

describe('a visit', () => {
  it('is ordered by seq, then by time for older events without one', () => {
    const a = at(5, 'turn_sent', { seq: 2 });
    const b = at(9, 'compose', { seq: 1 });
    const old1 = { ...at(1, 'nope'), payload: { to: 'x' } };
    const old2 = { ...at(0, 'nope'), payload: { to: 'y' } };
    expect(inOrder([a, old1, b, old2]).map((e) => e.id)).toEqual([b.id, a.id, old2.id, old1.id]);
  });

  it('who: username, else participant, else the start of the user id; guest without an account', () => {
    expect(who(visit({ username: 'leon', participantId: 'P07' }))).toEqual({ name: 'leon', guest: false });
    expect(who(visit({ participantId: 'P07' }))).toEqual({ name: 'P07', guest: true });
    expect(who(visit())).toEqual({ name: '6b0c1f2e', guest: true });
  });

  it('the user filter looks at name, participant and user id', () => {
    const v = visit({ username: 'Leon', participantId: 'P07' });
    expect(['leo', 'p07', '6B0C', ' ', ''].map((q) => matchesUser(v, q))).toEqual([true, true, true, true, true]);
    expect(matchesUser(v, 'jonas')).toBe(false);
  });

  it('browser names', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70';
    const fox = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0';
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
    expect([mac, iphone, edge, fox, android].map(browserOf)).toEqual(['chrome 131 · macos', 'safari 18 · ios', 'edge 131 · windows', 'firefox 133 · linux', 'chrome 131 · android']);
    expect(browserOf('curl/8.5')).toBe('curl/8.5');
  });
});

describe('filters', () => {
  const all = new Set<Group>([...GROUPS, 'other']);
  const f = (patch: Partial<Filter> = {}): Filter => ({ groups: all, type: '', query: '', hideNoise: true, ...patch });
  const show = (e: AdminEvent, filter: Filter) => passes(e, haystackOf(e), filter);
  const sent = at(1, 'turn_sent', { text: 'Grüße an die Rekursion', mode: 'own' });
  const rated = at(2, 'filter_rated', { percent: 40 });
  const view = at(3, 'view_change', { from: 'tree', to: 'outline' });
  const old = { ...at(4, 'nope'), payload: { to: 'forest' } };

  it('hides noise at first, shows it when switched off', () => {
    expect([sent, rated, view, old].map((e) => show(e, f()))).toEqual([true, false, true, true]);
    expect(show(rated, f({ hideNoise: false }))).toBe(true);
  });

  it('groups', () => {
    const writingOff = f({ groups: new Set<Group>(['replies', 'tree pane', 'navigation', 'page', 'other']), hideNoise: false });
    expect([sent, rated, view, old].map((e) => show(e, writingOff))).toEqual([false, false, true, true]);
    expect(show(old, f({ groups: new Set<Group>(['writing']) }))).toBe(false);
  });

  it('a type wins over groups and the noise switch', () => {
    expect(show(rated, f({ type: 'filter_rated', groups: new Set() }))).toBe(true);
    expect(show(sent, f({ type: 'filter_rated' }))).toBe(false);
  });

  it('text search over the type and every payload value, ignoring case', () => {
    expect(show(sent, f({ query: 'rekursion' }))).toBe(true);
    expect(show(sent, f({ query: 'GRÜSSE' }))).toBe(false);
    expect(show(sent, f({ query: 'grüße' }))).toBe(true);
    expect(show(view, f({ query: 'outline' }))).toBe(true);
    expect(show(view, f({ query: 'view_ch' }))).toBe(true);
    expect(show(sent, f({ query: 'forest' }))).toBe(false);
    expect(show(rated, f({ query: 'filter', type: 'filter_rated' }))).toBe(true);
  });
});

describe('time per pane view', () => {
  it('counts tree and outline from event to event', () => {
    const events = [at(0, 'view_start', { view: 'tree' }), start(), at(60, 'view_change', { from: 'tree', to: 'outline' }), at(90, 'page_hidden')];
    expect(paneTime(events)).toEqual({ tree: 60_000, outline: 30_000 });
  });

  it('leaves out hidden, idle, the closed pane and the open forest', () => {
    const events = [
      start(),
      at(0, 'view_start', { view: 'tree' }),
      at(10, 'page_hidden'),
      at(110, 'page_visible'), // 100 s hidden
      at(120, 'idle_start'),
      at(300, 'idle_end', { ms: 240_000 }), // 180 s idle
      at(310, 'panel', { open: false }),
      at(400, 'panel', { open: true }), // 90 s closed
      at(410, 'forest_open'),
      at(500, 'forest_close'), // 90 s forest
      at(520, 'view_change', { from: 'tree', to: 'outline' }),
      at(530, 'page_hidden'),
    ];
    // tree: 0-10, 110-120, 300-310, 400-410, 500-520 = 60 s; outline: 520-530 = 10 s
    expect(paneTime(events)).toEqual({ tree: 60_000, outline: 10_000 });
  });

  it('takes the start state from the url: a closed pane, an open forest', () => {
    expect(paneTime([start('panel=0'), at(0, 'view_start', { view: 'tree' }), at(60, 'panel', { open: true }), at(90, 'page_hidden')])).toEqual({ tree: 30_000, outline: 0 });
    expect(paneTime([start('view=forest&tree=t1'), at(0, 'view_start', { view: 'outline' }), at(60, 'forest_close'), at(70, 'page_hidden')])).toEqual({ tree: 0, outline: 10_000 });
  });

  it('a first page_visible means the tab started hidden', () => {
    expect(paneTime([start(), at(0, 'view_start', { view: 'tree' }), at(50, 'page_visible'), at(80, 'page_hidden')])).toEqual({ tree: 30_000, outline: 0 });
  });

  it('stops with the classic design and starts again with the next view_start', () => {
    const events = [start(), at(0, 'view_start', { view: 'tree' }), at(10, 'setting_changed', { key: 'design', value: 'classic' }), at(50, 'setting_changed', { key: 'design', value: 'ascii' }), at(50, 'view_start', { view: 'outline' }), at(70, 'page_hidden')];
    expect(paneTime(events)).toEqual({ tree: 10_000, outline: 20_000 });
  });

  it('cannot say without view_start or session_start', () => {
    expect(paneTime([start(), at(10, 'turn_sent')])).toBeNull();
    expect(paneTime([at(0, 'view_start', { view: 'tree' }), at(10, 'turn_sent')])).toBeNull();
  });
});

describe('facts', () => {
  it('browser, window and its last size, turns and pane time', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const events = [
      at(0, 'session_start', { userAgent: ua, width: 1400, height: 900, screenWidth: 1512, screenHeight: 982, pixelRatio: 2, touch: false, language: 'de-CH', timeZone: 'Europe/Zurich', provider: 'arbor', theme: 'system', signedIn: false, search: 'provider=arbor', referrer: '' }),
      at(0, 'view_start', { view: 'tree' }),
      at(30, 'turn_sent', { text: 'hi' }),
      at(40, 'resize', { width: 900, height: 800 }),
      at(60, 'view_change', { from: 'tree', to: 'outline' }),
      at(80, 'page_hidden'),
    ];
    expect(Object.fromEntries(facts(events))).toEqual({
      browser: 'chrome 131 · macos',
      window: '1400×900, last 900×800',
      screen: '1512×982 @2x',
      language: 'de-CH · Europe/Zurich',
      answers: 'arbor',
      theme: 'system',
      account: 'guest',
      url: '?provider=arbor',
      turns: '1',
      pane: 'tree 75% · outline 25% of 1 min',
    });
  });

  it('older events: only what they allow', () => {
    expect(facts([{ ...at(0, 'nope'), payload: { to: 'x' } }])).toEqual([['turns', '0']]);
  });
});
