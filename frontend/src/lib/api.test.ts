import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, event, fakeBackend, json, sse } from '../test/backend';
import { api, ApiError, apiStream } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const collect = async (stream: AsyncGenerator<{ event: string; data: unknown }>) => {
  const out: { event: string; data: unknown }[] = [];
  for await (const e of stream) out.push(e);
  return out;
};

describe('api', () => {
  it('posts JSON with the token and returns the answer', async () => {
    const calls = fakeBackend(() => json({ ok: true }));
    expect(await api('/api/x', { a: 1 }, { token: 't1' })).toEqual({ ok: true });
    expect(calls).toMatchObject([{ path: '/api/x', auth: 'Bearer t1', body: { a: 1 } }]);
  });

  it('turns the error body into a typed error', async () => {
    fakeBackend(() => apiError(422, 'invalid_request', 'messages: field required'));
    await expect(api('/api/x', {})).rejects.toMatchObject({ name: 'ApiError', status: 422, code: 'invalid_request', message: 'messages: field required' });
  });

  it('an error without our body still says its status', async () => {
    fakeBackend(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(api('/api/x', {})).rejects.toMatchObject({ status: 502, code: 'http_error', message: 'HTTP 502' });
  });

  it('no answer at all is a network error', async () => {
    fakeBackend(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api('/api/x', {})).rejects.toMatchObject({ status: 0, code: 'network', message: 'Could not reach the backend (Failed to fetch).' });
  });

  it('a build without VITE_API_URL fails loudly instead of calling the page itself', async () => {
    const calls = fakeBackend(() => json({}));
    vi.stubEnv('VITE_API_URL', '');
    await expect(api('/api/x', {})).rejects.toMatchObject({ code: 'no_backend' });
    expect(calls).toEqual([]);
  });
});

describe('apiStream', () => {
  it('reads events split across chunks, also inside a UTF-8 character', async () => {
    const bytes = new TextEncoder().encode(event('delta', { text: 'Grüße' }));
    const umlaut = bytes.indexOf(0xc3); // first byte of "ü"
    fakeBackend(() =>
      sse([
        'event: delta\ndata: {"text":"Hel',
        'lo"}\n',
        '\nevent: delta\r\ndata: {"text":" there"}\r\n\r\n: keep-alive\n\n',
        bytes.slice(0, umlaut + 1),
        bytes.slice(umlaut + 1),
        event('done', { model: 'm' }),
      ]),
    );
    expect(await collect(apiStream('/api/s', {}))).toEqual([
      { event: 'delta', data: { text: 'Hello' } },
      { event: 'delta', data: { text: ' there' } },
      { event: 'delta', data: { text: 'Grüße' } },
      { event: 'done', data: { model: 'm' } },
    ]);
  });

  it('an error status before the stream starts is a typed error', async () => {
    fakeBackend(() => apiError(429, 'budget_exceeded', 'Daily token budget used up'));
    await expect(collect(apiStream('/api/s', {}))).rejects.toMatchObject({ status: 429, code: 'budget_exceeded' });
  });

  it('an unreadable event is an error, not a silent skip', async () => {
    fakeBackend(() => sse(['event: delta\ndata: {not json\n\n']));
    await expect(collect(apiStream('/api/s', {}))).rejects.toBeInstanceOf(ApiError);
  });

  it('abort stops the stream with the AbortError', async () => {
    const c = new AbortController();
    // A body that never ends unless the request is aborted, like a slow model.
    fakeBackend(({ signal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(new TextEncoder().encode(event('delta', { text: 'a' })));
          signal?.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    });
    const seen: unknown[] = [];
    const run = (async () => {
      for await (const e of apiStream('/api/s', {}, { signal: c.signal })) {
        seen.push(e.data);
        c.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual([{ text: 'a' }]);
  });
});
