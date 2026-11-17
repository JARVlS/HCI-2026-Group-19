import { vi } from 'vitest';

/** Test helpers for code that talks to the backend Worker: a fake `fetch`, no network. */

export const API = 'http://api.test';

/** A response whose body arrives in the given chunks, like a real SSE stream over the network. */
export function sse(chunks: (string | Uint8Array)[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export const apiError = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

export const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

export interface Call {
  path: string;
  method: string;
  keepalive: boolean;
  auth: string | null;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

/**
 * Stub `fetch` and VITE_API_URL. `answer` gets each call and returns the response (or throws, like
 * a network failure). Undo with `vi.unstubAllGlobals()` and `vi.unstubAllEnvs()`.
 */
export function fakeBackend(answer: (call: Call) => Response | Promise<Response>): Call[] {
  vi.stubEnv('VITE_API_URL', API);
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      path: url.slice(API.length),
      method: init.method ?? 'GET',
      keepalive: Boolean(init.keepalive),
      auth: new Headers(init.headers).get('authorization'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      signal: init.signal ?? null,
    };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
