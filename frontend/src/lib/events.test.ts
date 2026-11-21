import { describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../ai/own/setup';
import { testStore } from '../test/harness';
import { biologyProvider } from '../test/server';
import type { Message } from './domain';
import { cut, eventsOf, MAX_TEXT, ownSetup, type Device, type EventEnv, type UsageEvent } from './events';
import { reducer, type Action, type State } from './state';

/** The store-derived usage events (IMPLEMENTATION_PLAN.md M6, "Event log"): one action in, its events out. */

const T = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (s: number) => new Date(T + s * 1000).toISOString();
const DEVICE: Device = {
  userAgent: 'Mozilla/5.0 test',
  language: 'de-CH',
  timeZone: 'Europe/Zurich',
  screenWidth: 1920,
  screenHeight: 1080,
  pixelRatio: 2,
  touch: false,
  search: 'provider=arbor',
  referrer: '',
};
const ENV: EventEnv = { at: T + 5000, width: 1280, height: 800, signedIn: true, device: DEVICE };
const env = () => ENV;

const TEXT = 'Explain how mitochondria produce energy for my exam';
const USER: Message = {
  id: 'u1',
  role: 'user',
  text: TEXT,
  classification: { mode: 'ai', confidence: 0.8, reasons: ['Asks for an explanation'] },
  conceptIds: [],
  conversationId: 'chat-1',
  createdAt: iso(0),
  analysis: 'pending',
};
const REPLY: Message = { id: 'r1', role: 'assistant', text: '', conceptIds: [], streaming: true, veiled: true, conversationId: 'chat-1', createdAt: iso(2) };

/** A first live visit: one empty chat, provider arbor. */
function live(): State {
  const s = testStore({ fresh: true }).state;
  return { ...s, settings: { ...s.settings, provider: 'arbor' } };
}
const apply = (s: State, ...actions: Action[]) => actions.reduce(reducer, s);
const step = (prev: State, a: Action) => eventsOf(prev, reducer(prev, a), a, env);

const sent = apply(live(), { type: 'user', msg: USER });
const veiled = apply(sent, { type: 'assistantStart', msg: REPLY, userMessageId: 'u1' });
const replied = apply(veiled, { type: 'assistantDone', conversationId: 'chat-1', id: 'r1', text: 'Mitochondria make ATP.', model: 'claude-x' });

const cases: [string, State, Action, UsageEvent[]][] = [
  [
    'a live load: session_start with counts (an unsaved empty chat not counted), screen, theme, account',
    live(),
    {
      type: 'hydrate',
      domain: { ...live().domain, conversations: { a: { ...live().domain.conversations['chat-1'], id: 'a' }, new: { ...live().domain.conversations['chat-1'], id: 'new' } }, messagesByConv: { new: [] } },
      activeConversationId: 'new',
      demoPrompts: [],
    },
    [{ type: 'session_start', payload: { provider: 'arbor', chats: 1, trees: 0, concepts: 0, width: 1280, height: 800, theme: 'system', signedIn: true, ...DEVICE } }],
  ],
  ['the demo world loading: nothing', { ...live(), settings: { ...live().settings, provider: 'scripted' } }, { type: 'hydrate', domain: live().domain, activeConversationId: 'chat-1', demoPrompts: [] }, []],
  [
    'a sent message: turn_sent with its text, lengths and its label',
    live(),
    { type: 'user', msg: USER },
    [{ type: 'turn_sent', conversationId: 'chat-1', payload: { messageId: 'u1', text: TEXT, chars: TEXT.length, words: 8, mode: 'ai', confidence: 0.8, thinking: null, quizAnswer: false } }],
  ],
  [
    'a message the composer rated: its thinking percent',
    live(),
    { type: 'user', msg: { ...USER, scores: { thinking: { p: 0.75 } } } },
    [{ type: 'turn_sent', conversationId: 'chat-1', payload: { messageId: 'u1', text: TEXT, chars: TEXT.length, words: 8, mode: 'ai', confidence: 0.8, thinking: 75, quizAnswer: false } }],
  ],
  [
    'a message longer than MAX_TEXT: the text cut, chars and words of the whole',
    live(),
    { type: 'user', msg: { ...USER, text: 'ab '.repeat(3000) } },
    [{ type: 'turn_sent', conversationId: 'chat-1', payload: { messageId: 'u1', text: 'ab '.repeat(3000).slice(0, MAX_TEXT), chars: 9000, words: 3000, mode: 'ai', confidence: 0.8, thinking: null, quizAnswer: false } }],
  ],
  [
    'a veiled reply starts (with its first text): reply_first with ms since the message was sent, veil_shown',
    sent,
    { type: 'assistantStart', msg: REPLY, userMessageId: 'u1' },
    [
      { type: 'reply_first', conversationId: 'chat-1', payload: { messageId: 'r1', userMessageId: 'u1', ms: 5000 } },
      { type: 'veil_shown', conversationId: 'chat-1', payload: { messageId: 'r1', userMessageId: 'u1' } },
    ],
  ],
  [
    'a plain reply starts: reply_first only',
    sent,
    { type: 'assistantStart', msg: { ...REPLY, veiled: undefined }, userMessageId: 'u1' },
    [{ type: 'reply_first', conversationId: 'chat-1', payload: { messageId: 'r1', userMessageId: 'u1', ms: 5000 } }],
  ],
  ['streaming: nothing', veiled, { type: 'stream', conversationId: 'chat-1', id: 'r1', text: 'Mito' }, []],
  [
    'the reply is complete: reply_done with its text and ms since the message was sent',
    veiled,
    { type: 'assistantDone', conversationId: 'chat-1', id: 'r1', text: 'Mitochondria make ATP.', model: 'claude-x' },
    [{ type: 'reply_done', conversationId: 'chat-1', payload: { messageId: 'r1', userMessageId: 'u1', text: 'Mitochondria make ATP.', chars: 22, ms: 5000, model: 'claude-x', stopped: false } }],
  ],
  [
    'a failed turn: turn_error, the error cut to 500 characters',
    veiled,
    { type: 'turnError', conversationId: 'chat-1', userMessageId: 'u1', assistantMessageId: 'r1', error: 'x'.repeat(600) },
    [{ type: 'turn_error', conversationId: 'chat-1', payload: { userMessageId: 'u1', assistantMessageId: 'r1', error: 'x'.repeat(500) } }],
  ],
  ['the start failed: load_failed', live(), { type: 'bootFailed', error: 'Could not reach the backend.' }, [{ type: 'load_failed', payload: { what: 'boot', error: 'Could not reach the backend.' } }]],
  [
    'a chat did not load: load_failed for that chat',
    live(),
    { type: 'messagesFailed', conversationId: 'chat-9', error: 'HTTP 500' },
    [{ type: 'load_failed', conversationId: 'chat-9', payload: { what: 'messages', error: 'HTTP 500' } }],
  ],
  ['stopped before the reply started: turn_stopped', sent, { type: 'turnStopped', conversationId: 'chat-1', userMessageId: 'u1' }, [{ type: 'turn_stopped', conversationId: 'chat-1', payload: { userMessageId: 'u1' } }]],
  ['a retry: retry', sent, { type: 'retryStart', conversationId: 'chat-1', userMessageId: 'u1' }, [{ type: 'retry', conversationId: 'chat-1', payload: { userMessageId: 'u1' } }]],
  ['the analysis failed: analysis_failed', sent, { type: 'analysisFailed', conversationId: 'chat-1', userMessageId: 'u1' }, [{ type: 'analysis_failed', conversationId: 'chat-1', payload: { userMessageId: 'u1' } }]],
  ['a score on its way: nothing', sent, { type: 'score', userMessageId: 'u1', key: 'thinking', value: 'pending' }, []],
  [
    'a score landed: its percent and the label it gave the message',
    sent,
    { type: 'score', userMessageId: 'u1', key: 'thinking', value: { p: 0.3, model: 'fast' } },
    [{ type: 'score', conversationId: 'chat-1', payload: { userMessageId: 'u1', key: 'thinking', percent: 30, label: 'together', model: 'fast', failed: false } }],
  ],
  [
    'a score failed',
    sent,
    { type: 'score', userMessageId: 'u1', key: 'correct', value: 'failed' },
    [{ type: 'score', conversationId: 'chat-1', payload: { userMessageId: 'u1', key: 'correct', percent: null, label: 'ai', model: null, failed: true } }],
  ],
  ['a relabel: from and to', sent, { type: 'reclassify', id: 'u1', mode: 'own' }, [{ type: 'relabel', conversationId: 'chat-1', payload: { messageId: 'u1', from: 'ai', to: 'own' } }]],
  [
    'a reveal with a guess: the guess, its length and the time from veil to reveal',
    replied,
    { type: 'reveal', id: 'r1', guess: ' it makes ATP ' },
    [{ type: 'reveal', conversationId: 'chat-1', payload: { messageId: 'r1', guess: 'it makes ATP', guessChars: 12, ms: 3000 } }],
  ],
  ['a reveal without a guess: veil_skip', replied, { type: 'reveal', id: 'r1', guess: '  ' }, [{ type: 'veil_skip', conversationId: 'chat-1', payload: { messageId: 'r1', ms: 3000 } }]],
  ['a nudge shows (classic design): nudge_shown with the lens', live(), { type: 'composer', lens: 'ai', nudge: true }, [{ type: 'nudge_shown', payload: { lens: 'ai' } }]],
  ['the lens changes, no nudge: nothing', live(), { type: 'composer', lens: 'own', nudge: false }, []],
  ['a setting: key and new value', live(), { type: 'settings', patch: { theme: 'dark' } }, [{ type: 'setting_changed', payload: { key: 'theme', value: 'dark' } }]],
  ['a setting set to what it was: nothing', live(), { type: 'settings', patch: { nudge: 'active' } }, []],
  [
    'two settings at once; the own setup with the hosts and models, never a whole URL',
    live(),
    { type: 'settings', patch: { mascot: false, own: { ...DEFAULT_SETUP, chat: { preset: 'custom', baseUrl: 'https://user:pw@llm.example/v1?key=sk-1', model: 'm' } } } },
    [
      { type: 'setting_changed', payload: { key: 'mascot', value: false } },
      { type: 'setting_changed', payload: { key: 'own', value: 'chat: custom llm.example m · analysis: same · scores: same' } },
    ],
  ],
  [
    'the own setup changed where it is not logged (the URL path): nothing',
    apply(live(), { type: 'settings', patch: { own: { ...DEFAULT_SETUP, chat: { preset: 'custom', baseUrl: 'https://llm.example/v', model: 'm' } } } }),
    { type: 'settings', patch: { own: { ...DEFAULT_SETUP, chat: { preset: 'custom', baseUrl: 'https://llm.example/v1', model: 'm' } } } },
    [],
  ],
  ['the pane closes', live(), { type: 'panel', open: false }, [{ type: 'panel', payload: { open: false } }]],
  ['the forest opens on a tree', live(), { type: 'forest', open: true, focus: 't1' }, [{ type: 'forest_open', payload: { focus: 't1' } }]],
  ['the forest opens again: nothing', apply(live(), { type: 'forest', open: true }), { type: 'forest', open: true }, []],
  ['the forest closes', apply(live(), { type: 'forest', open: true }), { type: 'forest', open: false }, [{ type: 'forest_close', payload: {} }]],
  ['the chat list opens', live(), { type: 'chats', open: true }, [{ type: 'chats_open', payload: {} }]],
  ['the intro opens', live(), { type: 'onboarding', open: true }, [{ type: 'onboarding', payload: { open: true } }]],
  ['another tree in the pane (one this state does not have: no title)', live(), { type: 'paneTree', id: 't2' }, [{ type: 'pane_tree', payload: { treeId: 't2', title: null } }]],
  [
    'a new chat (from the chat list, which closes): chat_new, chats_close',
    apply(sent, { type: 'chats', open: true }),
    { type: 'conversationNew', conversation: { ...live().domain.conversations['chat-1'], id: 'chat-2' } },
    [
      { type: 'chat_new', conversationId: 'chat-2', payload: {} },
      { type: 'chats_close', payload: {} },
    ],
  ],
  [
    'another chat opens: chat_open, from which',
    apply(sent, { type: 'conversationNew', conversation: { ...live().domain.conversations['chat-1'], id: 'chat-2' } }),
    { type: 'conversationOpen', id: 'chat-1' },
    [{ type: 'chat_open', conversationId: 'chat-1', payload: { from: 'chat-2', title: sent.domain.conversations['chat-1'].title } }],
  ],
  ['the open chat "opens" again: nothing', sent, { type: 'conversationOpen', id: 'chat-1' }, []],
  [
    'a rename: the new title and the old one',
    sent,
    { type: 'conversationTitle', id: 'chat-1', title: 'cell biology', at: iso(9) },
    [{ type: 'chat_rename', conversationId: 'chat-1', payload: { title: 'cell biology', from: sent.domain.conversations['chat-1'].title } }],
  ],
  ['text put into the prompt: draft_fill', live(), { type: 'draft', text: 'In my own words, atp is ' }, [{ type: 'draft_fill', payload: { text: 'In my own words, atp is ', chars: 24 } }]],
  ['a jump to a message: message_jump in its chat', sent, { type: 'flash', id: 'u1' }, [{ type: 'message_jump', conversationId: 'chat-1', payload: { messageId: 'u1' } }]],
  ['a toast: its text', live(), { type: 'toast', text: 'nothing to stop' }, [{ type: 'toast', payload: { text: 'nothing to stop' } }]],
];

describe('eventsOf: one action, its usage events', () => {
  it.each(cases)('%s', (_name, prev, action, expected) => {
    expect(step(prev, action)).toEqual(expected);
  });
});

describe('eventsOf: a whole live turn', () => {
  /** Replay a real turn's actions (turn.ts with a fake live provider) through the reducer and collect the events. */
  async function turn(text: string) {
    const t = testStore({ fresh: true, provider: biologyProvider() });
    const start: State = { ...t.state, settings: { ...t.state.settings, provider: 'arbor' } };
    await t.send(text);
    const events: UsageEvent[] = [];
    let s = start;
    for (const a of t.actions) {
      const next = reducer(s, a);
      if (next !== s) events.push(...eventsOf(s, next, a, env));
      s = next;
    }
    return { events, state: s };
  }

  it('turn_sent, reply_first, reply_done, then the analysis and the tree it grew (with its leaf count)', async () => {
    const { events, state } = await turn('I think vaccines train the immune system to react faster');
    const types = events.map((e) => e.type);
    expect(types.filter((x) => x !== 'analysis_shown' && x !== 'tree_created')).toEqual(['turn_sent', 'reply_first', 'reply_done']);
    expect(types.indexOf('tree_created')).toBe(types.indexOf('analysis_shown') + 1);
    const [tree] = state.domain.trees;
    expect(events.find((e) => e.type === 'analysis_shown')).toMatchObject({ payload: { mode: 'own', shown: 'own', judged: 1, newConcepts: 3, newTrees: 1 } });
    expect(events.find((e) => e.type === 'tree_created')).toEqual({ type: 'tree_created', conversationId: 'chat-1', payload: { treeId: tree.id, title: tree.title, splitFrom: null, leaves: 1 } });
  });

  it('the texts are in the events: the message, the reply, the labels the turn was judged on and the reasons', async () => {
    const text = 'I think vaccines quietly train lymphocytes to remember pathogens';
    const { events } = await turn(text);
    const payload = (type: UsageEvent['type']) => events.find((e) => e.type === type)?.payload;
    expect(payload('turn_sent')).toMatchObject({ text, chars: text.length });
    expect(payload('reply_done')).toMatchObject({ text: 'Vaccines show the body a harmless copy.', chars: 39 });
    expect(payload('analysis_shown')).toMatchObject({ concepts: ['Vaccines'], reasons: ['states a claim'] });
    expect([...((payload('analysis_shown') as { newConceptLabels: string[] }).newConceptLabels)].sort()).toEqual(['Biology', 'Immunology', 'Vaccines']);
  });

  it('a second turn on the same concept: judged on its label, nothing new', async () => {
    const t = testStore({ fresh: true, provider: biologyProvider() });
    await t.send('I think vaccines train the immune system');
    const before: State = { ...t.state, settings: { ...t.state.settings, provider: 'arbor' } };
    const from = t.actions.length;
    await t.send('I guess boosters remind the immune system');
    let s = before;
    const events: UsageEvent[] = [];
    for (const a of t.actions.slice(from)) {
      const next = reducer(s, a);
      if (next !== s) events.push(...eventsOf(s, next, a, env));
      s = next;
    }
    expect(events.find((e) => e.type === 'analysis_shown')?.payload).toMatchObject({ concepts: ['Vaccines'], newConcepts: 0, newConceptLabels: [] });
  });
});

describe('texts in events', () => {
  it('cut: at most MAX_TEXT characters', () => {
    expect(cut('short')).toBe('short');
    expect(cut('x'.repeat(MAX_TEXT + 5))).toHaveLength(MAX_TEXT);
  });

  it('ownSetup: per role the preset, the host and the model, or same / off; never a path, a query or credentials', () => {
    expect(ownSetup({ chat: { preset: 'openai', baseUrl: 'https://u:p@api.openai.com/v1?k=1', model: 'gpt' }, analysis: 'same', scores: 'off' })).toBe('chat: openai api.openai.com gpt · analysis: same · scores: off');
    expect(ownSetup({ ...DEFAULT_SETUP, chat: { preset: 'custom', baseUrl: 'not a url', model: '' } })).toBe('chat: custom (not a url)  · analysis: same · scores: same');
  });
});
