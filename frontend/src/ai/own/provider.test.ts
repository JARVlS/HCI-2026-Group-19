import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../../lib/session';
import { event, fakeBackend, json, sse, type Call } from '../../test/backend';
import { completion, delta, DONE, ENDPOINT, fakeEndpoint, logprobs, type EndpointCall } from '../../test/endpoint';
import { ArborProvider } from '../arbor/provider';
import type { AnalyzeInput, ChatRequest } from '../provider';
import { ProviderError } from '../provider';
import type { Keys } from './keys';
import { JSON_MODES } from './openai';
import { OwnProvider } from './provider';
import { connectionOf, DEFAULT_SETUP, parseSetup, type Connection, type OwnSetup } from './setup';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  JSON_MODES.clear();
});

const ANTHROPIC = 'https://api.anthropic.test';
const mine: Connection = { preset: 'custom', baseUrl: ENDPOINT, model: 'my-model' };
const claude: Connection = { preset: 'anthropic', baseUrl: ANTHROPIC, model: 'claude-test' };

const provider = (setup: OwnSetup, keys: Keys = {}) => new OwnProvider(() => ({ setup, keys }), new ArborProvider(createSession(async () => 'tok', null)));

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
  graph: [],
  subjectId: null,
};
const ANALYSIS = { mode: 'together', confidence: 0.8, reasons: ['asks why'], evidence: [], subject: { existingId: null, newLabel: 'Physics' }, concepts: [] };
const signal = () => new AbortController().signal;

/** The backend (session, /api/ai/*) and the user's endpoints, all faked; returns the calls of each. */
function world({ backend, endpoint, anthropic }: { backend?: (c: Call) => Response; endpoint?: (c: EndpointCall) => Response; anthropic?: (c: EndpointCall) => Response }) {
  const api = fakeBackend(backend ?? (() => json({ error: { code: 'not_found', message: 'no' } }, 404)));
  const own = fakeEndpoint(endpoint ?? (() => json({}, 500)));
  const ant = fakeEndpoint(anthropic ?? (() => json({}, 500)), ANTHROPIC);
  return { api, own, ant };
}

describe('own provider: routing by role', () => {
  it('chat, analysis and scores all go to the own endpoint with its key; nothing goes to the backend', async () => {
    const { api, own } = world({
      endpoint: (c) =>
        c.body?.stream ? sse([delta('Rayleigh') + DONE]) : c.body?.logprobs ? json(logprobs({ '2': 1 })) : json(completion(JSON.stringify(ANALYSIS))),
    });
    const p = provider({ chat: mine, analysis: 'same', scores: 'same' }, { chat: 'k-chat' });
    expect(p.kind).toBe('openai-compatible');
    expect(await p.chat(chatReq, () => {}, signal())).toEqual({ text: 'Rayleigh', model: 'test-model', pendingQuiz: null });
    expect((await p.json('analyze', analyzeInput, signal())).subject).toEqual({ newLabel: 'Physics' });
    expect((await p.score!({ question: 'thinking', text: 'Why?', recent: [] }, signal())).p).toBe(0.25);
    expect(own).toHaveLength(3);
    expect(own.every((c) => c.headers.get('authorization') === 'Bearer k-chat')).toBe(true);
    expect(api).toHaveLength(0);
  });

  it('chat on Anthropic, analysis on Anthropic, scores on the own endpoint with their own keys', async () => {
    const { own, ant } = world({
      anthropic: (c) =>
        c.body?.stream
          ? sse([event('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }) + event('message_stop', { type: 'message_stop' })])
          : json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(ANALYSIS) }] }),
      endpoint: () => json(logprobs({ '1': 1 })),
    });
    const p = provider({ chat: claude, analysis: 'same', scores: mine }, { chat: 'k-claude', scores: 'k-scores' });
    expect(p.kind).toBe('anthropic');
    expect((await p.chat(chatReq, () => {}, signal())).text).toBe('Hi');
    await p.json('analyze', analyzeInput, signal());
    expect((await p.score!({ question: 'correct', statement: 'a', reference: 'a' }, signal())).p).toBe(1);
    expect(ant.map((c) => c.headers.get('x-api-key'))).toEqual(['k-claude', 'k-claude']);
    expect(own.map((c) => c.headers.get('authorization'))).toEqual(['Bearer k-scores']);
  });

  it('scores off: no score at all, so turns keep the analysis numbers', () => {
    expect(provider({ chat: mine, analysis: 'same', scores: 'off' }).score).toBeUndefined();
    expect(provider({ chat: mine, analysis: 'same', scores: 'same' }).score).toBeTypeOf('function');
  });

  it('scores the same as an Anthropic chat fail loudly: Claude gives no token probabilities', async () => {
    const { ant } = world({});
    const e = await provider({ chat: claude, analysis: 'same', scores: 'same' }, { chat: 'k' }).score!({ question: 'thinking', text: 'x', recent: [] }, signal()).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect([e.code, e.message.includes('no token probabilities')]).toEqual(['no_scores', true]);
    expect(ant).toHaveLength(0);
  });

  it('a role on the group backend goes through /api/ai/* (analysis there, chat on the own endpoint)', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    const { api, own } = world({
      backend: (c) =>
        c.path === '/api/ai/complete'
          ? json({ output: ANALYSIS, model: 'claude-backend' })
          : c.path === '/api/ai/score'
            ? json({ probabilities: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 0 }, model: 'glm' })
            : json({}, 404),
      endpoint: () => sse([delta('Hi') + DONE]),
    });
    const p = provider({ chat: mine, analysis: connectionOf('arbor'), scores: connectionOf('arbor') });
    await p.chat(chatReq, () => {}, signal());
    await p.json('analyze', analyzeInput, signal());
    expect((await p.score!({ question: 'thinking', text: 'I think', recent: [] }, signal())).p).toBe(0.75);
    expect(own.map((c) => c.path)).toEqual(['/chat/completions']);
    expect(api.map((c) => c.path)).toEqual(['/api/ai/complete', '/api/ai/score']);
  });

  it('an unknown model gets the endpoint’s model list in the message', async () => {
    world({ endpoint: (c) => (c.path === '/models' ? json({ data: [{ id: 'llama3.2' }, { id: 'qwen3:8b' }] }) : json({ error: 'model "llama9" not found, try pulling it first' }, 404)) });
    const e = await provider({ chat: { ...mine, preset: 'ollama', model: 'llama9' }, analysis: 'same', scores: 'off' })
      .chat(chatReq, () => {}, signal())
      .catch((x) => x);
    expect(e.code).toBe('model');
    expect(e.message).toContain('does not know the model "llama9"');
    expect(e.message).toContain('Models there: llama3.2, qwen3:8b.');
  });
});

describe('own provider: test connection', () => {
  it('reports per role: works with the model and the JSON mode, or what failed; arbor and off are not tested', async () => {
    world({
      endpoint: (c) =>
        c.body?.stream
          ? sse([delta('Hello') + DONE])
          : c.body?.response_format
            ? json({ error: { message: 'response_format json_schema is not supported' } }, 400)
            : json(completion('{"mode":"own","note":null,"words":[{"word":"tree"}]}')),
    });
    const r = await provider({ chat: mine, analysis: 'same', scores: connectionOf('arbor') }).test(signal());
    expect(r.chat).toMatchObject({ status: 'ok', model: 'test-model' });
    expect(r.analysis).toMatchObject({ status: 'ok', mode: 'prompt' });
    expect(r.scores).toEqual({ status: 'skipped', why: 'arbor' });
    expect((await provider({ chat: mine, analysis: 'same', scores: 'off' }).test(signal())).scores).toEqual({ status: 'skipped', why: 'off' });
  });

  it('a model without logprobs: "cannot give scores"; anthropic scores: the same, without a call', async () => {
    world({
      endpoint: (c) => (c.body?.stream ? sse([delta('Hi') + DONE]) : c.body?.logprobs ? json(completion('1')) : json(completion('{"mode":"own","note":null,"words":[]}'))),
      anthropic: () => json({}, 500),
    });
    const r = await provider({ chat: mine, analysis: 'same', scores: 'same' }).test(signal());
    expect(r.analysis).toMatchObject({ status: 'ok', mode: 'schema' });
    expect(r.scores).toMatchObject({ status: 'failed', code: 'no_scores' });
    expect((r.scores as { error: string }).error).toContain('cannot give scores');
    const a = await provider({ chat: claude, analysis: 'same', scores: 'same' }, { chat: 'k' }).test(signal());
    expect(a.scores).toMatchObject({ status: 'failed', code: 'no_scores' });
  });

  it('a network failure is reported per role with the fix', async () => {
    world({
      endpoint: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const r = await provider({ chat: { ...mine, preset: 'lmstudio' }, analysis: 'same', scores: 'off' }).test(signal());
    expect(r.chat).toMatchObject({ status: 'failed', code: 'network' });
    expect((r.chat as { error: string }).error).toContain('CORS');
  });

  it('lists a role’s models; the group backend has none to pick', async () => {
    world({ endpoint: () => json({ data: [{ id: 'b' }, { id: 'a' }] }) });
    const p = provider({ chat: mine, analysis: connectionOf('arbor'), scores: 'same' });
    expect(await p.listModels('chat')).toEqual(['a', 'b']);
    expect(await p.listModels('analysis')).toEqual([]);
  });
});

describe('own setup', () => {
  it('a saved setup of any shape becomes a valid one; unknown presets get the default', () => {
    expect(parseSetup(null)).toEqual(DEFAULT_SETUP);
    expect(parseSetup({ chat: { preset: 'toString' }, analysis: 'off', scores: 'off' })).toEqual({ ...DEFAULT_SETUP, scores: 'off' });
    expect(parseSetup({ chat: { preset: 'ollama', model: 'qwen3' }, analysis: claude, scores: 'same' })).toEqual({
      chat: { preset: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3' },
      analysis: claude,
      scores: 'same',
    });
  });
});
