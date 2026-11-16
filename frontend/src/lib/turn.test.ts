import { describe, expect, it } from 'vitest';
import type { ChatRequest, JsonTask, JsonTasks, Provider } from '../ai/provider';
import { ProviderError } from '../ai/provider';
import type { TurnAnalysis } from '../ai/schemas/turnAnalysis';
import { testStore } from '../test/harness';
import { retryTurn } from './turn';

/** A provider you script per test: what chat streams, whether it fails, and what analysis says. */
class FakeProvider implements Provider {
  readonly kind = 'scripted' as const;
  readonly label = 'fake';
  chunks = ['Hello ', 'there', '.'];
  failChatAt: number | null = null;
  failAnalysis = false;
  onChunk: ((i: number) => void) | null = null;
  analysis: TurnAnalysis = {
    message: { mode: 'own', confidence: 0.9, reasons: ['Shares your view'], evidence: [{ quote: 'I think', mode: 'own', reason: 'Shares your view' }] },
    concepts: [
      { ref: { existingId: 'gradient' }, mode: 'own', independence: 1, correctness: null, confidence: 0.9, reason: 'own words' },
      { ref: { newNode: { label: 'Momentum', kind: 'concept', parent: { existingId: 'learning' }, description: '' } }, mode: 'together', independence: 0.5, correctness: null, confidence: 0.8, reason: 'asked' },
    ],
  };
  requests: ChatRequest[] = [];

  async chat(req: ChatRequest, onDelta: (t: string) => void, signal: AbortSignal) {
    this.requests.push(req);
    for (let i = 0; i < this.chunks.length; i++) {
      await Promise.resolve();
      if (signal.aborted) throw new ProviderError('stopped', 'aborted');
      if (this.failChatAt === i) throw new ProviderError('network down', 'network');
      onDelta(this.chunks[i]);
      this.onChunk?.(i);
    }
    return { text: this.chunks.join(''), model: 'fake-1' };
  }

  async json<K extends JsonTask>(_task: K, _input: JsonTasks[K]['input']): Promise<JsonTasks[K]['output']> {
    if (this.failAnalysis) throw new Error('bad json');
    return this.analysis as JsonTasks[K]['output'];
  }
}

const setup = (fake = new FakeProvider()) => ({ fake, s: testStore({ empty: true, provider: fake }) });
const types = (s: ReturnType<typeof testStore>) => s.actions.map((a) => a.type);

describe('turn: success', () => {
  it('streams the reply, then merges the analysis into the graph', async () => {
    const { s } = setup();
    await s.send('I think momentum helps gradient descent');
    const t = types(s);
    expect(t.filter((x) => x !== 'analysisDone')).toEqual(['user', 'assistantStart', 'stream', 'stream', 'assistantDone']);
    // The analysis lands once the reply has started, so leaves grow as the answer appears.
    expect(t.indexOf('analysisDone')).toBeGreaterThan(t.indexOf('assistantStart'));

    const [user, reply] = s.messages();
    expect(reply).toMatchObject({ role: 'assistant', text: 'Hello there.', streaming: false, model: 'fake-1' });
    expect(user.analysis).toBe('done');
    expect(user.classification!.evidence).toEqual([{ start: 0, end: 7, mode: 'own', reason: 'Shares your view' }]);

    // One existing concept, one new node under "How it learns"; both messages point at them.
    const momentum = Object.values(s.state.domain.concepts).find((c) => c.label === 'Momentum')!;
    expect(momentum).toMatchObject({ parentId: 'learning', createdBy: 'llm' });
    expect(user.conceptIds).toEqual(['gradient', momentum.id]);
    expect(reply.conceptIds).toEqual(user.conceptIds);
    const leaves = s.activeTrees()[0].branches.flatMap((b) => b.leaves.map((l) => [l.label, l.score]));
    expect(leaves).toEqual([
      ['Gradient descent', 1],
      ['Momentum', 0.5],
    ]);
    expect(s.state.session.turn.status).toBe('idle');
  });

  it('sends the transcript and what the chat already covered', async () => {
    const { s, fake } = setup();
    await s.send('I think momentum helps gradient descent');
    await s.send('and what about learning rate?');
    const req = fake.requests[1];
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(req.context.known.map((k) => k.label)).toEqual(['Gradient descent', 'Momentum']);
  });
});

describe('turn: errors and retry', () => {
  it('a failure before the reply starts leaves the user message and an error to retry', async () => {
    const { s, fake } = setup();
    fake.failChatAt = 0;
    await s.send('I think momentum helps gradient descent');
    expect(s.state.session.turn).toMatchObject({ status: 'error', error: 'network down' });
    expect(s.messages().map((m) => m.role)).toEqual(['user']);
    expect(s.messages()[0].analysis).toBe('done'); // the label still lands

    fake.failChatAt = null;
    await retryTurn(s.deps, new AbortController().signal);
    expect(s.messages().map((m) => [m.role, m.text])).toEqual([
      ['user', 'I think momentum helps gradient descent'],
      ['assistant', 'Hello there.'],
    ]);
    expect(s.state.session.turn.status).toBe('idle');
  });

  it('a failure mid-stream marks the partial reply; retry replaces it', async () => {
    const { s, fake } = setup();
    fake.failChatAt = 2;
    await s.send('I think momentum helps gradient descent');
    const failed = s.messages()[1];
    expect(failed).toMatchObject({ text: 'Hello there', error: 'network down', streaming: false });
    expect(s.state.session.turn).toMatchObject({ status: 'error', assistantMessageId: failed.id });

    fake.failChatAt = null;
    await retryTurn(s.deps, new AbortController().signal);
    expect(s.messages()).toHaveLength(2);
    expect(s.messages()[1].text).toBe('Hello there.');
    expect(s.messages()[1].error).toBeUndefined();
    // The retry does not analyse the message a second time.
    expect(types(s).filter((t) => t === 'analysisDone')).toHaveLength(1);
  });

  it('retry does nothing unless the last turn failed', async () => {
    const { s } = setup();
    await s.send('hi there friend');
    const before = s.actions.length;
    await retryTurn(s.deps, new AbortController().signal);
    expect(s.actions.length).toBe(before);
  });

  it('a failed analysis keeps the linter label', async () => {
    const { s, fake } = setup();
    fake.failAnalysis = true;
    await s.send('Write me a summary of backpropagation');
    const user = s.messages()[0];
    expect(user.analysis).toBe('failed');
    expect(user.classification!.mode).toBe('ai');
    expect(s.state.session.turn.status).toBe('idle');
  });
});

describe('turn: stop', () => {
  it('stopping mid-stream keeps what arrived and still applies the analysis', async () => {
    const { s, fake } = setup();
    const c = new AbortController();
    fake.onChunk = (i) => i === 0 && c.abort();
    await s.send('I think momentum helps gradient descent', { signal: c.signal });
    expect(s.messages()[1]).toMatchObject({ text: 'Hello ', stopped: true, streaming: false });
    expect(s.messages()[0].analysis).toBe('done');
    expect(s.state.session.turn.status).toBe('idle');
  });

  it('stopping before the reply starts leaves just the user message', async () => {
    const { s } = setup();
    const c = new AbortController();
    c.abort();
    await s.send('I think momentum helps gradient descent', { signal: c.signal });
    expect(types(s)).toContain('turnStopped');
    expect(s.messages().map((m) => m.role)).toEqual(['user']);
    expect(s.state.session.turn.status).toBe('idle');
  });
});

describe('turn: what the user did meanwhile wins over a late analysis', () => {
  it('a relabel before the analysis lands is kept', async () => {
    const { s, fake } = setup();
    fake.onChunk = (i) => {
      if (i === 0) s.deps.dispatch({ type: 'reclassify', id: s.messages()[0].id, mode: 'ai' });
    };
    await s.send('I think momentum helps gradient descent');
    expect(s.messages()[0].classification).toMatchObject({ mode: 'ai', overridden: true });
    expect(s.activeTrees()[0].branches.flatMap((b) => b.leaves.map((l) => l.score))).toEqual([0, 0]);
  });
});
