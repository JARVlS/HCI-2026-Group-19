import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, chat, json } from './arbor';
import { toTouched } from './live';
import type { LiveConcept } from './types';

/** A Response whose body arrives in the given chunks, like a real SSE stream. */
function sse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

let sessions = 0; // across tests, because the provider keeps its session for the whole page

/** Answers /api/session with a token and hands every /api/ai/complete call to `answers` in order. */
function backend(answers: Response[]) {
  const calls: { url: string; auth: string | null }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/session')) return reply({ userId: 'u', token: `token-${++sessions}` });
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    return answers.shift()!;
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('arbor provider', () => {
  it('reads deltas that are split across chunks and stops at done', async () => {
    backend([
      sse([
        'event: delta\ndata: {"text":"Hel',
        'lo"}\n\nevent: delta\ndata: {"text":" there"}\n\n',
        'event: done\ndata: {"usage":{"inputTokens":1,"outputTokens":2},"model":"m","truncated":false}\n\n',
      ]),
    ]);
    const seen: string[] = [];
    const done = await chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] }, (t) => seen.push(t));
    expect(seen).toEqual(['Hello', ' there']);
    expect(done).toEqual({ truncated: false });
  });

  it('turns an error event and a broken stream into ApiError', async () => {
    backend([
      sse(['event: delta\ndata: {"text":"a"}\n\nevent: error\ndata: {"code":"upstream_error","message":"broke"}\n\n']),
      sse(['event: delta\ndata: {"text":"a"}\n\n']),
    ]);
    const req = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };
    await expect(chat(req, () => {})).rejects.toMatchObject({ code: 'upstream_error', message: 'broke' });
    await expect(chat(req, () => {})).rejects.toBeInstanceOf(ApiError);
  });

  it('reports the backend error body and gets a new session once after a 401', async () => {
    const calls = backend([
      reply({ error: { code: 'unauthorized', message: 'unknown token' } }, 401),
      reply({ output: { ok: true }, usage: {}, model: 'm', truncated: false }),
      reply({ error: { code: 'budget_exceeded', message: 'Daily token budget used up' } }, 429),
    ]);
    const req = { task: 'analyze' as const, system: 's', messages: [], schema: {} };
    expect(await json(req)).toEqual({ ok: true });
    expect(calls[0].auth).not.toBe(calls[1].auth);
    await expect(json(req)).rejects.toMatchObject({ status: 429, code: 'budget_exceeded' });
  });
});

describe('toTouched', () => {
  const known: LiveConcept[] = [
    { id: 'live-gradient-descent', label: 'gradient descent', branchId: 'live:optimization', order: 0, messageIds: [] },
  ];

  it('keeps the ids of concepts and branches that exist', () => {
    expect(
      toTouched(
        [
          { label: 'Gradient Descent', branch: 'training' },
          { label: 'learning rate', branch: 'Optimization' },
          { label: 'Loss function', branch: 'losses' },
        ],
        known,
      ),
    ).toEqual([
      { id: 'live-gradient-descent', label: 'gradient descent', branchId: 'live:optimization' },
      { id: 'live-learning-rate', label: 'learning rate', branchId: 'live:optimization' },
      { id: 'live-loss-function', label: 'Loss function', branchId: 'live:losses' },
    ]);
  });

  it('drops empty labels, duplicates and everything after the third', () => {
    const found = ['a', ' ', 'A', 'b', 'c', 'd'].map((label) => ({ label, branch: 'x' }));
    expect(toTouched(found, []).map((t) => t.id)).toEqual(['live-a']);
  });
});
