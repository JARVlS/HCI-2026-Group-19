import { ApiError, apiUrl } from '../lib/api';
import type { AdminEvent, AdminVisit } from './visit';

/**
 * The logs page's calls to the backend's admin routes (backend/docs/api.md): the token goes in
 * `X-Admin-Token`, which `lib/api.ts` does not send, hence this one small helper. Failures are
 * the app's ApiError with the backend's message (403: the token is wrong).
 */

/** sessionStorage only: gone when the tab closes, never in localStorage or the url. */
export const TOKEN_KEY = 'arbor.logs.token';
export const readToken = () => sessionStorage.getItem(TOKEN_KEY);
export const keepToken = (token: string) => sessionStorage.setItem(TOKEN_KEY, token);
export const forgetToken = () => sessionStorage.removeItem(TOKEN_KEY);

export const VISITS_PAGE = 100;
/** The most the route gives: every page reads the whole events table (no index), so fewer pages are cheaper. */
export const EVENTS_PAGE = 1000;
/** The tables of `GET /api/admin/export` offered as downloads. */
export const TABLES = ['events', 'users', 'conversations', 'messages', 'attempts', 'concepts', 'trees', 'usage'] as const;
export type Table = (typeof TABLES)[number];

const query = (params: Record<string, string | number | null>) =>
  new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (v === null ? [] : [[k, String(v)]]))).toString();

/** GET an admin route. Resolves only for a 2xx answer. */
export async function adminGet(path: string, token: string, signal?: AbortSignal): Promise<Response> {
  const base = apiUrl();
  if (!base) throw new ApiError(0, 'no_backend', 'This build has no backend URL (VITE_API_URL is empty).');
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { headers: { 'x-admin-token': token }, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, 'network', `Could not reach the backend (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res;
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

/** Every page, one after the other, until `next` is null; `onCount` hears the running total. */
export async function loadAll<T>(page: (cursor: string | null) => Promise<Page<T>>, onCount?: (n: number) => void): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  do {
    const { items, next }: Page<T> = await page(cursor);
    if (next !== null && next === cursor) throw new Error('The backend sent the same cursor twice.');
    all.push(...items);
    onCount?.(all.length);
    cursor = next;
  } while (cursor !== null);
  return all;
}

export async function visitsPage(token: string, before: string | null, signal?: AbortSignal): Promise<Page<AdminVisit>> {
  const res = await adminGet(`/api/admin/visits?${query({ limit: VISITS_PAGE, before })}`, token, signal);
  const { visits, next } = (await res.json()) as { visits: AdminVisit[]; next: string | null };
  return { items: visits, next };
}

/** All events of one visit (`visit=` empty: the user's events without a visit). */
export function visitEvents(token: string, v: AdminVisit, onCount: (n: number) => void, signal?: AbortSignal): Promise<AdminEvent[]> {
  return loadAll(async (after) => {
    const res = await adminGet(`/api/admin/events?${query({ visit: v.visit ?? '', userId: v.userId, limit: EVENTS_PAGE, after })}`, token, signal);
    const { events, next } = (await res.json()) as { events: AdminEvent[]; next: string | null };
    return { items: events, next };
  }, onCount);
}

/** Every event of these types, all users and visits (one query per type; each reads the whole events table). */
export async function eventsOfTypes(token: string, types: readonly string[], onCount: (n: number) => void, signal?: AbortSignal): Promise<AdminEvent[]> {
  const all: AdminEvent[] = [];
  for (const type of types) {
    const done = all.length;
    all.push(
      ...(await loadAll(
        async (after) => {
          const res = await adminGet(`/api/admin/events?${query({ type, limit: EVENTS_PAGE, after })}`, token, signal);
          const { events, next } = (await res.json()) as { events: AdminEvent[]; next: string | null };
          return { items: events, next };
        },
        (n) => onCount(done + n),
      )),
    );
  }
  return all;
}

export async function tableCsv(token: string, table: Table): Promise<Blob> {
  return (await adminGet(`/api/admin/export?${query({ table })}`, token)).blob();
}

/** Hand a file to the browser's download. */
export function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
