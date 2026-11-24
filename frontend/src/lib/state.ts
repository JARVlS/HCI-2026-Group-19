import { mergeMessages, NEW_CHAT_TITLE, titleFrom } from './chats';
import type { Concept, ConceptAttempt, ConceptEdge, Conversation, Id, ISO, KnowledgeTree, Message, Mode, TreePlanner } from './domain';
import { slugify } from './graph';
import { MODE_SCORE } from './modes';
import { CHAT, stored, type View } from './nav';
import { HeuristicPlanner, runPlanner } from './planner';
import { scoredAttempt, scoredAttempts, scoredLabel } from './scores';
import type { Classification, ScoreKey, ScoreState, Settings } from './types';

/**
 * Store state and the pure reducer (IMPLEMENTATION_PLAN.md, M1). Three slices:
 *   domain  — canonical entities (ADR-2); what M2 persists and syncs
 *   session — the active chat and the turn in flight
 *   ui      — the view (`nav.ts`, changed only through `app.navigate()`), panel, draft, highlight, toast…
 * Side effects (providers, timers, ids for new records) live in `turn.ts` and `store.tsx`.
 */

export interface DomainState {
  conversations: Record<Id, Conversation>;
  messagesByConv: Record<Id, Message[]>;
  concepts: Record<Id, Concept>;
  edges: ConceptEdge[];
  trees: KnowledgeTree[];
  attempts: ConceptAttempt[];
}

export type TurnStatus = 'idle' | 'thinking' | 'streaming' | 'error';

export interface TurnState {
  status: TurnStatus;
  conversationId?: Id;
  userMessageId?: Id;
  assistantMessageId?: Id;
  error?: string;
}

/** Live mode: something is loading from the backend, or failed to. */
export type LoadStatus = 'loading' | { error: string };

export interface SessionState {
  activeConversationId: Id;
  /** Concept id if the assistant just asked a quiz question in the active chat. */
  pendingQuiz: Id | null;
  turn: TurnState;
  /** Prompts `tab` cycles through (from the active fixture). */
  demoPrompts: string[];
  /** Live mode: the user's data loads at start. Always 'ready' in demo mode. */
  boot: 'ready' | LoadStatus;
  /** Live mode: chats whose messages are loading or failed to load. A loaded chat has its list in `messagesByConv`. */
  chatLoad: Record<Id, LoadStatus>;
}

export interface UiState {
  panelOpen: boolean;
  /** The screen (ADR-13). A chat view means the active chat; `app.navigate()` changes it, never a design directly. */
  view: View;
  /** Text pushed into the composer from elsewhere (nudges, "explain it back"…). */
  draft: { text: string; nonce: number };
  highlight: string[];
  /** What the composer is showing right now, so the mascot can react while you type. */
  composer: { lens: Mode | null; nudge: boolean };
  flash: { id: string; nonce: number } | null;
  onboarding: boolean;
  toast: { text: string; nonce: number } | null;
  /** Which of the active chat's trees the pane shows (null: the most recent one). */
  paneTreeId: Id | null;
}

export interface State {
  domain: DomainState;
  session: SessionState;
  ui: UiState;
  settings: Settings;
}

/** The result of merging one analysis, computed in `turn.ts` (it needs fresh ids). */
export interface AnalysisPatch {
  conversationId: Id;
  userMessageId: Id;
  classification: Classification;
  created: Concept[];
  attempts: ConceptAttempt[];
  subjectId?: Id;
  now: ISO;
}

export type Action =
  | { type: 'hydrate'; domain: DomainState; activeConversationId: Id; demoPrompts: string[] }
  | { type: 'bootStart' }
  | { type: 'bootFailed'; error: string }
  | { type: 'messagesLoading'; conversationId: Id }
  | { type: 'messagesLoaded'; conversationId: Id; messages: Message[] }
  | { type: 'messagesFailed'; conversationId: Id; error: string }
  | { type: 'conversationNew'; conversation: Conversation }
  | { type: 'conversationOpen'; id: Id }
  | { type: 'conversationTitle'; id: Id; title: string; at: ISO }
  | { type: 'user'; msg: Message }
  | { type: 'retryStart'; conversationId: Id; userMessageId: Id }
  | { type: 'assistantStart'; msg: Message; userMessageId: Id }
  | { type: 'stream'; conversationId: Id; id: Id; text: string }
  | { type: 'assistantDone'; conversationId: Id; id: Id; text: string; pendingQuiz?: Id | null; reflectOn?: Id; model?: string; stopped?: boolean }
  | { type: 'turnError'; conversationId: Id; userMessageId: Id; assistantMessageId?: Id; error: string }
  | { type: 'turnStopped'; conversationId: Id; userMessageId: Id }
  | { type: 'analysisDone'; patch: AnalysisPatch }
  | { type: 'analysisFailed'; conversationId: Id; userMessageId: Id }
  /** A fast score of a user message started, failed or landed (live mode). */
  | { type: 'score'; userMessageId: Id; key: ScoreKey; value: ScoreState }
  | { type: 'reclassify'; id: Id; mode: Mode }
  | { type: 'reveal'; id: Id; guess: string }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'panel'; open: boolean }
  /** Only `app.navigate()` dispatches this (ADR-13). */
  | { type: 'view'; view: View }
  | { type: 'paneTree'; id: Id | null }
  | { type: 'draft'; text: string }
  | { type: 'highlight'; ids: string[] }
  | { type: 'composer'; lens: Mode | null; nudge: boolean }
  | { type: 'flash'; id: string }
  | { type: 'onboarding'; open: boolean }
  | { type: 'toast'; text: string };

export const isBusy = (t: TurnState) => t.status === 'thinking' || t.status === 'streaming';

const planner: TreePlanner = new HeuristicPlanner();

/* ───────────── helpers ───────────── */

function mapMessages(d: DomainState, conversationId: Id, f: (m: Message, i: number, all: Message[]) => Message): DomainState {
  const list = d.messagesByConv[conversationId];
  if (!list) return d;
  return { ...d, messagesByConv: { ...d.messagesByConv, [conversationId]: list.map(f) } };
}

export function findMessage(d: DomainState, id: Id): { conversationId: Id; index: number; msg: Message } | null {
  for (const [conversationId, list] of Object.entries(d.messagesByConv)) {
    const index = list.findIndex((m) => m.id === id);
    if (index >= 0) return { conversationId, index, msg: list[index] };
  }
  return null;
}

/** The assistant reply that follows a user message, if there is one yet. */
function replyOf(list: Message[], userIndex: number): Message | undefined {
  const next = list[userIndex + 1];
  return next?.role === 'assistant' ? next : undefined;
}

/**
 * Relabels never delete: each live attempt of the message is superseded by a new one with the
 * new mode. The new attempt keeps the original time, so replay order (and leaf order) is unchanged;
 * its id derives from the one it replaces, which keeps the reducer pure.
 */
function supersede(attempts: ConceptAttempt[], messageId: Id, mode: Mode, source: ConceptAttempt['source'], reason?: string): ConceptAttempt[] {
  const next: ConceptAttempt[] = [];
  const out = attempts.map((a) => {
    if (a.messageId !== messageId || a.supersededBy) return a;
    const id = `${a.id}~${source === 'reveal' ? 'r' : mode}`;
    next.push({ ...a, id, mode, independence: MODE_SCORE[mode], source, reasons: reason ? [...a.reasons, reason] : a.reasons });
    return { ...a, supersededBy: id };
  });
  return next.length ? [...out, ...next] : attempts;
}

const REVEAL_REASON = 'You predicted the answer before reading it';

function touchConversation(d: DomainState, id: Id, at: ISO): DomainState {
  const c = d.conversations[id];
  if (!c || c.updatedAt >= at) return d;
  return { ...d, conversations: { ...d.conversations, [id]: { ...c, updatedAt: at } } };
}

/* ───────────── domain reducer ───────────── */

function applyAnalysis(d: DomainState, p: AnalysisPatch): DomainState {
  const found = findMessage(d, p.userMessageId);
  if (!found) return d;
  const list = d.messagesByConv[found.conversationId];
  const user = found.msg;
  const reply = replyOf(list, found.index);

  // New concepts: drop any that another merge created meanwhile (same slug, same parent).
  const concepts = { ...d.concepts };
  const remap = new Map<Id, Id>();
  for (const c of p.created) {
    const dupe = Object.values(concepts).find((x) => !x.deletedAt && x.slug === slugify(c.label) && x.parentId === c.parentId);
    if (dupe) remap.set(c.id, dupe.id);
    else concepts[c.id] = c;
  }

  // What the user did while the analysis was on its way wins over it. A scored message (live)
  // takes its numbers from the fast scores, which may have landed first (`scores.ts`).
  let classification = p.classification;
  let adjust: ((a: ConceptAttempt) => ConceptAttempt) | null = null;
  if (user.classification?.overridden) {
    const mode = user.classification.mode;
    classification = { ...p.classification, mode, overridden: true };
    adjust = (a) => ({ ...a, mode, independence: MODE_SCORE[mode], source: 'override' });
  } else if (!user.scores && reply?.guess && p.classification.mode === 'ai') {
    classification = { ...p.classification, mode: 'together', reasons: [...p.classification.reasons, REVEAL_REASON] };
    adjust = (a) => (a.mode === 'ai' ? { ...a, mode: 'together', independence: MODE_SCORE.together, source: 'reveal', reasons: [...a.reasons, REVEAL_REASON] } : a);
  }
  const scores = user.scores;
  if (scores) classification = scoredLabel(classification, scores);
  const fresh = p.attempts.map((a) => {
    const b = { ...a, conceptId: remap.get(a.conceptId) ?? a.conceptId };
    const c = adjust ? adjust(b) : b;
    return scores ? scoredAttempt(c, scores) : c;
  });
  const conceptIds = [...new Set(fresh.map((a) => a.conceptId))];

  // Re-running an analysis for the same message replaces its earlier attempts.
  const attempts = [...d.attempts.filter((a) => a.messageId !== p.userMessageId), ...fresh];

  let next: DomainState = {
    ...d,
    concepts,
    attempts,
    messagesByConv: {
      ...d.messagesByConv,
      [found.conversationId]: list.map((m) =>
        m.id === user.id ? { ...m, classification, conceptIds, analysis: 'done' } : m === reply ? { ...m, conceptIds } : m,
      ),
    },
  };
  if (p.subjectId) {
    const conv = next.conversations[found.conversationId];
    if (conv && !conv.subjectId) next = { ...next, conversations: { ...next.conversations, [conv.id]: { ...conv, subjectId: p.subjectId } } };
  }
  return { ...next, trees: runPlanner(planner, next, p.now) };
}

function domainReducer(d: DomainState, a: Action): DomainState {
  switch (a.type) {
    case 'conversationNew':
      return { ...d, conversations: { ...d.conversations, [a.conversation.id]: a.conversation }, messagesByConv: { ...d.messagesByConv, [a.conversation.id]: [] } };
    case 'user': {
      const id = a.msg.conversationId;
      const list = d.messagesByConv[id] ?? [];
      const next = touchConversation({ ...d, messagesByConv: { ...d.messagesByConv, [id]: [...list, a.msg] } }, id, a.msg.createdAt);
      // A new chat is named after its first message (no model call); `/title` renames it.
      const c = next.conversations[id];
      if (!c || c.title !== NEW_CHAT_TITLE || list.some((m) => m.role === 'user')) return next;
      return { ...next, conversations: { ...next.conversations, [id]: { ...c, title: titleFrom(a.msg.text) } } };
    }
    case 'messagesLoaded':
      // What this device has (newer, or not saved yet) wins over what was loaded.
      return { ...d, messagesByConv: { ...d.messagesByConv, [a.conversationId]: mergeMessages(a.messages, d.messagesByConv[a.conversationId] ?? []) } };
    case 'conversationTitle': {
      const c = d.conversations[a.id];
      if (!c) return d;
      return { ...d, conversations: { ...d.conversations, [a.id]: { ...c, title: a.title, updatedAt: a.at > c.updatedAt ? a.at : c.updatedAt } } };
    }
    case 'retryStart': {
      // Drop the failed reply (if any) so the retry streams into a fresh one.
      const list = d.messagesByConv[a.conversationId] ?? [];
      const i = list.findIndex((m) => m.id === a.userMessageId);
      const failed = replyOf(list, i);
      if (!failed) return d;
      return { ...d, messagesByConv: { ...d.messagesByConv, [a.conversationId]: list.filter((m) => m !== failed) } };
    }
    case 'assistantStart': {
      const id = a.msg.conversationId;
      const list = d.messagesByConv[id] ?? [];
      const user = list.find((m) => m.id === a.userMessageId);
      return { ...d, messagesByConv: { ...d.messagesByConv, [id]: [...list, { ...a.msg, conceptIds: user?.conceptIds ?? a.msg.conceptIds }] } };
    }
    case 'stream':
      return mapMessages(d, a.conversationId, (m) => (m.id === a.id ? { ...m, text: a.text } : m));
    case 'assistantDone':
      return mapMessages(d, a.conversationId, (m) =>
        m.id === a.id ? { ...m, text: a.text, streaming: false, reflectOn: a.reflectOn, model: a.model ?? m.model, stopped: a.stopped || undefined } : m,
      );
    case 'turnError':
      return a.assistantMessageId
        ? mapMessages(d, a.conversationId, (m) => (m.id === a.assistantMessageId ? { ...m, streaming: false, error: a.error } : m))
        : d;
    case 'analysisDone':
      return applyAnalysis(d, a.patch);
    case 'analysisFailed':
      return mapMessages(d, a.conversationId, (m) => (m.id === a.userMessageId ? { ...m, analysis: 'failed' } : m));
    case 'score': {
      const found = findMessage(d, a.userMessageId);
      if (!found) return d;
      const scores = { ...found.msg.scores, [a.key]: a.value };
      const next = mapMessages(d, found.conversationId, (m) =>
        m.id === a.userMessageId ? { ...m, scores, classification: m.classification && scoredLabel(m.classification, scores) } : m,
      );
      return { ...next, attempts: scoredAttempts(next.attempts, a.userMessageId, scores) };
    }
    case 'reclassify': {
      const found = findMessage(d, a.id);
      if (!found?.msg.classification) return d;
      const next = mapMessages(d, found.conversationId, (m) =>
        m.id === a.id ? { ...m, classification: { ...m.classification!, mode: a.mode, overridden: true } } : m,
      );
      return { ...next, attempts: supersede(next.attempts, a.id, a.mode, 'override') };
    }
    case 'reveal': {
      // A guess before reading turns a delegated prompt into thinking together. A scored message
      // (live) is not flipped: its guess is scored once the reply is complete (`turn.ts`, `scores.ts`).
      const found = findMessage(d, a.id);
      if (!found) return d;
      const list = d.messagesByConv[found.conversationId];
      const guess = a.guess.trim();
      const userIdx = guess ? list.slice(0, found.index).map((m) => m.role).lastIndexOf('user') : -1;
      const user = userIdx >= 0 ? list[userIdx] : undefined;
      const flips = Boolean(user?.classification && user.classification.mode === 'ai' && !user.scores);
      const next = mapMessages(d, found.conversationId, (m, j) => {
        if (j === found.index) return { ...m, veiled: false, guess: guess || undefined };
        if (flips && j === userIdx) return { ...m, classification: { ...m.classification!, mode: 'together', reasons: [...m.classification!.reasons, REVEAL_REASON] } };
        return m;
      });
      return flips && user ? { ...next, attempts: supersede(next.attempts, user.id, 'together', 'reveal', REVEAL_REASON) } : next;
    }
    default:
      return d;
  }
}

/* ───────────── session + ui reducers ───────────── */

function sessionReducer(s: SessionState, a: Action): SessionState {
  switch (a.type) {
    case 'hydrate':
      return { ...s, activeConversationId: a.activeConversationId, demoPrompts: a.demoPrompts, pendingQuiz: null, turn: { status: 'idle' }, boot: 'ready', chatLoad: {} };
    case 'bootStart':
      return { ...s, boot: 'loading' };
    case 'bootFailed':
      return { ...s, boot: { error: a.error } };
    case 'messagesLoading':
      return { ...s, chatLoad: { ...s.chatLoad, [a.conversationId]: 'loading' } };
    case 'messagesFailed':
      return { ...s, chatLoad: { ...s.chatLoad, [a.conversationId]: { error: a.error } } };
    case 'messagesLoaded': {
      const { [a.conversationId]: _, ...rest } = s.chatLoad;
      return { ...s, chatLoad: rest };
    }
    case 'conversationNew':
    case 'conversationOpen': {
      const id = a.type === 'conversationNew' ? a.conversation.id : a.id;
      return id === s.activeConversationId ? s : { ...s, activeConversationId: id, pendingQuiz: null };
    }
    case 'user':
      return { ...s, turn: { status: 'thinking', conversationId: a.msg.conversationId, userMessageId: a.msg.id } };
    case 'retryStart':
      return { ...s, turn: { status: 'thinking', conversationId: a.conversationId, userMessageId: a.userMessageId } };
    case 'assistantStart':
      return { ...s, turn: { ...s.turn, status: 'streaming', assistantMessageId: a.msg.id } };
    case 'assistantDone': {
      const pendingQuiz = a.conversationId === s.activeConversationId && a.pendingQuiz !== undefined && !a.stopped ? a.pendingQuiz : s.pendingQuiz;
      return { ...s, pendingQuiz, turn: { status: 'idle' } };
    }
    case 'turnError':
      return { ...s, turn: { status: 'error', conversationId: a.conversationId, userMessageId: a.userMessageId, assistantMessageId: a.assistantMessageId, error: a.error } };
    case 'turnStopped':
      return { ...s, turn: { status: 'idle' } };
    default:
      return s;
  }
}

function uiReducer(u: UiState, a: Action): UiState {
  switch (a.type) {
    case 'hydrate':
      return { ...u, highlight: [], view: CHAT, paneTreeId: null };
    case 'conversationNew':
    case 'conversationOpen':
      // Opening a chat (from the chat list, the forest or a leaf) shows it.
      return { ...u, highlight: [], paneTreeId: null, view: CHAT };
    case 'view': {
      const view = stored(a.view);
      return view === u.view || JSON.stringify(view) === JSON.stringify(u.view) ? u : { ...u, view };
    }
    case 'panel':
      return { ...u, panelOpen: a.open };
    case 'paneTree':
      return { ...u, paneTreeId: a.id };
    case 'draft':
      return { ...u, draft: { text: a.text, nonce: u.draft.nonce + 1 } };
    case 'highlight':
      return { ...u, highlight: a.ids };
    case 'composer':
      if (u.composer.lens === a.lens && u.composer.nudge === a.nudge) return u;
      return { ...u, composer: { lens: a.lens, nudge: a.nudge } };
    case 'flash':
      return { ...u, flash: { id: a.id, nonce: (u.flash?.nonce ?? 0) + 1 } };
    case 'onboarding':
      return { ...u, onboarding: a.open };
    case 'toast':
      return { ...u, toast: { text: a.text, nonce: (u.toast?.nonce ?? 0) + 1 } };
    default:
      return u;
  }
}

/** A chat that was left without a message is dropped: an empty chat exists only while it is open. */
function leave(d: DomainState, s: SessionState, a: Action): DomainState {
  if (a.type !== 'conversationNew' && a.type !== 'conversationOpen') return d;
  const id = s.activeConversationId;
  const target = a.type === 'conversationNew' ? a.conversation.id : a.id;
  if (id === target || d.messagesByConv[id]?.length !== 0) return d;
  const { [id]: _c, ...conversations } = d.conversations;
  const { [id]: _m, ...messagesByConv } = d.messagesByConv;
  return { ...d, conversations, messagesByConv };
}

export function reducer(s: State, a: Action): State {
  if (a.type === 'hydrate') {
    return { ...s, domain: a.domain, session: sessionReducer(s.session, a), ui: uiReducer(s.ui, a) };
  }
  if (a.type === 'settings') return { ...s, settings: { ...s.settings, ...a.patch } };
  const domain = domainReducer(leave(s.domain, s.session, a), a);
  const session = sessionReducer(s.session, a);
  const ui = uiReducer(s.ui, a);
  return domain === s.domain && session === s.session && ui === s.ui ? s : { ...s, domain, session, ui };
}

/* ───────────── selectors ───────────── */

export const isForest = (s: State) => s.ui.view.kind === 'forest';
export const isChats = (s: State) => s.ui.view.kind === 'chats';
/** The tree the forest opened on, if any. */
export const forestFocus = (s: State): Id | null => (s.ui.view.kind === 'forest' ? (s.ui.view.treeId ?? null) : null);

export const activeMessages = (s: State): Message[] => s.domain.messagesByConv[s.session.activeConversationId] ?? [];
export const activeConversation = (s: State): Conversation | undefined => s.domain.conversations[s.session.activeConversationId];
