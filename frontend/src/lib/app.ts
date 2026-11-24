import { createKeyStore } from '../ai/own/keys';
import { OwnProvider } from '../ai/own/provider';
import { parseSetup } from '../ai/own/setup';
import type { Provider, ScoreResult } from '../ai/provider';
import { chooseProvider, createProvider, isLiveChoice } from '../ai/providers';
import { demoFixture } from '../ai/scripted/fixture';
import { readAccount } from './account';
import { classify } from './classify';
import { newConversation } from './chats';
import type { Id, ISO } from './domain';
import { cut, eventsOf, type EventEnv, type UsageEvent } from './events';
import { createLive, type Backend, type Live } from './live';
import { locate } from './locate';
import { CHAT, initialView, routeOf, sameView, type NavVia, type View } from './nav';
import { watchUsage } from './pageEvents';
import { SESSION_KEY } from './session';
import { isBusy, reducer, type Action, type DomainState, type State } from './state';
import { SyncQueue, watchPage, type KeyValue } from './sync';
import { EventLog, fingerprint } from './telemetry';
import { isQuizAnswer, retryTurn, revealTurn, sendTurn, type TurnDeps } from './turn';
import type { Classification, ProviderChoice, Settings } from './types';

/**
 * The app without React (IMPLEMENTATION_PLAN.md, M1/M2): initial state from the URL and storage,
 * the synchronous store, and everything that has effects: turns, chats, and the two modes.
 *   demo (provider `scripted`):     the scripted fixture, nothing saved, no request to the backend
 *   live (provider `arbor`, `own`): the user's own data, loaded from and saved to the backend (live.ts, sync.ts);
 *                                   `own` sends the model calls to the user's own endpoints (ai/own/);
 *                                   and the usage log (events.ts, pageEvents.ts, telemetry.ts)
 * `store.tsx` binds it to React.
 */

export const SETTINGS_KEY = 'arbor.settings.v1';
export const ONBOARD_KEY = 'arbor.onboarded.v1';
/**
 * The provider is saved on its own and only when the user picks one, so a URL parameter is never
 * remembered and a later change of the build default reaches everyone who never picked.
 */
export const PROVIDER_KEY = 'arbor.provider.v1';

export function stored(storage: KeyValue | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function save(storage: KeyValue | null, key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* storage unavailable: the setting stays in memory */
  }
}

/** Saved settings, except `provider`, which `initialState` chooses. */
function loadSettings(storage: KeyValue | null): Omit<Settings, 'provider'> {
  const defaults = { enabled: true, nudge: 'active', showTags: true, theme: 'system', mascot: true, design: 'ascii' } as const;
  try {
    const raw = stored(storage, SETTINGS_KEY);
    const { provider: _, ...saved } = raw ? JSON.parse(raw) : {};
    return { ...defaults, ...saved, own: parseSetup(saved.own) };
  } catch {
    return { ...defaults, own: parseSetup(null) };
  }
}

const EMPTY: DomainState = { conversations: {}, messagesByConv: {}, concepts: {}, edges: [], trees: [], attempts: [] };

/** The demo world: the scripted conversation (or an empty one) and the demo forest. */
function demoWorld(empty: boolean) {
  const f = demoFixture({ empty });
  const domain: DomainState = { conversations: f.conversations, messagesByConv: f.messagesByConv, concepts: f.concepts, edges: f.edges, trees: f.trees, attempts: f.attempts };
  return { domain, activeConversationId: f.activeConversationId, demoPrompts: f.demoPrompts };
}

/**
 * URL parameters for demos and user tests, e.g.
 * `?design=ascii&intro=0&view=forest&theme=dark&empty=1&nudge=gentle&arbor=off&mascot=0&provider=arbor|own&demo=1`.
 * `?demo=1` forces the scripted demo for the visit, whatever is saved or in `?provider`.
 */
export function initialState(p: URLSearchParams, storage: KeyValue | null, build?: string, hash = ''): State {
  const provider = chooseProvider({ demo: p.get('demo') === '1', url: p.get('provider'), saved: stored(storage, PROVIDER_KEY), build });
  const settings: Settings = { ...loadSettings(storage), provider };
  const theme = p.get('theme');
  if (theme === 'light' || theme === 'dark' || theme === 'system') settings.theme = theme;
  const nudge = p.get('nudge');
  if (nudge === 'off' || nudge === 'gentle' || nudge === 'active') settings.nudge = nudge;
  if (p.get('arbor') === 'off') settings.enabled = false;
  if (p.get('arbor') === 'on') settings.enabled = true;
  if (p.get('mascot') === '0') settings.mascot = false;
  if (p.get('mascot') === '1') settings.mascot = true;
  const design = p.get('design');
  if (design === 'ascii' || design === 'classic') settings.design = design;
  // Live mode starts empty and loads (`Live.boot`); the demo has its world at once.
  const world = provider === 'scripted' ? demoWorld(p.get('empty') === '1') : { domain: EMPTY, activeConversationId: '', demoPrompts: [] };
  return {
    domain: world.domain,
    session: {
      activeConversationId: world.activeConversationId,
      pendingQuiz: null,
      turn: { status: 'idle' },
      demoPrompts: world.demoPrompts,
      boot: provider === 'scripted' ? 'ready' : 'loading',
      chatLoad: {},
    },
    ui: {
      panelOpen: p.get('panel') !== '0',
      // A chat named in the hash is opened by `history.ts` once the chats are there.
      view: initialView(hash, p).kind === 'chat' ? CHAT : initialView(hash, p),
      draft: { text: '', nonce: 0 },
      highlight: [],
      composer: { lens: null, nudge: false },
      flash: null,
      // The intro opens by itself only in the demo. Live mode starts on an open, empty chat (M8);
      // the empty chat links to the intro, and `?intro=1` still forces it.
      onboarding: p.get('intro') === '1' || (provider === 'scripted' && p.get('intro') !== '0' && stored(storage, ONBOARD_KEY) !== '1'),
      toast: null,
      paneTreeId: null,
    },
    settings,
  };
}

/** A synchronous store: `getState()` is current right after `dispatch`, which `turn.ts` relies on. `observe` sees every change. */
export function createStore(initial: State, observe?: (prev: State, next: State, a: Action) => void) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(a: Action) {
      const prev = state;
      const next = reducer(state, a);
      if (next === prev) return;
      state = next;
      observe?.(prev, next, a);
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

/** Everything a design may dispatch: the reducer's actions, plus `reset` (demo: reload the fixture; live: reload, or a new chat). */
export type StoreAction = Action | { type: 'reset'; empty: boolean };

export interface AppOptions {
  params: URLSearchParams;
  storage: KeyValue | null;
  /** sessionStorage: where the own-model keys stay unless the user ticks "remember on this device". */
  session?: KeyValue | null;
  backend: Backend;
  /** The build default for the provider (VITE_DEFAULT_PROVIDER). */
  build?: string;
  /** Tests: answer every turn with this provider. */
  provider?: Provider;
  /** Browser events that trigger saving; null in tests that do not need them. */
  page?: { win: EventTarget; doc: EventTarget & { visibilityState: string } } | null;
  newId?: () => Id;
  now?: () => ISO;
  /** Every judged sent message (live mode): the word filter learns from it (`LiveFilter.learn`). */
  judged?: TurnDeps['judged'];
  /** The URL hash at start (`#/forest/…`): the first view (ADR-13). */
  hash?: string;
}

/** The browser history as `navigate()` needs it (`history.ts`); none in tests that do not need it. */
export interface NavHistory {
  /** The view of the entry before this one, if it is the app's (null: leaving would leave the app). */
  previous(): View | null;
  /** The next view change is a step back in the history, not a new entry. */
  backNext(): void;
  /** Undo `backNext` when nothing changed after all. */
  cancelBack(): void;
  /** The next view change replaces the current entry instead of adding one. */
  replaceNext(): void;
}

export interface NavOptions {
  via: NavVia;
  /** Replace the current history entry instead of adding one. */
  replace?: boolean;
  /** Milliseconds the user took to choose (radial menu), for the usage log. */
  ms?: number;
}

export type App = ReturnType<typeof createApp>;

export function createApp(opts: AppOptions) {
  const { storage, backend } = opts;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => new Date().toISOString());
  const queue = new SyncQueue({
    storage,
    send: backend.sync,
    onReject: (message) => store.dispatch({ type: 'toast', text: message }),
  });
  const log = new EventLog({
    storage,
    send: backend.events,
    owner: () => fingerprint(stored(storage, SESSION_KEY)),
    context: () => {
      const s = store.getState();
      return { design: s.settings.design, conversationId: s.session.activeConversationId };
    },
    onReject: (message) => store.dispatch({ type: 'toast', text: message }),
    now,
  });
  const size = () => ({ width: globalThis.innerWidth ?? 0, height: globalThis.innerHeight ?? 0 });
  const env = (): EventEnv => ({
    at: Date.parse(now()),
    ...size(),
    signedIn: readAccount(storage)?.kind === 'account',
    device: {
      userAgent: globalThis.navigator?.userAgent ?? '',
      language: globalThis.navigator?.language ?? '',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screenWidth: globalThis.screen?.width ?? 0,
      screenHeight: globalThis.screen?.height ?? 0,
      pixelRatio: globalThis.devicePixelRatio ?? 1,
      touch: globalThis.matchMedia?.('(pointer: coarse)').matches ?? false,
      // The parameters the app started with (no app parameter carries a token or key).
      search: cut(opts.params.toString()),
      referrer: cut(globalThis.document?.referrer ?? ''),
    },
  });
  /** Usage log: what the store knows (`eventsOf`), in live mode and at the switch to or from it. */
  const logChange = (prev: State, next: State, a: Action) => {
    if (!isLiveChoice(prev.settings.provider) && !isLiveChoice(next.settings.provider)) return;
    try {
      for (const e of eventsOf(prev, next, a, env)) log.record(e);
    } catch (e) {
      console.error(`[arbor events] could not log ${a.type}`, e);
    }
  };
  const store = createStore(initialState(opts.params, storage, opts.build, opts.hash), (prev, next, a) => {
    live.observe(prev, next, a);
    logChange(prev, next, a);
  });
  const live: Live = createLive(store, { backend, queue, newId, now });

  /** The own-model keys: on this device only, never in the store, the settings or saved data. */
  const keys = createKeyStore({ session: opts.session ?? null, local: storage });
  const own = new OwnProvider(() => ({ setup: store.getState().settings.own, keys: keys.snapshot().keys }));
  const providers = new Map<ProviderChoice, Provider>();
  /** A turn keeps the provider it started with. */
  const provider = (): Provider => {
    const choice = store.getState().settings.provider;
    if (opts.provider) return opts.provider;
    if (!providers.has(choice)) providers.set(choice, createProvider(choice, own));
    return providers.get(choice)!;
  };
  const isLive = () => isLiveChoice(store.getState().settings.provider);
  const toast = (text: string) => store.dispatch({ type: 'toast', text });
  /** Usage log: an event only a design knows. Nothing in the demo. */
  const track = (e: UsageEvent) => {
    if (isLive()) log.record(e);
  };

  let controller: AbortController | null = null;
  const abort = () => controller?.abort();
  const run = (go: (signal: AbortSignal) => Promise<void>) => {
    const c = new AbortController();
    controller = c;
    void go(c.signal).finally(() => {
      if (controller === c) controller = null;
    });
  };
  const deps = (): TurnDeps => ({ provider: provider(), dispatch: store.dispatch, getState: store.getState, newId, now, judged: opts.judged });

  const showDemo = (empty: boolean) => store.dispatch({ type: 'hydrate', ...demoWorld(empty) });

  /**
   * Switching between demo and live switches the world: live loads the user's chats, scripted shows
   * the demo. Between `arbor` and `own` the world stays: the next message goes to the other models.
   */
  const enter = (choice: ProviderChoice, before: ProviderChoice) => {
    if (isLiveChoice(choice) === isLiveChoice(before)) return;
    abort();
    if (isLiveChoice(choice)) {
      log.start();
      void live.boot();
    } else {
      live.stop();
      log.stop();
      showDemo(false);
    }
  };

  let history: NavHistory | null = null;
  const route = () => {
    const s = store.getState();
    return routeOf(s.ui.view, s.session.activeConversationId);
  };
  /** Show a view of the open chat's world (not another chat: that is `openChat`). */
  const show = (view: View, replace?: boolean) => {
    if (replace) history?.replaceNext();
    store.dispatch({ type: 'view', view });
  };

  const jumpTo = (messageId: Id) => {
    show(CHAT);
    store.dispatch({ type: 'flash', id: messageId });
  };

  const newChat = () => {
    abort();
    const s = store.getState();
    const active = s.session.activeConversationId;
    // The open chat is empty already: that is the new chat.
    if (s.domain.messagesByConv[active]?.length === 0) return store.dispatch({ type: 'conversationOpen', id: active });
    store.dispatch({ type: 'conversationNew', conversation: newConversation(newId(), now()) });
  };

  const classifyDraft = (text: string): Classification => {
    const pq = store.getState().session.pendingQuiz;
    return classify(text, { pendingQuiz: isQuizAnswer(provider(), text, pq) ? pq : null });
  };

  /**
   * The one way to change the view (ADR-13): the radial menu, `/commands`, keys, links and the back
   * button. A chat other than the open one is opened (and loaded) with `openChat`.
   */
  const navigate = (to: View, given: NavOptions) => {
    const from = route();
    if (sameView(from, to) && !(to.kind === 'chat' && to.messageId)) return;
    // The settings pop-up is a view (it has a URL) but never a history entry of its own: a click
    // outside closes it, and an async `history.back()` could land after that click's own navigation.
    const popup = (v: View) => v.kind === 'settings' && !v.section;
    const o = popup(to) || popup(from) ? { ...given, replace: true } : given;
    track({ type: 'nav', payload: { from: from.kind, to: to.kind, via: o.via, ms: o.ms ?? null } });
    if (to.kind === 'chat' && to.conversationId && to.conversationId !== store.getState().session.activeConversationId) {
      if (o.replace) history?.replaceNext();
      return void openChat(to.conversationId, to.messageId);
    }
    if (to.kind === 'chat' && to.messageId) {
      if (o.replace) history?.replaceNext();
      return jumpTo(to.messageId);
    }
    show(to, o.replace);
  };

  /** Open a chat (loading its messages if needed) and, given a message, jump to it. */
  async function openChat(id: Id, messageId?: Id) {
    const s = store.getState();
    if (!s.domain.conversations[id]) return;
    if (id !== s.session.activeConversationId) {
      // The demo's past chats are only their trees: the fixture has no transcript for them.
      if (!isLive() && !s.domain.messagesByConv[id]) return toast('demo: past chats have no transcript. their trees are in the forest.');
      abort();
      store.dispatch({ type: 'conversationOpen', id });
    } else {
      // Already open: show it, but keep its pane as it is.
      show(CHAT);
    }
    if (isLive()) await live.loadMessages(id);
    const after = store.getState();
    if (!messageId || after.session.activeConversationId !== id || after.session.chatLoad[id]) return;
    if (after.domain.messagesByConv[id]?.some((m) => m.id === messageId)) jumpTo(messageId);
    else toast('that message was not saved');
  }

  return {
    store,
    queue,
    live,
    log,
    track,
    provider,
    /** Settings → model: the keys, test connection and the endpoints' model lists. */
    keys,
    own,

    /** Start the visit (live mode: load the user's data). Returns the cleanup. */
    start(): () => void {
      if (isLive()) {
        log.start();
        void live.boot();
      }
      if (!opts.page) return () => {};
      const unwatch = [
        // First, so `page_hidden` goes out with the keepalive send that hiding starts.
        watchUsage(opts.page, track, size, {
          locate,
          context: () => {
            const { ui } = store.getState();
            return { view: ui.view.kind, panel: ui.panelOpen };
          },
        }),
        watchPage(queue, opts.page, () => {
          // Back online after a failed start: try again.
          const { boot } = store.getState().session;
          if (isLive() && typeof boot === 'object') void live.boot();
        }),
        watchPage(log, opts.page),
      ];
      return () => unwatch.forEach((stop) => stop());
    },

    dispatch(a: StoreAction) {
      if (a.type === 'settings' && a.patch.provider) {
        save(storage, PROVIDER_KEY, a.patch.provider);
        const before = store.getState().settings.provider;
        store.dispatch(a);
        if (a.patch.provider !== before) enter(a.patch.provider, before);
        return;
      }
      // A revealed guess may need scoring (live mode); `revealTurn` dispatches the reveal itself.
      if (a.type === 'reveal') return void revealTurn(deps(), a.id, a.guess);
      if (a.type !== 'reset') return store.dispatch(a);
      abort();
      if (!isLive()) return showDemo(a.empty);
      if (a.empty) newChat();
      else void live.boot();
    },

    /** Returns the id of the message it sent (undefined: not sent), for the usage log's `compose`. */
    send(text: string, cls?: Classification, o?: { veil?: boolean; thinking?: ScoreResult }): Id | undefined {
      const s = store.getState();
      if (isBusy(s.session.turn) || !text.trim()) return;
      if (!s.domain.messagesByConv[s.session.activeConversationId]) return void toast('this chat is still loading');
      run((signal) => sendTurn(deps(), { text, classification: cls ?? classifyDraft(text), veil: o?.veil, thinking: o?.thinking }, signal));
      // `sendTurn` puts the message into the store before its first await.
      return store.getState().session.turn.userMessageId;
    },
    stop: abort,
    retry() {
      if (store.getState().session.turn.status === 'error') run((signal) => retryTurn(deps(), signal));
    },
    classifyDraft,
    jumpTo,
    toast,
    finishOnboarding() {
      save(storage, ONBOARD_KEY, '1');
      store.dispatch({ type: 'onboarding', open: false });
    },

    newChat,

    openChat,

    navigate,
    /**
     * Leave an overlay (forest, chat list, a sheet): back to where the user came from if that is in
     * the app, else to `fallback` in place of this entry.
     */
    back(fallback: View = CHAT, via: NavVia = 'key') {
      const prev = history?.previous();
      if (history && prev && !sameView(prev, route())) {
        history.backNext();
        navigate(prev, { via });
        history.cancelBack();
      } else navigate(fallback, { via, replace: true });
    },
    route,
    /** `history.ts` binds the browser history; without it views change but the URL stays. */
    attachHistory(h: NavHistory | null) {
      history = h;
    },

    /** Load a chat's messages without opening it (snippets in a leaf's list of messages). */
    loadChat(id: Id) {
      if (isLive()) void live.loadMessages(id);
    },

    /** Try again after a failed load: the start, or the open chat's messages. */
    retryLoad() {
      const s = store.getState();
      if (typeof s.session.boot === 'object') void live.boot();
      else void live.loadMessages(s.session.activeConversationId);
    },

    renameChat(title: string) {
      const t = title.replace(/\s+/g, ' ').trim();
      if (!t) return toast('/title takes a name, e.g. /title recursion basics');
      store.dispatch({ type: 'conversationTitle', id: store.getState().session.activeConversationId, title: t, at: now() });
    },
  };
}
