import { sseEvents } from '../../lib/api';
import { scaleScore, type ScorePrompt } from '../prompts/score';
import { ProviderError, type ScoreResult } from '../provider';
import { EndpointError, listModels, nameOf, readJson, send, toProviderError, type Target } from './http';
import type { ChatCall, JsonCall, JsonMode, ModelApi } from './types';

/**
 * The OpenAI chat completions format (`POST {base}/chat/completions`), spoken by OpenAI,
 * OpenRouter, Groq, vLLM, LiteLLM, Ollama and LM Studio. Chat streams; structured output uses
 * `response_format: json_schema`; scores come from the first token's logprobs, as in the group
 * backend's fast slot (`backend/src/scoring.py`).
 */

/**
 * The structured-output mode per endpoint and model, for this visit: once an endpoint has shown
 * it has no json_schema support, its calls go out in prompt mode right away.
 */
export const JSON_MODES = new Map<string, JsonMode>();

/** The most OpenAI allows; an option counts only if it is among them. */
export const TOP_LOGPROBS = 20;
/** Below this the model mostly answered something else, and the score means little. */
export const MIN_MASS = 0.5;

export const SCORES_FIX = 'Set scores to off or to the group backend in settings → model.';

export const JSON_ONLY = 'Answer with one JSON object and nothing else: no code fences, no text before or after it. It must match this JSON schema:';
const repair = (why: string) => `That answer could not be used (${why}). Answer again with only the JSON object that matches the schema.`;

/** An endpoint saying it cannot do `response_format: json_schema`. */
const NO_JSON_SCHEMA = /response_format|json_schema|json schema|structured|format/i;

type Message = { role: 'system' | 'user' | 'assistant'; content: string };
const withSystem = (system: string, messages: ChatCall['messages']): Message[] => [...(system ? [{ role: 'system' as const, content: system }] : []), ...messages];

const errorText = (e: unknown) => (typeof e === 'string' ? e : typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message : JSON.stringify(e));

/** JSON from a model's text: `<think>` blocks and a code fence around it are dropped; anything else must be the object. */
export function parseJsonText(text: string): unknown {
  const body = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const inner = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body)?.[1] ?? body;
  try {
    return JSON.parse(inner);
  } catch {
    throw new ProviderError(`the answer is not valid JSON: ${body.replace(/\s+/g, ' ').slice(0, 80)}`, 'invalid_output');
  }
}

/**
 * The options' probabilities from the top logprobs of the first generated token. A token counts
 * for an option when it equals the option after trimming whitespace ("1" and " 1"); each option
 * gets its share of the options' summed probability. No logprobs, or options holding less than
 * MIN_MASS, means this model cannot give scores (`no_scores`).
 */
export function optionProbabilities(data: unknown, options: string[]): Record<string, number> {
  const top = (data as { choices?: { logprobs?: { content?: { top_logprobs?: unknown }[] } | null }[] } | null)?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
  if (!Array.isArray(top) || !top.length) throw new ProviderError(`This model returns no token probabilities, so it cannot give scores. ${SCORES_FIX}`, 'no_scores');
  const found = new Map(options.map((o) => [o, 0]));
  let likeliest = { token: '', logprob: -Infinity };
  for (const item of top as { token?: unknown; logprob?: unknown }[]) {
    if (typeof item.token !== 'string' || typeof item.logprob !== 'number') continue;
    if (item.logprob > likeliest.logprob) likeliest = { token: item.token, logprob: item.logprob };
    const option = item.token.trim();
    if (found.has(option)) found.set(option, found.get(option)! + Math.exp(item.logprob));
  }
  const total = [...found.values()].reduce((a, b) => a + b, 0);
  if (total < MIN_MASS) {
    throw new ProviderError(
      `This model did not answer with one of ${options.join(', ')} (they hold ${Math.round(total * 100)} % of its first token, its likeliest was ${JSON.stringify(likeliest.token)}), so it cannot give scores. ${SCORES_FIX}`,
      'no_scores',
    );
  }
  return Object.fromEntries([...found].map(([o, p]) => [o, p / total]));
}

interface Completion {
  text: string;
  model: string;
  /** The answer hit the token limit. */
  truncated: boolean;
}

export class OpenAICompatible implements ModelApi {
  constructor(
    private readonly t: Target,
    private readonly modes: Map<string, JsonMode> = JSON_MODES,
  ) {}

  private headers(): Record<string, string> {
    return this.t.key ? { authorization: `Bearer ${this.t.key}` } : {};
  }

  private post(body: object, signal?: AbortSignal) {
    return send(this.t, '/chat/completions', { body: { model: this.t.model, ...body }, headers: this.headers(), signal });
  }

  private parse(data: string): Record<string, unknown> {
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new ProviderError(`${nameOf(this.t)} sent an unreadable event: ${data.slice(0, 80)}`, 'upstream');
    }
  }

  async chat({ system, messages }: ChatCall, onDelta: (text: string) => void, signal: AbortSignal) {
    try {
      const res = await this.post({ messages: withSystem(system, messages), stream: true }, signal);
      let text = '';
      let model = this.t.model;
      let finished = false;
      for await (const { data } of sseEvents(res, signal)) {
        if (data.trim() === '[DONE]') {
          finished = true;
          break;
        }
        const chunk = this.parse(data) as { error?: unknown; model?: unknown; choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[] };
        if (chunk.error) throw new ProviderError(`${nameOf(this.t)} failed: ${errorText(chunk.error)}`, 'upstream');
        if (typeof chunk.model === 'string' && chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta) {
          text += delta;
          onDelta(delta);
        }
        if (choice?.finish_reason) finished = true;
      }
      if (!finished) throw new ProviderError('The reply broke off before it was complete.', 'network');
      return { text, model };
    } catch (e) {
      throw toProviderError(e, signal);
    }
  }

  /** One call without streaming: the text of the first choice. */
  private async complete(body: object, signal: AbortSignal): Promise<Completion> {
    const data = (await readJson(this.t, await this.post(body, signal))) as { model?: unknown; choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] };
    const choice = data?.choices?.[0];
    return {
      text: typeof choice?.message?.content === 'string' ? choice.message.content : '',
      model: typeof data?.model === 'string' && data.model ? data.model : this.t.model,
      truncated: choice?.finish_reason === 'length',
    };
  }

  /**
   * Structured output: `response_format: json_schema` first. An endpoint that refuses it (or
   * ignores it and answers in prose) is asked in prompt mode from then on: the schema goes into
   * the prompt, and an answer that is not valid JSON (or does not fit) gets one repair retry.
   */
  async json<T>(call: JsonCall<T>, signal: AbortSignal) {
    const key = `${this.t.baseUrl} ${this.t.model}`;
    try {
      if (this.modes.get(key) !== 'prompt') {
        const answer = await this.schemaCall(call, signal);
        if (answer) return answer;
        this.modes.set(key, 'prompt');
      }
      return await this.promptCall(call, signal);
    } catch (e) {
      throw toProviderError(e, signal);
    }
  }

  /** The schema-mode answer, or null when the endpoint has no json_schema support. */
  private async schemaCall<T>(call: JsonCall<T>, signal: AbortSignal) {
    let answer: Completion;
    try {
      answer = await this.complete(
        {
          messages: withSystem(call.system, [{ role: 'user', content: call.user }]),
          response_format: { type: 'json_schema', json_schema: { name: call.name, schema: call.schema, strict: true } },
        },
        signal,
      );
    } catch (e) {
      if (e instanceof EndpointError && [400, 422, 501].includes(e.status) && NO_JSON_SCHEMA.test(e.detail)) return null;
      throw e;
    }
    if (answer.truncated) throw new ProviderError('The structured answer hit the token limit and is incomplete.', 'invalid_output');
    let raw: unknown;
    try {
      raw = JSON.parse(answer.text);
    } catch {
      // Constrained output is always JSON: prose means the endpoint ignored `response_format`.
      return null;
    }
    return { value: call.read(raw), mode: 'schema' as const, model: answer.model };
  }

  private async promptCall<T>(call: JsonCall<T>, signal: AbortSignal) {
    const system = `${call.system}\n\n${JSON_ONLY}\n${JSON.stringify(call.schema)}`;
    const ask: ChatCall['messages'] = [{ role: 'user', content: call.user }];
    const read = (a: Completion) => {
      if (a.truncated) throw new ProviderError('the answer hit the token limit and is incomplete', 'invalid_output');
      return { value: call.read(parseJsonText(a.text)), mode: 'prompt' as const, model: a.model };
    };
    const first = await this.complete({ messages: withSystem(system, ask) }, signal);
    try {
      return read(first);
    } catch (e) {
      if (!(e instanceof ProviderError && e.code === 'invalid_output')) throw e;
      const fix: ChatCall['messages'] = [...ask, { role: 'assistant', content: first.text }, { role: 'user', content: repair(e.message) }];
      return read(await this.complete({ messages: withSystem(system, fix) }, signal));
    }
  }

  /** G-Eval: one greedy token and its top logprobs (the body of the backend's fast slot). */
  async score({ system, messages, scale }: ScorePrompt, signal: AbortSignal): Promise<ScoreResult> {
    try {
      let data: unknown;
      try {
        const body = { messages: withSystem(system, messages), max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: TOP_LOGPROBS };
        data = await readJson(this.t, await this.post(body, signal));
      } catch (e) {
        if (e instanceof EndpointError && e.status === 400 && /logprob/i.test(e.detail)) {
          throw new ProviderError(`${nameOf(this.t)} gives no token probabilities for this model, so it cannot give scores. ${SCORES_FIX}`, 'no_scores');
        }
        throw e;
      }
      const distribution = optionProbabilities(data, Object.keys(scale));
      const p = scaleScore(distribution, scale);
      if (p === null) throw new ProviderError('The score lacks a probability for an option of the scale.', 'invalid_output');
      const model = (data as { model?: unknown }).model;
      return { p, model: typeof model === 'string' && model ? model : this.t.model, distribution };
    } catch (e) {
      throw toProviderError(e, signal);
    }
  }

  models(signal?: AbortSignal) {
    return listModels(this.t, '/models', this.headers(), signal);
  }
}
