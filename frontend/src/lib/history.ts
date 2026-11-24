import type { App } from './app';
import { formatHash, parseHash, routeOf, sameView, type View } from './nav';

/**
 * The URL hash and the browser history for `navigate()` (IMPLEMENTATION_PLAN.md ADR-13).
 *   store → URL: every view change (and every chat switch) becomes a history entry `#/…`
 *   URL → store: back/forward, or a typed hash, navigate there (`via: 'back'`)
 * The hash only holds the view; the study parameters (`?pid&cond&…`) stay in the query string.
 *
 * The store is always the truth, the URL follows it. `history.back()` is asynchronous, so the app's
 * own back (esc, ×) changes the view at once and only then asks the browser to step back; until
 * that step lands the URL is left alone, and whatever the store shows then is written after it
 * (a "try →" button that closes a sheet and opens the forest in one click ends on the forest).
 * Entries the app made carry `{ arbor: n, prev: <hash before> }`, so a reload still knows its way back.
 */

/** The parts of `window` this needs, so tests can pass a fake. */
export interface HistoryWindow {
  location: { hash: string; pathname: string; search: string };
  history: {
    state: unknown;
    pushState(data: unknown, unused: string, url: string): void;
    replaceState(data: unknown, unused: string, url: string): void;
    back(): void;
  };
  addEventListener(type: 'popstate' | 'hashchange', l: () => void): void;
  removeEventListener(type: 'popstate' | 'hashchange', l: () => void): void;
}

type Bindable = Pick<App, 'store' | 'navigate' | 'attachHistory'>;
type Entry = { arbor: number; prev: string | null };

const entryOf = (state: unknown): Entry | null => {
  const e = state as Partial<Entry> | null;
  return typeof e?.arbor === 'number' ? { arbor: e.arbor, prev: typeof e.prev === 'string' ? e.prev : null } : null;
};

/** A browser that never delivers the popstate of a `back()` must not freeze the URL. */
const BACK_TIMEOUT_MS = 1000;

export function bindHistory(app: Bindable, win: HistoryWindow): () => void {
  const { store } = app;
  const url = (hash: string) => `${win.location.pathname}${win.location.search}${hash}`;
  /** The hash the app started with; applied once the user's chats are there (live mode loads them first). */
  let pending: string | null = win.location.hash || null;
  let replace = false;
  /** The next view change is the app's own back: step back in the history instead of adding an entry. */
  let backNext = false;
  /** A `history.back()` is on its way: the URL waits for it. */
  let stepping: ReturnType<typeof setTimeout> | null = null;
  /** Set while the URL leads (back/forward): the store follows, and must not add an entry for it. */
  let following = false;
  let entry: Entry = entryOf(win.history.state) ?? { arbor: 0, prev: null };

  const ready = () => store.getState().session.boot === 'ready';
  const currentHash = () => {
    const s = store.getState();
    return formatHash(routeOf(s.ui.view, s.session.activeConversationId));
  };

  /** Apply the hash the visit started with, once: a chat id, a tree, a sheet. */
  const applyPending = () => {
    if (pending === null || !ready()) return;
    const view = parseHash(pending);
    pending = null;
    if (!view) return;
    following = true;
    try {
      app.navigate(view, { via: 'link', replace: true });
    } finally {
      following = false;
    }
  };

  const landed = () => {
    if (stepping !== null) clearTimeout(stepping);
    stepping = null;
  };

  /** store → URL */
  const write = () => {
    if (!ready() || stepping !== null) return;
    applyPending();
    const hash = currentHash();
    if (backNext) {
      backNext = false;
      replace = false;
      if (entry.arbor > 0) {
        stepping = setTimeout(() => {
          stepping = null;
          write();
        }, BACK_TIMEOUT_MS);
        win.history.back();
        return;
      }
    }
    if (hash === win.location.hash) {
      replace = false;
      return;
    }
    if (replace || following || !win.location.hash) {
      entry = { ...entry };
      win.history.replaceState(entry, '', url(hash));
    } else {
      entry = { arbor: entry.arbor + 1, prev: win.location.hash };
      win.history.pushState(entry, '', url(hash));
    }
    replace = false;
  };

  /** URL → store */
  const read = () => {
    const e = entryOf(win.history.state);
    if (e) entry = e;
    if (stepping !== null) {
      // The app's own back landed: the store already shows the view, maybe a newer one (write it).
      landed();
      write();
      return;
    }
    const view = parseHash(win.location.hash);
    if (!ready()) {
      pending = win.location.hash || null;
      return;
    }
    following = true;
    try {
      const s = store.getState();
      if (view && !sameView(view, routeOf(s.ui.view, s.session.activeConversationId))) app.navigate(view, { via: 'back' });
    } finally {
      following = false;
    }
    // A hash that names nothing (a chat that is gone, a typo) shows where the app really is.
    write();
  };

  if (!entryOf(win.history.state)) win.history.replaceState(entry, '', url(win.location.hash));
  app.attachHistory({
    previous: (): View | null => (entry.arbor > 0 && entry.prev ? parseHash(entry.prev) : null),
    backNext: () => {
      backNext = true;
    },
    cancelBack: () => {
      backNext = false;
    },
    replaceNext: () => {
      replace = true;
    },
  });
  const unsubscribe = store.subscribe(write);
  win.addEventListener('popstate', read);
  win.addEventListener('hashchange', read);
  write();
  return () => {
    landed();
    unsubscribe();
    win.removeEventListener('popstate', read);
    win.removeEventListener('hashchange', read);
    app.attachHistory(null);
  };
}
