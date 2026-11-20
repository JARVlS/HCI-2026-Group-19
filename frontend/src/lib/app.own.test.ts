import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYS_KEY } from '../ai/own/keys';
import { JSON_MODES } from '../ai/own/openai';
import type { OwnSetup } from '../ai/own/setup';
import { sse, json } from '../test/backend';
import { completion, delta, DONE, ENDPOINT, fakeEndpoint, logprobs, type EndpointCall } from '../test/endpoint';
import { fakeServer, serverMessages, testSession } from '../test/server';
import { memoryStorage } from '../test/storage';
import { createApp, PROVIDER_KEY, SETTINGS_KEY } from './app';
import { remoteBackend } from './live';
import { SYNC_KEY } from './sync';
import { EVENTS_KEY } from './telemetry';

/**
 * Provider `own` end to end without React (IMPLEMENTATION_PLAN.md M7 acceptance at unit level):
 * the model calls of a turn go to the user's endpoint, the chat is saved on the backend as in
 * live mode, and the key stays on the device.
 */

const KEY = 'sk-very-secret-key';
const SETUP: OwnSetup = { chat: { preset: 'custom', baseUrl: ENDPOINT, model: 'my-model' }, analysis: 'same', scores: 'same' };

const ANALYSIS = {
  mode: 'own',
  confidence: 0.9,
  reasons: ['states a claim'],
  evidence: [],
  subject: { existingId: null, newLabel: 'Biology' },
  concepts: [
    {
      existingId: null,
      newLabel: 'Vaccines',
      newKind: 'concept',
      parentId: null,
      parentLabel: 'Immunology',
      description: 'How vaccines train the immune system',
      mode: 'own',
      independence: 1,
      correctness: null,
      confidence: 0.9,
      reason: 'own words',
      evidenceQuote: null,
    },
  ],
};

/** The user's endpoint: a streamed reply, the analysis (json_schema), scores (logprobs). */
const endpoint = (c: EndpointCall) =>
  c.body?.stream ? sse([delta('Vaccines show the body ') + delta('a harmless copy.') + DONE]) : c.body?.logprobs ? json(logprobs({ '5': 1 })) : json(completion(JSON.stringify(ANALYSIS)));

let ids = 0;
function app(search: string, { local = memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ own: SETUP }) }), session = memoryStorage() } = {}) {
  const a = createApp({ params: new URLSearchParams(search), storage: local, session, backend: remoteBackend(testSession()), page: null, newId: () => `id-${++ids}` });
  return Object.assign(a, { state: () => a.store.getState(), local, session });
}

const settle = () => vi.advanceTimersByTimeAsync(2000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T09:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  JSON_MODES.clear();
});

describe('own model', () => {
  it('a turn: model calls go to the own endpoint, the backend only loads and saves, and the key is nowhere in saved data', async () => {
    const server = fakeServer();
    const calls = fakeEndpoint(endpoint);
    const a = app('?provider=own');
    expect(a.state().settings.provider).toBe('own');
    a.keys.setKey('chat', KEY);
    a.start();
    await settle();
    a.send('I think a vaccine shows the immune system a harmless copy of the germ');
    await settle();

    // The reply streamed in, the analysis grew a leaf, the fast score set the percent.
    const s = a.state();
    const conv = s.session.activeConversationId;
    const [user, reply] = s.domain.messagesByConv[conv];
    expect(reply).toMatchObject({ role: 'assistant', text: 'Vaccines show the body a harmless copy.', provider: 'openai-compatible', model: 'test-model' });
    expect(Object.values(s.domain.concepts).map((c) => c.label).sort()).toEqual(['Biology', 'Immunology', 'Vaccines']);
    expect(user.scores?.thinking).toEqual({ p: 1, model: 'test-model' });

    // Model calls: all at the own endpoint, with the key; none at /api/ai/*.
    expect(calls.map((c) => c.path)).toEqual(['/chat/completions', '/chat/completions', '/chat/completions']);
    expect(calls.every((c) => c.headers.get('authorization') === `Bearer ${KEY}`)).toBe(true);
    expect(server.calls.filter((c) => c.path.startsWith('/api/ai/'))).toEqual([]);
    expect(server.calls.map((c) => c.path).filter((p) => p !== '/api/events')).toEqual(['/api/state', '/api/sync']);

    // Saved like live mode, without the key: not in the sync payload, the queue mirror or the settings.
    const synced = JSON.stringify(server.calls.filter((c) => c.path === '/api/sync').map((c) => c.body));
    expect(synced).toContain('Vaccines show the body a harmless copy.');
    expect(synced).not.toContain(KEY);
    expect(serverMessages(server, conv).map((m) => m.model ?? null)).toEqual([null, 'test-model']);
    for (const k of [SYNC_KEY, SETTINGS_KEY, PROVIDER_KEY, KEYS_KEY, EVENTS_KEY]) expect(a.local.getItem(k) ?? '').not.toContain(KEY);
    // The usage log has neither the key nor the endpoint.
    const logged = JSON.stringify([...server.events, ...a.log.pending()]);
    expect(logged).toContain('turn_sent');
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(ENDPOINT);
    // The key itself: in this tab's sessionStorage only.
    expect(a.session.getItem(KEYS_KEY)).toContain(KEY);
  });

  it('remember on this device: the key moves to localStorage and is there after a reload', async () => {
    fakeServer();
    const first = app('?provider=own');
    first.keys.setKey('chat', KEY);
    first.keys.setRemember(true);
    expect(first.local.getItem(KEYS_KEY)).toContain(KEY);
    expect(first.session.getItem(KEYS_KEY)).toBeNull();
    const second = app('?provider=own', { local: first.local, session: memoryStorage() });
    expect(second.keys.snapshot()).toEqual({ keys: { chat: KEY }, remember: true });
    expect(second.state().settings.own).toEqual(SETUP);
  });

  it('arbor → own keeps the loaded chats (no new load); own → scripted shows the demo', async () => {
    const server = fakeServer();
    const a = app('?provider=arbor');
    a.start();
    await settle();
    const conv = a.state().session.activeConversationId;
    a.dispatch({ type: 'settings', patch: { provider: 'own' } });
    await settle();
    expect(a.state().session.activeConversationId).toBe(conv);
    expect(server.calls.map((c) => c.path).filter((p) => p !== '/api/events')).toEqual(['/api/state']);
    expect(a.local.getItem(PROVIDER_KEY)).toBe('own');
    a.dispatch({ type: 'settings', patch: { provider: 'scripted' } });
    expect(a.state().session.activeConversationId).toBe('c-nn');
  });

  it('?demo=1 still wins over a saved own choice: no request at all', async () => {
    const server = fakeServer();
    const calls = fakeEndpoint(endpoint);
    const a = app('?demo=1', { local: memoryStorage({ [PROVIDER_KEY]: 'own', [SETTINGS_KEY]: JSON.stringify({ own: SETUP }) }) });
    a.start();
    await settle();
    expect(a.state().settings.provider).toBe('scripted');
    a.send('Quiz me on loss');
    await settle();
    expect([...server.calls, ...calls]).toEqual([]);
  });

  it('a wrong key fails the turn with a message that says to check the key (and never shows it)', async () => {
    const server = fakeServer();
    fakeEndpoint(() => json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401));
    const a = app('?provider=own');
    a.keys.setKey('chat', KEY);
    a.start();
    await settle();
    a.send('Why is the sky blue?');
    await settle();
    const { turn } = a.state().session;
    expect(turn.status).toBe('error');
    expect(turn.error).toContain('refused the key (HTTP 401)');
    expect(turn.error).not.toContain(KEY);
    const logged = [...server.events, ...a.log.pending()];
    expect(logged.map((e) => e.type)).toContain('turn_error');
    expect(JSON.stringify(logged)).not.toContain(KEY);
  });
});
