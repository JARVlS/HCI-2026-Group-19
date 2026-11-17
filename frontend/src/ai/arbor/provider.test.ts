import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { createSession } from '../../lib/session';
import { apiError, event, fakeBackend, json, sse, type Call } from '../../test/backend';
import { testStore } from '../../test/harness';
import type { AnalyzeInput, ChatRequest } from '../provider';
import { ProviderError } from '../provider';
import { ArborProvider } from './provider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A provider with its own session (token-1, token-2, … from POST /api/session), so tests never share one. */
const provider = () => {
  let n = 0;
  return new ArborProvider(createSession(async () => `token-${++n}`, null));
};

const chatReq: ChatRequest = {
  conversationId: 'c',
  messages: [{ role: 'user', text: 'Why is the sky blue?' }],
  context: { mode: 'together', pendingQuiz: null, known: [], nudge: 'active', studyMode: false },
};

const analyzeInput: AnalyzeInput = {
  conversationId: 'c',
  text: 'Why is the sky blue?',
  linter: { mode: 'together', confidence: 0.6, reasons: [] },
  recent: [],
  context: chatReq.context,
  graph: [{ id: 'phys', label: 'Physics', kind: 'subject', parentId: null }],
  subjectId: null,
};

const done = event('done', { usage: { inputTokens: 10, outputTokens: 5 }, model: 'claude-test', truncated: false });

const chat = (p = provider(), signal = new AbortController().signal) => {
  const deltas: string[] = [];
  return { deltas, result: p.chat(chatReq, (d) => deltas.push(d), signal) };
};

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error('expected a failure');
};

describe('arbor provider: chat', () => {
  it('streams the reply and returns the model that answered', async () => {
    const calls = fakeBackend(() => sse([event('delta', { text: 'Rayleigh ' }), event('delta', { text: 'scattering.' }) + done]));
    const { deltas, result } = chat();
    expect(await result).toEqual({ text: 'Rayleigh scattering.', model: 'claude-test', pendingQuiz: null });
    expect(deltas).toEqual(['Rayleigh ', 'scattering.']);
    expect(calls[0]).toMatchObject({ path: '/api/ai/complete', auth: 'Bearer token-1' });
    expect(calls[0].body).toMatchObject({ task: 'chat', stream: true, messages: [{ role: 'user', content: 'Why is the sky blue?' }] });
    expect(calls[0].body!.system).toContain('one short question');
  });

  it('an error event is an upstream failure with the backend message', async () => {
    fakeBackend(() => sse([event('delta', { text: 'Ray' }), event('error', { code: 'upstream_error', message: 'Claude stream broke off' })]));
    const e = await failure(chat().result);
    expect([e.code, e.message]).toEqual(['upstream', 'Claude stream broke off']);
  });

  it('a stream that ends without done is a broken connection (retry helps)', async () => {
    fakeBackend(() => sse([event('delta', { text: 'Ray' })]));
    expect((await failure(chat().result)).code).toBe('network');
  });

  it('no connection is a network failure', async () => {
    fakeBackend(() => {
      throw new TypeError('Failed to fetch');
    });
    expect((await failure(chat().result)).code).toBe('network');
  });

  it('stop aborts the request itself', async () => {
    const c = new AbortController();
    let seen: Call | undefined;
    fakeBackend((call) => {
      seen = call;
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(new TextEncoder().encode(event('delta', { text: 'Ray' })));
          call.signal?.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body);
    });
    const { deltas, result } = chat(provider(), c.signal);
    await vi.waitFor(() => expect(deltas).toEqual(['Ray']));
    c.abort();
    expect((await failure(result)).code).toBe('aborted');
    expect(seen!.signal!.aborted).toBe(true);
  });

  it.each([
    ['budget_exceeded', 'Daily token budget used up (200000 of 200000 tokens). It resets at 2026-11-18T00:00:00Z (midnight UTC).'],
    ['total_budget_exceeded', "The project's total token budget is used up (900000 of 900000 tokens, all users together)."],
  ])('429 %s is budget_exceeded and keeps the backend message', async (code, message) => {
    fakeBackend(() => apiError(429, code, message));
    const e = await failure(chat().result);
    expect([e.code, e.message]).toEqual(['budget_exceeded', message]);
  });

  it('a stale token gets one new session, then the call goes through', async () => {
    const calls = fakeBackend(({ auth }) => (auth === 'Bearer token-1' ? apiError(401, 'unauthorized', 'unknown token') : sse([event('delta', { text: 'Hi' }) + done])));
    expect((await chat().result).text).toBe('Hi');
    expect(calls.map((c) => c.auth)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('a build without a backend URL fails visibly instead of switching to the script', async () => {
    fakeBackend(() => json({}));
    vi.stubEnv('VITE_API_URL', '');
    expect((await failure(chat().result)).message).toMatch(/no backend URL/);
  });
});

/** A valid `analyze` answer from the backend. */
const answer = {
  mode: 'together',
  confidence: 0.85,
  reasons: ['Asks why something happens'],
  evidence: [{ quote: 'Why is', mode: 'together', reason: 'Asks why' }],
  subject: { existingId: 'phys', newLabel: null },
  concepts: [
    {
      existingId: null,
      newLabel: 'Rayleigh scattering',
      newKind: 'concept',
      parentId: null,
      parentLabel: 'Optics',
      description: 'Light scattering by particles smaller than its wavelength.',
      mode: 'together',
      independence: 0.5,
      correctness: null,
      confidence: 0.8,
      reason: 'Asks about it',
      evidenceQuote: 'sky blue',
    },
  ],
};

describe('arbor provider: analyze', () => {

  it('sends the rendered prompt with the schema and converts the answer', async () => {
    const calls = fakeBackend(() => json({ output: answer, usage: {}, model: 'claude-test', truncated: false }));
    const a = await provider().json('analyze', analyzeInput, new AbortController().signal);
    expect(calls[0].body).toMatchObject({ task: 'analyze', schema: { type: 'object', additionalProperties: false } });
    expect(calls[0].body!.messages).toEqual([{ role: 'user', content: expect.stringContaining('phys | subject | Physics | -') }]);
    expect(a.subject).toEqual({ existingId: 'phys' });
    expect(a.concepts[0].ref).toEqual({
      newNode: { label: 'Rayleigh scattering', kind: 'concept', parent: { newLabel: 'Optics' }, description: 'Light scattering by particles smaller than its wavelength.' },
    });
  });

  it('an answer that does not fit is invalid_output, not a quiet fallback', async () => {
    fakeBackend(() => json({ output: { ...answer, mode: 'mostly ai' }, usage: {}, model: 'm', truncated: false }));
    expect((await failure(provider().json('analyze', analyzeInput, new AbortController().signal))).code).toBe('invalid_output');
  });

  it('the backend rejecting the model output is invalid_output too', async () => {
    fakeBackend(() => apiError(502, 'invalid_model_output', 'not valid JSON'));
    expect((await failure(provider().json('analyze', analyzeInput, new AbortController().signal))).code).toBe('invalid_output');
  });
});

describe('arbor provider: score', () => {
  const scored = (p: Partial<{ probabilities: Record<string, number>; model: string }> = {}) =>
    json({ probabilities: { '1': 0.83, '2': 0.17 }, mass: 0.99, usage: { inputTokens: 212, outputTokens: 1 }, model: 'zai.glm-4.7-flash', ...p });
  const think = { question: 'thinking' as const, text: 'I think it scatters blue light more', recent: [] };

  it('asks the question with the options 1 and 2 and returns P(1)', async () => {
    const calls = fakeBackend(() => scored());
    expect(await provider().score(think, new AbortController().signal)).toEqual({ p: 0.83, model: 'zai.glm-4.7-flash' });
    expect(calls[0]).toMatchObject({ path: '/api/ai/score', method: 'POST', auth: 'Bearer token-1' });
    expect(calls[0].body).toEqual({
      system: expect.stringContaining('did the student think along?'),
      messages: [{ role: 'user', content: 'Student message:\nI think it scatters blue light more\n\nAnswer (1 or 2):' }],
      options: ['1', '2'],
    });
  });

  it('the correct question sends the statement and the tutor answer', async () => {
    const calls = fakeBackend(() => scored({ probabilities: { '1': 0.1, '2': 0.9 } }));
    const r = await provider().score({ question: 'correct', statement: 'it reflects the ocean', reference: 'Rayleigh scattering.' }, new AbortController().signal);
    expect(r.p).toBe(0.1);
    expect(calls[0].body!.system).toContain("is the student's statement right?");
    expect((calls[0].body!.messages as { content: string }[])[0].content).toContain("Tutor's answer:\nRayleigh scattering.\n\nStudent's statement:\nit reflects the ocean");
  });

  it.each(['budget_exceeded', 'total_budget_exceeded'])('429 %s is budget_exceeded', async (code) => {
    fakeBackend(() => apiError(429, code, 'used up'));
    expect((await failure(provider().score(think, new AbortController().signal))).code).toBe('budget_exceeded');
  });

  it('the model not answering with an option, or an answer without P(1), is invalid_output', async () => {
    fakeBackend(() => apiError(502, 'invalid_model_output', 'The model answered "maybe".'));
    expect((await failure(provider().score(think, new AbortController().signal))).code).toBe('invalid_output');
    fakeBackend(() => scored({ probabilities: { yes: 1 } }));
    expect((await failure(provider().score(think, new AbortController().signal))).code).toBe('invalid_output');
  });

  it('a server without the fast model key is an upstream failure', async () => {
    fakeBackend(() => apiError(500, 'server_misconfigured', 'The fast model key is not set.'));
    expect((await failure(provider().score(think, new AbortController().signal))).code).toBe('upstream');
  });

  it('abort cancels the request', async () => {
    const c = new AbortController();
    let seen: Call | undefined;
    fakeBackend(
      (call) =>
        new Promise<Response>((_, reject) => {
          seen = call;
          call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = provider().score(think, c.signal);
    await vi.waitFor(() => expect(seen).toBeDefined());
    c.abort();
    expect((await failure(pending)).code).toBe('aborted');
    expect(seen!.signal!.aborted).toBe(true);
  });
});

describe('arbor provider in a turn', () => {
  it('a live turn on a fresh chat streams, picks a subject and grows a leaf in that grove', async () => {
    const calls = fakeBackend(({ path, body }) =>
      path === '/api/ai/score'
        ? json({ probabilities: { '1': 0.6, '2': 0.4 }, mass: 0.98, usage: {}, model: 'fast-test' })
        : body!.task === 'chat'
          ? sse([event('delta', { text: 'Short ' }), event('delta', { text: 'answer.' }), done])
          : json({ output: { ...answer, subject: { existingId: null, newLabel: 'Physics of light' } }, usage: {}, model: 'claude-test', truncated: false }),
    );
    const s = testStore({ fresh: true, provider: provider() });
    expect(s.messages()).toEqual([]);
    await s.send('Why is the sky blue?');

    const [user, reply] = s.messages();
    expect(reply).toMatchObject({ text: 'Short answer.', model: 'claude-test', provider: 'arbor', streaming: false });
    expect(user).toMatchObject({ analysis: 'done', classification: { mode: 'together', reasons: ['Asks why something happens'] } });
    // Three calls per ungraded turn: the reply, the analysis and the fast "thought along" score.
    expect(calls.map((c) => c.path).sort()).toEqual(['/api/ai/complete', '/api/ai/complete', '/api/ai/score']);
    expect(user.scores).toEqual({ thinking: { p: 0.6, model: 'fast-test' } });
    expect(s.state.domain.attempts.map((a) => [a.mode, a.independence])).toEqual([['together', 0.6]]);

    const { concepts, conversations } = s.state.domain;
    const subject = Object.values(concepts).find((c) => c.label === 'Physics of light')!;
    const optics = Object.values(concepts).find((c) => c.label === 'Optics')!;
    expect(subject).toMatchObject({ kind: 'subject', parentId: null });
    expect(optics).toMatchObject({ kind: 'topic', parentId: subject.id }); // below the new subject, not loose
    expect(conversations[s.state.session.activeConversationId].subjectId).toBe(subject.id);
    const [tree] = s.activeTrees();
    expect(tree).toMatchObject({ title: 'Optics', grove: subject.id });
    expect(tree.branches.flatMap((b) => b.leaves.map((l) => l.label))).toEqual(['Rayleigh scattering']);
  });

  it('a used-up budget ends the turn with a friendly sentence and keeps the linter label', async () => {
    fakeBackend(() => apiError(429, 'total_budget_exceeded', "The project's total token budget is used up."));
    const s = testStore({ fresh: true, provider: provider() });
    await s.send('Why is the sky blue?');
    expect(s.state.session.turn).toMatchObject({ status: 'error' });
    expect(s.state.session.turn.error).toMatch(/^The project’s budget for live answers is used up/);
    expect(s.messages()[0].analysis).toBe('failed');
  });
});

it('ApiError is what the transport throws (the provider maps it)', () => {
  expect(new ApiError(429, 'budget_exceeded', 'x')).toBeInstanceOf(Error);
});
