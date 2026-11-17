import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, attempt, concept, tree } from '../test/build';
import { testStore } from '../test/harness';
import { memoryStorage } from '../test/storage';
import { ApiError } from './api';
import type { Conversation, Message } from './domain';
import type { DomainState } from './state';
import { backoff, changedRows, MAX_ROWS, SYNC_KEY, SyncQueue, watchPage, type Row, type SyncBody } from './sync';

const domain = (d: Partial<DomainState> = {}): DomainState => ({ conversations: {}, messagesByConv: {}, concepts: {}, edges: [], trees: [], attempts: [], ...d });
const chat = (id: string, extra: Partial<Conversation> = {}): Conversation => ({ id, title: id, subjectId: null, studyMode: false, createdAt: at(0), updatedAt: at(0), ...extra });
const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: 'user', text: id, conceptIds: [], conversationId: 'c1', createdAt: at(1), ...extra });
const kinds = (rows: Row[]) => rows.map((r) => `${r.kind}:${r.data.id}`).sort();

describe('changedRows: what a state change saves', () => {
  it('new and replaced entities of every kind, found by reference', () => {
    const c1 = concept('c1', null, 'subject');
    const t1 = tree('t1', 'c1');
    const a1 = attempt('c1', { id: 'a1', conv: 'c1' });
    const m1 = msg('m1');
    const prev = domain({ concepts: { c1 }, trees: [t1], attempts: [a1], conversations: { c1: chat('c1') }, messagesByConv: { c1: [m1] } });
    expect(changedRows(prev, prev, at(9))).toEqual([]);

    const next = domain({
      concepts: { c1, c2: concept('c2', 'c1') },
      edges: [{ id: 'e1', fromId: 'c1', toId: 'c2', kind: 'related', createdAt: at(2) }],
      trees: [{ ...t1, title: 'renamed' }],
      attempts: [{ ...a1, supersededBy: 'a2' }, attempt('c2', { id: 'a2', conv: 'c1' })],
      conversations: { c1: chat('c1', { subjectId: 'c1' }) },
      messagesByConv: { c1: [m1, msg('m2')] },
    });
    expect(kinds(changedRows(prev, next, at(9)))).toEqual(['attempts:a1', 'attempts:a2', 'concepts:c2', 'conversations:c1', 'edges:e1', 'messages:m2', 'trees:t1']);
  });

  it('skips a message while it streams and a failed reply, and sends the reply once it is done', () => {
    const user = msg('u');
    const streaming = msg('r', { role: 'assistant', text: 'Hal', streaming: true });
    const prev = domain({ conversations: { c1: chat('c1') }, messagesByConv: { c1: [user] } });
    const during = domain({ ...prev, messagesByConv: { c1: [user, streaming] } });
    expect(changedRows(prev, during, at(9))).toEqual([]);
    const more = domain({ ...prev, messagesByConv: { c1: [user, { ...streaming, text: 'Hallo' }] } });
    expect(changedRows(during, more, at(9))).toEqual([]);
    const failed = domain({ ...prev, messagesByConv: { c1: [user, { ...streaming, streaming: false, error: 'boom' }] } });
    expect(changedRows(more, failed, at(9))).toEqual([]);
    const done = domain({ ...prev, messagesByConv: { c1: [user, { ...streaming, text: 'Hallo!', streaming: false }] } });
    const rows = changedRows(more, done, at(9));
    expect(rows).toEqual([{ kind: 'messages', data: { ...streaming, text: 'Hallo!' } }].map((r) => ({ ...r, data: (({ streaming: _, ...m }) => m)(r.data) })));
    expect('streaming' in rows[0].data).toBe(false);
  });

  it('a tree the planner removed is sent once more with deletedAt (and a newer updatedAt)', () => {
    const t1 = tree('t1', 'c1');
    const rows = changedRows(domain({ trees: [t1, tree('t2', 'c2')] }), domain({ trees: [tree('t2', 'c2')].map((t) => t) }), at(9));
    expect(rows).toContainEqual({ kind: 'trees', data: { ...t1, updatedAt: at(9), deletedAt: at(9) } });
  });

  it('a concept with deletedAt is saved like any other change', () => {
    const c = concept('c1', null);
    const gone = { ...c, deletedAt: at(5), updatedAt: at(5) };
    expect(changedRows(domain({ concepts: { c1: c } }), domain({ concepts: { c1: gone } }), at(9))).toEqual([{ kind: 'concepts', data: gone }]);
  });

  it('a chat is saved from its first message on, not while it is empty', () => {
    const empty = domain({ conversations: { c1: chat('c1') }, messagesByConv: { c1: [] } });
    expect(changedRows(domain(), empty, at(9))).toEqual([]);
    const renamed = domain({ ...empty, conversations: { c1: chat('c1', { title: 'mine' }) } });
    expect(changedRows(empty, renamed, at(9))).toEqual([]);
    // Its first message brings it along, even if the chat object itself did not change.
    const first = domain({ ...renamed, messagesByConv: { c1: [msg('m1')] } });
    expect(kinds(changedRows(renamed, first, at(9)))).toEqual(['conversations:c1', 'messages:m1']);
    // A chat whose messages are not loaded (yet) is on the server already: a rename is saved.
    const unloaded = domain({ conversations: { c2: chat('c2') } });
    expect(kinds(changedRows(unloaded, domain({ conversations: { c2: chat('c2', { title: 'x' }) } }), at(9)))).toEqual(['conversations:c2']);
  });

  it('a whole scripted turn: no row while streaming, then the messages, attempts and the chat', async () => {
    const s = testStore();
    const perAction: { type: string; rows: Row[] }[] = [];
    const dispatch = s.deps.dispatch;
    s.deps.dispatch = (a) => {
      const before = s.state.domain;
      dispatch(a);
      perAction.push({ type: a.type, rows: changedRows(before, s.state.domain, at(9)) });
    };
    await s.send('Write me a summary of backpropagation for my exam');
    expect(perAction.filter((p) => p.type === 'stream').every((p) => p.rows.length === 0)).toBe(true);
    const all = perAction.flatMap((p) => p.rows);
    expect(all.some((r) => r.kind === 'messages' && (r.data as Message).streaming)).toBe(false);
    const [user, reply] = s.messages().slice(-2);
    expect(all.filter((r) => r.data.id === user.id).length).toBeGreaterThanOrEqual(1);
    expect(all.filter((r) => r.data.id === reply.id).length).toBeGreaterThanOrEqual(1);
    expect(all.some((r) => r.kind === 'attempts' && (r.data as { messageId: string }).messageId === user.id)).toBe(true);
    expect(all.some((r) => r.kind === 'conversations')).toBe(true);
    // The last copy of each message is the final one.
    const last = new Map(all.map((r) => [r.data.id, r.data]));
    expect(last.get(user.id)).toEqual(user);
    expect(last.get(reply.id)).toEqual((({ streaming: _, ...m }) => m)(reply));
  });
});

/* ───────────── The queue ───────────── */

const row = (id: string, kind: Row['kind'] = 'concepts'): Row => ({ kind, data: { ...concept(id, null), id } } as Row);
const rows = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`));
const count = (b: SyncBody) => Object.values(b).reduce((n, l) => n + (l?.length ?? 0), 0);

function setup(answer: (body: SyncBody, n: number) => Promise<unknown> = async () => ({ ok: true }), storage = memoryStorage()) {
  const sent: { body: SyncBody; keepalive: boolean }[] = [];
  const onReject = vi.fn();
  const q = new SyncQueue({
    storage,
    onReject,
    send: (body, { keepalive }) => {
      sent.push({ body, keepalive });
      return answer(body, sent.length);
    },
  });
  return { q, sent, onReject, storage };
}

describe('SyncQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits a moment so a burst of changes goes out in one request; a newer row replaces a queued one', async () => {
    const { q, sent } = setup();
    q.start();
    q.add([row('a')]);
    q.add([row('b'), { kind: 'concepts', data: { ...concept('a', null), label: 'newer' } }]);
    await vi.advanceTimersByTimeAsync(700);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.concepts!.map((c) => [c.id, c.label])).toEqual([
      ['a', 'newer'],
      ['b', 'b'],
    ]);
    expect(q.status()).toMatchObject({ pending: 0, error: null });
  });

  it('sends at once when a turn ends', async () => {
    const { q, sent } = setup();
    q.start();
    q.add([row('a')], { urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
  });

  it('splits a backlog into requests of at most 500 rows', async () => {
    const { q, sent } = setup();
    q.add(rows(1200));
    q.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => count(s.body))).toEqual([MAX_ROWS, MAX_ROWS, 200]);
    expect(q.status().pending).toBe(0);
  });

  it('a 413 halves the batch and tries again at once', async () => {
    const { q, sent } = setup(async (b) => {
      if (count(b) > 2) throw new ApiError(413, 'too_many_rows', 'split it');
      return { ok: true };
    });
    q.add(rows(4));
    q.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => count(s.body))).toEqual([4, 2, 2]);
    expect(q.status().pending).toBe(0);
  });

  it('retries network errors, 5xx and 401 with backoff and keeps the rows meanwhile', async () => {
    const failures = [new ApiError(0, 'network', 'offline'), new ApiError(503, 'http_error', 'HTTP 503'), new ApiError(401, 'unauthorized', 'who')];
    const { q, sent } = setup(async (_, n) => {
      if (n <= failures.length) throw failures[n - 1];
      return { ok: true };
    });
    q.add([row('a')]);
    q.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(q.status()).toMatchObject({ pending: 1, offline: true, rejected: 0 });
    // New changes while backing off wait for the retry instead of hammering the backend.
    q.add([row('b')]);
    await vi.advanceTimersByTimeAsync(backoff(0) - 1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    expect(q.status()).toMatchObject({ offline: false, error: 'HTTP 503' });
    await vi.advanceTimersByTimeAsync(backoff(1));
    expect(sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(backoff(2));
    expect(sent).toHaveLength(4);
    expect(count(sent[3].body)).toBe(2);
    expect(q.status()).toEqual({ pending: 0, rejected: 0, offline: false, error: null });
    expect([backoff(0), backoff(1), backoff(2), backoff(10)]).toEqual([1000, 2000, 4000, 30_000]);
  });

  it('a 4xx is a bug: the batch is kept and reported, not retried, and later rows still go out', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { q, sent, onReject, storage } = setup(async (_, n) => {
      if (n === 1) throw new ApiError(422, 'invalid_request', 'concepts.0.kind: bad');
      return { ok: true };
    });
    q.add([row('bad')]);
    q.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onReject).toHaveBeenCalledWith('1 change not saved: concepts.0.kind: bad');
    expect(error).toHaveBeenCalled();
    expect(q.status()).toMatchObject({ pending: 1, rejected: 1, error: '1 change not saved: concepts.0.kind: bad' });
    expect(JSON.parse(storage.getItem(SYNC_KEY)!)).toHaveLength(1);

    q.add([row('good')]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.map((s) => s.body.concepts!.map((c) => c.id))).toEqual([['bad'], ['good']]);
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(2);
    expect(q.status()).toMatchObject({ pending: 1, rejected: 1 });
  });

  it('survives a reload: the mirror holds the queue, and the next start sends it', async () => {
    const storage = memoryStorage();
    const first = setup(undefined, storage);
    first.q.add([row('a'), row('m1', 'messages')]); // the page goes away before it was started or sent
    expect(first.sent).toEqual([]);

    const second = setup(undefined, storage);
    expect(second.q.rows()).toEqual(first.q.rows());
    expect(second.q.status().pending).toBe(2);
    second.q.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.sent).toHaveLength(1);
    expect(storage.getItem(SYNC_KEY)).toBeNull();
  });

  it('a row that changes while its request is on the way stays queued in its newer form', async () => {
    let release!: () => void;
    const { q, sent } = setup((_, n) => (n === 1 ? new Promise((r) => (release = () => r({ ok: true }))) : Promise.resolve({ ok: true })));
    q.add([row('a')]);
    q.start();
    await vi.advanceTimersByTimeAsync(0);
    q.add([{ kind: 'concepts', data: { ...concept('a', null), label: 'v2' } }]);
    expect(q.rows().map((r) => (r.data as { label: string }).label)).toEqual(['v2']);
    release();
    await vi.advanceTimersByTimeAsync(0);
    // The answer for the old copy does not remove the new one: it goes out next.
    expect(sent.map((s) => s.body.concepts![0].label)).toEqual(['a', 'v2']);
    expect(q.status().pending).toBe(0);
  });

  it('sends nothing until started, and nothing after stop (demo mode)', async () => {
    const { q, sent } = setup();
    q.add([row('a')], { urgent: true });
    await q.flush();
    await vi.runAllTimersAsync();
    q.start();
    q.stop();
    q.add([row('b')], { urgent: true });
    q.hide();
    await vi.runAllTimersAsync();
    expect(sent).toEqual([]);
    expect(q.status().pending).toBe(2);
  });

  it('page events: back online sends at once; hidden or closed sends with keepalive', async () => {
    const { q, sent } = setup(async (_, n) => {
      if (n === 1) throw new ApiError(0, 'network', 'offline');
      return { ok: true };
    });
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const onOnline = vi.fn();
    const off = watchPage(q, { win, doc }, onOnline);
    q.add([row('a')]);
    q.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(q.status().offline).toBe(true);
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onOnline).toHaveBeenCalled();
    expect(sent).toHaveLength(2);
    expect(q.status().pending).toBe(0);

    q.add([row('b')]);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)).toMatchObject({ keepalive: true });
    q.add([row('c')]);
    win.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)).toMatchObject({ keepalive: true, body: { concepts: [expect.objectContaining({ id: 'c' })] } });

    off();
    q.add([row('d')]);
    win.dispatchEvent(new Event('pagehide'));
    expect(sent).toHaveLength(4);
  });
});
