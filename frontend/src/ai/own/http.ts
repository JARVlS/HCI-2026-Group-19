import { ApiError } from '../../lib/api';
import { ProviderError, type ProviderErrorCode } from '../provider';
import { PRESETS, type PresetId } from './setup';

/**
 * Calls from the browser straight to the user's own endpoint (M7), and what their failures mean
 * for the user. Every failure is a ProviderError whose message says what to fix; the key is never
 * part of a message.
 */

/** One endpoint with the key for it. */
export interface Target {
  preset: PresetId;
  baseUrl: string;
  model: string;
  key: string;
}

/** A failed answer of the endpoint: the ProviderError the UI shows, plus the HTTP status and the endpoint's own words. */
export class EndpointError extends ProviderError {
  constructor(
    message: string,
    code: ProviderErrorCode,
    readonly status: number,
    readonly detail: string,
  ) {
    super(message, code);
  }
}

/** The name the user picked the endpoint by (its preset), for messages. */
export const nameOf = (t: Target) => (t.preset === 'custom' ? 'your endpoint' : PRESETS[t.preset].label);
const origin = () => globalThis.location?.origin ?? 'this page’s address';
const LOCAL_ACCESS = 'If the browser asks to access devices on your local network, allow it.';

/** What to do when the browser could not reach the endpoint (no answer, or blocked by CORS: the browser does not tell which). */
export function networkFix(t: Target): string {
  switch (t.preset) {
    case 'ollama':
      return `Start Ollama with OLLAMA_ORIGINS=${origin()} so it allows this page, and check that it runs at ${t.baseUrl}. ${LOCAL_ACCESS}`;
    case 'lmstudio':
      return `In LM Studio, start the server and switch on CORS in its server settings. ${LOCAL_ACCESS}`;
    case 'custom':
      return `Your server needs CORS headers that allow ${origin()}, and HTTPS unless it runs on this computer (or use a tunnel such as cloudflared). ${LOCAL_ACCESS}`;
    default:
      return `Check the base URL (${t.baseUrl}) and your internet connection.`;
  }
}

const isLocalHost = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** Refuse calls that cannot work, before they go out. Listing the models needs no model name. */
function check(t: Target, needsModel: boolean): URL {
  let url: URL;
  try {
    url = new URL(t.baseUrl);
  } catch {
    throw new ProviderError(`Set a base URL for ${nameOf(t)} in settings → model (it starts with https://).`, 'network');
  }
  // A page served over HTTPS may not call plain http:// (mixed content), except this computer.
  if (globalThis.location?.protocol === 'https:' && url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new ProviderError(`This page is served over HTTPS, so the browser blocks ${t.baseUrl}. Give your server HTTPS, or use a tunnel such as cloudflared.`, 'network');
  }
  if (needsModel && !t.model.trim()) throw new ProviderError(`Set a model for ${nameOf(t)} in settings → model.`, 'model');
  if (PRESETS[t.preset].needsKey && !t.key) throw new ProviderError(`${nameOf(t)} needs your key: type it in settings → model.`, 'auth');
  return url;
}

/** The endpoint's own words from an error body: OpenAI `{error:{message}}`, Anthropic the same, Ollama `{error:"…"}`, vLLM `{message}`. */
async function detailOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const b = JSON.parse(text) as Record<string, unknown>;
    const e = b.error as Record<string, unknown> | string | undefined;
    const m = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : typeof b.message === 'string' ? b.message : typeof b.detail === 'string' ? b.detail : null;
    if (m) return m;
  } catch {
    /* not JSON: the text itself */
  }
  return text.trim().slice(0, 200);
}

const MODEL_UNKNOWN = /model\b.*\b(not found|not exist|unknown|not available|invalid)|\b(unknown|invalid|no such) model|not a valid model/i;

/** A non-2xx answer → the error the user can act on. */
export function explain(t: Target, status: number, rawDetail: string): EndpointError {
  const detail = t.key ? rawDetail.split(t.key).join('[key]') : rawDetail;
  const theirs = detail ? ` (${nameOf(t)} says: ${detail})` : '';
  if (status === 401 || status === 403)
    return new EndpointError(`${nameOf(t)} refused the key (HTTP ${status})${theirs}. Check the key in settings → model.`, 'auth', status, detail);
  if (status === 404 || MODEL_UNKNOWN.test(detail))
    return new EndpointError(`${nameOf(t)} does not know the model "${t.model}" (HTTP ${status})${theirs}. Check the model name, or the base URL (it usually ends in /v1).`, 'model', status, detail);
  if (status === 429)
    return new EndpointError(`${nameOf(t)} says you hit its limit (HTTP 429)${theirs}. Wait a moment, or check your plan with ${nameOf(t)}.`, 'rate_limited', status, detail);
  if (status >= 500) return new EndpointError(`${nameOf(t)} failed (HTTP ${status})${theirs}. Try again.`, 'upstream', status, detail);
  return new EndpointError(`${nameOf(t)} refused the request (HTTP ${status})${theirs}.`, 'unknown', status, detail);
}

/** Any failure inside a call → a ProviderError: abort, a dropped stream, or one that already is. */
export function toProviderError(e: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return new ProviderError('stopped', 'aborted');
  if (e instanceof ProviderError) return e;
  // From `sseEvents`: the stream broke off after it started (not CORS), or came without a body.
  if (e instanceof ApiError) return new ProviderError(e.message, e.code === 'network' ? 'network' : 'upstream');
  return new ProviderError(e instanceof Error ? e.message : String(e), 'unknown');
}

/**
 * GET (no body) or POST JSON to `{baseUrl}{path}`. Resolves only for a 2xx answer; everything
 * else is a ProviderError (an EndpointError when the endpoint answered).
 */
export async function send(t: Target, path: string, { body, headers, signal }: { body?: unknown; headers: Record<string, string>; signal?: AbortSignal }): Promise<Response> {
  const url = check(t, body !== undefined);
  let res: Response;
  try {
    res = await fetch(`${url.href.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new ProviderError('stopped', 'aborted');
    throw new ProviderError(`${nameOf(t)} did not answer, or did not allow this page to call it (${e instanceof Error ? e.message : String(e)}). ${networkFix(t)}`, 'network');
  }
  if (!res.ok) throw explain(t, res.status, await detailOf(res));
  return res;
}

/** The JSON body of a 2xx answer. */
export async function readJson(t: Target, res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ProviderError(`${nameOf(t)} sent an answer that is not JSON.`, 'upstream');
  }
}

/** The ids of a model list: `{ data: [{ id }] }` in both the OpenAI and the Anthropic format. */
export function modelIds(raw: unknown): string[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((m) => (typeof m?.id === 'string' && m.id ? [m.id as string] : [])).sort();
}

/** `GET {base}{path}`: the endpoint's model ids. A 404 here means the endpoint has no list, not an unknown model. */
export async function listModels(t: Target, path: string, headers: Record<string, string>, signal?: AbortSignal): Promise<string[]> {
  try {
    return modelIds(await readJson(t, await send(t, path, { headers, signal })));
  } catch (e) {
    if (e instanceof EndpointError && e.status === 404) throw new ProviderError(`${nameOf(t)} has no model list at ${path} (HTTP 404). Type the model name.`, 'unknown');
    throw toProviderError(e, signal);
  }
}

/** Ask a model-not-found error to list what the endpoint has instead (one GET; no list: the error as it was). */
export async function withModelList(e: unknown, list: () => Promise<string[]>): Promise<unknown> {
  if (!(e instanceof EndpointError) || e.code !== 'model') return e;
  const models = await list().catch(() => []);
  if (!models.length) return e;
  const shown = models.slice(0, 12).join(', ') + (models.length > 12 ? ` and ${models.length - 12} more` : '');
  return new EndpointError(`${e.message} Models there: ${shown}.`, e.code, e.status, e.detail);
}
