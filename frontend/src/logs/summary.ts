import type { UsageEvent } from '../lib/events';
import type { EventType } from './legend';
import { clock } from './visit';

/**
 * One readable line per event, built from its payload, and the texts it carries (message, reply,
 * draft, guess, paste, copied text, ...) to show in full under it. Typed by the catalogue
 * (`lib/events.ts`): a new event type does not compile without a line here. Payloads are read
 * defensively (`Partial`, and every value is checked before use): older events lack fields, and
 * a broken row must not break the page.
 */

export interface Text {
  label: string;
  text: string;
}
export interface Summary {
  line: string;
  texts: Text[];
}

/** Each member of a union payload made Partial on its own (`hint_hover` has two shapes). */
type Loose<P> = P extends unknown ? Partial<P> : never;
type PayloadOf<T extends EventType> = Loose<Extract<UsageEvent, { type: T }>['payload']>;

/** The envelope every payload carries (`telemetry.ts`, the backend's conversationId): shown in the header and the raw json, not in a line. */
const ENVELOPE = new Set(['visit', 'seq', 'design', 'conversationId']);

const isText = (x: unknown): x is string => typeof x === 'string' && x !== '';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The parts that are non-empty strings, with ` · ` between them. */
const join = (...parts: unknown[]) => parts.filter(isText).join(' · ');
const word = (x: unknown) => (isText(x) ? x : isNum(x) || typeof x === 'boolean' ? String(x) : '?');
const pct = (x: unknown, before = '') => (isNum(x) ? `${before}${Math.round(x)}%` : null);
const secs = (ms: unknown, before = '') => (isNum(ms) ? `${before}${(ms / 1000).toFixed(1)} s` : null);
const count = (x: unknown, one: string, many = `${one}s`) => (isNum(x) ? `${x} ${x === 1 ? one : many}` : null);
const quote = (x: unknown) => (isText(x) ? `"${x}"` : null);
const yes = (x: unknown, text: string) => (x === true ? text : null);
const labels = (x: unknown) => (Array.isArray(x) && x.length ? x.map(word).join(', ') : null);
const size = (w: unknown, h: unknown) => (isNum(w) && isNum(h) ? `${w}×${h}` : null);
const open = (x: unknown) => (x === true ? 'opened' : x === false ? 'closed' : null);
const arrow = (from: unknown, to: unknown) => `${word(from ?? '–')} → ${word(to)}`;

/** A line and the texts that are non-empty strings. */
const s = (line: string, ...texts: [string, unknown][]): Summary => ({
  line,
  texts: texts.flatMap(([label, text]) => (isText(text) ? [{ label, text }] : [])),
});
const none = () => s('');

const DESCRIBE: { [T in EventType]: (p: PayloadOf<T>) => Summary } = {
  session_start: (p) =>
    s(join(p.provider, count(p.chats, 'chat'), count(p.trees, 'tree'), count(p.concepts, 'concept'), size(p.width, p.height), p.theme, p.signedIn === true ? 'signed in' : p.signedIn === false ? 'guest' : null)),
  turn_sent: (p) => s(join(p.mode, pct(p.thinking, 'thinking '), count(p.words, 'word'), count(p.chars, 'char'), yes(p.quizAnswer, 'quiz answer')), ['message', p.text]),
  reply_first: (p) => s(join(secs(p.ms, 'after '))),
  reply_done: (p) => s(join(secs(p.ms, 'after '), p.model, count(p.chars, 'char'), yes(p.stopped, 'stopped')), ['reply', p.text]),
  turn_error: (p) => s(join(p.error)),
  turn_stopped: none,
  retry: none,
  analysis_shown: (p) =>
    s(
      join(p.mode, p.shown && p.shown !== p.mode ? `shown as ${word(p.shown)}` : null, labels(p.concepts) && `judged ${labels(p.concepts)}`, labels(p.newConceptLabels) && `new ${labels(p.newConceptLabels)}`, isNum(p.newTrees) && p.newTrees > 0 ? count(p.newTrees, 'new tree') : null),
      ['reasons', Array.isArray(p.reasons) ? p.reasons.map(word).join('\n') : null],
    ),
  analysis_failed: none,
  score: (p) => s(p.failed === true ? join(p.key, 'failed') : join(pct(p.percent, `${word(p.key)} `), p.label && `label ${word(p.label)}`, p.model)),
  relabel: (p) => s(arrow(p.from, p.to)),
  veil_shown: none,
  reveal: (p) => s(join(secs(p.ms, 'veiled '), count(p.guessChars, 'char')), ['guess', p.guess]),
  veil_skip: (p) => s(join('no guess', secs(p.ms, 'veiled '))),
  nudge_shown: (p) => s(join(p.lens && `lens ${word(p.lens)}`)),
  setting_changed: (p) => s(`${word(p.key)} = ${word(p.value ?? 'none')}`),
  panel: (p) => s(join(open(p.open))),
  forest_open: (p) => s(join(p.focus && `focus ${word(p.focus)}`)),
  forest_close: none,
  chats_open: none,
  chats_close: none,
  pane_tree: (p) => s(join(quote(p.title))),
  onboarding: (p) => s(join(open(p.open))),
  chat_new: none,
  chat_open: (p) => s(join(quote(p.title))),
  chat_rename: (p) => s(`${quote(p.from) ?? '(no title)'} → ${quote(p.title) ?? '?'}`),
  tree_created: (p) => s(join(quote(p.title), count(p.leaves, 'leaf', 'leaves'), p.splitFrom && `split from ${word(p.splitFrom)}`)),
  draft_fill: (p) => s(join(count(p.chars, 'char')), ['text', p.text]),
  message_jump: (p) => s(join(p.messageId)),
  toast: (p) => s(join(quote(p.text))),
  load_failed: (p) => s(join(p.what, p.error)),
  view_start: (p) => s(join(p.view)),
  view_change: (p) => s(join(arrow(p.from, p.to), p.via && `by ${word(p.via)}`)),
  pane_action: (p) =>
    s(join(isText(p.kind) ? p.kind.replaceAll('_', ' ') : null, quote(p.label), p.view && `in ${word(p.view)}`, p.kind === 'scrub' || (isNum(p.days) && p.days !== 0) ? count(p.days, 'day') : null)),
  why_open: (p) => s(join(p.messageId)),
  sheet_open: (p) => s(join(p.which)),
  nav: (p) => s(join(arrow(p.from, p.to), p.via && `by ${word(p.via)}`, secs(p.ms, 'chosen in '))),
  radial_open: (p) => s(join(p.input, p.on && `over ${word(p.on)}`)),
  radial_cancel: (p) => s(join(p.reason, secs(p.ms, 'after '))),
  command: (p) => s(isText(p.name) ? `/${p.name}${isText(p.arg) ? ` ${p.arg}` : ''}` : ''),
  squirrel_poke: (p) => s(join(yes(p.dizzy, 'dizzy'))),
  squirrel_tip: (p) => s(join(quote(p.text), p.action && `→ ${word(p.action)}`)),
  draft_rated: (p) => s(join(pct(p.percent), p.mode, p.model, count(p.chars, 'char')), ['draft', p.text]),
  filter_rated: (p) => s(join(pct(p.percent), p.mode, count(p.words, 'word'), p.from, yes(p.unsure, 'unsure'))),
  draft_paste: (p) => s(join(count(p.chars, 'char'), isNum(p.draftChars) ? `into a draft of ${p.draftChars}` : null), ['pasted', p.text]),
  compose: (p) =>
    s(join(secs(p.ms, 'written in '), count(p.keys, 'key'), count(p.deletes, 'delete'), count(p.pastes, 'paste'), isNum(p.pastedChars) && p.pastedChars > 0 ? `${p.pastedChars} chars pasted` : null)),
  draft_abandoned: (p) => s(join(count(p.chars, 'char')), ['draft', p.text]),
  hint_hover: (p) => (p.which === 'word' ? s(join(quote(p.word), p.mode, p.reason)) : p.which === 'line' ? s(join('score line', p.mode, pct(p.percent), p.from)) : none()),
  message_rest: (p) => s(join(p.role, p.messageId)),
  transcript_copy: (p) => s(join(p.role && `from ${word(p.role)}`, count(p.chars, 'char')), ['copied', p.text]),
  shortcut: (p) => s(join(p.key, p.where && `in ${word(p.where)}`)),
  forest_zoom: (p) => s(p.to === 'tree' ? `into ${quote(p.title) ?? 'a tree'}` : p.to === 'forest' ? 'out to all trees' : ''),
  forest_filter: (p) => s(join(quote(p.query) && `search ${quote(p.query)}`, isText(p.filter) ? `filter ${p.filter}` : null, isText(p.grove) ? `grove ${p.grove}` : null)),
  concept_try: (p) => s(join(quote(p.name))),
  model_test: (p) => s(join(isText(p.chat) && `chat ${p.chat}`, isText(p.analysis) && `analysis ${p.analysis}`, isText(p.scores) && `scores ${p.scores}`)),
  page_hidden: none,
  page_visible: none,
  online: none,
  offline: none,
  resize: (p) => s(join(size(p.width, p.height))),
  idle_start: none,
  idle_end: (p) => s(join(isNum(p.ms) ? `quiet for ${clock(p.ms)}` : null)),
  client_error: (p) => s(join(p.message, isText(p.source) ? `at ${p.source}${isNum(p.line) ? `:${p.line}` : ''}` : null)),
  events_dropped: (p) => s(join(count(p.count, 'event'))),
  click: (p) => s(join(p.region, p.target, isNum(p.x) && isNum(p.y) ? `at ${p.x},${p.y}` : null, secs(p.sincePrev, '+'), yes(p.typed, 'typed before'), p.pointer !== 'mouse' ? p.pointer : null)),
  hover: (p) => s(join(p.name, p.name === 'radial' ? p.id : null, secs(p.ms))),
};

/** An event of a type the catalogue does not know: its fields as `name value`, long strings as texts. */
function generic(payload: Record<string, unknown>): Summary {
  const fields = Object.entries(payload).filter(([k]) => !ENVELOPE.has(k));
  const long = (v: unknown) => typeof v === 'string' && v.length > 80;
  return {
    line: join(...fields.filter(([, v]) => !long(v)).map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`)),
    texts: fields.filter(([, v]) => long(v)).map(([label, text]) => ({ label, text: text as string })),
  };
}

export function summarize(e: { type: string; payload: Record<string, unknown> }): Summary {
  if (typeof e.payload._raw === 'string') return { line: 'the stored payload is not valid json', texts: [{ label: 'stored', text: e.payload._raw }] };
  if (!Object.hasOwn(DESCRIBE, e.type)) return generic(e.payload);
  return (DESCRIBE[e.type as EventType] as (p: Record<string, unknown>) => Summary)(e.payload);
}
