import { api, ApiError } from './api';

/**
 * The anonymous session (IMPLEMENTATION_PLAN.md ADR-8, backend/docs/api.md): one token per
 * browser, created with `POST /api/session` on first use, kept in localStorage and sent as
 * `Authorization: Bearer`. The backend answers 401 to a token it no longer knows (database reset,
 * new secret); then we create a new session once and repeat the call.
 */
export const SESSION_KEY = 'arbor.session.v1';

type TokenStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface Session {
  /** Run an authenticated call. After a 401 it gets a new session and runs the call once more. */
  run<T>(call: (token: string) => Promise<T>): Promise<T>;
}

export function createSession(create: () => Promise<string>, storage: TokenStore | null): Session {
  let token: Promise<string> | null = null;
  /** The token the last renewal replaced, so parallel 401s share one new session. */
  let replaced: string | null = null;

  const start = (): Promise<string> => {
    const next = create().then((t) => {
      safely(() => storage?.setItem(SESSION_KEY, t));
      return t;
    });
    token = next;
    // A failed create is not remembered: the next call tries again.
    next.catch(() => {
      if (token === next) token = null;
    });
    return next;
  };

  const current = (): Promise<string> => {
    if (token) return token;
    const saved = safely(() => storage?.getItem(SESSION_KEY)) ?? null;
    return saved ? (token = Promise.resolve(saved)) : start();
  };

  const renew = (stale: string): Promise<string> => {
    if (replaced === stale && token) return token;
    replaced = stale;
    safely(() => storage?.removeItem(SESSION_KEY));
    return start();
  };

  return {
    async run(call) {
      const t = await current();
      try {
        return await call(t);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) throw e;
        return call(await renew(t));
      }
    },
  };
}

/** localStorage can be missing or blocked (private mode, tests): then the session lives as long as the page. */
function safely<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

const browserStorage = (): TokenStore | null => safely(() => globalThis.localStorage) ?? null;

const newSession = async () => (await api<{ token: string }>('/api/session', {})).token;

/** The session of this browser. */
export const session: Session = createSession(newSession, browserStorage());
