import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScoreInput, ScoreResult } from '../ai/provider';
import { json } from '../test/backend';
import { memoryStorage } from '../test/storage';
import { biologyProvider, fakeServer, serverMessages, testSession } from '../test/server';
import { createApp, PROVIDER_KEY, type AppOptions } from './app';
import { NEW_CHAT_TITLE } from './chats';
import { conversationsOfTree, refsOfConcept, treeOfConcept } from './links';
import { remoteBackend } from './live';
import { activeMessages } from './state';
import { SYNC_KEY } from './sync';

/**
 * The app end to end without React: the modes, the live start, saving and lazy loading, against
 * an in-memory backend behind a fake `fetch` (IMPLEMENTATION_PLAN.md M2 acceptance, at unit level).
 */

let ids = 0;
function app(search: string, storage = memoryStorage(), extra: Partial<AppOptions> = {}) {
  const a = createApp({
    params: new URLSearchParams(search),
    storage,
    backend: remoteBackend(testSession()),
    provider: biologyProvider(),
    page: null,
    newId: () => `id-${++ids}`,
    ...extra,
  });
  return Object.assign(a, { state: () => a.store.getState() });
}

/** Let fetches, turns and the sync debounce run. */
const settle = () => vi.advanceTimersByTimeAsync(2000);

const send = async (a: ReturnType<typeof app>, text: string) => {
  a.send(text);
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T09:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('live mode', () => {
  it('a first visit loads an empty state and gets one new, empty chat; nothing is saved until it has a message', async () => {
    const server = fakeServer();
    const a = app('?provider=arbor');
    expect(a.state().session.boot).toBe('loading');
    a.start();
    await settle();
    const s = a.state();
    expect(s.session.boot).toBe('ready');
    const chats = Object.values(s.domain.conversations);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ title: NEW_CHAT_TITLE, subjectId: null });
    expect(s.domain.messagesByConv[chats[0].id]).toEqual([]);
    expect(s.domain.trees).toEqual([]); // no demo forest in live mode
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/state']);
  });

  it('a turn is saved: the chat (titled from its first message), both messages, the concepts, attempts and tree', async () => {
    const server = fakeServer();
    const a = app('?provider=arbor');
    a.start();
    await settle();
    await send(a, 'I think a vaccine shows the immune system a harmless copy of the germ so it reacts faster');
    const puts = server.calls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBeGreaterThanOrEqual(1);
    const [conv] = [...server.db.conversations.values()];
    expect(conv.title).toBe('I think a vaccine shows the immune system a…');
    expect(serverMessages(server, conv.id as string).map((m) => [m.role, m.analysis ?? null])).toEqual([
      ['user', 'done'],
      ['assistant', null],
    ]);
    expect([...server.db.concepts.values()].map((c) => c.label).sort()).toEqual(['Biology', 'Immunology', 'Vaccines']);
    expect(server.db.attempts.size).toBe(1);
    expect([...server.db.trees.values()].map((t) => t.title)).toEqual(['Immunology']);
    expect(a.queue.status()).toMatchObject({ pending: 0, rejected: 0 });
    expect(JSON.stringify(puts.map((p) => p.body))).not.toContain('"streaming"');
  });

  it('acceptance: two chats on one subject come back after a reload; the tree was grown in both; a leaf jumps into either chat', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const first = app('?provider=arbor', storage);
    first.start();
    await settle();
    await send(first, 'I think vaccines train the immune system');
    const chat1 = first.state().session.activeConversationId;
    first.newChat();
    await send(first, 'Vaccines also need boosters, I guess because memory fades');
    const chat2 = first.state().session.activeConversationId;
    expect(chat2).not.toBe(chat1);

    // Reload: a new app on the same storage.
    server.calls.length = 0;
    const second = app('?provider=arbor', storage);
    second.start();
    await settle();
    const s = second.state();
    expect(Object.keys(s.domain.conversations).sort()).toEqual([chat1, chat2].sort());
    expect(s.session.activeConversationId).toBe(chat2); // the latest chat opens
    expect(activeMessages(s)).toHaveLength(2);
    // Messages load per chat: only the open one so far.
    expect(server.calls.map((c) => c.path)).toEqual(['/api/state', `/api/conversations/${chat2}/messages`]);
    expect(s.domain.messagesByConv[chat1]).toBeUndefined();

    const vaccines = Object.values(s.domain.concepts).find((c) => c.label === 'Vaccines')!;
    const membership = treeOfConcept(s.domain.trees, s.domain.concepts);
    const [tree] = s.domain.trees;
    expect(conversationsOfTree(tree.id, { attempts: s.domain.attempts, membership }).map((g) => g.conversationId).sort()).toEqual([chat1, chat2].sort());
    const refs = refsOfConcept(vaccines.id, s.domain.attempts);
    expect(refs.map((r) => r.conversationId)).toEqual([chat1, chat2]);

    // The leaf's first ref is in the other chat: open it and jump to the message.
    await second.openChat(refs[0].conversationId, refs[0].messageId);
    expect(second.state().session.activeConversationId).toBe(chat1);
    expect(second.state().ui.flash).toMatchObject({ id: refs[0].messageId });
    expect(server.calls.filter((c) => c.path === `/api/conversations/${chat1}/messages`)).toHaveLength(1);
    // …and back into the second chat: its messages are cached for the visit.
    await second.openChat(refs[1].conversationId, refs[1].messageId);
    expect(second.state().ui.flash).toMatchObject({ id: refs[1].messageId });
    expect(server.calls.filter((c) => c.path.endsWith('/messages'))).toHaveLength(2);
  });

  it('offline: changes wait in the mirror, a reload while offline shows an error (no demo data), and back online everything syncs', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const first = app('?provider=arbor', storage, { page: { win, doc } });
    first.start();
    await settle();
    server.offline = true;
    await send(first, 'I think vaccines train the immune system');
    expect(first.queue.status()).toMatchObject({ offline: true });
    expect(JSON.parse(storage.getItem(SYNC_KEY)!).length).toBeGreaterThan(0);
    expect(server.db.messages.size).toBe(0);

    // Reload while still offline.
    const second = app('?provider=arbor', storage, { page: { win, doc } });
    second.start();
    await settle();
    expect(second.state().session.boot).toEqual({ error: expect.stringContaining('Could not reach the backend') });
    expect(second.state().domain.conversations).toEqual({});

    // Back online: the start is tried again, the queue goes out, the turn is there.
    server.offline = false;
    win.dispatchEvent(new Event('online'));
    await settle();
    const s = second.state();
    expect(s.session.boot).toBe('ready');
    expect(activeMessages(s).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(server.db.messages.size).toBe(2);
    expect(storage.getItem(SYNC_KEY)).toBeNull();
  });

  it('queued rows go on top of what loads: a rename not saved yet wins over the server copy', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const first = app('?provider=arbor', storage);
    first.start();
    await settle();
    await send(first, 'I think vaccines train the immune system');
    const chat = first.state().session.activeConversationId;
    server.offline = true;
    first.renameChat('  immune   memory ');
    await settle();
    expect(server.db.conversations.get(chat)!.title).not.toBe('immune memory');

    server.offline = false;
    const second = app('?provider=arbor', storage);
    second.start();
    await settle();
    expect(second.state().domain.conversations[chat].title).toBe('immune memory');
    expect(server.db.conversations.get(chat)!.title).toBe('immune memory'); // and the queue went out
  });

  it('a chat that only exists in the queue loads as empty instead of failing (404 before its first save)', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const first = app('?provider=arbor', storage);
    first.start();
    await settle();
    server.offline = true;
    await send(first, 'I think vaccines train the immune system');
    const chat = first.state().session.activeConversationId;

    server.offline = false;
    // The save fails once more while the reload loads, so the chat is still unknown to the server.
    server.fail.set('/api/sync', [json({ error: { code: 'internal_error', message: 'boom' } }, 500)]);
    const second = app('?provider=arbor', storage);
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    const s = second.state();
    expect(s.session.chatLoad[chat]).toBeUndefined();
    expect(activeMessages(s).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('a chat whose messages fail to load says so and can be retried', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const first = app('?provider=arbor', storage);
    first.start();
    await settle();
    await send(first, 'I think vaccines train the immune system');
    const chat = first.state().session.activeConversationId;

    server.fail.set(`/api/conversations/${chat}/messages`, [json({ error: { code: 'internal_error', message: 'boom' } }, 503)]);
    const second = app('?provider=arbor', storage);
    second.start();
    await settle();
    expect(second.state().session.chatLoad[chat]).toEqual({ error: 'boom' });
    second.send('another message');
    expect(second.state().ui.toast?.text).toBe('this chat is still loading');
    second.retryLoad();
    await settle();
    expect(second.state().session.chatLoad[chat]).toBeUndefined();
    expect(activeMessages(second.state())).toHaveLength(2);
  });

  it('a jump inside the open chat keeps its pane as it is (no reopen)', async () => {
    fakeServer();
    const a = app('?provider=arbor');
    a.start();
    await settle();
    await send(a, 'I think vaccines train the immune system');
    const chat = a.state().session.activeConversationId;
    const [user] = activeMessages(a.state());
    a.dispatch({ type: 'paneTree', id: 'picked-in-the-pane' });
    a.dispatch({ type: 'forest', open: true });
    await a.openChat(chat, user.id);
    expect(a.state().ui).toMatchObject({ paneTreeId: 'picked-in-the-pane', forest: { open: false }, flash: { id: user.id } });
  });

  it('fast scores are saved with the message and come back after a reload; a score on its way is not saved; a reveal scores the guess', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const asked: { input: ScoreInput; answer: (r: ScoreResult) => void }[] = [];
    const provider = { ...biologyProvider(), score: (input: ScoreInput) => new Promise<ScoreResult>((answer) => asked.push({ input, answer })) };
    const a = app('?provider=arbor', storage, { provider });
    a.start();
    await settle();
    a.send('Write me a summary of how vaccines work', undefined, { veil: true });
    await settle();
    const chat = a.state().session.activeConversationId;
    const [user, reply] = activeMessages(a.state());
    // Saved while the score is on its way: without it, so a reload never waits for it forever.
    expect(user.scores).toEqual({ thinking: 'pending' });
    expect(serverMessages(server, chat)[0].scores).toEqual({});

    asked[0].answer({ p: 0.2, model: 'fast' });
    await settle();
    expect(serverMessages(server, chat)[0].scores).toEqual({ thinking: { p: 0.2, model: 'fast' } });

    a.dispatch({ type: 'reveal', id: reply.id, guess: 'it trains memory cells' });
    expect(asked.slice(1).map((x) => x.input.question)).toEqual(['guess', 'correct']);
    asked[1].answer({ p: 0.8 });
    asked[2].answer({ p: 0.9 });
    await settle();

    // Reload: a new app on the same storage.
    const second = app('?provider=arbor', storage, { provider });
    second.start();
    await settle();
    const [loaded] = activeMessages(second.state());
    expect(loaded).toMatchObject({ scores: { thinking: { p: 0.2, model: 'fast' }, guess: { p: 0.8 }, correct: { p: 0.9 } }, classification: { mode: 'own' } });
    expect(second.state().domain.attempts.map((x) => [x.mode, x.independence, x.correctness, x.source])).toEqual([['own', 0.8, 0.9, 'reveal']]);
  });

  it('/title renames the open chat and saves it; an empty chat left behind is dropped', async () => {
    const server = fakeServer();
    const a = app('?provider=arbor');
    a.start();
    await settle();
    await send(a, 'I think vaccines train the immune system');
    const chat = a.state().session.activeConversationId;
    a.renameChat('immunity');
    await settle();
    expect(server.db.conversations.get(chat)!.title).toBe('immunity');

    a.newChat();
    const empty = a.state().session.activeConversationId;
    a.newChat(); // already in an empty chat: no second one
    expect(a.state().session.activeConversationId).toBe(empty);
    await a.openChat(chat);
    expect(a.state().domain.conversations[empty]).toBeUndefined();
    expect(server.db.conversations.size).toBe(1);
  });
});

describe('demo mode', () => {
  it('makes no request at all, also with a saved live choice, queued rows and page events (?demo=1)', async () => {
    const server = fakeServer();
    const queued = [{ kind: 'concepts', data: { id: 'x', label: 'x', slug: 'x', aliases: [], kind: 'subject', parentId: null, createdBy: 'llm', createdAt: 'a', updatedAt: 'a' } }];
    const storage = memoryStorage({ [PROVIDER_KEY]: 'arbor', [SYNC_KEY]: JSON.stringify(queued) });
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const a = app('?demo=1&provider=arbor', storage, { provider: undefined, page: { win, doc } });
    expect(a.state().settings.provider).toBe('scripted');
    a.start();
    expect(a.state().session).toMatchObject({ boot: 'ready', activeConversationId: 'c-nn' });
    await send(a, 'Write me a summary of backpropagation for my exam');
    a.newChat();
    await send(a, 'Quiz me on loss');
    await a.openChat('c-nn');
    a.renameChat('demo');
    win.dispatchEvent(new Event('online'));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.calls).toEqual([]);
    expect(JSON.parse(storage.getItem(SYNC_KEY)!)).toEqual(queued); // kept for the next live visit
  });

  it('is the default without parameters (build default scripted), with the demo world', async () => {
    const server = fakeServer();
    const a = app('', memoryStorage(), { provider: undefined, build: 'scripted' });
    a.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.calls).toEqual([]);
    expect(a.state().domain.trees.length).toBeGreaterThan(1);
  });

  it('past demo chats have no transcript: opening one explains that instead of showing an empty chat', async () => {
    fakeServer();
    const a = app('?demo=1', memoryStorage(), { provider: undefined });
    a.start();
    const past = Object.keys(a.state().domain.conversations).find((id) => id !== 'c-nn')!;
    await a.openChat(past);
    expect(a.state().session.activeConversationId).toBe('c-nn');
    expect(a.state().ui.toast?.text).toMatch(/^demo: past chats have no transcript/);
  });
});

describe('switching the provider switches the world', () => {
  it('scripted → live loads the user’s chats; live → scripted shows the demo and stops saving', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const a = app('', storage, { build: 'scripted' });
    a.start();
    expect(a.state().session.activeConversationId).toBe('c-nn');
    a.dispatch({ type: 'settings', patch: { provider: 'arbor' } });
    expect(storage.getItem(PROVIDER_KEY)).toBe('arbor');
    await settle();
    expect(a.state().domain.trees).toEqual([]);
    expect(server.calls.map((c) => c.path)).toEqual(['/api/state']);

    a.dispatch({ type: 'settings', patch: { provider: 'scripted' } });
    expect(a.state().session.activeConversationId).toBe('c-nn');
    await send(a, 'Quiz me on loss');
    expect(server.calls).toHaveLength(1);
  });
});

describe('first visit (M8)', () => {
  it('the intro opens by itself in the demo, not in live mode (live starts on the open chat)', async () => {
    const { initialState, ONBOARD_KEY } = await import('./app');
    expect(initialState(new URLSearchParams(), memoryStorage(), 'scripted').ui.onboarding).toBe(true);
    expect(initialState(new URLSearchParams(), memoryStorage(), 'arbor').ui.onboarding).toBe(false);
    expect(initialState(new URLSearchParams('intro=1'), memoryStorage(), 'arbor').ui.onboarding).toBe(true);
    expect(initialState(new URLSearchParams(), memoryStorage({ [ONBOARD_KEY]: '1' }), 'scripted').ui.onboarding).toBe(false);
  });
});
