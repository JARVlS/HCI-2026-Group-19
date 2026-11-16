import { describe, expect, it } from 'vitest';
import { testStore } from '../test/harness';

describe('reducer: relabel and reveal', () => {
  it('a relabel supersedes the attempts instead of deleting them, and keeps leaf order', () => {
    const s = testStore();
    const before = s.activeTrees()[0].branches.flatMap((b) => b.leaves.map((l) => l.id));
    s.deps.dispatch({ type: 'reclassify', id: 'seed-0-u', mode: 'own' });

    const touched = s.state.domain.attempts.filter((a) => a.messageId === 'seed-0-u');
    expect(touched.map((a) => [a.conceptId, a.mode, a.source, Boolean(a.supersededBy)])).toEqual([
      ['neuron', 'ai', 'prompt', true],
      ['layers', 'ai', 'prompt', true],
      ['neuron', 'own', 'override', false],
      ['layers', 'own', 'override', false],
    ]);
    expect(s.messages()[0].classification).toMatchObject({ mode: 'own', overridden: true });
    expect(s.activeTrees()[0].branches.flatMap((b) => b.leaves.map((l) => l.id))).toEqual(before);
  });

  it('relabelling twice chains the supersessions', () => {
    const s = testStore();
    s.deps.dispatch({ type: 'reclassify', id: 'seed-0-u', mode: 'own' });
    s.deps.dispatch({ type: 'reclassify', id: 'seed-0-u', mode: 'together' });
    const live = s.state.domain.attempts.filter((a) => a.messageId === 'seed-0-u' && !a.supersededBy);
    expect(live.map((a) => a.mode)).toEqual(['together', 'together']);
    expect(new Set(s.state.domain.attempts.map((a) => a.id)).size).toBe(s.state.domain.attempts.length);
  });

  it('revealing with a guess turns a delegated prompt into thinking together', async () => {
    const s = testStore();
    await s.send('Write me a summary of backpropagation for my exam', { veil: true });
    const reply = s.messages().at(-1)!;
    s.deps.dispatch({ type: 'reveal', id: reply.id, guess: '  ' });
    expect(s.messages().at(-2)!.classification!.mode).toBe('ai');

    const s2 = testStore();
    await s2.send('Write me a summary of backpropagation for my exam', { veil: true });
    s2.deps.dispatch({ type: 'reveal', id: s2.messages().at(-1)!.id, guess: 'chain rule backwards' });
    expect(s2.messages().at(-1)).toMatchObject({ veiled: false, guess: 'chain rule backwards' });
    expect(s2.messages().at(-2)!.classification!.mode).toBe('together');
    const backprop = s2.activeTrees()[0].branches.flatMap((b) => b.leaves).find((l) => l.id === 'backprop')!;
    expect(backprop.score).toBe(0.5);
  });

  it('remembers a pending quiz until it is answered', async () => {
    const s = testStore();
    await s.send('Quiz me on loss');
    expect(s.state.session.pendingQuiz).toBe('loss');
    await s.send('it measures how far off the predictions are');
    expect(s.state.session.pendingQuiz).toBeNull();
    const quizAttempt = s.state.domain.attempts.at(-1)!;
    expect(quizAttempt).toMatchObject({ conceptId: 'loss', source: 'quiz', correctness: 1, mode: 'own' });
  });
});
