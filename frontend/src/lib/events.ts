import { isLiveChoice } from '../ai/providers';
import { looksLikeQuizAnswer } from './classify';
import type { Id, Message } from './domain';
import { liveAttempts, treeOfConcept } from './links';
import { pct } from './modes';
import { treeLeaves } from './project';
import { isScore } from './scores';
import { findMessage, type Action, type State, type UiState } from './state';
import type { Mode, ProviderChoice, ScoreKey, Settings, Theme } from './types';

/**
 * The usage log's catalogue (IMPLEMENTATION_PLAN.md M6, "Event log"): every event Arbor logs and
 * the shape of its payload. `track` takes only these, so a new event starts here.
 *
 * Payloads hold ids, counts, lengths, labels, numbers and enum values. Never a message, a draft, a
 * chat title, a concept label, a guess, a username, a key or an endpoint: the texts are in the
 * saved chats already, and the log must stay harmless. `telemetry.ts` adds the envelope (`visit`,
 * `seq`, `design`) and sends them (`POST /api/events`), in live mode only.
 */

type Payload = Record<string, string | number | boolean | null>;
type None = Record<string, never>;
/** `conversationId`: the chat it is about; `telemetry.ts` puts in the open chat when it is left out. */
type Ev<T extends string, P extends Payload = None> = { type: T; payload: P; conversationId?: Id };

export type TreeView = 'tree' | 'outline';
/** What the knowledge pane shows: its tree in one of the two views, or the forest over it. */
export type PaneView = TreeView | 'forest';
export type ViewVia = 'key' | 'command' | 'click';
export type PaneKind = 'rest_on_leaf' | 'open_refs' | 'jump_to_message' | 'scrub';
/** The settings whose new value is logged; `own` (endpoints) only says that it changed. */
const LOGGED_SETTINGS = ['provider', 'nudge', 'theme', 'design', 'enabled', 'mascot', 'showTags'] as const satisfies readonly (keyof Settings)[];

export type UsageEvent =
  /* Derived from the store (`eventsOf`), in every design. */
  | Ev<'session_start', { provider: ProviderChoice; chats: number; trees: number; concepts: number; width: number; height: number; theme: Theme; signedIn: boolean }>
  | Ev<'turn_sent', { messageId: Id; chars: number; words: number; mode: Mode | null; confidence: number | null; thinking: number | null; quizAnswer: boolean }>
  | Ev<'reply_done', { messageId: Id; userMessageId: Id | null; chars: number; ms: number | null; model: string | null; stopped: boolean }>
  | Ev<'turn_error', { userMessageId: Id; assistantMessageId: Id | null; error: string }>
  | Ev<'turn_stopped', { userMessageId: Id }>
  | Ev<'retry', { userMessageId: Id }>
  | Ev<'analysis_shown', { userMessageId: Id; mode: Mode; shown: Mode | null; judged: number; newConcepts: number; newTrees: number }>
  | Ev<'analysis_failed', { userMessageId: Id }>
  | Ev<'score', { userMessageId: Id; key: ScoreKey; percent: number | null; label: Mode | null; failed: boolean }>
  | Ev<'relabel', { messageId: Id; from: Mode | null; to: Mode }>
  | Ev<'veil_shown', { messageId: Id; userMessageId: Id }>
  | Ev<'reveal', { messageId: Id; guessChars: number; ms: number }>
  | Ev<'veil_skip', { messageId: Id; ms: number }>
  | Ev<'nudge_shown', { lens: Mode | null }>
  | Ev<'setting_changed', { key: (typeof LOGGED_SETTINGS)[number] | 'own'; value: string | boolean | null }>
  | Ev<'panel', { open: boolean }>
  | Ev<'forest_open', { focus: Id | null }>
  | Ev<'forest_close'>
  | Ev<'chats_open'>
  | Ev<'chats_close'>
  | Ev<'pane_tree', { treeId: Id | null }>
  | Ev<'onboarding', { open: boolean }>
  | Ev<'chat_new'>
  | Ev<'chat_open', { from: Id | null }>
  | Ev<'chat_rename'>
  | Ev<'tree_created', { treeId: Id; splitFrom: Id | null; leaves: number }>
  /* Only the ASCII design knows these (`useStore().track`). */
  | Ev<'view_start', { view: TreeView }>
  | Ev<'view_change', { from: TreeView; to: TreeView; via: ViewVia }>
  /** `conceptId`: the leaf (null for `scrub`); `days`: where the forgetting scrubber stands. */
  | Ev<'pane_action', { kind: PaneKind; view: PaneView; conceptId: Id | null; days: number }>
  | Ev<'why_open', { messageId: Id }>
  | Ev<'sheet_open', { which: 'concepts' | 'model' }>
  /** The command's name only, never its argument. */
  | Ev<'command', { name: string }>
  | Ev<'squirrel_poke', { dizzy: boolean }>
  /** The fast model's rating of a draft landed (not every word the filter rates). */
  | Ev<'draft_rated', { percent: number; mode: Mode; model: string | null; chars: number }>
  /* The page, and the log itself (`telemetry.ts`). */
  | Ev<'page_hidden'>
  | Ev<'page_visible'>
  | Ev<'events_dropped', { count: number }>;

/** What `eventsOf` needs besides the state: the time (ms) and, for `session_start`, the screen and the account. */
export interface EventEnv {
  at: number;
  width: number;
  height: number;
  signedIn: boolean;
}

const NONE: None = {};
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const since = (at: number, iso: string) => Math.max(0, at - Date.parse(iso));

/** The user message right before a reply in its chat. */
function promptOf(s: State, conversationId: Id, replyId: Id): Message | undefined {
  const list = s.domain.messagesByConv[conversationId] ?? [];
  const before = list[list.findIndex((m) => m.id === replyId) - 1];
  return before?.role === 'user' ? before : undefined;
}

/** Trees in `next` that `prev` did not have. */
function grownTrees(prev: State, next: State) {
  const before = new Set(prev.domain.trees.map((t) => t.id));
  return next.domain.trees.filter((t) => !before.has(t.id));
}

/** Panels that opened or closed and a nudge that showed, read from the state (so a chat opened from the forest also counts as leaving it). */
function uiEvents(p: UiState, n: UiState): UsageEvent[] {
  const out: UsageEvent[] = [];
  if (p.panelOpen !== n.panelOpen) out.push({ type: 'panel', payload: { open: n.panelOpen } });
  if (p.forest.open !== n.forest.open) out.push(n.forest.open ? { type: 'forest_open', payload: { focus: n.forest.focus } } : { type: 'forest_close', payload: NONE });
  if (p.chats !== n.chats) out.push({ type: n.chats ? 'chats_open' : 'chats_close', payload: NONE });
  if (p.onboarding !== n.onboarding) out.push({ type: 'onboarding', payload: { open: n.onboarding } });
  if (!p.composer.nudge && n.composer.nudge) out.push({ type: 'nudge_shown', payload: { lens: n.composer.lens } });
  return out;
}

/** What one action did, as usage events. Pure: the store's observer calls it with every change (`app.ts`). */
export function eventsOf(prev: State, next: State, a: Action, env: () => EventEnv): UsageEvent[] {
  const out: UsageEvent[] = [];
  const d = next.domain;
  switch (a.type) {
    case 'hydrate':
      if (isLiveChoice(next.settings.provider)) {
        const { width, height, signedIn } = env();
        out.push({
          type: 'session_start',
          payload: {
            provider: next.settings.provider,
            // A first visit's new, empty chat is not saved yet: not counted.
            chats: Object.keys(d.conversations).filter((id) => d.messagesByConv[id]?.length !== 0).length,
            trees: d.trees.length,
            concepts: Object.values(d.concepts).filter((c) => !c.deletedAt).length,
            width,
            height,
            theme: next.settings.theme,
            signedIn,
          },
        });
      }
      break;
    case 'user': {
      const { msg } = a;
      const thinking = msg.scores?.thinking;
      out.push({
        type: 'turn_sent',
        conversationId: msg.conversationId,
        payload: {
          messageId: msg.id,
          chars: msg.text.length,
          words: words(msg.text),
          mode: msg.classification?.mode ?? null,
          confidence: msg.classification?.confidence ?? null,
          thinking: isScore(thinking) ? pct(thinking.p) : null,
          quizAnswer: looksLikeQuizAnswer(msg.text, prev.session.pendingQuiz),
        },
      });
      break;
    }
    case 'assistantStart':
      if (a.msg.veiled) out.push({ type: 'veil_shown', conversationId: a.msg.conversationId, payload: { messageId: a.msg.id, userMessageId: a.userMessageId } });
      break;
    case 'assistantDone': {
      const user = promptOf(next, a.conversationId, a.id);
      const reply = findMessage(d, a.id)?.msg;
      out.push({
        type: 'reply_done',
        conversationId: a.conversationId,
        payload: {
          messageId: a.id,
          userMessageId: user?.id ?? null,
          chars: a.text.length,
          ms: user ? since(env().at, user.createdAt) : null,
          model: reply?.model ?? null,
          stopped: Boolean(a.stopped),
        },
      });
      break;
    }
    case 'turnError':
      out.push({
        type: 'turn_error',
        conversationId: a.conversationId,
        payload: { userMessageId: a.userMessageId, assistantMessageId: a.assistantMessageId ?? null, error: a.error.slice(0, 200) },
      });
      break;
    case 'turnStopped':
      out.push({ type: 'turn_stopped', conversationId: a.conversationId, payload: { userMessageId: a.userMessageId } });
      break;
    case 'retryStart':
      out.push({ type: 'retry', conversationId: a.conversationId, payload: { userMessageId: a.userMessageId } });
      break;
    case 'analysisDone': {
      const { patch } = a;
      out.push({
        type: 'analysis_shown',
        conversationId: patch.conversationId,
        payload: {
          userMessageId: patch.userMessageId,
          mode: patch.classification.mode,
          shown: findMessage(d, patch.userMessageId)?.msg.classification?.mode ?? null,
          judged: patch.attempts.length,
          newConcepts: Object.keys(d.concepts).filter((id) => !(id in prev.domain.concepts)).length,
          newTrees: grownTrees(prev, next).length,
        },
      });
      break;
    }
    case 'analysisFailed':
      out.push({ type: 'analysis_failed', conversationId: a.conversationId, payload: { userMessageId: a.userMessageId } });
      break;
    case 'score': {
      if (a.value === 'pending') break;
      const found = findMessage(d, a.userMessageId);
      out.push({
        type: 'score',
        conversationId: found?.conversationId,
        payload: {
          userMessageId: a.userMessageId,
          key: a.key,
          percent: isScore(a.value) ? pct(a.value.p) : null,
          label: found?.msg.classification?.mode ?? null,
          failed: a.value === 'failed',
        },
      });
      break;
    }
    case 'reclassify': {
      const found = findMessage(prev.domain, a.id);
      if (found?.msg.classification) out.push({ type: 'relabel', conversationId: found.conversationId, payload: { messageId: a.id, from: found.msg.classification.mode, to: a.mode } });
      break;
    }
    case 'reveal': {
      const found = findMessage(prev.domain, a.id);
      if (!found?.msg.veiled) break;
      const ms = since(env().at, found.msg.createdAt);
      const guess = a.guess.trim();
      out.push(
        guess
          ? { type: 'reveal', conversationId: found.conversationId, payload: { messageId: a.id, guessChars: guess.length, ms } }
          : { type: 'veil_skip', conversationId: found.conversationId, payload: { messageId: a.id, ms } },
      );
      break;
    }
    case 'settings':
      for (const key of LOGGED_SETTINGS) {
        if (key in a.patch && prev.settings[key] !== next.settings[key]) out.push({ type: 'setting_changed', payload: { key, value: next.settings[key] } });
      }
      if ('own' in a.patch && prev.settings.own !== next.settings.own) out.push({ type: 'setting_changed', payload: { key: 'own', value: null } });
      break;
    case 'paneTree':
      if (prev.ui.paneTreeId !== next.ui.paneTreeId) out.push({ type: 'pane_tree', payload: { treeId: a.id } });
      break;
    case 'conversationNew':
      out.push({ type: 'chat_new', conversationId: a.conversation.id, payload: NONE });
      break;
    case 'conversationOpen':
      if (prev.session.activeConversationId !== next.session.activeConversationId) {
        out.push({ type: 'chat_open', conversationId: a.id, payload: { from: prev.session.activeConversationId || null } });
      }
      break;
    case 'conversationTitle':
      out.push({ type: 'chat_rename', conversationId: a.id, payload: NONE });
      break;
  }
  out.push(...uiEvents(prev.ui, next.ui));
  // Trees the planner grew (a load brings trees too, but none of them is new).
  if (a.type !== 'hydrate' && prev.domain.trees !== d.trees) {
    const grown = grownTrees(prev, next);
    if (grown.length) {
      const membership = treeOfConcept(d.trees, d.concepts);
      const live = liveAttempts(d.attempts, d.concepts);
      for (const t of grown) {
        const leaves = treeLeaves(t, d.concepts, live, membership).reduce((n, b) => n + b.conceptIds.length, 0);
        out.push({
          type: 'tree_created',
          conversationId: a.type === 'analysisDone' ? a.patch.conversationId : undefined,
          payload: { treeId: t.id, splitFrom: t.splitFrom ?? null, leaves },
        });
      }
    }
  }
  return out;
}
