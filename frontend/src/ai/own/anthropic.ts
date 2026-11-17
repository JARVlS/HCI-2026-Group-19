import { sseEvents } from '../../lib/api';
import { ProviderError } from '../provider';
import { listModels, nameOf, readJson, send, toProviderError, type Target } from './http';
import type { ChatCall, JsonCall, ModelApi } from './types';

/**
 * The Anthropic Messages API (`POST {base}/v1/messages`) with the user's own key, called from the
 * browser. The request shape mirrors the group backend's (`backend/src/llm.py`, checked against the
 * real API): JSON outputs through `output_config.format` (forced tool use returns 400 on newer
 * models), no `temperature`/`top_p` (version 2026-10-21 rejects them), no `thinking`, and no
 * `effort` either (some models, e.g. Claude Haiku 4.5, reject it). Claude returns no token
 * probabilities, so this connection gives no scores.
 */

export const ANTHROPIC_VERSION = '2026-10-21';
/** The backend's caps (MAX_TOKENS_CHAT, MAX_TOKENS_JSON). */
const MAX_TOKENS = 4096;

const REFUSAL = 'Claude declined to answer this request (stop_reason: refusal).';

/** The fields of a stream event that matter here (message_start, content_block_delta, message_delta, error). */
interface StreamEvent {
  type?: string;
  message?: { model?: unknown };
  delta?: { type?: unknown; text?: unknown; stop_reason?: unknown };
  error?: { type?: unknown; message?: unknown };
}

export class Anthropic implements ModelApi {
  constructor(private readonly t: Target) {}

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.t.key,
      'anthropic-version': ANTHROPIC_VERSION,
      // Anthropic's opt-in for calls straight from a browser (CORS); the key is the user's own.
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  private body(system: string, messages: ChatCall['messages'], extra: object) {
    return { model: this.t.model, max_tokens: MAX_TOKENS, ...(system && { system }), messages, ...extra };
  }

  async chat({ system, messages }: ChatCall, onDelta: (text: string) => void, signal: AbortSignal) {
    try {
      const res = await send(this.t, '/v1/messages', { body: this.body(system, messages, { stream: true }), headers: this.headers(), signal });
      let text = '';
      let model = this.t.model;
      let stop: unknown = null;
      for await (const { event, data } of sseEvents(res, signal)) {
        let d: StreamEvent;
        try {
          d = JSON.parse(data) as StreamEvent;
        } catch {
          throw new ProviderError(`${nameOf(this.t)} sent an unreadable event: ${data.slice(0, 80)}`, 'upstream');
        }
        const type = event === 'message' ? d.type : event;
        if (type === 'message_start' && typeof d.message?.model === 'string') model = d.message.model;
        else if (type === 'content_block_delta' && d.delta?.type === 'text_delta' && typeof d.delta.text === 'string') {
          text += d.delta.text;
          onDelta(d.delta.text);
        } else if (type === 'message_delta') stop = d.delta?.stop_reason ?? stop;
        else if (type === 'error') throw new ProviderError(`${nameOf(this.t)} failed: ${String(d.error?.message ?? d.error?.type ?? 'stream error')}`, 'upstream');
        else if (type === 'message_stop') {
          if (stop === 'refusal') throw new ProviderError(REFUSAL, 'upstream');
          return { text, model };
        }
      }
      throw new ProviderError('The reply broke off before it was complete.', 'network');
    } catch (e) {
      throw toProviderError(e, signal);
    }
  }

  async json<T>(call: JsonCall<T>, signal: AbortSignal) {
    try {
      const body = this.body(call.system, [{ role: 'user', content: call.user }], { output_config: { format: { type: 'json_schema', schema: call.schema } } });
      const data = (await readJson(this.t, await send(this.t, '/v1/messages', { body, headers: this.headers(), signal }))) as {
        model?: unknown;
        stop_reason?: unknown;
        content?: { type?: unknown; text?: unknown }[];
      };
      if (data.stop_reason === 'refusal') throw new ProviderError(REFUSAL, 'upstream');
      if (data.stop_reason === 'max_tokens') throw new ProviderError('The structured answer hit max_tokens and is incomplete.', 'invalid_output');
      const text = (data.content ?? []).flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ProviderError('The structured answer was not valid JSON.', 'invalid_output');
      }
      return { value: call.read(raw), mode: 'schema' as const, model: typeof data.model === 'string' ? data.model : this.t.model };
    } catch (e) {
      throw toProviderError(e, signal);
    }
  }

  models(signal?: AbortSignal) {
    return listModels(this.t, '/v1/models', this.headers(), signal);
  }
}
