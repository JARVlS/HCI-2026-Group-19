import { afterEach, describe, expect, it, vi } from 'vitest';
import { event, json, sse } from '../../test/backend';
import { fakeEndpoint } from '../../test/endpoint';
import { ProviderError } from '../provider';
import { Anthropic, ANTHROPIC_VERSION } from './anthropic';
import type { JsonCall } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = 'https://api.anthropic.test';
const api = (key = 'sk-ant-secret') => new Anthropic({ preset: 'anthropic', baseUrl: BASE, model: 'claude-test', key });
const signal = () => new AbortController().signal;

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error('expected a failure');
};

const chat = (a = api()) => {
  const deltas: string[] = [];
  return { deltas, result: a.chat({ system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] }, (d) => deltas.push(d), signal()) };
};

const start = event('message_start', { type: 'message_start', message: { model: 'claude-test-2026', usage: { input_tokens: 5 } } });
const text = (t: string) => event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
const stop = (reason = 'end_turn') =>
  event('message_delta', { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 3 } }) + event('message_stop', { type: 'message_stop' });

const call: JsonCall<{ ok: boolean }> = {
  name: 'test',
  system: 'Judge.',
  user: 'Is it ok?',
  schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
  read: (raw) => raw as { ok: boolean },
};

describe('anthropic (own key): chat', () => {
  it('sends the key, the API version and the browser opt-in; the body has no effort, temperature or thinking', async () => {
    const calls = fakeEndpoint(() => sse([start + text('Hel'), text('lo') + event('ping', { type: 'ping' }) + stop()]), BASE);
    const { deltas, result } = chat();
    expect(await result).toEqual({ text: 'Hello', model: 'claude-test-2026' });
    expect(deltas).toEqual(['Hel', 'lo']);
    const c = calls[0];
    expect(c.url).toBe(`${BASE}/v1/messages`);
    expect(c.headers.get('x-api-key')).toBe('sk-ant-secret');
    expect(c.headers.get('anthropic-version')).toBe(ANTHROPIC_VERSION);
    expect(ANTHROPIC_VERSION).toBe('2026-10-21');
    expect(c.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(c.headers.has('authorization')).toBe(false);
    expect(c.body).toEqual({ model: 'claude-test', max_tokens: 4096, system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], stream: true });
  });

  it('events split across network chunks are put back together', async () => {
    const all = start + text('Grüße') + stop();
    const bytes = new TextEncoder().encode(all);
    const cut = all.indexOf('ü') + 1;
    fakeEndpoint(() => sse([bytes.slice(0, 20), bytes.slice(20, cut), bytes.slice(cut)]), BASE);
    expect((await chat().result).text).toBe('Grüße');
  });

  it('a refusal, an error event and a stream without message_stop all fail visibly', async () => {
    fakeEndpoint(() => sse([start + text('No') + stop('refusal')]), BASE);
    expect((await failure(chat().result)).message).toContain('refusal');
    vi.unstubAllGlobals();
    fakeEndpoint(() => sse([start + event('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })]), BASE);
    const e = await failure(chat().result);
    expect([e.code, e.message]).toEqual(['upstream', 'anthropic failed: Overloaded']);
    vi.unstubAllGlobals();
    fakeEndpoint(() => sse([start + text('Hal')]), BASE);
    expect((await failure(chat().result)).code).toBe('network');
  });

  it('a wrong key is the key; it never shows up in the message', async () => {
    fakeEndpoint(() => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-secret' } }, 401), BASE);
    const e = await failure(chat().result);
    expect(e.code).toBe('auth');
    expect(e.message).toContain('invalid x-api-key [key]');
    expect(e.message).not.toContain('sk-ant-secret');
  });

  it('no key: refused before the call', async () => {
    const calls = fakeEndpoint(() => json({}), BASE);
    expect((await failure(chat(api('')).result)).code).toBe('auth');
    expect(calls).toHaveLength(0);
  });
});

describe('anthropic (own key): structured output', () => {
  it('uses output_config.format json_schema (no forced tool use, no effort) and reads the text block', async () => {
    const calls = fakeEndpoint(
      () => json({ model: 'claude-test-2026', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":true}' }] }),
      BASE,
    );
    expect(await api().json(call, signal())).toEqual({ value: { ok: true }, mode: 'schema', model: 'claude-test-2026' });
    expect(calls[0].body).toEqual({
      model: 'claude-test',
      max_tokens: 4096,
      system: 'Judge.',
      messages: [{ role: 'user', content: 'Is it ok?' }],
      output_config: { format: { type: 'json_schema', schema: call.schema } },
    });
  });

  it('refusal is upstream, max_tokens and invalid JSON are invalid_output', async () => {
    const answers = [
      { stop_reason: 'refusal', content: [] },
      { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok":' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok!' }] },
    ];
    fakeEndpoint(() => json(answers.shift()), BASE);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await failure(api().json(call, signal()))).code);
    expect(codes).toEqual(['upstream', 'invalid_output', 'invalid_output']);
  });

  it('lists the models (GET /v1/models) with the same headers', async () => {
    const calls = fakeEndpoint(() => json({ data: [{ id: 'claude-sonnet-5-5', type: 'model' }, { id: 'claude-haiku-5-5', type: 'model' }], has_more: false }), BASE);
    expect(await api().models()).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(calls[0]).toMatchObject({ url: `${BASE}/v1/models`, method: 'GET' });
    expect(calls[0].headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
  });
});
