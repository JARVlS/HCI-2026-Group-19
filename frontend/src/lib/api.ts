/**
 * The HTTP side of the backend Worker (backend/docs/api.md): base URL, JSON calls, typed errors and
 * server-sent events. It knows nothing about sessions; `session.ts` adds the token.
 *
 * The base URL comes from VITE_API_URL: `.env.development` locally, the default in
 * `vite.config.ts` for production builds (the Cloudflare Pages project settings can override it).
 */
export const apiUrl = (): string => (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/**
 * A failed call. `status` is the HTTP status (0 when no answer arrived), `code` the backend's error
 * code (`budget_exceeded`, `upstream_error`, …) or one of ours: `network`, `no_backend`, `bad_stream`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface CallOptions {
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  signal?: AbortSignal;
  /** Default: GET without a body, POST with one. */
  method?: 'PUT';
  /** Let the request finish after the page is gone (`PUT /api/sync` on pagehide; bodies up to 64 KB). */
  keepalive?: boolean;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function errorOf(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `HTTP ${res.status}`);
}

/** GET without a body, POST (or `method`) with one. Resolves only for a 2xx answer. An abort rejects with the AbortError. */
async function request(path: string, body: unknown, { token, signal, method, keepalive }: CallOptions): Promise<Response> {
  const base = apiUrl();
  if (!base) throw new ApiError(0, 'no_backend', 'This build has no backend URL (VITE_API_URL is empty).');
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      keepalive: keepalive || undefined,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, 'network', `Could not reach the backend (${reason(e)}).`);
  }
  if (!res.ok) throw await errorOf(res);
  return res;
}

export async function api<T>(path: string, body?: unknown, opts: CallOptions = {}): Promise<T> {
  const res = await request(path, body, opts);
  return (await res.json()) as T;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/** An event with its data as text: the backend sends JSON, an OpenAI-style stream ends with `[DONE]`. */
export interface SseText {
  event: string;
  data: string;
}

/** One event block (`event: …` and `data: …` lines); null for comments and keep-alives. */
function parseBlock(block: string): SseText | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/**
 * The server-sent events of a response body, one at a time, from any server (the backend, or a
 * model API in `ai/own/`). Events (and UTF-8 characters) may be split across network chunks; that
 * is handled here. A connection that breaks mid-stream is an ApiError `network`; aborting `signal`
 * rejects with the AbortError. The caller decides which event ends the stream.
 */
export async function* sseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<SseText> {
  if (!res.body) throw new ApiError(res.status, 'bad_stream', 'The answer came without a body.');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new ApiError(0, 'network', `The connection broke off (${reason(e)}).`);
      }
      if (chunk.done) return;
      buffer += chunk.value.replace(/\r\n/g, '\n');
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const ev = parseBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (ev) yield ev;
      }
    }
  } finally {
    // The caller stopped early (done, error event, abort): close the connection.
    reader.cancel().catch(() => {});
  }
}

/**
 * POST to the backend and read the answer as server-sent events with JSON data. Errors before the
 * stream starts are ApiErrors with the HTTP status; the rest is as in `sseEvents`.
 */
export async function* apiStream(path: string, body: unknown, opts: CallOptions = {}): AsyncGenerator<SseEvent> {
  const res = await request(path, body, opts);
  for await (const { event, data } of sseEvents(res, opts.signal)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new ApiError(200, 'bad_stream', `The backend sent an unreadable event: ${data.replace(/\n/g, ' ').slice(0, 80)}`);
    }
    yield { event, data: parsed };
  }
}
