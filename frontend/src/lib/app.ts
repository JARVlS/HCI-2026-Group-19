import type { Provider } from '../ai/provider';
import { chooseProvider, createProvider } from '../ai/providers';
import { demoFixture } from '../ai/scripted/fixture';
import { classify } from './classify';
import { newConversation } from './chats';
import type { Id, ISO } from './domain';
import { createLive, type Backend, type Live } from './live';
import { isBusy, reducer, type Action, type DomainState, type State } from './state';
import { SyncQueue, watchPage, type KeyValue } from './sync';
import { isQuizAnswer, retryTurn, revealTurn, sendTurn } from './turn';
import type { Classification, ProviderChoice, Settings } from './types';

/**
 * The app without React (IMPLEMENTATION_PLAN.md, M1/M2): initial state from the URL and storage,
 * the synchronous store, and everything that has effects: turns, chats, and the two modes.
 *   demo (provider `scripted`): the scripted fixture, nothing saved, no request to the backend
 *   live (provider `arbor`):    the user's own data, loaded from and saved to the backend (live.ts, sync.ts)
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
    return { ...defaults, ...saved };
  } catch {
    return defaults;
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
 * `?design=ascii&intro=0&view=forest&theme=dark&empty=1&nudge=gentle&arbor=off&mascot=0&provider=arbor&demo=1`.
 * `?demo=1` forces the scripted demo for the visit, whatever is saved or in `?provider`.
 */
export function initialState(p: URLSearchParams, storage: KeyValue | null, build?: string): State {
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
      forest: { open: p.get('view') === 'forest', focus: p.get('tree') },
      draft: { text: '', nonce: 0 },
      highlight: [],
      composer: { lens: null, nudge: false },
      flash: null,
      onboarding: p.get('intro') === '1' || (p.get('intro') !== '0' && stored(storage, ONBOARD_KEY) !== '1'),
      toast: null,
      paneTreeId: null,
      chats: false,
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
  backend: Backend;
  /** The build default for the provider (VITE_DEFAULT_PROVIDER). */
  build?: string;
  /** Tests: answer every turn with this provider. */
  provider?: Provider;
  /** Browser events that trigger saving; null in tests that do not need them. */
  page?: { win: EventTarget; doc: EventTarget & { visibilityState: string } } | null;
  newId?: () => Id;
  now?: () => ISO;
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
  const store = createStore(initialState(opts.params, storage, opts.build), (prev, next, a) => live.observe(prev, next, a));
  const live: Live = createLive(store, { backend, queue, newId, now });

  const providers = new Map<ProviderChoice, Provider>();
  /** A turn keeps the provider it started with. */
  const provider = (): Provider => {
    const choice = store.getState().settings.provider;
    if (opts.provider) return opts.provider;
    if (!providers.has(choice)) providers.set(choice, createProvider(choice));
    return providers.get(choice)!;
  };
  const isLive = () => store.getState().settings.provider === 'arbor';
  const toast = (text: string) => store.dispatch({ type: 'toast', text });

  let controller: AbortController | null = null;
  const abort = () => controller?.abort();
  const run = (go: (signal: AbortSignal) => Promise<void>) => {
    const c = new AbortController();
    controller = c;
    void go(c.signal).finally(() => {
      if (controller === c) controller = null;
    });
  };
  const deps = () => ({ provider: provider(), dispatch: store.dispatch, getState: store.getState, newId, now });

  const showDemo = (empty: boolean) => store.dispatch({ type: 'hydrate', ...demoWorld(empty) });

  /** Switching the provider switches the world: live loads the user's chats, scripted shows the demo. */
  const enter = (choice: ProviderChoice) => {
    abort();
    if (choice === 'arbor') void live.boot();
    else {
      live.stop();
      showDemo(false);
    }
  };

  const jumpTo = (messageId: Id) => {
    store.dispatch({ type: 'forest', open: false });
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

  return {
    store,
    queue,
    live,
    provider,

    /** Start the visit (live mode: load the user's data). Returns the cleanup. */
    start(): () => void {
      if (isLive()) void live.boot();
      if (!opts.page) return () => {};
      return watchPage(queue, opts.page, () => {
        // Back online after a failed start: try again.
        const { boot } = store.getState().session;
        if (isLive() && typeof boot === 'object') void live.boot();
      });
    },

    dispatch(a: StoreAction) {
      if (a.type === 'settings' && a.patch.provider) {
        save(storage, PROVIDER_KEY, a.patch.provider);
        const before = store.getState().settings.provider;
        store.dispatch(a);
        if (a.patch.provider !== before) enter(a.patch.provider);
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

    send(text: string, cls?: Classification, o?: { veil?: boolean }) {
      const s = store.getState();
      if (isBusy(s.session.turn) || !text.trim()) return;
      if (!s.domain.messagesByConv[s.session.activeConversationId]) return toast('this chat is still loading');
      run((signal) => sendTurn(deps(), { text, classification: cls ?? classifyDraft(text), veil: o?.veil }, signal));
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

    /** Open a chat (loading its messages if needed) and, given a message, jump to it. */
    async openChat(id: Id, messageId?: Id) {
      const s = store.getState();
      if (!s.domain.conversations[id]) return;
      if (id !== s.session.activeConversationId) {
        // The demo's past chats are only their trees: the fixture has no transcript for them.
        if (!isLive() && !s.domain.messagesByConv[id]) return toast('demo: past chats have no transcript. their trees are in the forest.');
        abort();
        store.dispatch({ type: 'conversationOpen', id });
      } else {
        // Already open: show it, but keep its pane as it is.
        store.dispatch({ type: 'chats', open: false });
        store.dispatch({ type: 'forest', open: false });
      }
      if (isLive()) await live.loadMessages(id);
      const after = store.getState();
      if (!messageId || after.session.activeConversationId !== id || after.session.chatLoad[id]) return;
      if (after.domain.messagesByConv[id]?.some((m) => m.id === messageId)) jumpTo(messageId);
      else toast('that message was not saved');
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
