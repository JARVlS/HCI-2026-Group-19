import type { UsageEvent } from '../lib/events';

/**
 * "what is logged" on the logs page: every event of the usage log's catalogue (`lib/events.ts`)
 * with its group and one plain sentence. LEGEND is a Record over the catalogue's types, so an
 * event added there without a line here does not compile.
 */

export type EventType = UsageEvent['type'];

export const GROUPS = ['writing', 'replies', 'tree pane', 'navigation', 'page'] as const;
/** `other`: a type the catalogue does not have (older events, or a test's). */
export type Group = (typeof GROUPS)[number] | 'other';

export const GROUP_WHAT: Record<Group, string> = {
  writing: 'the prompt: what was typed, pasted, rated and sent',
  replies: "the tutor's answers and what arbor made of each turn",
  'tree pane': 'the knowledge pane and the forest',
  navigation: 'chats, sheets, commands, keys and settings',
  page: 'the browser tab, the window, errors and the log itself',
  other: 'types the catalogue does not know (older events)',
};

export interface LegendLine {
  group: Exclude<Group, 'other'>;
  what: string;
  /** Hidden while "hide noise" is on: frequent and rarely worth reading one by one. */
  noise?: true;
}

export const LEGEND: Record<EventType, LegendLine> = {
  turn_sent: { group: 'writing', what: 'a message was sent: its text, length, words, label and the thinking percent of the score line.' },
  compose: { group: 'writing', what: 'how a sent message was written: time from the first key to send, key presses, deletes, pastes.' },
  draft_rated: { group: 'writing', what: 'the fast model rated the draft after a pause: the draft as rated, percent and label.' },
  filter_rated: { group: 'writing', what: 'the word filter put a new number on the score line (no text).', noise: true },
  draft_paste: { group: 'writing', what: 'text was pasted into the prompt: the pasted text and the draft length before it.' },
  draft_abandoned: { group: 'writing', what: 'a draft of 5 characters or more was emptied by hand, not sent: its text.' },
  draft_fill: { group: 'writing', what: 'arbor put text into the prompt (explain it back, the / key, a nudge).' },
  hint_hover: { group: 'writing', what: "the pointer rested on the score line or an underlined word: the label, or the word and its rule.", noise: true },
  nudge_shown: { group: 'writing', what: 'the classic design showed a nudge under the prompt.' },
  concept_try: { group: 'writing', what: 'a "try" button in the interaction concepts sheet.' },
  reply_first: { group: 'replies', what: 'the first text of a reply arrived: milliseconds since the message was sent.' },
  reply_done: { group: 'replies', what: 'a reply was complete: its text, length, time since sent, model, whether it was stopped.' },
  turn_error: { group: 'replies', what: 'a turn failed: the error message.' },
  turn_stopped: { group: 'replies', what: 'the user stopped a reply while it streamed.' },
  retry: { group: 'replies', what: 'the user retried a failed turn.' },
  analysis_shown: { group: 'replies', what: "the turn analysis landed: its label, the concepts it judged, its reasons, new concepts and trees." },
  analysis_failed: { group: 'replies', what: 'the turn analysis failed (the linter label stays).' },
  score: { group: 'replies', what: 'a fast-model score of a message: thought along or is it right, in percent.' },
  relabel: { group: 'replies', what: 'the user changed the label of a message (own, together, ai).' },
  veil_shown: { group: 'replies', what: 'a reply arrived veiled (predict, then reveal).' },
  reveal: { group: 'replies', what: 'a veiled reply was revealed with a guess: the guess and how long it was veiled.' },
  veil_skip: { group: 'replies', what: 'a veiled reply was revealed without a guess.' },
  why_open: { group: 'replies', what: 'the "why" of a message was opened.' },
  message_rest: { group: 'replies', what: 'the pointer rested 400 ms on a chat message.', noise: true },
  transcript_copy: { group: 'replies', what: 'text of the chat was copied: the copied text and the message it lies in.' },
  message_jump: { group: 'replies', what: 'the view jumped to a message and flashed it (a leaf, the trail, /why).' },
  view_start: { group: 'tree pane', what: 'the pane started in a view: tree or outline.' },
  view_change: { group: 'tree pane', what: 'the pane switched between tree and outline, by key, command or click.' },
  pane_action: { group: 'tree pane', what: 'something on a leaf: rested on it, opened its messages, jumped to one, or moved the forgetting scrubber.' },
  pane_tree: { group: 'tree pane', what: 'the pane switched to another tree: its title.' },
  panel: { group: 'tree pane', what: 'the arbor pane was opened or closed.' },
  tree_created: { group: 'tree pane', what: 'the planner grew a new tree: its title and leaves.' },
  forest_open: { group: 'tree pane', what: 'the forest (all trees) was opened.' },
  forest_close: { group: 'tree pane', what: 'the forest was closed.' },
  forest_zoom: { group: 'tree pane', what: 'the forest zoomed into one tree or back out to all.' },
  forest_filter: { group: 'tree pane', what: "the forest's search, filter or grove settled: their values." },
  chat_new: { group: 'navigation', what: 'a new chat was started.' },
  chat_open: { group: 'navigation', what: 'another chat was opened: its title.' },
  chat_rename: { group: 'navigation', what: 'a chat got a new title: the new and the old one.' },
  chats_open: { group: 'navigation', what: 'the chat list was opened.' },
  chats_close: { group: 'navigation', what: 'the chat list was closed.' },
  command: { group: 'navigation', what: 'a /command: its name and argument (never the argument of /provider).' },
  shortcut: { group: 'navigation', what: 'a keyboard shortcut outside the prompt: the key and where.' },
  sheet_open: { group: 'navigation', what: 'a sheet was opened: concepts or model.' },
  nav: { group: 'navigation', what: 'the view changed: from, to, how (radial, flick, key, command, click, link, back) and the time to choose in the radial menu.' },
  radial_open: { group: 'navigation', what: 'the radial menu was drawn (alt held, or a long press on touch).' },
  radial_cancel: { group: 'navigation', what: 'the radial menu closed without a choice, and why.' },
  onboarding: { group: 'navigation', what: 'the intro was opened or closed.' },
  setting_changed: { group: 'navigation', what: 'a setting changed: its new value (own model: preset, host and model per role, no key).' },
  squirrel_poke: { group: 'navigation', what: 'the squirrel was poked.' },
  squirrel_tip: { group: 'navigation', what: "a button of the squirrel's tip: its text and action." },
  model_test: { group: 'navigation', what: 'test connection of the own model: the result per role.' },
  session_start: { group: 'page', what: 'the visit started: browser, language, time zone, screen and window, theme, signed in, url parameters, counts.' },
  page_hidden: { group: 'page', what: 'the tab was hidden (another tab, minimized, closed).' },
  page_visible: { group: 'page', what: 'the tab was shown again.' },
  online: { group: 'page', what: 'the browser went online.' },
  offline: { group: 'page', what: 'the browser went offline.' },
  resize: { group: 'page', what: 'the window size, once it settled after a resize.', noise: true },
  idle_start: { group: 'page', what: 'no pointer, key or wheel input for 60 s on a visible tab.', noise: true },
  idle_end: { group: 'page', what: 'input again after idle: the whole quiet time.', noise: true },
  client_error: { group: 'page', what: 'an uncaught error in the page: message and where (at most 10 per visit).' },
  load_failed: { group: 'page', what: "the start or a chat's messages did not load: the error." },
  toast: { group: 'page', what: 'arbor showed a short message at the bottom: its text.' },
  events_dropped: { group: 'page', what: 'the log queue on the device was full and dropped this many old events.' },
  click: { group: 'page', what: 'a press or tap: where in the window, the part of the page, what was pressed (tag and class, no text), time since the previous click (up to 10 s).', noise: true },
  hover: { group: 'page', what: 'the pointer left something that reacts to hover (a message, a leaf, a tree, a hint, a radial option): how long it stayed.', noise: true },
};

const line = (type: string): LegendLine | undefined => (Object.hasOwn(LEGEND, type) ? LEGEND[type as EventType] : undefined);

export const groupOf = (type: string): Group => line(type)?.group ?? 'other';
export const isNoise = (type: string) => line(type)?.noise === true;
export const whatIs = (type: string) => line(type)?.what ?? 'not in the catalogue of lib/events.ts';

/** What the log never holds, for the legend sheet (the catalogue's rules, `lib/events.ts`). */
export const NEVER_LOGGED = [
  'the session token',
  'passwords (sign up, log in)',
  'own-model keys',
  'the username (the backend files every event under the user id)',
  'full endpoint urls (only their host: a url can carry credentials)',
  'the argument of /provider',
  'every keystroke (only the counts in compose)',
];
