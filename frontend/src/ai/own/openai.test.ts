import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, sse } from '../../test/backend';
import { chunk, completion, delta, DONE, ENDPOINT, fakeEndpoint, finish, logprobs, type EndpointCall } from '../../test/endpoint';
import { CORRECT_SCALE, scorePrompt, THINKING_SCALE } from '../prompts/score';
import { ProviderError } from '../provider';
import type { Target } from './http';
import { JSON_ONLY, OpenAICompatible, parseJsonText } from './openai';
import type { JsonCall, JsonMode } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

const target = (over: Partial<Target> = {}): Target => ({ preset: 'openai', baseUrl: ENDPOINT, model: 'gpt-test', key: 'sk-secret-123', ...over });
const api = (over: Partial<Target> = {}, modes = new Map<string, JsonMode>()) => new OpenAICompatible(target(over), modes);
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

const chat = (a = api(), s = signal()) => {
  const deltas: string[] = [];
  return { deltas, result: a.chat({ system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] }, (d) => deltas.push(d), s) };
};

/** A JSON call with a tiny schema; `read` accepts `{ ok: true }` only. */
const call: JsonCall<{ ok: boolean }> = {
  name: 'test',
  system: 'Judge.',
  user: 'Is it ok?',
  schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
  read: (raw) => {
    if ((raw as { ok?: unknown })?.ok !== true) throw new ProviderError('the analysis did not fit its schema: ok is not true', 'invalid_output');
    return { ok: true };
  },
};

const noSchema = () => json({ error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.", type: 'invalid_request_error' } }, 400);

describe('openai-compatible: chat', () => {
  it('streams data chunks split anywhere across network reads, ends at [DONE], and sends the system prompt first', async () => {
    const stream = delta('Grüße ') + delta('from ') + delta('the model.') + finish() + DONE;
    const bytes = new TextEncoder().encode(stream);
    // Cut inside the JSON and between the two bytes of "ü" (everything before it is ASCII).
    const ends = [7, stream.indexOf('ü') + 1, 90, 200, bytes.length];
    const calls = fakeEndpoint(() => sse(ends.map((end, i) => bytes.slice(i ? ends[i - 1] : 0, end))));
    const { deltas, result } = chat();
    expect(await result).toEqual({ text: 'Grüße from the model.', model: 'test-model' });
    expect(deltas).toEqual(['Grüße ', 'from ', 'the model.']);
    expect(calls[0]).toMatchObject({ path: '/chat/completions', method: 'POST' });
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-secret-123');
    expect(calls[0].body).toEqual({ model: 'gpt-test', stream: true, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }] });
  });

  it('no key: no authorization header (a local server)', async () => {
    const calls = fakeEndpoint(() => sse([delta('ok') + DONE]));
    await chat(api({ preset: 'ollama', key: '' })).result;
    expect(calls[0].headers.has('authorization')).toBe(false);
  });

  it('an error body is the provider error, with the key never in the message', async () => {
    fakeEndpoint(() => json({ error: { message: 'Incorrect API key provided: sk-secret-123.', type: 'invalid_request_error' } }, 401));
    const e = await failure(chat().result);
    expect(e.code).toBe('auth');
    expect(e.message).toContain('openai refused the key (HTTP 401)');
    expect(e.message).not.toContain('sk-secret-123');
    expect(e.message).toContain('[key]');
  });

  it('an error inside the stream is upstream; a stream without [DONE] or finish is a broken connection', async () => {
    fakeEndpoint(() => sse([delta('Hal') + chunk({ error: { message: 'overloaded' } })]));
    const e = await failure(chat().result);
    expect([e.code, e.message]).toEqual(['upstream', 'openai failed: overloaded']);
    vi.unstubAllGlobals();
    fakeEndpoint(() => sse([delta('Hal')]));
    expect((await failure(chat().result)).code).toBe('network');
  });

  it('a finish reason without [DONE] is complete', async () => {
    fakeEndpoint(() => sse([delta('Hi') + finish()]));
    expect((await chat().result).text).toBe('Hi');
  });

  it('stop aborts the request itself', async () => {
    const c = new AbortController();
    let seen: EndpointCall | undefined;
    fakeEndpoint((call) => {
      seen = call;
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(new TextEncoder().encode(delta('Hal')));
          call.signal?.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body);
    });
    const { deltas, result } = chat(api(), c.signal);
    await vi.waitFor(() => expect(deltas).toEqual(['Hal']));
    c.abort();
    expect((await failure(result)).code).toBe('aborted');
    expect(seen!.signal!.aborted).toBe(true);
  });
});

describe('openai-compatible: structured output', () => {
  it('asks with response_format json_schema (strict) and reads the answer', async () => {
    const calls = fakeEndpoint(() => json(completion('{"ok":true}')));
    expect(await api().json(call, signal())).toEqual({ value: { ok: true }, mode: 'schema', model: 'test-model' });
    expect(calls[0].body).toMatchObject({
      model: 'gpt-test',
      messages: [{ role: 'system', content: 'Judge.' }, { role: 'user', content: 'Is it ok?' }],
      response_format: { type: 'json_schema', json_schema: { name: 'test', schema: call.schema, strict: true } },
    });
    expect(calls[0].body).not.toHaveProperty('stream');
  });

  it('an endpoint without json_schema support switches to prompt mode for the rest of the visit', async () => {
    const modes = new Map<string, JsonMode>();
    const calls = fakeEndpoint((c) => (c.body?.response_format ? noSchema() : json(completion('```json\n{"ok": true}\n```'))));
    expect((await api({}, modes).json(call, signal())).mode).toBe('prompt');
    expect(calls).toHaveLength(2);
    expect(calls[1].body).not.toHaveProperty('response_format');
    const system = (calls[1].body!.messages as { content: string }[])[0].content;
    expect(system).toContain(JSON_ONLY);
    expect(system).toContain(JSON.stringify(call.schema));
    // The next call (a new connection object, the same endpoint and model) goes out in prompt mode at once.
    expect((await api({}, modes).json(call, signal())).mode).toBe('prompt');
    expect(calls).toHaveLength(3);
    // Another model at the same endpoint is tried with the schema again.
    await api({ model: 'other' }, modes).json(call, signal());
    expect(calls[3].body).toHaveProperty('response_format');
  });

  it('an endpoint that ignores response_format and answers in prose is asked in prompt mode', async () => {
    const calls = fakeEndpoint((c) => json(completion(c.body?.response_format ? 'Sure! It is ok.' : '{"ok":true}')));
    expect(await api().json(call, signal())).toMatchObject({ value: { ok: true }, mode: 'prompt' });
    expect(calls).toHaveLength(2);
  });

  it('prompt mode: invalid JSON gets exactly one repair retry with the bad answer and the reason', async () => {
    const modes = new Map<string, JsonMode>([[`${ENDPOINT} gpt-test`, 'prompt']]);
    const answers = ['Here you go: {ok: true', '<think>easy</think>{"ok": true}'];
    const calls = fakeEndpoint(() => json(completion(answers.shift()!)));
    expect((await api({}, modes).json(call, signal())).value).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    const retry = calls[1].body!.messages as { role: string; content: string }[];
    expect(retry.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(retry[2].content).toBe('Here you go: {ok: true');
    expect(retry[3].content).toContain('not valid JSON');
  });

  it('prompt mode: JSON that does not fit the schema is repaired too; a second miss is invalid_output', async () => {
    const modes = new Map<string, JsonMode>([[`${ENDPOINT} gpt-test`, 'prompt']]);
    const calls = fakeEndpoint(() => json(completion('{"ok": false}')));
    const e = await failure(api({}, modes).json(call, signal()));
    expect(e.code).toBe('invalid_output');
    expect(calls).toHaveLength(2);
    expect((calls[1].body!.messages as { content: string }[])[3].content).toContain('did not fit its schema');
  });

  it('a structured answer cut by the token limit is invalid_output, not a reason to switch modes', async () => {
    const modes = new Map<string, JsonMode>();
    fakeEndpoint(() => json(completion('{"ok": tr', 'length')));
    expect((await failure(api({}, modes).json(call, signal()))).code).toBe('invalid_output');
    expect(modes.size).toBe(0);
  });

  it('parseJsonText drops <think> blocks and a code fence, nothing else', () => {
    expect(parseJsonText('<think>hm</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonText('The answer is {"a":1}')).toThrow(ProviderError);
  });
});

describe('openai-compatible: scores from logprobs', () => {
  const thinking = scorePrompt({ question: 'thinking', text: 'I think it is 4', recent: [] });

  it('asks for one token with its top 20 logprobs and weighs each option share (whitespace-prefixed tokens count)', async () => {
    const calls = fakeEndpoint(() => json(logprobs({ '4': 0.5, ' 4': 0.2, '5': 0.2, '3': 0.05, hello: 0.05 })));
    const { p, model, distribution } = await api().score(thinking, signal());
    // Options hold 0.95 of the mass: 4 → 0.7/0.95, 5 → 0.2/0.95, 3 → 0.05/0.95.
    const expected = (0.7 * THINKING_SCALE['4'] + 0.2 * THINKING_SCALE['5'] + 0.05 * THINKING_SCALE['3']) / 0.95;
    expect(p).toBeCloseTo(expected, 6);
    expect(Object.keys(distribution!)).toEqual(['1', '2', '3', '4', '5']);
    expect(distribution!['4']).toBeCloseTo(0.7 / 0.95, 6);
    expect(model).toBe('test-model');
    expect(calls[0].body).toMatchObject({ model: 'gpt-test', max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20 });
    expect((calls[0].body!.messages as { role: string }[])[0].role).toBe('system');
  });

  it('the correct scale: right → 1, partly → 0.5, wrong → 0', async () => {
    fakeEndpoint(() => json(logprobs({ '1': 0.6, '2': 0.3, '3': 0.1 })));
    const { p } = await api().score(scorePrompt({ question: 'correct', statement: 'a', reference: 'a' }), signal());
    expect(p).toBeCloseTo(0.6 * CORRECT_SCALE['1'] + 0.3 * CORRECT_SCALE['2'], 6);
  });

  it('options holding under half the mass: this model cannot give scores (a control token first)', async () => {
    fakeEndpoint(() => json(logprobs({ '<|channel|>': 0.9, '4': 0.05 })));
    const e = await failure(api().score(thinking, signal()));
    expect(e.code).toBe('no_scores');
    expect(e.message).toContain('"<|channel|>"');
    expect(e.message).toContain('cannot give scores');
  });

  it('no logprobs in the answer, or an endpoint that refuses them: cannot give scores', async () => {
    fakeEndpoint(() => json({ ...completion('4'), choices: [{ index: 0, message: { content: '4' }, logprobs: null, finish_reason: 'length' }] }));
    expect((await failure(api().score(thinking, signal()))).code).toBe('no_scores');
    vi.unstubAllGlobals();
    fakeEndpoint(() => json({ error: { message: 'logprobs is not supported with this model' } }, 400));
    const e = await failure(api({ preset: 'groq' }).score(thinking, signal()));
    expect([e.code, e.message.startsWith('groq gives no token probabilities')]).toEqual(['no_scores', true]);
  });
});

describe('openai-compatible: models and errors', () => {
  it('lists the models of the endpoint (GET /models), sorted, without needing a model name', async () => {
    const calls = fakeEndpoint(() => json({ object: 'list', data: [{ id: 'zeta' }, { id: 'alpha' }] }));
    expect(await api({ model: '' }).models()).toEqual(['alpha', 'zeta']);
    expect(calls[0]).toMatchObject({ path: '/models', method: 'GET', body: null });
  });

  it('an endpoint without a model list says so (a 404 there is not an unknown model)', async () => {
    fakeEndpoint(() => json({ message: 'Not Found' }, 404));
    const e = await failure(api().models());
    expect(e.code).toBe('unknown');
    expect(e.message).toBe('openai has no model list at /models (HTTP 404). Type the model name.');
  });

  it.each([
    ['ollama', 'http://localhost:11434/v1', 'OLLAMA_ORIGINS='],
    ['lmstudio', 'http://localhost:1234/v1', 'switch on CORS'],
    ['custom', 'https://my.server/v1', 'CORS headers'],
    ['openai', 'https://api.openai.com/v1', 'Check the base URL'],
  ] as const)('no answer or CORS (%s): says the endpoint did not allow this page, and the fix', async (preset, baseUrl, fix) => {
    fakeEndpoint(() => {
      throw new TypeError('Failed to fetch');
    }, baseUrl);
    const e = await failure(chat(api({ preset, baseUrl, key: preset === 'openai' ? 'k' : '' })).result);
    expect(e.code).toBe('network');
    expect(e.message).toContain('did not allow this page to call it');
    expect(e.message).toContain(fix);
  });

  it('404 or "model not found" is the model; 429 is the provider limit; 5xx is upstream', async () => {
    const answers = [
      json({ error: { message: 'The model `gpt-9` does not exist' } }, 404),
      json({ error: 'model "llama9" not found, try pulling it first' }, 400),
      json({ error: { message: 'Rate limit reached' } }, 429),
      json({ error: { message: 'boom' } }, 503),
    ];
    fakeEndpoint(() => answers.shift()!);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await failure(chat().result)).code);
    expect(codes).toEqual(['model', 'model', 'rate_limited', 'upstream']);
  });

  it('refuses before the call: no key for a preset that needs one, no model, no base URL, http from an https page', async () => {
    const calls = fakeEndpoint(() => json({}));
    expect((await failure(chat(api({ key: '' })).result)).code).toBe('auth');
    expect((await failure(chat(api({ model: ' ' })).result)).code).toBe('model');
    expect((await failure(chat(api({ baseUrl: '' })).result)).code).toBe('network');
    vi.stubGlobal('location', { protocol: 'https:', origin: 'https://hci-2026-group-19.pages.dev' });
    const e = await failure(chat(api({ preset: 'custom', baseUrl: 'http://my.server/v1', key: '' })).result);
    expect(e.message).toContain('served over HTTPS');
    expect(calls).toHaveLength(0);
  });
});
