import { vi } from 'vitest';

/** Test helpers for the user's own model endpoint (`ai/own/`): a fake `fetch` for one base URL, no network. */

export const ENDPOINT = 'http://llm.test/v1';

export interface EndpointCall {
  url: string;
  /** The URL after the base, e.g. `/chat/completions`. */
  path: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

/**
 * Stub `fetch` for calls to `base`; every other URL goes to the `fetch` that was there before (e.g.
 * `fakeServer()`'s backend, so install that first). `answer` gets each call and returns the
 * response, or throws like a network failure. Undo with `vi.unstubAllGlobals()`.
 */
export function fakeEndpoint(answer: (call: EndpointCall) => Response | Promise<Response>, base = ENDPOINT): EndpointCall[] {
  const calls: EndpointCall[] = [];
  const next = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (!String(url).startsWith(base)) return next(url, init);
    const call: EndpointCall = {
      url,
      path: url.slice(base.length),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      signal: init.signal ?? null,
    };
    calls.push(call);
    return answer(call);
  });
  return calls;
}

/** An OpenAI-style stream event (`data: {...}`), and the end marker. */
export const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
export const DONE = 'data: [DONE]\n\n';
export const delta = (content: string, extra: object = {}) => chunk({ model: 'test-model', choices: [{ index: 0, delta: { content }, finish_reason: null }], ...extra });
export const finish = (reason = 'stop') => chunk({ model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: reason }] });

/** A non-streaming chat completion with `content`. */
export const completion = (content: string, finish_reason = 'stop', extra: object = {}) => ({
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }],
  ...extra,
});

/** A one-token completion with these top logprobs (token → probability). */
export function logprobs(top: Record<string, number>) {
  const items = Object.entries(top).map(([token, p]) => ({ token, logprob: Math.log(p) }));
  return { model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: items[0]?.token ?? '' }, logprobs: { content: [{ token: items[0]?.token, logprob: items[0]?.logprob, top_logprobs: items }] }, finish_reason: 'length' }] };
}
