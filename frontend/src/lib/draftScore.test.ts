import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnProvider } from '../ai/own/provider';
import { DEFAULT_SETUP } from '../ai/own/setup';
import type { ScoreInput, ScoreResult } from '../ai/provider';
import { ProviderError } from '../ai/provider';
import { testStore } from '../test/harness';
import { biologyProvider, fakeServer, serverMessages, testSession } from '../test/server';
import { createApp } from './app';
import { classify } from './classify';
import type { Message } from './domain';
import {
  DELAY_MS,
  draftContext,
  draftGauge,
  draftScoreFn,
  DraftScorer,
  draftView,
  MAX_FAILURES,
  ratable,
  sendMode,
  TIMEOUT_MS,
  type Recent,
  type ScoreFn,
} from './draftScore';
import { remoteBackend } from './live';
import { draftShare } from './modes';
import { activeMessages } from './state';
import { sendTurn } from './turn';
import type { Classification } from './types';

interface Call {
  input: ScoreInput;
  signal: AbortSignal;
  answer: (r: ScoreResult) => void;
  fail: (e: unknown) => void;
}

/** A fast model the test answers by hand. Like the real providers it rejects when its call is aborted, unless `ignoreAbort`. */
function fakeModel({ ignoreAbort = false } = {}) {
  const calls: Call[] = [];
  const score: ScoreFn = (input, signal) =>
    new Promise<ScoreResult>((answer, fail) => {
      calls.push({ input, signal, answer, fail });
      if (!ignoreAbort) signal.addEventListener('abort', () => fail(new ProviderError('stopped', 'aborted')));
    });
  return { score, calls };
}

function setup(opts?: { ignoreAbort?: boolean }) {
  const model = fakeModel(opts);
  const scorer = new DraftScorer(model.score);
  return { ...model, scorer, view: (draft: string, recent: Recent = []) => draftView(scorer.snapshot(), draft, recent) };
}

/** Let timers and settled promises run. */
const wait = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const texts = (calls: Call[]) => calls.map((c) => (c.input.question === 'thinking' ? c.input.text : c.input.question));

/** Type a draft and let the pause pass: the call is then in flight. */
async function typed(s: ReturnType<typeof setup>, draft: string, recent: Recent = []) {
  s.scorer.update(draft, recent);
  await wait(DELAY_MS);
  return s.calls.at(-1)!;
}

const RULES: Classification = { mode: 'own', confidence: 0.8, reasons: ['States a claim'] };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('draft scorer: when it asks', () => {
  it('asks once, DELAY_MS after the last keystroke, about the last text and with the context', async () => {
    const s = setup();
    const recent: Recent = [
      { role: 'user', text: 'Why do we have seasons?' },
      { role: 'assistant', text: 'What do you think causes them?' },
    ];
    for (const t of ['I thi', 'I think', 'I think the', 'I think the tilt ']) {
      s.scorer.update(t, recent);
      await wait(DELAY_MS - 100);
    }
    expect(s.calls).toHaveLength(0);
    await wait(100);
    expect(s.calls.map((c) => c.input)).toEqual([{ question: 'thinking', text: 'I think the tilt', recent }]);
  });

  it('no call for an empty draft, a single word or a command', async () => {
    const s = setup();
    for (const t of ['', '   ', 'hello', '  hello  ', '/nudge off', '/quiz the seasons please']) s.scorer.update(t, []);
    await wait(DELAY_MS * 3);
    expect(s.calls).toHaveLength(0);
    expect([ratable('hello there'), ratable('hello'), ratable('/hint why is it'), ratable('')]).toEqual([true, false, false, false]);
    await typed(s, 'hello there');
    expect(texts(s.calls)).toEqual(['hello there']);
  });

  it('never rates the same text in the same context twice in a row (trailing spaces, typing and deleting back)', async () => {
    const s = setup();
    (await typed(s, 'I will do nothing myself')).answer({ p: 0, model: 'fast' });
    await wait();
    s.scorer.update('I will do nothing myself ', []);
    await wait(DELAY_MS * 2);
    s.scorer.update('I will do nothing myself!', []);
    await wait(DELAY_MS - 100);
    s.scorer.update('I will do nothing myself', []);
    await wait(DELAY_MS * 2);
    expect(texts(s.calls)).toEqual(['I will do nothing myself']);
    expect(s.view('I will do nothing myself').rated).toEqual({ p: 0, model: 'fast' });
  });

  it('a new context (a reply finished, another chat) rates the same text again; meanwhile the old rating is the earlier one', async () => {
    const s = setup();
    (await typed(s, 'yes because of the tilt')).answer({ p: 0.75 });
    await wait();
    const recent: Recent = [{ role: 'assistant', text: 'Is it the distance?' }];
    expect(s.view('yes because of the tilt', recent)).toMatchObject({ rated: null, earlier: { p: 0.75 } });
    (await typed(s, 'yes because of the tilt', recent)).answer({ p: 1 });
    await wait();
    expect(s.calls.map((c) => c.input.question === 'thinking' && c.input.recent)).toEqual([[], recent]);
    expect(s.view('yes because of the tilt', recent).rated).toEqual({ p: 1 });
  });
});

describe('draft scorer: aborts, stale answers and timeouts', () => {
  it('a keystroke aborts the call in flight, and the next pause asks about the new text', async () => {
    const s = setup();
    const first = await typed(s, 'I think the');
    s.scorer.update('I think the tilt', []);
    expect(first.signal.aborted).toBe(true);
    await wait(DELAY_MS);
    expect(texts(s.calls)).toEqual(['I think the', 'I think the tilt']);
    expect(s.calls[1].signal.aborted).toBe(false);
  });

  it('an answer for an older text is dropped, even from a model that ignores the abort; aborted calls are no failures', async () => {
    const s = setup({ ignoreAbort: true });
    const old = await typed(s, 'I think the');
    const now = await typed(s, 'I think the tilt');
    old.answer({ p: 0.5 });
    await wait();
    expect(s.scorer.snapshot().rating).toBeNull();
    now.answer({ p: 0.75 });
    await wait();
    expect(s.view('I think the tilt').rated).toEqual({ p: 0.75 });
    for (let i = 0; i < MAX_FAILURES + 1; i++) await typed(s, `draft number ${i}`);
    expect(s.scorer.snapshot().unavailable).toBe(false);
  });

  it(`gives up after ${TIMEOUT_MS} ms and keeps what was shown; slow calls do not stop the model`, async () => {
    const s = setup();
    (await typed(s, 'I think the')).answer({ p: 0.5 });
    await wait();
    for (const t of ['I think the tilt', 'I think the tilt matters', 'I think the tilt matters most']) {
      const call = await typed(s, t);
      await wait(TIMEOUT_MS - 1);
      expect(call.signal.aborted).toBe(false);
      await wait(1);
      expect(call.signal.aborted).toBe(true);
      // The line keeps the earlier rating (dimmed), no error.
      expect(s.view(t)).toEqual({ rated: null, earlier: { p: 0.5 }, canRate: true, unavailable: false });
    }
    expect(s.calls).toHaveLength(4);
  });
});

describe('draft scorer: a model that fails', () => {
  it(`stops asking after ${MAX_FAILURES} failures in a row; the view falls back to the word rules and says why`, async () => {
    const s = setup();
    (await typed(s, 'I think the')).answer({ p: 0.5 });
    await wait();
    (await typed(s, 'I think the tilt')).fail(new ProviderError('FAST_API_KEY is not set.', 'upstream'));
    await wait();
    expect(s.view('I think the tilt')).toMatchObject({ earlier: { p: 0.5 }, unavailable: false });
    (await typed(s, 'I think the tilt matters')).fail(new ProviderError('FAST_API_KEY is not set.', 'upstream'));
    await wait();
    expect(s.view('I think the tilt matters')).toEqual({ rated: null, earlier: null, canRate: true, unavailable: true });
    // Even the text it rated: the rules decide from now on.
    expect(s.view('I think the').rated).toBeNull();
    await typed(s, 'I think the tilt matters most');
    await wait(DELAY_MS * 3);
    expect(s.calls).toHaveLength(3);
  });

  it('a success in between resets the count', async () => {
    const s = setup();
    (await typed(s, 'one two')).fail(new Error('500'));
    await wait();
    (await typed(s, 'one two three')).answer({ p: 0.25 });
    await wait();
    (await typed(s, 'one two three four')).fail(new Error('500'));
    await wait();
    expect(s.scorer.snapshot().unavailable).toBe(false);
    await typed(s, 'one two three four five');
    expect(s.calls).toHaveLength(4);
  });
});

describe('draft view and gauge', () => {
  it('the rating of exactly this draft, the earlier one while a newer draft waits, none for a short draft or after clearing', async () => {
    const s = setup();
    expect(s.view('I think the')).toEqual({ rated: null, earlier: null, canRate: true, unavailable: false });
    (await typed(s, 'I think the')).answer({ p: 0.5, model: 'fast' });
    await wait();
    expect(s.view('  I think the ')).toMatchObject({ rated: { p: 0.5, model: 'fast' }, earlier: null });
    expect(s.view('I think the tilt')).toMatchObject({ rated: null, earlier: { p: 0.5, model: 'fast' } });
    // Nothing is coming for a single word or a command: the word rules, not an old rating.
    expect(s.view('I')).toMatchObject({ rated: null, earlier: null });
    expect(s.view('/nudge off')).toMatchObject({ rated: null, earlier: null });
    // Sent or cleared: the next draft starts from the rules.
    s.scorer.update('', []);
    expect(s.view('I think the')).toMatchObject({ rated: null, earlier: null });
    expect(draftView(null, 'I think the', [])).toEqual({ rated: null, earlier: null, canRate: false, unavailable: false });
  });

  it('labels a model rating by the thresholds of a sent message; the word rules keep their split', () => {
    const at = (p: number) => draftGauge(RULES, { rated: { p }, earlier: null, canRate: true, unavailable: false });
    expect([0, 0.2, 0.24, 0.46, 0.66, 0.67, 0.75, 1].map((p) => at(p).mode)).toEqual(['ai', 'ai', 'together', 'together', 'together', 'own', 'own', 'own']);
    expect(at(0)).toEqual({ mode: 'ai', you: 0, from: 'model' });
    expect(draftGauge(RULES, { rated: null, earlier: { p: 0.75 }, canRate: true, unavailable: false })).toEqual({ mode: 'own', you: 0.75, from: 'earlier' });
    const none = { rated: null, earlier: null, canRate: true, unavailable: false };
    expect(draftGauge(RULES, none)).toEqual({ mode: 'own', you: draftShare('own', 0.8), from: 'rules' });
  });

  it('at send only a rating of exactly this text decides the label; an earlier one does not', () => {
    expect(sendMode(RULES, { rated: { p: 0 }, earlier: null, canRate: true, unavailable: false })).toBe('ai');
    expect(sendMode(RULES, { rated: null, earlier: { p: 0 }, canRate: true, unavailable: false })).toBe('own');
  });

  it("the context is the chat's finished messages, as the turn sends them", () => {
    const m = (role: 'user' | 'assistant', text: string, extra: Partial<Message> = {}): Message => ({ id: text, role, text, conceptIds: [], conversationId: 'c', createdAt: '', ...extra });
    const messages = [m('user', 'a'), m('assistant', 'b'), m('user', 'c'), m('assistant', 'failed', { error: 'x' }), m('user', 'd'), m('assistant', 'e'), m('user', 'f'), m('assistant', 'streaming', { streaming: true })];
    // The last four, without the failed reply and the one still streaming.
    expect(draftContext(messages)).toEqual([
      { role: 'user', text: 'c' },
      { role: 'user', text: 'd' },
      { role: 'assistant', text: 'e' },
      { role: 'user', text: 'f' },
    ]);
  });
});

describe('who can rate drafts', () => {
  it('only a provider with a fast model: not the demo, not an own model with scores off', async () => {
    const app = (search: string) => createApp({ params: new URLSearchParams(search), storage: null, backend: remoteBackend(testSession()), page: null });
    expect(draftScoreFn(app('?demo=1').provider())).toBeNull();
    expect(draftScoreFn(app('?provider=scripted').provider())).toBeNull();
    expect(draftScoreFn(app('?provider=arbor').provider())).toBeTypeOf('function');
    const own = (scores: 'same' | 'off') => new OwnProvider(() => ({ setup: { ...DEFAULT_SETUP, scores }, keys: {} }));
    expect(draftScoreFn(own('off'))).toBeNull();
    expect(draftScoreFn(own('same'))).toBeTypeOf('function');
  });

  it('the function asks the provider itself', async () => {
    const score = vi.fn(async () => ({ p: 0.25 }));
    const fn = draftScoreFn({ ...biologyProvider(), score })!;
    const input = { question: 'thinking' as const, text: 'Why is the sky blue?', recent: [] };
    const signal = new AbortController().signal;
    expect(await fn(input, signal)).toEqual({ p: 0.25 });
    expect(score).toHaveBeenCalledWith(input, signal);
  });
});

describe('send with a rating from the composer', () => {
  const TEXT = 'I think you could just write the essay for me';

  it('the turn takes it: no second score call, the model label decides (veiled), the same score shape as a turn stores', async () => {
    const rules = classify(TEXT);
    expect(rules.mode).not.toBe('ai');
    // The composer: the model rates the draft as it is typed.
    const s = setup();
    (await typed(s, TEXT)).answer({ p: 0, model: 'fast' });
    await wait();
    const v = s.view(TEXT);
    expect(sendMode(rules, v)).toBe('ai');

    const score = vi.fn(async () => ({ p: 0.5, model: 'fast' }));
    const t = testStore({ fresh: true, provider: { ...biologyProvider(), score } });
    await sendTurn(t.deps, { text: TEXT, classification: rules, veil: true, thinking: v.rated! }, new AbortController().signal);
    expect(score).not.toHaveBeenCalled();
    // The message arrives labelled by the model (the rules' reasons stay until the analysis lands)…
    const sent = t.actions.find((a) => a.type === 'user');
    expect(sent?.type === 'user' && sent.msg).toMatchObject({ scores: { thinking: { p: 0, model: 'fast' } }, classification: { mode: 'ai', reasons: rules.reasons } });
    // …and keeps that label after the analysis, as with a score from the turn.
    const [user, reply] = t.messages();
    expect(user).toMatchObject({ scores: { thinking: { p: 0, model: 'fast' } }, classification: { mode: 'ai' }, analysis: 'done' });
    expect(reply.veiled).toBe(true);
    expect(t.state.domain.attempts.map((a) => [a.mode, a.independence])).toEqual([['ai', 0]]);

    // Without a rating, the turn asks as before.
    await sendTurn(t.deps, { text: 'Why do vaccines need boosters?', classification: classify('Why do vaccines need boosters?') }, new AbortController().signal);
    expect(score).toHaveBeenCalledTimes(1);
  });

  it('through the app: the rating is saved with the message, and the provider is not asked', async () => {
    const server = fakeServer();
    const score = vi.fn(async () => ({ p: 0.5 }));
    const a = createApp({
      params: new URLSearchParams('?provider=arbor'),
      storage: null,
      backend: remoteBackend(testSession()),
      provider: { ...biologyProvider(), score },
      page: null,
    });
    a.start();
    await wait(2000);
    a.send(TEXT, classify(TEXT), { veil: true, thinking: { p: 0, model: 'fast' } });
    await wait(2000);
    expect(score).not.toHaveBeenCalled();
    const chat = a.store.getState().session.activeConversationId;
    expect(activeMessages(a.store.getState())[1].veiled).toBe(true);
    expect(serverMessages(server, chat)[0].scores).toEqual({ thinking: { p: 0, model: 'fast' } });
  });
});
