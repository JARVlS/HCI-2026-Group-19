import { ROLES, type OwnSetup } from '../ai/own/setup';
import { isLiveChoice } from '../ai/providers';
import { looksLikeQuizAnswer } from './classify';
import type { DraftGauge } from './draftScore';
import type { Id, Message } from './domain';
import { liveAttempts, treeOfConcept } from './links';
import { sheetOf, type NavVia, type ViewKind } from './nav';
import { pct } from './modes';
import { treeLeaves } from './project';
import { isScore } from './scores';
import { findMessage, type Action, type State, type UiState } from './state';
import type { Mode, ProviderChoice, ScoreKey, Settings, Theme } from './types';

/**
 * The usage log's catalogue (IMPLEMENTATION_PLAN.md M6, "Event log"): every event Arbor logs and
 * the shape of its payload. `track` takes only these, so a new event starts here.
 *
 * Since 21 Nov (Salomon: "Log anything potentially relevant") payloads carry the texts too: the
 * message, the reply, drafts as rated, pasted, copied and abandoned, guesses, chat titles, concept
 * labels, command arguments and toasts, each cut to MAX_TEXT characters (its `chars` field keeps
 * the real length, so a cut shows). Never logged: the session token, passwords, the own-model keys
 * (`ai/own/keys.ts`), a full endpoint URL (only its host) and the username (the backend files every
 * event under the user id). `telemetry.ts` adds the envelope (`visit`, `seq`, `design`) and sends
 * them (`POST /api/events`), in live mode only.
 */

type Payload = Record<string, string | number | boolean | null | string[]>;
type None = Record<string, never>;
/** `conversationId`: the chat it is about; `telemetry.ts` puts in the open chat when it is left out. */
type Ev<T extends string, P extends Payload = None> = { type: T; payload: P; conversationId?: Id };

export type TreeView = 'tree' | 'outline';
/** What the knowledge pane shows: its tree in one of the two views, or the forest over it. */
export type PaneView = TreeView | 'forest';
export type ViewVia = 'key' | 'command' | 'click';
export type PaneKind = 'rest_on_leaf' | 'open_refs' | 'jump_to_message' | 'scrub';
/** The settings whose new value is logged; `own` is logged without anything secret (`ownSetup`). */
const LOGGED_SETTINGS = ['provider', 'nudge', 'theme', 'design', 'enabled', 'mascot', 'showTags'] as const satisfies readonly (keyof Settings)[];

/** Most characters of one text in an event; a longer one is cut (its `chars` field has the real length). */
export const MAX_TEXT = 8000;
/** Most characters of an error message in an event. */
export const MAX_ERROR = 500;
export const cut = (text: string) => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);
const cutOrNull = (text: string | undefined) => (text === undefined ? null : cut(text));

/** The browser and the page, once per visit (`session_start`). `search`: the URL parameters the app was started with (none of them carries a secret). */
export type Device = {
  userAgent: string;
  language: string;
  timeZone: string;
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
  /** A coarse pointer (touch screen). */
  touch: boolean;
  search: string;
  referrer: string;
};

type Role = Message['role'];

export type UsageEvent =
  /* Derived from the store (`eventsOf`), in every design. */
  | Ev<'session_start', { provider: ProviderChoice; chats: number; trees: number; concepts: number; width: number; height: number; theme: Theme; signedIn: boolean } & Device>
  | Ev<'turn_sent', { messageId: Id; text: string; chars: number; words: number; mode: Mode | null; confidence: number | null; thinking: number | null; quizAnswer: boolean }>
  /** The first text of a reply arrived: `ms` since its message was sent. */
  | Ev<'reply_first', { messageId: Id; userMessageId: Id; ms: number | null }>
  | Ev<'reply_done', { messageId: Id; userMessageId: Id | null; text: string; chars: number; ms: number | null; model: string | null; stopped: boolean }>
  | Ev<'turn_error', { userMessageId: Id; assistantMessageId: Id | null; error: string }>
  | Ev<'turn_stopped', { userMessageId: Id }>
  | Ev<'retry', { userMessageId: Id }>
  /** `concepts`: the labels the turn was judged on; `reasons`: the analysis's reasons for its label. */
  | Ev<'analysis_shown', { userMessageId: Id; mode: Mode; shown: Mode | null; judged: number; concepts: string[]; reasons: string[]; newConcepts: number; newConceptLabels: string[]; newTrees: number }>
  | Ev<'analysis_failed', { userMessageId: Id }>
  | Ev<'score', { userMessageId: Id; key: ScoreKey; percent: number | null; label: Mode | null; model: string | null; failed: boolean }>
  | Ev<'relabel', { messageId: Id; from: Mode | null; to: Mode }>
  | Ev<'veil_shown', { messageId: Id; userMessageId: Id }>
  | Ev<'reveal', { messageId: Id; guess: string; guessChars: number; ms: number }>
  | Ev<'veil_skip', { messageId: Id; ms: number }>
  | Ev<'nudge_shown', { lens: Mode | null }>
  | Ev<'setting_changed', { key: (typeof LOGGED_SETTINGS)[number] | 'own'; value: string | boolean | null }>
  | Ev<'panel', { open: boolean }>
  | Ev<'forest_open', { focus: Id | null }>
  | Ev<'forest_close'>
  | Ev<'chats_open'>
  | Ev<'chats_close'>
  | Ev<'pane_tree', { treeId: Id | null; title: string | null }>
  | Ev<'onboarding', { open: boolean }>
  | Ev<'chat_new'>
  | Ev<'chat_open', { from: Id | null; title: string | null }>
  | Ev<'chat_rename', { title: string; from: string | null }>
  | Ev<'tree_created', { treeId: Id; title: string; splitFrom: Id | null; leaves: number }>
  /** Text put into the prompt from elsewhere ("explain it back", the `/` key, the classic nudges). */
  | Ev<'draft_fill', { text: string; chars: number }>
  /** The view scrolled to a message and flashed it (a leaf, the trail, `/why`). */
  | Ev<'message_jump', { messageId: Id }>
  | Ev<'toast', { text: string }>
  /** The start (`boot`) or a chat's messages did not load. */
  | Ev<'load_failed', { what: 'boot' | 'messages'; error: string }>
  /* Only the ASCII design knows these (`useStore().track`). */
  | Ev<'view_start', { view: TreeView }>
  | Ev<'view_change', { from: TreeView; to: TreeView; via: ViewVia }>
  /** `conceptId` and `label`: the leaf (null for `scrub`); `days`: where the forgetting scrubber stands. */
  | Ev<'pane_action', { kind: PaneKind; view: PaneView; conceptId: Id | null; label: string | null; days: number }>
  | Ev<'why_open', { messageId: Id }>
  | Ev<'sheet_open', { which: 'concepts' | 'model' }>
  /** A view change through `app.navigate()` (ADR-13); `via: 'back'` is the browser's back/forward, `link` a URL with a view. `ms`: time to choose in the radial menu. */
  | Ev<'nav', { from: ViewKind; to: ViewKind; via: NavVia; ms: number | null }>
  /** The radial menu was drawn (Alt held, or a long press); `on`: the view it opened over. */
  | Ev<'radial_open', { input: 'alt' | 'touch'; on: ViewKind }>
  /** The radial menu closed without a choice: released in the centre, esc, another key, the window lost focus, a tap outside. */
  | Ev<'radial_cancel', { reason: 'centre' | 'escape' | 'key' | 'blur' | 'outside'; ms: number }>
  /** `arg` as typed; null for a command that takes none, and for `/provider` (a confused user might paste a key after it). */
  | Ev<'command', { name: string; arg: string | null }>
  | Ev<'squirrel_poke', { dizzy: boolean }>
  /** A tip's button after a poke ("quiz me", "skip ahead", …). */
  | Ev<'squirrel_tip', { text: string; action: string }>
  /** The fast model's rating of a draft landed (not every word the filter rates): the draft as rated. */
  | Ev<'draft_rated', { text: string; percent: number; mode: Mode; model: string | null; chars: number }>
  /** The score line shows a new number from the word filter (`adjusted`: the model's last rating moved by the words since). No text: it comes with `draft_rated` and `turn_sent`. */
  | Ev<'filter_rated', { words: number; chars: number; percent: number; mode: Mode; from: Extract<DraftGauge['from'], 'filter' | 'adjusted'>; unsure: boolean }>
  /** A paste into the prompt; `draftChars`: the draft's length before it. */
  | Ev<'draft_paste', { text: string; chars: number; draftChars: number }>
  /** How a sent message was written: `ms` from the draft's first key or paste to send, key presses, of them Backspace/Delete, pastes. */
  | Ev<'compose', { messageId: Id | null; chars: number; ms: number | null; keys: number; deletes: number; pastes: number; pastedChars: number }>
  /** A draft was emptied by hand, not sent (`draftLog.ts`). */
  | Ev<'draft_abandoned', { text: string; chars: number }>
  /** A hover pop-up in the prompt, after the pointer rested on it: the score line, or an underlined word and the rule behind it. */
  | Ev<'hint_hover', { which: 'line'; mode: Mode; percent: number; from: DraftGauge['from'] } | { which: 'word'; mode: Mode; word: string; reason: string }>
  /** The pointer rested on a chat message (as `rest_on_leaf` on a leaf). */
  | Ev<'message_rest', { messageId: Id; role: Role }>
  /** Selected text of the chat was copied; `messageId` and `role` when it lies in one message. */
  | Ev<'transcript_copy', { messageId: Id | null; role: Role | null; text: string; chars: number }>
  /** A keyboard shortcut outside the prompt: `chat` (the app's keys), `reply` (make it yours), `forest`. */
  | Ev<'shortcut', { key: string; where: 'chat' | 'reply' | 'forest' }>
  /** The forest zoomed into a tree, or back out to all trees. */
  | Ev<'forest_zoom', { to: 'tree' | 'forest'; treeId: Id | null; title: string | null }>
  /** The forest's search, filter and grove once they settle. */
  | Ev<'forest_filter', { query: string; filter: string; grove: string | null }>
  /** A "try →" button in the interaction concepts sheet. */
  | Ev<'concept_try', { name: string }>
  /** Test connection of the own model: per role `ok`, `skipped` or the failure's code. */
  | Ev<'model_test', { chat: string; analysis: string; scores: string }>
  /* The page (`pageEvents.ts`), and the log itself (`telemetry.ts`). */
  | Ev<'page_hidden'>
  | Ev<'page_visible'>
  | Ev<'online'>
  | Ev<'offline'>
  /** The window's size once it settled. */
  | Ev<'resize', { width: number; height: number }>
  /** No pointer, key or wheel input for IDLE_MS while the page was visible; `idle_end` `ms`: the whole quiet time. */
  | Ev<'idle_start'>
  | Ev<'idle_end', { ms: number }>
  /** An uncaught error or rejected promise (at most MAX_ERRORS per visit). */
  | Ev<'client_error', { message: string; source: string; line: number | null }>
  | Ev<'events_dropped', { count: number }>
  /* The pointer (`pageEvents.ts` for clicks, the ASCII design's `restOn` for hovers): positions and fixed names, never text. */
  /**
   * A primary press (mouse, touch, pen) anywhere on the page. `x`, `y`: in the viewport (px), with its
   * `width` and `height`; `region`: the part of the page (`locate.ts`), `rx`, `ry` (0..1) inside its box;
   * `target`: tag and first class of what was pressed; `sincePrev`: ms since the previous click, null for
   * the first and past CLICK_CHAIN_MS; `typed`: a key was pressed since the previous click.
   */
  | Ev<'click', Click>
  /** The pointer left a place that does something on hover (`HoverName`): how long it stayed. `id`: the message, leaf, tree or wedge, never text. */
  | Ev<'hover', { name: HoverName; id: string | null; ms: number; x: number | null; y: number | null; view: ViewKind }>;

/** Where a press landed, as `locate.ts` describes it: fixed names from the code, never text from the page. */
export type Located = { region: string; target: string; rx: number | null; ry: number | null };
export type Click = Located & {
  x: number;
  y: number;
  width: number;
  height: number;
  view: ViewKind;
  panel: boolean;
  pointer: string;
  sincePrev: number | null;
  typed: boolean;
};
/** The places that react to the pointer resting on them (`hoverLog.ts`). */
export type HoverName = 'leaf' | 'message' | 'word' | 'line' | 'tree' | 'diag' | 'squirrel' | 'radial';

/** What `eventsOf` needs besides the state: the time (ms) and, for `session_start`, the screen, the account and the device. */
export interface EventEnv {
  at: number;
  width: number;
  height: number;
  signedIn: boolean;
  device: Device;
}

const NONE: None = {};
export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const since = (at: number, iso: string) => Math.max(0, at - Date.parse(iso));
const labelsOf = (s: State, ids: Iterable<Id>) => [...new Set(ids)].flatMap((id) => s.domain.concepts[id]?.label ?? []).map(cut);

/** The own-model setup without anything secret: per role the preset, the host of its base URL (a URL can carry credentials) and the model. */
export function ownSetup(o: OwnSetup): string {
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url ? '(not a url)' : '';
    }
  };
  return ROLES.map((r) => {
    const c = o[r];
    return `${r}: ${typeof c === 'string' ? c : `${c.preset} ${host(c.baseUrl)} ${c.model}`}`;
  }).join(' · ');
}

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
  const was = p.view.kind;
  const is = n.view.kind;
  if (is === 'forest' && (was !== 'forest' || p.view.treeId !== n.view.treeId)) out.push({ type: 'forest_open', payload: { focus: n.view.treeId ?? null } });
  if (was === 'forest' && is !== 'forest') out.push({ type: 'forest_close', payload: NONE });
  if ((was === 'chats') !== (is === 'chats')) out.push({ type: is === 'chats' ? 'chats_open' : 'chats_close', payload: NONE });
  const sheet = sheetOf(n.view);
  if (sheet && sheet !== sheetOf(p.view)) out.push({ type: 'sheet_open', payload: { which: sheet } });
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
        const { width, height, signedIn, device } = env();
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
            ...device,
          },
        });
      }
      break;
    case 'bootFailed':
      out.push({ type: 'load_failed', payload: { what: 'boot', error: a.error.slice(0, MAX_ERROR) } });
      break;
    case 'messagesFailed':
      out.push({ type: 'load_failed', conversationId: a.conversationId, payload: { what: 'messages', error: a.error.slice(0, MAX_ERROR) } });
      break;
    case 'user': {
      const { msg } = a;
      const thinking = msg.scores?.thinking;
      out.push({
        type: 'turn_sent',
        conversationId: msg.conversationId,
        payload: {
          messageId: msg.id,
          text: cut(msg.text),
          chars: msg.text.length,
          words: wordCount(msg.text),
          mode: msg.classification?.mode ?? null,
          confidence: msg.classification?.confidence ?? null,
          thinking: isScore(thinking) ? pct(thinking.p) : null,
          quizAnswer: looksLikeQuizAnswer(msg.text, prev.session.pendingQuiz),
        },
      });
      break;
    }
    case 'assistantStart': {
      // A reply starts with its first text (`turn.ts`).
      const { conversationId, id } = a.msg;
      const user = promptOf(next, conversationId, id);
      out.push({ type: 'reply_first', conversationId, payload: { messageId: id, userMessageId: a.userMessageId, ms: user ? since(env().at, user.createdAt) : null } });
      if (a.msg.veiled) out.push({ type: 'veil_shown', conversationId, payload: { messageId: id, userMessageId: a.userMessageId } });
      break;
    }
    case 'assistantDone': {
      const user = promptOf(next, a.conversationId, a.id);
      const reply = findMessage(d, a.id)?.msg;
      out.push({
        type: 'reply_done',
        conversationId: a.conversationId,
        payload: {
          messageId: a.id,
          userMessageId: user?.id ?? null,
          text: cut(a.text),
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
        payload: { userMessageId: a.userMessageId, assistantMessageId: a.assistantMessageId ?? null, error: a.error.slice(0, MAX_ERROR) },
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
      const fresh = Object.keys(d.concepts).filter((id) => !(id in prev.domain.concepts));
      out.push({
        type: 'analysis_shown',
        conversationId: patch.conversationId,
        payload: {
          userMessageId: patch.userMessageId,
          mode: patch.classification.mode,
          shown: findMessage(d, patch.userMessageId)?.msg.classification?.mode ?? null,
          judged: patch.attempts.length,
          // From the merged attempts: a concept the merge deduplicated has the id it kept.
          concepts: labelsOf(next, d.attempts.filter((t) => t.messageId === patch.userMessageId && !t.supersededBy).map((t) => t.conceptId)),
          reasons: patch.classification.reasons.map(cut),
          newConcepts: fresh.length,
          newConceptLabels: labelsOf(next, fresh),
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
          model: isScore(a.value) ? (a.value.model ?? null) : null,
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
          ? { type: 'reveal', conversationId: found.conversationId, payload: { messageId: a.id, guess: cut(guess), guessChars: guess.length, ms } }
          : { type: 'veil_skip', conversationId: found.conversationId, payload: { messageId: a.id, ms } },
      );
      break;
    }
    case 'settings': {
      for (const key of LOGGED_SETTINGS) {
        if (key in a.patch && prev.settings[key] !== next.settings[key]) out.push({ type: 'setting_changed', payload: { key, value: next.settings[key] } });
      }
      const own = ownSetup(next.settings.own);
      if ('own' in a.patch && own !== ownSetup(prev.settings.own)) out.push({ type: 'setting_changed', payload: { key: 'own', value: own } });
      break;
    }
    case 'paneTree':
      if (prev.ui.paneTreeId !== next.ui.paneTreeId) out.push({ type: 'pane_tree', payload: { treeId: a.id, title: cutOrNull(d.trees.find((t) => t.id === a.id)?.title) } });
      break;
    case 'conversationNew':
      out.push({ type: 'chat_new', conversationId: a.conversation.id, payload: NONE });
      break;
    case 'conversationOpen':
      if (prev.session.activeConversationId !== next.session.activeConversationId) {
        out.push({ type: 'chat_open', conversationId: a.id, payload: { from: prev.session.activeConversationId || null, title: cutOrNull(d.conversations[a.id]?.title) } });
      }
      break;
    case 'conversationTitle':
      out.push({ type: 'chat_rename', conversationId: a.id, payload: { title: cut(a.title), from: cutOrNull(prev.domain.conversations[a.id]?.title) } });
      break;
    case 'draft':
      out.push({ type: 'draft_fill', payload: { text: cut(a.text), chars: a.text.length } });
      break;
    case 'flash':
      out.push({ type: 'message_jump', conversationId: findMessage(d, a.id)?.conversationId, payload: { messageId: a.id } });
      break;
    case 'toast':
      out.push({ type: 'toast', payload: { text: cut(a.text) } });
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
          payload: { treeId: t.id, title: cut(t.title), splitFrom: t.splitFrom ?? null, leaves },
        });
      }
    }
  }
  return out;
}
