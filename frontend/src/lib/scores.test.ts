import { describe, expect, it, vi } from 'vitest';
import type { ChatRequest, Provider, ScoreInput, ScoreResult } from '../ai/provider';
import { ProviderError } from '../ai/provider';
import type { ConceptJudgement, TurnAnalysis } from '../ai/schemas/turnAnalysis';
import { testStore } from '../test/harness';
import type { ConceptAttempt } from './domain';
import { AI_UP_TO, OWN_FROM, thinkingMode } from './modes';
import { scoredAttempt, scoredLabel, scoreView } from './scores';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const concept = (label: string, over: Partial<ConceptJudgement> = {}): ConceptJudgement => ({
  // Straight below the new subject: with it, two concepts stay within the cap of 3 new nodes per turn.
  ref: { newNode: { label, kind: 'concept', parent: {}, description: '' } },
  mode: 'ai',
  independence: 0.2,
  correctness: null,
  confidence: 0.8,
  reason: 'asks for it',
  ...over,
});

const ANALYSIS: TurnAnalysis = {
  message: { mode: 'ai', confidence: 0.9, reasons: ['Asks for a finished summary'], evidence: [{ quote: 'Write me', mode: 'ai', reason: 'Asks for text' }] },
  subject: { newLabel: 'Biology' },
  concepts: [concept('Vaccines'), concept('Memory cells')],
};

/** A live-like provider: chat streams at once; the analysis and every score call wait until the test answers them, in any order. */
class Scoring implements Provider {
  readonly kind = 'arbor' as const;
  readonly label = 'fake live';
  chunks = ['Vaccines show the body ', 'a harmless copy.'];
  onChunk: ((i: number) => void) | null = null;
  analysis = deferred<TurnAnalysis>();
  calls: { input: ScoreInput; answer: ReturnType<typeof deferred<ScoreResult>> }[] = [];

  async chat(_req: ChatRequest, onDelta: (t: string) => void, signal: AbortSignal) {
    for (let i = 0; i < this.chunks.length; i++) {
      await Promise.resolve();
      if (signal.aborted) throw new ProviderError('stopped', 'aborted');
      onDelta(this.chunks[i]);
      this.onChunk?.(i);
    }
    return { text: this.chunks.join(''), model: 'claude-test' };
  }

  json() {
    return this.analysis.promise as never;
  }

  score(input: ScoreInput) {
    const answer = deferred<ScoreResult>();
    this.calls.push({ input, answer });
    return answer.promise;
  }

  /** The score call that asked this question about this text. */
  call(question: ScoreInput['question'], text: string) {
    const c = this.calls.find((x) => x.input.question === question && (x.input.question === 'thinking' ? x.input.text : x.input.statement) === text);
    if (!c) throw new Error(`no ${question} call about "${text}"`);
    return c.answer;
  }
}

/** Let streamed chunks, dispatches and settled promises run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const SUMMARY = 'Write me a summary of how vaccines work';
const CLAIM = 'I think a vaccine shows the body a harmless copy of the germ';

function live(fake = new Scoring()) {
  const s = testStore({ fresh: true, provider: fake });
  return { fake, s, user: () => s.messages()[0], reply: () => s.messages()[1] };
}

const numbers = (attempts: ConceptAttempt[]) => attempts.filter((a) => !a.supersededBy).map((a) => [a.mode, a.independence, a.correctness, a.source]);

describe('thresholds', () => {
  it('own from 0.67, ai up to 0.33, together in between', () => {
    expect([OWN_FROM, AI_UP_TO]).toEqual([0.67, 0.33]);
    expect([1, 0.67, 0.669, 0.5, 0.331, 0.33, 0].map(thinkingMode)).toEqual(['own', 'own', 'together', 'together', 'together', 'ai', 'ai']);
  });
});

describe('turn with a scoring provider: the thinking score', () => {
  async function run(order: 'score first' | 'analysis first') {
    const t = live();
    const sent = t.s.send(SUMMARY);
    expect(t.user().scores).toEqual({ thinking: 'pending' });
    await tick();
    expect(t.fake.calls.map((c) => c.input)).toEqual([{ question: 'thinking', text: SUMMARY, recent: [] }]);
    if (order === 'score first') {
      t.fake.call('thinking', SUMMARY).resolve({ p: 0.8, model: 'fast' });
      await tick();
      // The fast score relabels the message at once; the analysis is still on its way.
      expect(t.user()).toMatchObject({ analysis: 'pending', classification: { mode: 'own' } });
      t.fake.analysis.resolve(ANALYSIS);
    } else {
      t.fake.analysis.resolve(ANALYSIS);
      await vi.waitFor(() => expect(t.user().analysis).toBe('done'));
      // Until the score lands, the analysis's own numbers stand.
      expect(numbers(t.s.state.domain.attempts)).toEqual([
        ['ai', 0.2, null, 'prompt'],
        ['ai', 0.2, null, 'prompt'],
      ]);
      t.fake.call('thinking', SUMMARY).resolve({ p: 0.8, model: 'fast' });
    }
    await sent;
    return t;
  }

  it('whichever lands first, the end state is the same: numbers and label from the score, concepts and reasons from the analysis', async () => {
    const a = await run('score first');
    const b = await run('analysis first');
    for (const t of [a, b]) {
      expect(t.user()).toMatchObject({
        analysis: 'done',
        scores: { thinking: { p: 0.8, model: 'fast' } },
        classification: { mode: 'own', reasons: ['Asks for a finished summary'] },
      });
      expect(numbers(t.s.state.domain.attempts)).toEqual([
        ['own', 0.8, null, 'prompt'],
        ['own', 0.8, null, 'prompt'],
      ]);
      expect(t.s.activeTrees()[0].branches.flatMap((x) => x.leaves.map((l) => [l.label, l.score]))).toEqual([
        ['Vaccines', 0.8],
        ['Memory cells', 0.8],
      ]);
    }
    expect(b.user().classification).toEqual(a.user().classification);
    // Nothing gradable, no guess: one score call for the turn.
    expect(a.fake.calls).toHaveLength(1);
  });

  it('earlier turns go along as context', async () => {
    const { s, fake } = live();
    fake.analysis.resolve({ ...ANALYSIS, concepts: [] });
    const first = s.send(SUMMARY);
    await tick();
    fake.call('thinking', SUMMARY).resolve({ p: 0.1 });
    await first;
    const second = s.send('And why do some need a booster?');
    await tick();
    expect(fake.calls[1].input).toEqual({
      question: 'thinking',
      text: 'And why do some need a booster?',
      recent: [
        { role: 'user', text: SUMMARY },
        { role: 'assistant', text: 'Vaccines show the body a harmless copy.' },
      ],
    });
    fake.calls[1].answer.resolve({ p: 0.5 });
    await second;
  });

  it('a failed score is visible on the message and leaves the analysis numbers; the turn does not fail', async () => {
    const { s, fake, user } = live();
    const sent = s.send(SUMMARY);
    await tick();
    fake.call('thinking', SUMMARY).reject(new ProviderError('The model did not answer with an option.', 'invalid_output'));
    fake.analysis.resolve(ANALYSIS);
    await sent;
    expect(user()).toMatchObject({ scores: { thinking: 'failed' }, analysis: 'done', classification: { mode: 'ai' } });
    expect(numbers(s.state.domain.attempts)).toEqual([
      ['ai', 0.2, null, 'prompt'],
      ['ai', 0.2, null, 'prompt'],
    ]);
    expect(s.state.session.turn).toEqual({ status: 'idle' });
    expect(scoreView(user().scores)).toMatchObject({ thought: 'failed', right: null });
  });

  it('a relabel by the user wins over a score, also one that lands later', async () => {
    const { s, fake, user } = live();
    const sent = s.send(SUMMARY);
    fake.analysis.resolve(ANALYSIS);
    await vi.waitFor(() => expect(user().analysis).toBe('done'));
    s.deps.dispatch({ type: 'reclassify', id: user().id, mode: 'together' });
    fake.call('thinking', SUMMARY).resolve({ p: 0.95 });
    await sent;
    expect(user().classification).toMatchObject({ mode: 'together', overridden: true });
    expect(numbers(s.state.domain.attempts)).toEqual([
      ['together', 0.5, null, 'override'],
      ['together', 0.5, null, 'override'],
    ]);
    // The score is kept as it came (study data), it just does not decide.
    expect(user().scores).toEqual({ thinking: { p: 0.95 } });
  });

  it('a provider without score keeps the analysis numbers and asks nothing more (Claude-only, demo)', async () => {
    const fake = new Scoring();
    const plain: Provider = { kind: 'arbor', label: 'no scores', chat: fake.chat.bind(fake), json: fake.json.bind(fake) };
    const s = testStore({ fresh: true, provider: plain });
    fake.analysis.resolve({ ...ANALYSIS, concepts: [concept('Vaccines', { mode: 'own', independence: 0.8, correctness: 0.4 })] });
    await s.send(CLAIM, { veil: false });
    expect(s.messages()[0].scores).toBeUndefined();
    expect(numbers(s.state.domain.attempts)).toEqual([['own', 0.8, 0.4, 'prompt']]);
    expect(fake.calls).toEqual([]);
  });
});

describe('turn with a scoring provider: own claims', () => {
  it('a turn the analysis found gradable is graded against the complete reply; only gradable concepts change', async () => {
    const { s, fake, user, reply } = live();
    fake.analysis.resolve({ ...ANALYSIS, concepts: [concept('Vaccines', { mode: 'own', independence: 1, correctness: 0.4 }), concept('Germs')] });
    const sent = s.send(CLAIM);
    await tick();
    // Not before the reply is complete and the analysis applied.
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(reply().streaming).toBe(false);
    expect(fake.calls[1].input).toEqual({ question: 'correct', statement: CLAIM, reference: 'Vaccines show the body a harmless copy.' });
    fake.call('thinking', CLAIM).resolve({ p: 0.9 });
    fake.call('correct', CLAIM).resolve({ p: 0.85 });
    await sent;
    expect(numbers(s.state.domain.attempts)).toEqual([
      ['own', 0.9, 0.85, 'prompt'],
      ['own', 0.9, null, 'prompt'],
    ]);
    expect(scoreView(user().scores)).toEqual({ thought: 0.9, byGuess: false, guess: null, right: 0.85 });
  });

  it('a stopped reply is not graded', async () => {
    const { s, fake } = live();
    fake.analysis.resolve({ ...ANALYSIS, concepts: [concept('Vaccines', { correctness: 0.4 })] });
    const c = new AbortController();
    fake.onChunk = (i) => i === 0 && c.abort();
    const sent = s.send(CLAIM, { signal: c.signal });
    await tick();
    fake.call('thinking', CLAIM).resolve({ p: 0.9 });
    await sent;
    expect(fake.calls.map((x) => x.input.question)).toEqual(['thinking']);
    expect(numbers(s.state.domain.attempts)).toEqual([['own', 0.9, 0.4, 'prompt']]);
  });
});

describe('turn with a scoring provider: predict → reveal', () => {
  /** A veiled delegating turn whose thinking score and analysis have landed; the reveal happens in `during` (mid-stream) or after. */
  async function veiled(thinking: number, guess: string, during = false) {
    const t = live();
    t.fake.analysis.resolve(ANALYSIS);
    let revealed: Promise<void> | null = null;
    if (during) t.fake.onChunk = (i) => {
      if (i !== 0) return;
      revealed = t.s.reveal(t.reply().id, guess);
      // Mid-stream: nothing is asked about the guess yet.
      expect(t.fake.calls.map((c) => c.input.question)).toEqual(['thinking']);
    };
    const sent = t.s.send(SUMMARY, { veil: true });
    await tick();
    t.fake.call('thinking', SUMMARY).resolve({ p: thinking });
    if (!during) {
      await tick();
      expect(t.reply()).toMatchObject({ veiled: true, streaming: false });
      revealed = t.s.reveal(t.reply().id, guess);
    }
    return { ...t, sent, revealed: () => revealed };
  }

  it('a real guess gets both questions once the reply is complete; it raises the percent and says how right it was', async () => {
    const t = await veiled(0.1, 'it trains memory cells to react faster', true);
    await vi.waitFor(() => expect(t.fake.calls).toHaveLength(3));
    expect(t.fake.calls.slice(1).map((c) => c.input)).toEqual([
      { question: 'thinking', text: 'it trains memory cells to react faster', recent: [{ role: 'user', text: SUMMARY }] },
      { question: 'correct', statement: 'it trains memory cells to react faster', reference: 'Vaccines show the body a harmless copy.' },
    ]);
    expect(t.user().classification!.mode).toBe('ai'); // no flip by the reveal itself
    t.fake.call('thinking', 'it trains memory cells to react faster').resolve({ p: 0.75 });
    t.fake.call('correct', 'it trains memory cells to react faster').resolve({ p: 0.9 });
    await Promise.all([t.sent, t.revealed()]);
    expect(t.user().classification!.mode).toBe('own');
    expect(numbers(t.s.state.domain.attempts)).toEqual([
      ['own', 0.75, 0.9, 'reveal'],
      ['own', 0.75, 0.9, 'reveal'],
    ]);
    expect(scoreView(t.user().scores)).toEqual({ thought: 0.75, byGuess: true, guess: 0.75, right: 0.9 });
  });

  it('a reveal after the reply ended scores at once; a guess never lowers the percent; a wrong guess shows a low "right"', async () => {
    const t = await veiled(0.6, 'it is about the blood sugar');
    expect(t.fake.calls).toHaveLength(3);
    t.fake.call('thinking', 'it is about the blood sugar').resolve({ p: 0.4 });
    t.fake.call('correct', 'it is about the blood sugar').resolve({ p: 0.05 });
    await Promise.all([t.sent, t.revealed()]);
    expect(numbers(t.s.state.domain.attempts)).toEqual([
      ['together', 0.6, 0.05, 'reveal'],
      ['together', 0.6, 0.05, 'reveal'],
    ]);
    expect(scoreView(t.user().scores)).toEqual({ thought: 0.6, byGuess: false, guess: 0.4, right: 0.05 });
  });

  it('a stopped reply: the guess is scored for thinking along, but there is no "right"', async () => {
    const t = live();
    t.fake.analysis.resolve(ANALYSIS);
    const c = new AbortController();
    t.fake.onChunk = (i) => i === 0 && c.abort();
    const sent = t.s.send(SUMMARY, { veil: true, signal: c.signal });
    await tick();
    expect(t.reply()).toMatchObject({ stopped: true, veiled: true });
    const revealed = t.s.reveal(t.reply().id, 'memory cells');
    expect(t.fake.calls.map((x) => x.input.question)).toEqual(['thinking', 'thinking']);
    t.fake.call('thinking', SUMMARY).resolve({ p: 0.1 });
    t.fake.call('thinking', 'memory cells').resolve({ p: 0.7 });
    await Promise.all([sent, revealed]);
    expect(numbers(t.s.state.domain.attempts)).toEqual([
      ['own', 0.7, null, 'reveal'],
      ['own', 0.7, null, 'reveal'],
    ]);
    expect(scoreView(t.user().scores).right).toBeNull();
  });

  it('an empty guess asks nothing and changes nothing', async () => {
    const t = await veiled(0.1, '   ');
    await Promise.all([t.sent, t.revealed()]);
    expect(t.fake.calls).toHaveLength(1);
    expect(t.reply()).toMatchObject({ veiled: false });
    expect(t.user().classification!.mode).toBe('ai');
  });

  it('without a scoring provider the old rule stays: any guess makes it "together"', async () => {
    const s = testStore();
    await s.send('Write me a summary of backpropagation for my exam', { veil: true });
    await s.reveal(s.messages().at(-1)!.id, 'chain rule backwards');
    expect(s.messages().at(-2)!.classification!.mode).toBe('together');
  });
});

describe('the rules on their own', () => {
  const attempt: ConceptAttempt = {
    id: 'a',
    conversationId: 'c',
    messageId: 'm',
    conceptId: 'x',
    mode: 'ai',
    independence: 0.2,
    correctness: null,
    confidence: 0.8,
    reasons: [],
    evidence: [],
    source: 'prompt',
    createdAt: '2026-11-17T00:00:00Z',
  };

  it('applying the scores twice changes nothing (same object), in any order of guess and thinking', () => {
    const s = { thinking: { p: 0.3 }, guess: { p: 0.5 }, correct: { p: 0.9 } };
    const once = scoredAttempt(attempt, s);
    expect(scoredAttempt(once, s)).toBe(once);
    expect(scoredAttempt(scoredAttempt(attempt, { guess: { p: 0.5 } }), s)).toEqual(once);
    expect(scoredAttempt(attempt, { thinking: 'pending' })).toBe(attempt);
  });

  it('without a thinking score a guess can only raise the label', () => {
    const c = { mode: 'together' as const, confidence: 0.7, reasons: [] };
    expect(scoredLabel(c, { thinking: 'failed', guess: { p: 0.4 } })).toBe(c);
    expect(scoredLabel(c, { thinking: 'failed', guess: { p: 0.8 } }).mode).toBe('own');
    expect(scoredLabel({ ...c, overridden: true }, { thinking: { p: 0.1 } }).mode).toBe('together');
  });
});
