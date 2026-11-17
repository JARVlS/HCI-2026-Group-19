import { api, ApiError } from './api';
import { SESSION_KEY } from './session';
import { SYNC_KEY, type KeyValue } from './sync';

/**
 * Optional accounts (IMPLEMENTATION_PLAN.md ADR-8, amended 17 Nov 2026; backend/docs/api.md).
 * Everyone starts as a guest: an anonymous session whose token lives in localStorage. An account is
 * a username and password on top of that. Signing up as a guest keeps the guest's chats (same user,
 * same token); logging in switches this browser to the account's token. Logging out forgets the
 * token on this device. Nothing here runs in demo mode.
 */

export const ACCOUNT_KEY = 'arbor.account.v1';

export type Account = { kind: 'guest' } | { kind: 'account'; username: string };

export interface Credentials {
  username: string;
  password: string;
}

/** The backend's rules (backend/src/schemas.py), checked here first for a message in plain words. */
export const USERNAME_RULE = /^[A-Za-z0-9._@+-]{3,64}$/;
export const PASSWORD_MIN = 8;

type Store = KeyValue & { removeItem(key: string): void };

const get = (s: Store | null, key: string): string | null => {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const put = (s: Store | null, key: string, value: string) => {
  try {
    s?.setItem(key, value);
  } catch {
    /* storage blocked: the choice lasts as long as the page */
  }
};
const drop = (s: Store | null, key: string) => {
  try {
    s?.removeItem(key);
  } catch {
    /* nothing to forget */
  }
};

/** What this browser is: a guest, an account, or nothing yet (first visit: show the welcome screen). */
export function readAccount(s: Store | null): Account | null {
  const raw = get(s, ACCOUNT_KEY);
  if (raw) {
    try {
      const a = JSON.parse(raw);
      if (a?.kind === 'account' && typeof a.username === 'string') return { kind: 'account', username: a.username };
      if (a?.kind === 'guest') return { kind: 'guest' };
    } catch {
      /* unreadable: decide from the token below */
    }
  }
  // A visitor from before accounts existed has a session token: a guest, no welcome screen.
  return get(s, SESSION_KEY) ? { kind: 'guest' } : null;
}

export function continueAsGuest(s: Store | null): Account {
  const a: Account = { kind: 'guest' };
  put(s, ACCOUNT_KEY, JSON.stringify(a));
  return a;
}

/** A message for the form, or null if the backend may see it. */
export function checkCredentials({ username, password }: Credentials): string | null {
  if (username.length < 3) return 'the username needs at least 3 characters';
  if (!USERNAME_RULE.test(username)) return 'a username has letters, digits and . _ - @ + only, up to 64';
  if (password.length < PASSWORD_MIN) return `the password needs at least ${PASSWORD_MIN} characters`;
  if (password.length > 256) return 'the password is too long (256 at most)';
  return null;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'wrong username or password',
  username_taken: 'that username is taken',
  already_registered: 'this browser is logged in to an account already. log out first.',
  network: 'could not reach the arbor backend. check your connection, or continue as guest.',
  no_backend: 'this build has no backend, so there are no accounts. continue as guest.',
};

/** An error from signUp/logIn in the words of the form. */
export function accountError(e: unknown): string {
  if (e instanceof ApiError) {
    if (MESSAGES[e.code]) return MESSAGES[e.code];
    if (e.status === 404) return 'accounts are not on the backend yet. continue as guest for now.';
    return e.message.toLowerCase();
  }
  return e instanceof Error ? e.message : String(e);
}

interface AccountResponse {
  userId: string;
  token: string;
  username: string;
}

function remember(s: Store | null, r: AccountResponse): { account: Account; switched: boolean } {
  const switched = get(s, SESSION_KEY) !== r.token;
  put(s, SESSION_KEY, r.token);
  const account: Account = { kind: 'account', username: r.username };
  put(s, ACCOUNT_KEY, JSON.stringify(account));
  if (switched) drop(s, SYNC_KEY); // queued rows belong to the user this browser was before
  return { account, switched };
}

/**
 * Sign up. With a guest token on this browser the guest becomes the account (its chats stay, the
 * token stays). `switched` is true when the token changed, and the app must reload its data.
 */
export async function signUp(s: Store | null, creds: Credentials) {
  const token = get(s, SESSION_KEY) ?? undefined;
  return remember(s, await api<AccountResponse>('/api/auth/signup', creds, { token }));
}

/** Log in. The guest this browser was keeps its chats on the backend but is no longer reachable from here. */
export async function logIn(s: Store | null, creds: Credentials) {
  return remember(s, await api<AccountResponse>('/api/auth/login', creds, {}));
}

/** Forget the token, the account and what was waiting to be saved. The next visit starts at the welcome screen. */
export function logOut(s: Store | null) {
  drop(s, SESSION_KEY);
  drop(s, ACCOUNT_KEY);
  drop(s, SYNC_KEY);
}
