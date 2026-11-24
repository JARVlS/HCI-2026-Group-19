import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biologyProvider, fakeServer, testSession } from '../test/server';
import { memoryStorage } from '../test/storage';
import { signUp } from './account';
import { createApp, type AppOptions } from './app';
import { remoteBackend } from './live';
import { createSession, SESSION_KEY } from './session';
import { DEBOUNCE_MS, EVENTS_KEY } from './telemetry';

/** The usage log through the whole app (createApp, the store observer, the queue, a fake backend). */

const TEXT = 'I think vaccines quietly train lymphocytes to remember pathogens';

function pageEvents() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const show = (state: 'hidden' | 'visible') => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  return { win, doc, show };
}

function app(search: string, extra: Partial<AppOptions> = {}) {
  const a = createApp({ params: new URLSearchParams(search), storage: memoryStorage(), backend: remoteBackend(testSession()), provider: biologyProvider(), page: null, ...extra });
  return Object.assign(a, { state: () => a.store.getState() });
}

const settle = () => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1000);
const eventCalls = (server: ReturnType<typeof fakeServer>) => server.calls.filter((c) => c.path === '/api/events');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('usage log, live mode', () => {
  it('a sent turn logs session_start, turn_sent, then reply_done, in order, with the envelope and the texts', async () => {
    const server = fakeServer();
    const a = app('?provider=arbor');
    a.start();
    await settle();
    a.send(TEXT);
    await settle();
    const types = server.events.map((e) => e.type);
    expect(types[0]).toBe('session_start');
    expect(types.indexOf('turn_sent')).toBeGreaterThan(0);
    expect(types.indexOf('reply_done')).toBeGreaterThan(types.indexOf('turn_sent'));
    expect(types).toContain('analysis_shown');
    const chat = a.state().session.activeConversationId;
    const sent = server.events.find((e) => e.type === 'turn_sent')!;
    const done = server.events.find((e) => e.type === 'reply_done')!;
    expect(sent).toMatchObject({ conversationId: chat, payload: { chars: TEXT.length, words: 9, design: 'ascii' } });
    expect(done.payload).toMatchObject({ userMessageId: sent.payload.messageId, model: 'fake', stopped: false });
    // One visit, numbered in order.
    expect(new Set(server.events.map((e) => e.payload.visit)).size).toBe(1);
    expect(server.events.map((e) => e.payload.seq)).toEqual(server.events.map((_, i) => i + 1));
    // The texts went over the wire: the message and the reply.
    expect(sent.payload).toMatchObject({ text: TEXT });
    expect(done.payload).toMatchObject({ text: 'Vaccines show the body a harmless copy.' });
    // The device, once per visit.
    expect(server.events[0].payload).toMatchObject({ search: 'provider=arbor', timeZone: expect.any(String), touch: false });
  });

  it('a design reports what only it knows through track; hiding the page sends page_hidden with keepalive', async () => {
    const server = fakeServer();
    const p = pageEvents();
    const a = app('?provider=arbor', { page: p });
    a.start();
    await settle();
    a.track({ type: 'view_change', payload: { from: 'tree', to: 'outline', via: 'key' } });
    p.show('hidden');
    await vi.advanceTimersByTimeAsync(0);
    const last = eventCalls(server).at(-1)!;
    expect(last.keepalive).toBe(true);
    expect((last.body!.events as { type: string }[]).map((e) => e.type)).toEqual(['view_change', 'page_hidden']);
    p.show('visible');
    await settle();
    expect(server.events.at(-1)!.type).toBe('page_visible');
  });

  it('offline: the events wait (and survive a reload), and go out at once when the browser is back online', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const p = pageEvents();
    const a = app('?provider=arbor', { storage, page: p });
    a.start();
    await settle();
    server.offline = true;
    a.track({ type: 'command', payload: { name: 'forest', arg: null } });
    await settle();
    expect(server.events.map((e) => e.type)).toEqual(['session_start']);
    expect(JSON.parse(storage.getItem(EVENTS_KEY)!).events.map((e: { type: string }) => e.type)).toEqual(['command']);
    server.offline = false;
    p.win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.events.map((e) => e.type)).toEqual(['session_start', 'command', 'online']);
  });

  it('another user on this browser never sends the last user’s events', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = fakeServer();
    const storage = memoryStorage({ [SESSION_KEY]: 'token-a' });
    const first = app('?provider=arbor', { storage });
    first.start();
    await settle();
    server.offline = true;
    first.track({ type: 'command', payload: { name: 'login', arg: null } });
    // Logging in as someone else stores their token; the page reloads.
    storage.setItem(SESSION_KEY, 'token-b');
    first.track({ type: 'page_hidden', payload: {} });
    first.log.stop();
    server.offline = false;
    const second = app('?provider=arbor', { storage });
    second.start();
    await settle();
    const visits = new Set(server.events.map((e) => e.payload.visit));
    expect(visits.size).toBe(2); // each page's session_start, nothing else of the first page
    expect(server.events.map((e) => e.type)).toEqual(['session_start', 'session_start']);
  });
});

describe('usage log: never logged', () => {
  it('the session token, an own-model key, a password typed to sign up and the username are in no event', async () => {
    const TOKEN = 'u1.token-9f8e7d6c5b4a';
    const KEY = 'sk-own-model-key-123456';
    const PASSWORD = 'correct horse battery staple';
    const USERNAME = 'student-4711';
    const server = fakeServer();
    const p = pageEvents();
    const storage = memoryStorage({ [SESSION_KEY]: TOKEN });
    const a = app('?provider=arbor', { storage, session: memoryStorage(), backend: remoteBackend(createSession(async () => TOKEN, storage)), page: p });
    const stop = a.start();
    await settle();
    // Settings → model: the key goes into the key store, the endpoint into the settings.
    a.keys.setKey('chat', KEY);
    // An endpoint URL with credentials in it: only its host may be logged.
    const endpoint = Object.assign(new URL('http://llm.test/v1'), { username: USERNAME, password: PASSWORD }).href;
    a.dispatch({ type: 'settings', patch: { own: { chat: { preset: 'custom', baseUrl: endpoint, model: 'm' }, analysis: 'same', scores: 'same' } } });
    // The welcome screen: typing reaches the window's listeners (idle time), then the form signs up.
    for (const key of PASSWORD) p.win.dispatchEvent(Object.assign(new Event('keydown'), { key }));
    await signUp(storage, { username: USERNAME, password: PASSWORD });
    a.send(TEXT);
    await settle();
    p.show('hidden');
    await settle();
    stop();
    const logged = JSON.stringify([...server.events, ...a.log.pending()]);
    expect(logged).toContain(TEXT); // the log does carry texts
    expect(logged).toContain('llm.test'); // and the endpoint's host
    expect(endpoint).toContain(USERNAME);
    for (const secret of [TOKEN, KEY, PASSWORD, encodeURIComponent(PASSWORD), USERNAME, endpoint]) expect(logged).not.toContain(secret);
    expect(server.events.find((e) => e.type === 'setting_changed')?.payload).toMatchObject({ key: 'own', value: 'chat: custom llm.test m · analysis: same · scores: same' });
  });
});

describe('usage log, demo mode', () => {
  it('records nothing and sends nothing (?demo=1), whatever the design or the page does', async () => {
    const server = fakeServer();
    const p = pageEvents();
    const storage = memoryStorage();
    const a = app('?demo=1', { storage, provider: undefined, page: p });
    a.start();
    a.send('Quiz me on loss');
    a.track({ type: 'squirrel_poke', payload: { dizzy: false } });
    a.navigate({ kind: 'forest' }, { via: 'click' });
    p.show('hidden');
    p.win.dispatchEvent(new Event('pagehide'));
    p.win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(eventCalls(server)).toEqual([]);
    expect(a.log.pending()).toEqual([]);
    expect(storage.getItem(EVENTS_KEY)).toBeNull();
  });
});
