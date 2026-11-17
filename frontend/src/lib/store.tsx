import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { chooseProvider, createProvider } from '../ai/providers';
import { demoFixture, type DemoFixture } from '../ai/scripted/fixture';
import type { Provider } from '../ai/provider';
import { classify } from './classify';
import type { Conversation, Id, Message } from './domain';
import { treeOfConcept, treesOfConversation } from './links';
import { crossRoots, projectForest, type CrossRoots } from './project';
import { activeConversation, activeMessages, isBusy, reducer, type Action, type DomainState, type State } from './state';
import { dayGroup, type DayGroup } from './time';
import { isQuizAnswer, retryTurn, sendTurn } from './turn';
import type { Classification, Grove, ProviderChoice, Settings, TreeData } from './types';

export type { State } from './state';

/** Everything a design may dispatch: the reducer's actions, plus `reset` (reloads the demo fixture). */
export type StoreAction = Action | { type: 'reset'; empty: boolean };

/* ───────────── Initial state ───────────── */

const SETTINGS_KEY = 'arbor.settings.v1';
const ONBOARD_KEY = 'arbor.onboarded.v1';
/**
 * The provider is saved on its own and only when the user picks one, so a URL parameter is never
 * remembered and a later change of the build default reaches everyone who never picked.
 */
const PROVIDER_KEY = 'arbor.provider.v1';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the setting stays in memory */
  }
}

/** Saved settings, except `provider`, which `init` chooses. */
function loadSettings(): Omit<Settings, 'provider'> {
  const defaults = { enabled: true, nudge: 'active', showTags: true, theme: 'system', mascot: true, design: 'ascii' } as const;
  try {
    const raw = stored(SETTINGS_KEY);
    const { provider: _, ...saved } = raw ? JSON.parse(raw) : {};
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

const hasOnboarded = () => stored(ONBOARD_KEY) === '1';

/**
 * URL parameters for demos and user tests, e.g.
 * `?design=ascii&intro=0&view=forest&theme=dark&empty=1&nudge=gentle&arbor=off&mascot=0&provider=arbor`.
 */
function urlParams() {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

const domainOf = (f: DemoFixture): DomainState => ({
  conversations: f.conversations,
  messagesByConv: f.messagesByConv,
  concepts: f.concepts,
  edges: f.edges,
  trees: f.trees,
  attempts: f.attempts,
});

/** The scripted demo starts with its conversation; a live provider with a new, empty chat next to the demo forest (M2 loads the user's own). */
const startFixture = (provider: ProviderChoice, empty: boolean) => demoFixture(provider === 'scripted' ? { empty } : { fresh: true });

function init(): State {
  const p = urlParams();
  const provider = chooseProvider({ url: p.get('provider'), saved: stored(PROVIDER_KEY), build: import.meta.env.VITE_DEFAULT_PROVIDER });
  const settings: Settings = { ...loadSettings(), provider };
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
  const fixture = startFixture(provider, p.get('empty') === '1');
  return {
    domain: domainOf(fixture),
    session: { activeConversationId: fixture.activeConversationId, pendingQuiz: null, turn: { status: 'idle' }, demoPrompts: fixture.demoPrompts },
    ui: {
      panelOpen: p.get('panel') !== '0',
      forest: { open: p.get('view') === 'forest', focus: p.get('tree') },
      draft: { text: '', nonce: 0 },
      highlight: [],
      composer: { lens: null, nudge: false },
      flash: null,
      onboarding: p.get('intro') === '1' || (p.get('intro') !== '0' && !hasOnboarded()),
      toast: null,
      paneTreeId: null,
    },
    settings,
  };
}

/** A synchronous store: `getState()` is current right after `dispatch`, which `turn.ts` relies on. */
function createStore(initial: State) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(a: Action) {
      const next = reducer(state, a);
      if (next === state) return;
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/* ───────────── Derived data ───────────── */

export interface ChatListItem {
  id: Id;
  title: string;
  updatedAt: string;
  /** The tree this chat grew most recently (for its glyph), if any. */
  treeId: Id | null;
  active: boolean;
}

function groveRowsOf(groves: Grove[]): string[][] {
  const ids = groves.map((g) => g.id);
  const k = Math.floor(ids.length / 2);
  return k ? [ids.slice(0, k), ids.slice(k)] : [ids];
}

/* ───────────── Context ───────────── */

interface Ctx {
  state: State;
  dispatch: (a: StoreAction) => void;
  /** The active chat and its messages. */
  conversation: Conversation;
  messages: Message[];
  /** True while a reply is on its way. */
  busy: boolean;
  /** The tree the pane shows: the active chat's most recent tree (or the one picked in the pane). */
  activeTree: TreeData;
  /** Every tree the active chat grew, most recent first. */
  activeTrees: TreeData[];
  /** Every tree, for the forest. */
  forestTrees: TreeData[];
  /** Roots between trees (shared concepts, splits, chats), matched by concept id. */
  roots: CrossRoots;
  groves: Grove[];
  groveRows: string[][];
  /** All chats, most recent first, grouped like a chat app's sidebar. */
  chats: { label: DayGroup; items: ChatListItem[] }[];
  demoPrompts: string[];
  /** Can the assistant quiz the user on this concept? */
  canQuiz: (conceptId: Id) => boolean;
  /** `veil`: hide the answer until the user guesses or reveals it (predict → reveal). */
  send: (text: string, cls?: Classification, opts?: { veil?: boolean }) => void;
  /** Stop the reply that is streaming. */
  stop: () => void;
  /** Run the failed turn again. */
  retry: () => void;
  /** Classify with the current conversation context (e.g. a pending quiz). */
  classifyDraft: (text: string) => Classification;
  jumpTo: (messageId: string) => void;
  toast: (text: string) => void;
  finishOnboarding: () => void;
}

const StoreContext = createContext<Ctx | null>(null);

export function StoreProvider({ children, provider: given }: { children: ReactNode; provider?: Provider }) {
  const [store] = useState(() => createStore(init()));
  const state = useSyncExternalStore(store.subscribe, store.getState);
  // A turn keeps the provider it started with; a new choice in settings applies from the next turn.
  const choice = state.settings.provider;
  const provider = useMemo(() => given ?? createProvider(choice), [given, choice]);
  const controller = useRef<AbortController | null>(null);
  const initialSettings = useRef(state.settings);

  // Persist only changes the user makes (not URL-parameter overrides on load). The provider is saved in `dispatch`.
  useEffect(() => {
    if (state.settings === initialSettings.current) return;
    const { provider: _, ...rest } = state.settings;
    save(SETTINGS_KEY, JSON.stringify(rest));
  }, [state.settings]);

  useEffect(() => () => controller.current?.abort(), []);

  const deps = useMemo(() => ({ provider, dispatch: store.dispatch, getState: store.getState }), [provider, store]);

  const dispatch = useCallback(
    (a: StoreAction) => {
      if (a.type === 'settings' && a.patch.provider) save(PROVIDER_KEY, a.patch.provider);
      if (a.type !== 'reset') return store.dispatch(a);
      controller.current?.abort();
      const f = startFixture(store.getState().settings.provider, a.empty);
      store.dispatch({ type: 'hydrate', domain: domainOf(f), activeConversationId: f.activeConversationId, demoPrompts: f.demoPrompts });
    },
    [store],
  );

  const classifyDraft = useCallback(
    (text: string) => {
      const pq = store.getState().session.pendingQuiz;
      return classify(text, { pendingQuiz: isQuizAnswer(provider, text, pq) ? pq : null });
    },
    [store, provider],
  );

  const run = useCallback(
    (go: (signal: AbortSignal) => Promise<void>) => {
      const c = new AbortController();
      controller.current = c;
      void go(c.signal).finally(() => {
        if (controller.current === c) controller.current = null;
      });
    },
    [],
  );

  const send = useCallback(
    (text: string, cls?: Classification, opts?: { veil?: boolean }) => {
      if (isBusy(store.getState().session.turn) || !text.trim()) return;
      run((signal) => sendTurn(deps, { text, classification: cls ?? classifyDraft(text), veil: opts?.veil }, signal));
    },
    [store, deps, classifyDraft, run],
  );

  const stop = useCallback(() => controller.current?.abort(), []);
  const retry = useCallback(() => {
    if (store.getState().session.turn.status === 'error') run((signal) => retryTurn(deps, signal));
  }, [store, deps, run]);

  const jumpTo = useCallback((messageId: string) => {
    store.dispatch({ type: 'forest', open: false });
    store.dispatch({ type: 'flash', id: messageId });
  }, [store]);

  const toast = useCallback((text: string) => store.dispatch({ type: 'toast', text }), [store]);

  const finishOnboarding = useCallback(() => {
    save(ONBOARD_KEY, '1');
    store.dispatch({ type: 'onboarding', open: false });
  }, [store]);

  const canQuiz = useCallback((id: Id) => (provider.canQuiz ? provider.canQuiz(id) : true), [provider]);

  // Projections. They depend only on the domain entities, so streaming text does not recompute them.
  const { concepts, attempts, trees, edges, conversations } = state.domain;
  const activeId = state.session.activeConversationId;
  const graph = useMemo(() => {
    const membership = treeOfConcept(trees, concepts);
    const conv = conversations[activeId];
    const touched = treesOfConversation(activeId, { attempts, membership });
    // A chat that has not grown anything yet shows its subject's most recent tree.
    const home = touched.length
      ? touched
      : trees
          .filter((t) => conv?.subjectId && t.groveId === conv.subjectId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 1)
          .map((t) => t.id);
    const forestTrees = projectForest(trees, concepts, attempts, { conversationId: activeId, liveTreeIds: home });
    const activeTrees = home.map((id) => forestTrees.find((t) => t.id === id)!).filter(Boolean);
    const groves: Grove[] = Object.values(concepts)
      .filter((c) => c.kind === 'subject' && !c.deletedAt && trees.some((t) => t.groveId === c.id))
      .map((c) => ({ id: c.id, label: c.label }));
    if (trees.some((t) => !t.groveId)) groves.push({ id: 'other', label: 'Other' });
    const chats = new Map<DayGroup, ChatListItem[]>();
    for (const c of Object.values(conversations).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const g = dayGroup(c.updatedAt);
      const treeId = treesOfConversation(c.id, { attempts, membership })[0] ?? (c.id === activeId ? (home[0] ?? null) : null);
      chats.set(g, [...(chats.get(g) ?? []), { id: c.id, title: c.title, updatedAt: c.updatedAt, treeId, active: c.id === activeId }]);
    }
    return {
      forestTrees,
      activeTrees,
      roots: crossRoots(forestTrees, edges, trees, attempts, conversations),
      groves,
      groveRows: groveRowsOf(groves),
      chats: [...chats.entries()].map(([label, items]) => ({ label, items })),
    };
  }, [concepts, attempts, trees, edges, conversations, activeId]);

  const conversation = activeConversation(state) ?? { id: activeId, title: 'New chat', subjectId: null, studyMode: false, createdAt: '', updatedAt: '' };
  const messages = activeMessages(state);
  const paneTreeId = state.ui.paneTreeId;
  const activeTree = useMemo<TreeData>(
    () =>
      graph.activeTrees.find((t) => t.id === paneTreeId) ??
      graph.activeTrees[0] ?? { id: `new:${conversation.id}`, title: conversation.title, grove: conversation.subjectId ?? 'other', updatedAt: conversation.updatedAt, live: true, branches: [] },
    [graph.activeTrees, paneTreeId, conversation.id, conversation.title, conversation.subjectId, conversation.updatedAt],
  );

  const busy = isBusy(state.session.turn);
  const value = useMemo<Ctx>(
    () => ({
      state,
      dispatch,
      conversation,
      messages,
      busy,
      activeTree,
      ...graph,
      demoPrompts: provider.demoPrompts ?? state.session.demoPrompts,
      canQuiz,
      send,
      stop,
      retry,
      classifyDraft,
      jumpTo,
      toast,
      finishOnboarding,
    }),
    [state, dispatch, conversation, messages, busy, activeTree, graph, provider, canQuiz, send, stop, retry, classifyDraft, jumpTo, toast, finishOnboarding],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore outside StoreProvider');
  return ctx;
}
