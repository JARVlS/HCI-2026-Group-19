// The `arbor` provider (ADR-4): chat and structured calls through the backend relay
// (backend/docs/api.md). The backend picks the model and enforces the budgets; this file only
// keeps the anonymous session and reads the stream.
import { API_URL } from './api';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

const TOKEN_KEY = 'arbor.session.v1';
let token: Promise<string> | null = null;

function stored(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // storage unavailable: the session lives as long as the page
  }
}

async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  throw new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `HTTP ${res.status}`);
}

async function newSession(): Promise<string> {
  const res = await fetch(`${API_URL}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) return fail(res);
  const { token: fresh } = (await res.json()) as { token: string };
  try {
    localStorage.setItem(TOKEN_KEY, fresh);
  } catch {
    /* see stored() */
  }
  return fresh;
}

async function complete(body: object, signal?: AbortSignal, retry = true): Promise<Response> {
  token ??= Promise.resolve(stored() ?? newSession());
  const res = await fetch(`${API_URL}/api/ai/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token}` },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401 && retry) {
    // The stored token is from an older database or secret: start a new session once.
    token = newSession();
    return complete(body, signal, false);
  }
  if (!res.ok) return fail(res);
  return res;
}

/** Streams a chat answer; `onDelta` gets each new piece of text. Resolves when the answer is complete. */
export async function chat(
  req: { system: string; messages: Turn[] },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ truncated: boolean }> {
  const res = await complete({ task: 'chat', stream: true, ...req }, signal);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      // one SSE event can span several chunks
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]);
      if (event === 'delta') onDelta(data.text);
      else if (event === 'done') return { truncated: data.truncated };
      else if (event === 'error') throw new ApiError(res.status, data.code, data.message);
    }
  }
  throw new ApiError(res.status, 'upstream_error', 'The stream ended without a done event.');
}

/** One structured call: the answer is JSON that matches `schema`. */
export async function json<T>(
  req: { task: 'analyze' | 'tree' | 'quiz'; system: string; messages: Turn[]; schema: object },
  signal?: AbortSignal,
): Promise<T> {
  const res = await complete(req, signal);
  return ((await res.json()) as { output: T }).output;
}
