import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/storage';
import { biologyProvider, testSession } from '../test/server';
import { createApp } from './app';
import { bindHistory, type HistoryWindow } from './history';
import { remoteBackend } from './live';
import { formatHash, initialView, parseHash, routeOf, sheetOf, type View } from './nav';

describe('nav: hashes', () => {
  const views: View[] = [
    { kind: 'chat' },
    { kind: 'chat', conversationId: 'c1' },
    { kind: 'chat', conversationId: 'c 1/x', messageId: 'm1' },
    { kind: 'chats' },
    { kind: 'forest' },
    { kind: 'forest', treeId: 'tree:sql' },
    { kind: 'concepts' },
    { kind: 'settings' },
    { kind: 'settings', section: 'model' },
  ];
  it.each(views.map((v) => [formatHash(v), v] as const))('%s round-trips', (hash, v) => {
    expect(parseHash(hash)).toEqual(v);
  });

  it('anything else is no view', () => {
    for (const h of ['', '#', '#top', '#/', '#/nope', '#/chats/x', '#/settings/x', '#/forest/a/b', '#/chat/a/b/c', '#/chat/%E0%A4%A']) expect(parseHash(h), h).toBeNull();
  });

  it('a trailing slash is fine', () => {
    expect(parseHash('#/forest/')).toEqual({ kind: 'forest' });
  });

  it('the first view: the hash, else the old ?view=forest&tree=, else the chat', () => {
    expect(initialView('#/chats', new URLSearchParams('view=forest'))).toEqual({ kind: 'chats' });
    expect(initialView('', new URLSearchParams('view=forest&tree=t1'))).toEqual({ kind: 'forest', treeId: 't1' });
    expect(initialView('#junk', new URLSearchParams())).toEqual({ kind: 'chat' });
  });

  it('the route fills in the active chat; sheets are concepts and the model', () => {
    expect(routeOf({ kind: 'chat' }, 'c9')).toEqual({ kind: 'chat', conversationId: 'c9' });
    expect(routeOf({ kind: 'forest' }, 'c9')).toEqual({ kind: 'forest' });
    expect(sheetOf({ kind: 'concepts' })).toBe('concepts');
    expect(sheetOf({ kind: 'settings', section: 'model' })).toBe('model');
    expect(sheetOf({ kind: 'settings' })).toBeNull();
  });
});

/** A browser history in memory: entries, an index, popstate on back/forward (synchronously). */
function fakeWindow(hash = '', state: unknown = null) {
  const entries: { state: unknown; hash: string }[] = [{ state, hash }];
  let at = 0;
  const listeners = new Map<string, Set<() => void>>();
  const fire = (t: string) => listeners.get(t)?.forEach((l) => l());
  const hashOf = (url: string) => (url.includes('#') ? url.slice(url.indexOf('#')) : '');
  const win: HistoryWindow & { go(n: number): void; type(hash: string): void; entries: typeof entries; at: () => number } = {
    location: {
      get hash() {
        return entries[at].hash;
      },
      pathname: '/',
      search: '?demo=1',
    },
    history: {
      get state() {
        return entries[at].state;
      },
      pushState(state, _u, url) {
        entries.splice(at + 1);
        entries.push({ state, hash: hashOf(url) });
        at++;
      },
      replaceState(state, _u, url) {
        entries[at] = { state, hash: hashOf(url) };
      },
      // Like a browser: the step back lands later, in its own task.
      back() {
        setTimeout(() => win.go(-1), 0);
      },
    },
    addEventListener(t, l) {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(l);
    },
    removeEventListener(t, l) {
      listeners.get(t)?.delete(l);
    },
    go(n) {
      at = Math.max(0, Math.min(entries.length - 1, at + n));
      fire('popstate');
      fire('hashchange');
    },
    /** The user types a hash into the address bar. */
    type(h) {
      entries.splice(at + 1);
      entries.push({ state: null, hash: h });
      at++;
      fire('hashchange');
    },
    entries,
    at: () => at,
  };
  return win;
}

let ids = 0;
function demo(hash = '', state: unknown = null) {
  const a = createApp({
    params: new URLSearchParams('?demo=1'),
    storage: memoryStorage(),
    backend: remoteBackend(testSession()),
    provider: biologyProvider(),
    page: null,
    newId: () => `id-${++ids}`,
    hash,
  });
  const win = fakeWindow(hash, state);
  const unbind = bindHistory(a, win);
  return { a, win, unbind, view: () => a.store.getState().ui.view, active: () => a.store.getState().session.activeConversationId };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('navigate and the history', () => {
  it('starts on the chat and writes its hash in place (no new entry)', () => {
    const { win, active } = demo();
    expect(win.location.hash).toBe(`#/chat/${active()}`);
    expect(win.entries).toHaveLength(1);
  });

  it('each view is an entry; back and forward walk them; the store follows', () => {
    const { a, win, view } = demo();
    a.navigate({ kind: 'forest' }, { via: 'radial' });
    a.navigate({ kind: 'chats' }, { via: 'command' });
    expect(win.location.hash).toBe('#/chats');
    expect(win.entries).toHaveLength(3);
    win.go(-1);
    expect(view()).toEqual({ kind: 'forest' });
    win.go(-1);
    expect(view()).toEqual({ kind: 'chat' });
    win.go(1);
    expect(view()).toEqual({ kind: 'forest' });
    // Following the history never adds entries.
    expect(win.entries).toHaveLength(3);
  });

  it('back() leaves an overlay through the history when the previous entry is ours, else replaces it with the chat', () => {
    const { a, win, view, active } = demo('#/forest');
    expect(view()).toEqual({ kind: 'forest' });
    a.back();
    expect(view()).toEqual({ kind: 'chat' });
    expect(win.entries).toHaveLength(1);
    expect(win.location.hash).toBe(`#/chat/${active()}`);
    a.navigate({ kind: 'concepts' }, { via: 'key' });
    a.back();
    // The view changes at once; the URL follows when the browser's step back lands.
    expect(view()).toEqual({ kind: 'chat' });
    expect(win.location.hash).toBe('#/concepts');
    vi.runAllTimers();
    expect(win.at()).toBe(0);
    expect(win.location.hash).toBe(`#/chat/${active()}`);
  });

  it('close a sheet and open the forest in one click (a "try →" button): ends on the forest, whenever the step back lands', () => {
    const { a, win, view, active } = demo();
    a.navigate({ kind: 'concepts' }, { via: 'key' });
    a.back();
    a.navigate({ kind: 'forest' }, { via: 'click' });
    expect(view()).toEqual({ kind: 'forest' });
    vi.runAllTimers();
    expect(view()).toEqual({ kind: 'forest' });
    expect(win.entries.map((e) => e.hash)).toEqual([`#/chat/${active()}`, '#/forest']);
    expect(win.at()).toBe(1);
    // And back from there is the chat.
    a.back();
    vi.runAllTimers();
    expect(view()).toEqual({ kind: 'chat' });
  });

  it('after a reload the entry still knows its way back', () => {
    const { a, win, view } = demo('#/forest', { arbor: 3, prev: '#/chats' });
    a.back();
    expect(view()).toEqual({ kind: 'chats' });
    vi.runAllTimers();
    expect(win.location.hash).toBe('#/chats');
  });

  it('the settings pop-up has a URL but never an entry of its own', () => {
    const { a, win, view } = demo();
    a.navigate({ kind: 'settings' }, { via: 'radial' });
    expect(win.location.hash).toBe('#/settings');
    expect(win.entries).toHaveLength(1);
    a.navigate({ kind: 'forest' }, { via: 'click' });
    expect(win.entries.map((e) => e.hash.split('/')[1])).toEqual(['forest']);
    expect(view()).toEqual({ kind: 'forest' });
  });

  it('a deep link opens that view (forest on a tree, a sheet)', () => {
    expect(demo('#/forest/t1').view()).toEqual({ kind: 'forest', treeId: 't1' });
    expect(demo('#/settings/model').view()).toEqual({ kind: 'settings', section: 'model' });
  });

  it('switching chats is an entry too; back reopens the chat; a chat that is gone shows where the app is', () => {
    const { a, win, active } = demo();
    const first = active();
    a.newChat();
    const second = active();
    expect(second).not.toBe(first);
    expect(win.location.hash).toBe(`#/chat/${second}`);
    win.go(-1);
    expect(active()).toBe(first);
    // The new chat was empty, so leaving it dropped it: forward names a chat that no longer exists.
    win.go(1);
    expect(active()).toBe(first);
    expect(win.location.hash).toBe(`#/chat/${first}`);
  });

  it('a typed hash navigates; junk is replaced with the real view', () => {
    const { win, view, active } = demo();
    win.type('#/chats');
    expect(view()).toEqual({ kind: 'chats' });
    win.type('#nonsense');
    expect(view()).toEqual({ kind: 'chats' });
    expect(win.location.hash).toBe('#/chats');
    expect(active()).toBeTruthy();
  });

  it('a view change from elsewhere (opening a chat from the forest) is an entry, and unbinding stops all of it', () => {
    const { a, win, unbind } = demo();
    a.navigate({ kind: 'forest' }, { via: 'click' });
    a.openChat(a.store.getState().session.activeConversationId);
    expect(win.entries.map((e) => e.hash.split('/')[1])).toEqual(['chat', 'forest', 'chat']);
    unbind();
    a.navigate({ kind: 'chats' }, { via: 'click' });
    expect(win.entries).toHaveLength(3);
  });
});
