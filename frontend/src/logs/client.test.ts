import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeBackend, json } from '../test/backend';
import { adminGet, EVENTS_PAGE, loadAll, tableCsv, visitEvents, visitsPage } from './client';
import type { AdminVisit } from './visit';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const visit = (fields: Partial<AdminVisit> = {}): AdminVisit => ({
  visit: 'v1',
  userId: 'u1',
  participantId: null,
  condition: null,
  username: null,
  design: 'ascii',
  first: '',
  last: '',
  lastServerTs: '',
  events: 3,
  turns: 0,
  ...fields,
});
const event = (id: string) => ({ id, userId: 'u1', condition: null, type: 'turn_sent', payload: {}, clientTs: '', serverTs: '' });

describe('admin calls', () => {
  it('send the token as X-Admin-Token, never as Authorization or in the url', async () => {
    const calls = fakeBackend(() => json({ visits: [], next: null }));
    await visitsPage('secret-token', null);
    expect(calls).toMatchObject([{ path: '/api/admin/visits?limit=100', admin: 'secret-token', auth: null }]);
    expect(calls[0].path).not.toContain('secret');
  });

  it('a wrong token is a 403 with the backend message', async () => {
    fakeBackend(() => apiError(403, 'forbidden', 'Missing or wrong X-Admin-Token header.'));
    await expect(visitsPage('nope', null)).rejects.toMatchObject({ name: 'ApiError', status: 403, code: 'forbidden', message: 'Missing or wrong X-Admin-Token header.' });
  });

  it('no answer is a network error, a build without a backend fails before calling', async () => {
    fakeBackend(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(adminGet('/api/admin/visits', 't')).rejects.toMatchObject({ status: 0, code: 'network', message: 'Could not reach the backend (Failed to fetch).' });
    const calls = fakeBackend(() => json({}));
    vi.stubEnv('VITE_API_URL', '');
    await expect(adminGet('/api/admin/visits', 't')).rejects.toMatchObject({ code: 'no_backend' });
    expect(calls).toEqual([]);
  });

  it('the cursor of the page before goes along', async () => {
    const calls = fakeBackend(() => json({ visits: [visit()], next: 'c2' }));
    expect(await visitsPage('t', 'c1')).toEqual({ items: [visit()], next: 'c2' });
    expect(calls[0].path).toBe('/api/admin/visits?limit=100&before=c1');
  });

  it('a csv table comes as a blob', async () => {
    const calls = fakeBackend(() => new Response('id,user_id\n', { headers: { 'content-type': 'text/csv' } }));
    expect(await (await tableCsv('t', 'events')).text()).toBe('id,user_id\n');
    expect(calls[0]).toMatchObject({ path: '/api/admin/export?table=events', admin: 't' });
  });
});

describe('loading a visit page by page', () => {
  it('follows the cursor until it is null, counting as it goes', async () => {
    const pages: Record<string, { events: ReturnType<typeof event>[]; next: string | null }> = {
      '': { events: [event('a'), event('b')], next: 'c1' },
      c1: { events: [event('c')], next: 'c2' },
      c2: { events: [], next: null },
    };
    const calls = fakeBackend((call) => json(pages[new URL(call.path, 'http://x').searchParams.get('after') ?? '']));
    const counts: number[] = [];
    const events = await visitEvents('t', visit(), (n) => counts.push(n));
    expect(events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(counts).toEqual([2, 3, 3]);
    expect(calls.map((c) => c.path)).toEqual([
      `/api/admin/events?visit=v1&userId=u1&limit=${EVENTS_PAGE}`,
      `/api/admin/events?visit=v1&userId=u1&limit=${EVENTS_PAGE}&after=c1`,
      `/api/admin/events?visit=v1&userId=u1&limit=${EVENTS_PAGE}&after=c2`,
    ]);
  });

  it('a visit without an id asks for the user events without one (visit=)', async () => {
    const calls = fakeBackend(() => json({ events: [], next: null }));
    await visitEvents('t', visit({ visit: null }), () => {});
    expect(calls[0].path).toBe(`/api/admin/events?visit=&userId=u1&limit=${EVENTS_PAGE}`);
  });

  it('a failed page fails the whole load, loudly', async () => {
    let n = 0;
    fakeBackend(() => (n++ === 0 ? json({ events: [event('a')], next: 'c1' }) : apiError(500, 'internal_error', 'Internal server error.')));
    await expect(visitEvents('t', visit(), () => {})).rejects.toMatchObject({ status: 500, message: 'Internal server error.' });
  });

  it('a cursor that does not move is an error, not an endless loop', async () => {
    await expect(loadAll(async () => ({ items: [1], next: 'same' }))).rejects.toThrow('same cursor twice');
  });
});
