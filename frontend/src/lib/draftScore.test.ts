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
import { MAX_TEXT } from './events';
import {
  adjusted,
  DELAY_MS,
  draftContext,
  draftGauge,
  draftRated,
  draftScoreFn,
  DraftScorer,
  draftView,
  MAX_FAILURES,
  ratable,
  sendMode,
  steadyMode,
  TIMEOUT_MS,
  type DraftView,
  type FilterView,
  type Recent,
  type ScoreFn,
  type Steady,
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
  const rated: [string, ScoreResult][] = [];
  const scorer = new DraftScorer(model.score, (text, score) => rated.push([text, score]));
  return { ...model, rated, scorer, view: (draft: string, recent: Recent = []) => draftView(scorer.snapshot(), draft, recent) };
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
/** A view of the composer's model rating: nothing rated unless given. */
const viewOf = (v: Partial<DraftView>): DraftView => ({ rated: null, earlier: null, anchor: null, canRate: true, unavailable: false, ...v });

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
    // Only the rating that landed reaches the usage log (draft_rated): the draft as rated, its length and the numbers.
    expect(s.rated).toEqual([['I think the tilt', { p: 0.75 }]]);
    expect(draftRated('I think the tilt', { p: 0.75, model: 'fast' })).toEqual({ type: 'draft_rated', payload: { text: 'I think the tilt', percent: 75, mode: 'own', model: 'fast', chars: 16 } });
    for (let i = 0; i < MAX_FAILURES + 1; i++) await typed(s, `draft number ${i}`);
    expect(s.scorer.snapshot().unavailable).toBe(false);
  });

  it('draft_rated: a draft longer than MAX_TEXT is cut, its length is the real one', () => {
    const { payload } = draftRated('z'.repeat(MAX_TEXT + 1), { p: 0.1 }) as { payload: { text: string; chars: number } };
    expect([payload.text.length, payload.chars]).toEqual([MAX_TEXT, MAX_TEXT + 1]);
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
      expect(s.view(t)).toEqual(viewOf({ earlier: { p: 0.5 }, anchor: { text: 'I think the', score: { p: 0.5 } } }));
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
    expect(s.view('I think the tilt matters')).toEqual(viewOf({ unavailable: true }));
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
    expect(s.view('I think the')).toEqual(viewOf({}));
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
    expect(draftView(null, 'I think the', [])).toEqual(viewOf({ canRate: false }));
  });

  it('labels a model rating by the thresholds of a sent message; the word rules keep their split', () => {
    const at = (p: number) => draftGauge(RULES, viewOf({ rated: { p } }));
    expect([0, 0.2, 0.24, 0.46, 0.66, 0.67, 0.75, 1].map((p) => at(p).mode)).toEqual(['ai', 'ai', 'together', 'together', 'together', 'own', 'own', 'own']);
    expect(at(0)).toEqual({ mode: 'ai', you: 0, from: 'model' });
    expect(draftGauge(RULES, viewOf({ earlier: { p: 0.75 } }))).toEqual({ mode: 'own', you: 0.75, from: 'earlier' });
    expect(draftGauge(RULES, viewOf({}))).toEqual({ mode: 'own', you: draftShare('own', 0.8), from: 'rules' });
  });

  it('at send only a rating of exactly this text decides the label; an earlier one does not', () => {
    expect(sendMode(RULES, viewOf({ rated: { p: 0 } }))).toBe('ai');
    expect(sendMode(RULES, viewOf({ earlier: { p: 0 } }))).toBe('own');
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

describe('the word filter below the model (instant tier)', () => {
  const filter = (you: number, anchorYou: number | null = null, unsure = false): FilterView => ({ you, unsure, anchorYou });

  it('the anchor: the last rating while the draft still starts with its text, in the same chat', async () => {
    const s = setup();
    (await typed(s, 'I think the')).answer({ p: 0.5 });
    await wait();
    expect(s.view('I think the tilt').anchor).toEqual({ text: 'I think the', score: { p: 0.5 } });
    // Earlier words edited, another chat, or the rated text itself: no anchor.
    expect(s.view('We think the tilt').anchor).toBeNull();
    expect(s.view('I think the tilt', [{ role: 'assistant', text: 'Why?' }]).anchor).toBeNull();
    expect(s.view('I think the ').anchor).toBeNull();
  });

  it("a rating of exactly this draft wins; after it, the model's number moves by what the filter thinks the new words changed", () => {
    const anchor = { text: 'I will do nothing myself', score: { p: 0.1 } };
    expect(draftGauge(RULES, viewOf({ rated: { p: 0.9 } }), filter(0.2))).toEqual({ mode: 'own', you: 0.9, from: 'model' });
    const g = draftGauge(RULES, viewOf({ earlier: anchor.score, anchor }), filter(0.6, 0.15));
    expect(g.from).toBe('adjusted');
    expect(g.you).toBeCloseTo(0.1 + (0.6 - 0.15));
    expect(g.mode).toBe('together');
    // Kept in 0..1.
    expect([adjusted(0.9, 0.9, 0.2), adjusted(0.1, 0, 0.5)]).toEqual([1, 0]);
  });

  it('without an anchor the filter alone (and whether it is unsure); without the filter the line is as before', () => {
    const earlier = { p: 0.75 };
    expect(draftGauge(RULES, viewOf({ earlier }), filter(0.1, null, true))).toEqual({ mode: 'ai', you: 0.1, from: 'filter', unsure: true });
    // An anchor whose filter number is missing is no anchor.
    expect(draftGauge(RULES, viewOf({ earlier, anchor: { text: 'a b', score: earlier } }), filter(0.5))).toMatchObject({ from: 'filter', unsure: false });
    expect(draftGauge(RULES, viewOf({ earlier }), null)).toEqual({ mode: 'own', you: 0.75, from: 'earlier' });
    expect(draftGauge(RULES, viewOf({}), null).from).toBe('rules');
  });

  it('the label changes only after a new label held for two word updates in a row; the first one and a model rating show at once', () => {
    const run = (labels: ('own' | 'together' | 'ai')[]) => {
      let st: Steady | null = null;
      return labels.map((m) => (st = steadyMode(st, m)).shown);
    };
    expect(run(['ai', 'together', 'together', 'together'])).toEqual(['ai', 'ai', 'together', 'together']);
    // A one-word blip never shows; a second new label starts its own count.
    expect(run(['own', 'together', 'own', 'ai', 'together', 'together'])).toEqual(['own', 'own', 'own', 'own', 'own', 'together']);
    expect(steadyMode({ shown: 'own', waiting: null }, 'ai', true)).toEqual({ shown: 'ai', waiting: null });
  });

  it('at send: a model rating of exactly the text, else the steady label after the whole draft as the last word, else the rules', () => {
    const steady: Steady = { shown: 'together', waiting: 'ai' };
    const whole = (you: number, newWord: boolean) => ({ gauge: draftGauge(RULES, viewOf({}), filter(you)), steady, newWord });
    expect(sendMode(RULES, viewOf({ rated: { p: 0.9 } }), whole(0, true))).toBe('own');
    // The last word confirms the waiting label: veiled as "ai". Without a new word, the line's label stands.
    expect(sendMode(RULES, viewOf({}), whole(0.05, true))).toBe('ai');
    expect(sendMode(RULES, viewOf({}), whole(0.05, false))).toBe('together');
    // A first rating at send shows at once; no filter: the word rules, as before.
    expect(sendMode(RULES, viewOf({}), { ...whole(0.05, true), steady: null })).toBe('ai');
    expect(sendMode(RULES, viewOf({}), { gauge: draftGauge(RULES, viewOf({}), null), steady, newWord: true })).toBe('own');
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
  const DIST = { '1': 0.9, '2': 0.1, '3': 0, '4': 0, '5': 0 };

  it("the rating's distribution teaches the word filter once and is never stored; a turn's own score does the same", async () => {
    const s = setup();
    (await typed(s, TEXT)).answer({ p: 0.025, model: 'fast', distribution: DIST });
    await wait();
    const rated = s.view(TEXT).rated!;
    expect(rated.distribution).toEqual(DIST);

    const judged = vi.fn();
    const score = vi.fn(async () => ({ p: 0.5, model: 'fast', distribution: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 0 } }));
    const t = testStore({ fresh: true, provider: { ...biologyProvider(), score } });
    const deps = { ...t.deps, judged };
    await sendTurn(deps, { text: TEXT, classification: classify(TEXT), thinking: rated }, new AbortController().signal);
    expect(score).not.toHaveBeenCalled();
    expect(t.messages()[0].scores).toEqual({ thinking: { p: 0.025, model: 'fast' } });
    expect(judged.mock.calls).toEqual([[{ question: 'thinking', text: TEXT, recent: [] }, DIST]]);

    // No rating from the composer: the turn's score teaches it when it lands, with the chat as context.
    await sendTurn(deps, { text: 'Why do vaccines need boosters?', classification: classify('Why do vaccines need boosters?') }, new AbortController().signal);
    expect(judged).toHaveBeenCalledTimes(2);
    expect(judged.mock.calls[1][0]).toMatchObject({ question: 'thinking', text: 'Why do vaccines need boosters?', recent: [{ role: 'user', text: TEXT }, { role: 'assistant' }] });
    expect(t.messages()[2].scores).toEqual({ thinking: { p: 0.5, model: 'fast' } });

    // A score without a distribution (a provider that has none) teaches nothing.
    score.mockResolvedValueOnce({ p: 0.5, model: 'fast' } as never);
    await sendTurn(deps, { text: 'And the flu shot?', classification: classify('And the flu shot?') }, new AbortController().signal);
    expect(judged).toHaveBeenCalledTimes(2);
  });

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
