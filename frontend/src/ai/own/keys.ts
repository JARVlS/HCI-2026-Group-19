import type { Role } from './setup';

/**
 * The user's own API keys (IMPLEMENTATION_PLAN.md ADR-4 "BYOK rules", ADR-11 `SecretStore`): one
 * per role, kept on this device only. By default in sessionStorage (gone when the tab closes); in
 * localStorage only after "remember on this device". They are never sent to the group's backend,
 * never part of the settings or of saved chats, and never logged. In the desktop shell (S2) this
 * store would sit on the OS keychain instead.
 */

export const KEYS_KEY = 'arbor.keys.v1';

export type Keys = Partial<Record<Role, string>>;

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface KeySnapshot {
  keys: Keys;
  /** The keys are in localStorage and survive closing the tab. */
  remember: boolean;
}

export interface KeyStore {
  /** The same object until something changes (for `useSyncExternalStore`). */
  snapshot(): KeySnapshot;
  /** An empty key removes it. */
  setKey(role: Role, key: string): void;
  /** Move the keys to localStorage (on) or back to sessionStorage (off). */
  setRemember(on: boolean): void;
  subscribe(listener: () => void): () => void;
}

/** Storage can be missing or blocked (private mode, tests): then the keys live as long as the page. */
function safely<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

function read(storage: KeyValue | null): Keys | null {
  const raw = safely(() => storage?.getItem(KEYS_KEY));
  if (!raw) return null;
  const parsed = safely(() => JSON.parse(raw) as unknown);
  if (typeof parsed !== 'object' || parsed === null) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([role, key]) => ['chat', 'analysis', 'scores'].includes(role) && typeof key === 'string' && key));
}

export function createKeyStore({ session, local }: { session: KeyValue | null; local: KeyValue | null }): KeyStore {
  const remembered = read(local);
  let snap: KeySnapshot = { keys: remembered ?? read(session) ?? {}, remember: remembered !== null };
  const listeners = new Set<() => void>();

  const commit = (next: KeySnapshot) => {
    snap = next;
    const [keep, drop] = next.remember ? [local, session] : [session, local];
    safely(() => keep?.setItem(KEYS_KEY, JSON.stringify(next.keys)));
    safely(() => drop?.removeItem(KEYS_KEY));
    listeners.forEach((l) => l());
  };

  return {
    snapshot: () => snap,
    setKey(role, key) {
      const { [role]: _, ...rest } = snap.keys;
      const trimmed = key.trim();
      commit({ ...snap, keys: trimmed ? { ...rest, [role]: trimmed } : rest });
    },
    setRemember(on) {
      if (on !== snap.remember) commit({ ...snap, remember: on });
    },
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}
