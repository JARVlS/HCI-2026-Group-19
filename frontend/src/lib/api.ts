// Base URL of the Python Worker (backend/). Set VITE_API_URL in the Cloudflare Pages
// project settings for production; locally it comes from .env.development.
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}
