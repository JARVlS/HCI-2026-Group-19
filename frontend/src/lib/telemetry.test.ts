import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/storage';
import { ApiError } from './api';
import { backoff } from './sync';
import { DEBOUNCE_MS, EVENTS_KEY, EventLog, fingerprint, KEEPALIVE_BYTES, MAX_BATCH, type EventLogOptions, type EventsBody } from './telemetry';

/** The usage log's queue (IMPLEMENTATION_PLAN.md M6, "Event log"): batching, retries, the mirror, the cap, keepalive, refusals, users. */

const page = { type: 'page_visible', payload: {} } as const;

function setup({ owner = 'user-a', ...opts }: Partial<Omit<EventLogOptions, 'owner'>> & { owner?: string | null } = {}) {
  const storage = opts.storage ?? memoryStorage();
  const sent: { body: EventsBody; keepalive: boolean }[] = [];
  const send = vi.fn(async (body: EventsBody, { keepalive }: { keepalive: boolean }) => {
    sent.push({ body, keepalive });
    return { ok: true };
  });
  const onReject = vi.fn();
  const who = { owner };
  const log = new EventLog({ storage, send, onReject, owner: () => who.owner, context: () => ({ design: 'ascii', conversationId: 'chat-1' }), ...opts });
  const types = () => sent.flatMap((s) => s.body.events.map((e) => e.type));
  const mirror = () => JSON.parse(storage.getItem(EVENTS_KEY) ?? 'null');
  return { log, storage, sent, send, onReject, who, types, mirror };
}

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('event log: sending', () => {
  it('goes out DEBOUNCE_MS after the first event waiting, with an id, the client time, the envelope and the open chat', async () => {
    const t = setup();
    t.log.start();
    t.log.record({ type: 'view_start', payload: { view: 'tree' } });
    await wait(DEBOUNCE_MS - 1000);
    t.log.record({ type: 'chat_rename', conversationId: 'chat-9', payload: {} }); // does not push the send back
    await wait(999);
    expect(t.sent).toEqual([]);
    await wait(1);
    expect(t.sent).toHaveLength(1);
    const [a, b] = t.sent[0].body.events;
    expect(a).toEqual({ id: expect.any(String), type: 'view_start', payload: { view: 'tree', visit: expect.any(String), seq: 1, design: 'ascii' }, clientTs: '2026-11-20T10:00:00.000Z', conversationId: 'chat-1' });
    expect(b).toMatchObject({ type: 'chat_rename', payload: { visit: a.payload.visit, seq: 2 }, conversationId: 'chat-9' });
    expect(a.id).not.toBe(b.id);
    expect(t.sent[0].keepalive).toBe(false);
    expect(t.storage.getItem(EVENTS_KEY)).toBeNull(); // sent: the mirror is empty
  });

  it(`sends at most ${MAX_BATCH} events per request, in order`, async () => {
    const t = setup();
    t.log.start();
    for (let i = 0; i < 450; i++) t.log.record(page);
    await wait(DEBOUNCE_MS);
    expect(t.sent.map((s) => s.body.events.length)).toEqual([200, 200, 50]);
    expect(t.sent.flatMap((s) => s.body.events.map((e) => e.payload.seq))).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
  });

  it('network errors, 401, 429 and 5xx are tried again with backoff, silently, and nothing is lost', async () => {
    const t = setup();
    const failures = [new ApiError(0, 'network', 'offline'), new ApiError(401, 'unauthorized', 'x'), new ApiError(429, 'budget_exceeded', 'x'), new ApiError(503, 'internal_error', 'x')];
    t.send.mockImplementation(async (body, { keepalive }) => {
      t.sent.push({ body, keepalive });
      const f = failures.shift();
      if (f) throw f;
      return { ok: true };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    t.log.start();
    t.log.record(page);
    await wait(DEBOUNCE_MS);
    expect(t.sent).toHaveLength(1);
    expect(t.mirror().events).toHaveLength(1);
    for (let n = 0; n < 4; n++) await wait(backoff(n));
    expect(t.sent).toHaveLength(5);
    expect(t.log.pending()).toEqual([]);
    expect(t.onReject).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('a refusal (4xx) is a bug: those events are dropped, the console says why, and one toast per visit', async () => {
    const t = setup();
    t.send.mockRejectedValue(new ApiError(422, 'invalid_request', 'events.0.clientTs: needs a zone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.log.start();
    t.log.record(page);
    await wait(DEBOUNCE_MS);
    expect(t.log.pending()).toEqual([]);
    expect(t.storage.getItem(EVENTS_KEY)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('1 events refused and dropped: events.0.clientTs: needs a zone'), expect.any(ApiError));
    expect(t.onReject).toHaveBeenCalledWith('usage log not saved: events.0.clientTs: needs a zone');
    t.log.record(page);
    await wait(DEBOUNCE_MS);
    expect(error).toHaveBeenCalledTimes(2);
    expect(t.onReject).toHaveBeenCalledTimes(1);
  });

  it('stopped (the demo): records stay in the mirror and nothing is sent until it starts', async () => {
    const t = setup();
    t.log.record(page);
    await wait(60_000);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.mirror().events).toHaveLength(1);
    t.log.start();
    t.log.stop();
    await wait(60_000);
    expect(t.send).not.toHaveBeenCalled();
    t.log.start();
    await wait(DEBOUNCE_MS);
    expect(t.types()).toEqual(['page_visible']);
  });

  it('hidden or closed: what is left goes out at once with keepalive, within its budget; the rest follows', async () => {
    const t = setup();
    t.log.start();
    for (let i = 0; i < 60; i++) t.log.record({ type: 'pane_action', payload: { kind: 'rest_on_leaf', view: 'tree', conceptId: crypto.randomUUID(), days: 0 } });
    t.log.hide();
    await wait(0);
    expect(t.sent.length).toBeGreaterThan(1);
    expect(t.sent[0].keepalive).toBe(true);
    expect(JSON.stringify(t.sent[0].body).length).toBeLessThanOrEqual(KEEPALIVE_BYTES);
    expect(t.sent.slice(1).every((s) => !s.keepalive)).toBe(true);
    expect(t.sent.reduce((n, s) => n + s.body.events.length, 0)).toBe(60);
  });

  it('back online (flush): sends at once, without waiting for the backoff', async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new ApiError(0, 'network', 'offline'));
    t.log.start();
    t.log.record(page);
    await wait(DEBOUNCE_MS);
    await t.log.flush();
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(t.log.pending()).toEqual([]);
  });
});

describe('event log: the mirror', () => {
  it('a reload sends what the last visit left (same user)', async () => {
    const first = setup();
    first.log.record(page);
    first.log.record(page);
    expect(first.mirror()).toMatchObject({ owner: 'user-a', events: [{ type: 'page_visible' }, { type: 'page_visible' }] });
    const second = setup({ storage: first.storage });
    second.log.start();
    await wait(DEBOUNCE_MS);
    expect(second.types()).toEqual(['page_visible', 'page_visible']);
  });

  it('full: the oldest go, events_dropped says how many, and the console warns', () => {
    const t = setup({ cap: 10 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 11; i++) t.log.record(page);
    const left = t.log.pending();
    expect(left).toHaveLength(10);
    expect(left[0].payload.seq).toBe(3);
    expect(left.at(-1)).toMatchObject({ type: 'events_dropped', payload: { count: 2 } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the 2 oldest events were dropped'));
    expect(t.mirror().events).toHaveLength(10);
  });

  it('a broken mirror is ignored and said so', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup({ storage: memoryStorage({ [EVENTS_KEY]: '{not json' }) });
    expect(t.log.pending()).toEqual([]);
    expect(error).toHaveBeenCalled();
  });

  it('never throws into the app, even when the context fails', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup({
      context: () => {
        throw new Error('boom');
      },
    });
    expect(() => t.log.record(page)).not.toThrow();
    expect(error).toHaveBeenCalled();
  });
});

describe('event log: one user’s events never go out under another user’s token', () => {
  it('a page signed in as someone else discards the mirror (logged out, then another user)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = setup({ owner: 'user-a' });
    a.log.record(page);
    const b = setup({ storage: a.storage, owner: 'user-b' });
    b.log.start();
    await wait(60_000);
    expect(b.send).not.toHaveBeenCalled();
    expect(b.storage.getItem(EVENTS_KEY)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 events queued on this browser by another user were discarded'));
  });

  it('the page that switches keeps stamping its own user, even after the new token is stored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = setup({ owner: 'user-a' });
    a.log.record(page);
    a.who.owner = 'user-b'; // login wrote the new token, the page is about to reload
    a.log.record({ type: 'page_hidden', payload: {} });
    expect(a.mirror().owner).toBe('user-a');
    const b = setup({ storage: a.storage, owner: 'user-b' });
    b.log.start();
    await wait(DEBOUNCE_MS);
    expect(b.send).not.toHaveBeenCalled();
  });

  it('a first visit: events before the session exists belong to the session it gets', async () => {
    const first = setup({ owner: null });
    first.log.record(page); // before the session
    first.who.owner = 'guest';
    first.log.record(page);
    expect(first.mirror().owner).toBe('guest');
    const second = setup({ storage: first.storage, owner: 'guest' });
    second.log.start();
    await wait(DEBOUNCE_MS);
    expect(second.types()).toEqual(['page_visible', 'page_visible']);
  });

  it('fingerprint: tells tokens apart, stable, and never the token itself', () => {
    expect(fingerprint(null)).toBeNull();
    expect(fingerprint('tok-123')).toBe(fingerprint('tok-123'));
    expect(fingerprint('tok-123')).not.toBe(fingerprint('tok-124'));
    expect(fingerprint('tok-123')).not.toContain('tok');
  });
});
