import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { KeySnapshot } from '../ai/own/keys';
import type { TestReport } from '../ai/own/provider';
import type { Role } from '../ai/own/setup';
import type { Provider, ScoreResult } from '../ai/provider';
import { isLiveChoice } from '../ai/providers';
import { createApp, save, SETTINGS_KEY, type StoreAction } from './app';
import type { Conversation, Id, ISO, Message } from './domain';
import { draftScoreFn, type ScoreFn } from './draftScore';
import type { UsageEvent } from './events';
import { LiveFilter } from './liveFilter';
import { conversationsOfTree, treeOfConcept, treesOfConversation } from './links';
import { remoteBackend } from './live';
import { crossRoots, projectForest, type CrossRoots } from './project';
import { session } from './session';
import { activeConversation, activeMessages, isBusy, type State } from './state';
import type { SyncStatus } from './sync';
import { dayGroup, type DayGroup } from './time';
import type { Classification, Grove, TreeData } from './types';

export type { State } from './state';
export type { StoreAction } from './app';

/* ───────────── Derived data ───────────── */

/** A tree a chat grew, as its crown: the scores of the leaves that chat touched. */
export interface Crown {
  treeId: Id;
  title: string;
  scores: number[];
}

export interface ChatListItem {
  id: Id;
  title: string;
  updatedAt: string;
  /** The tree this chat grew most recently (for its glyph), if any. */
  treeId: Id | null;
  /** Every tree this chat grew. */
  crowns: Crown[];
  active: boolean;
}

/** A chat a tree was grown in. */
export interface GrownIn {
  id: Id;
  title: string;
  lastAt: ISO;
  /** Scores of the leaves of the tree that this chat touched. */
  scores: number[];
}

function groveRowsOf(groves: Grove[]): string[][] {
  const ids = groves.map((g) => g.id);
  const k = Math.floor(ids.length / 2);
  return k ? [ids.slice(0, k), ids.slice(k)] : [ids];
}

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function tabStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function urlParams() {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

/* ───────────── Context ───────────── */

interface Ctx {
  state: State;
  dispatch: (a: StoreAction) => void;
  /** demo: the scripted world, nothing saved · live: the user's own chats, saved (IMPLEMENTATION_PLAN.md M2). */
  mode: 'demo' | 'live';
  /** Live mode: what is not saved yet. */
  sync: SyncStatus;
  /** The active chat and its messages. */
  conversation: Conversation;
  messages: Message[];
  /** True while a reply is on its way. */
  busy: boolean;
  /** The tree the pane shows: the active chat's most recent tree (or the one picked in the pane). */
  activeTree: TreeData;
  /** Every tree the active chat grew, most recent first (or its subject's latest tree, if it grew none yet). */
  activeTrees: TreeData[];
  /** Only the trees the active chat really grew, most recent first. */
  grownTrees: TreeData[];
  /** Every tree, for the forest. */
  forestTrees: TreeData[];
  /** Roots between trees (shared concepts, splits, chats), matched by concept id. */
  roots: CrossRoots;
  groves: Grove[];
  groveRows: string[][];
  /** All chats, most recent first, grouped like a chat app's sidebar. */
  chats: { label: DayGroup; items: ChatListItem[] }[];
  /** The chats a tree was grown in, most recent first. */
  grownIn: (treeId: Id) => GrownIn[];
  demoPrompts: string[];
  /** Can the assistant quiz the user on this concept? */
  canQuiz: (conceptId: Id) => boolean;
  /** `veil`: hide the answer until the user guesses or reveals it (predict → reveal). `thinking`: the fast model's rating of exactly this text, from the composer. Returns the new message's id (undefined: not sent). */
  send: (text: string, cls?: Classification, opts?: { veil?: boolean; thinking?: ScoreResult }) => Id | undefined;
  /** The fast model's rating, for the composer's live score (`draftScore.ts`); null when the provider has none (demo, scores off). */
  scoreDraft: ScoreFn | null;
  /** The word filter, the composer's instant tier (`liveFilter.ts`); null in demo mode. */
  filter: LiveFilter | null;
  /** Stop the reply that is streaming. */
  stop: () => void;
  /** Run the failed turn again. */
  retry: () => void;
  /** Classify with the current conversation context (e.g. a pending quiz). */
  classifyDraft: (text: string) => Classification;
  /** Scroll to a message of the active chat and flash it. */
  jumpTo: (messageId: string) => void;
  /** Open a chat (any chat) and, given a message, jump to it. */
  openChat: (id: Id, messageId?: Id) => void;
  newChat: () => void;
  /** Rename the active chat. */
  renameChat: (title: string) => void;
  /** Load a chat's messages without opening it (live mode). */
  loadChat: (id: Id) => void;
  /** Try a failed load again. */
  retryLoad: () => void;
  toast: (text: string) => void;
  finishOnboarding: () => void;
  /** Settings → model (provider `own`): the keys on this device, test connection, model lists. */
  own: OwnControls;
  /** Usage log (`events.ts`): an event only the design knows. A no-op in the demo; never throws. */
  track: (e: UsageEvent) => void;
}

export interface OwnControls extends KeySnapshot {
  setKey: (role: Role, key: string) => void;
  setRemember: (on: boolean) => void;
  test: (signal: AbortSignal) => Promise<TestReport>;
  models: (role: Role, signal?: AbortSignal) => Promise<string[]>;
}

const StoreContext = createContext<Ctx | null>(null);

export function StoreProvider({ children, provider: given }: { children: ReactNode; provider?: Provider }) {
  // The word filter learns from every judged message in live mode; its weights load on first use.
  const [filter] = useState(() => new LiveFilter(browserStorage()));
  const [app] = useState(() =>
    createApp({
      params: urlParams(),
      storage: browserStorage(),
      session: tabStorage(),
      backend: remoteBackend(session),
      build: import.meta.env.VITE_DEFAULT_PROVIDER,
      provider: given,
      page: typeof window === 'undefined' ? null : { win: window, doc: document },
      judged: filter.learn,
    }),
  );
  const { store } = app;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const sync = useSyncExternalStore(app.queue.subscribe, app.queue.status);
  const keys = useSyncExternalStore(app.keys.subscribe, app.keys.snapshot);
  const own = useMemo<OwnControls>(
    () => ({
      ...keys,
      setKey: app.keys.setKey,
      setRemember: app.keys.setRemember,
      test: (signal) => app.own.test(signal),
      models: (role, signal) => app.own.listModels(role, signal),
    }),
    [app, keys],
  );
  const initialSettings = useRef(state.settings);

  useEffect(() => app.start(), [app]);

  // Persist only changes the user makes (not URL-parameter overrides on load). The provider is saved in `dispatch`.
  useEffect(() => {
    if (state.settings === initialSettings.current) return;
    const { provider: _, ...rest } = state.settings;
    save(browserStorage(), SETTINGS_KEY, JSON.stringify(rest));
  }, [state.settings]);

  useEffect(() => () => app.stop(), [app]);

  const choice = state.settings.provider;
  // `app.provider()` follows the setting, so `choice` keys the memo.
  const provider = useMemo(() => app.provider(), [app, choice]);
  const canQuiz = useCallback((id: Id) => (provider.canQuiz ? provider.canQuiz(id) : true), [provider]);
  // `own` switches its scores on and off in settings without a new provider: `canScore` keys the memo too.
  const canScore = Boolean(provider.score);
  const scoreDraft = useMemo(() => draftScoreFn(provider), [provider, canScore]);

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
    const byId = new Map(forestTrees.map((t) => [t.id, t]));
    const activeTrees = home.flatMap((id) => byId.get(id) ?? []);
    const grownTrees = touched.flatMap((id) => byId.get(id) ?? []);
    const groves: Grove[] = Object.values(concepts)
      .filter((c) => c.kind === 'subject' && !c.deletedAt && trees.some((t) => t.groveId === c.id))
      .map((c) => ({ id: c.id, label: c.label }));
    if (trees.some((t) => !t.groveId)) groves.push({ id: 'other', label: 'Other' });

    // Leaf scores by concept, and per chat the leaves it touched in each tree (its crowns).
    const score = new Map<Id, number>();
    const crowns = new Map<Id, Crown[]>();
    for (const t of forestTrees) {
      const mine = new Map<Id, number[]>();
      for (const l of t.branches.flatMap((b) => b.leaves)) {
        score.set(l.id, l.score);
        for (const c of new Set((l.refs ?? []).map((r) => r.conversationId))) mine.set(c, [...(mine.get(c) ?? []), l.score]);
      }
      for (const [c, scores] of mine) crowns.set(c, [...(crowns.get(c) ?? []), { treeId: t.id, title: t.title, scores }]);
    }

    const chats = new Map<DayGroup, ChatListItem[]>();
    for (const c of Object.values(conversations).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const g = dayGroup(c.updatedAt);
      const treeId = treesOfConversation(c.id, { attempts, membership })[0] ?? (c.id === activeId ? (home[0] ?? null) : null);
      chats.set(g, [...(chats.get(g) ?? []), { id: c.id, title: c.title, updatedAt: c.updatedAt, treeId, crowns: crowns.get(c.id) ?? [], active: c.id === activeId }]);
    }
    const grownIn = (treeId: Id): GrownIn[] =>
      conversationsOfTree(treeId, { attempts, membership }).flatMap((g) => {
        const c = conversations[g.conversationId];
        return c ? [{ id: c.id, title: c.title, lastAt: g.lastAt, scores: g.conceptIds.flatMap((id) => score.get(id) ?? []) }] : [];
      });
    return {
      forestTrees,
      activeTrees,
      grownTrees,
      roots: crossRoots(forestTrees, edges, trees, attempts, conversations),
      groves,
      groveRows: groveRowsOf(groves),
      chats: [...chats.entries()].map(([label, items]) => ({ label, items })),
      grownIn,
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
      dispatch: app.dispatch,
      mode: isLiveChoice(choice) ? 'live' : 'demo',
      sync,
      conversation,
      messages,
      busy,
      activeTree,
      ...graph,
      demoPrompts: provider.demoPrompts ?? state.session.demoPrompts,
      canQuiz,
      send: app.send,
      scoreDraft,
      filter: isLiveChoice(choice) ? filter : null,
      stop: app.stop,
      retry: app.retry,
      classifyDraft: app.classifyDraft,
      jumpTo: app.jumpTo,
      openChat: app.openChat,
      newChat: app.newChat,
      renameChat: app.renameChat,
      loadChat: app.loadChat,
      retryLoad: app.retryLoad,
      toast: app.toast,
      finishOnboarding: app.finishOnboarding,
      own,
      track: app.track,
    }),
    [app, state, choice, sync, conversation, messages, busy, activeTree, graph, provider, canQuiz, scoreDraft, filter, own],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore outside StoreProvider');
  return ctx;
}
