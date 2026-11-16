import { describe, expect, it } from 'vitest';
import { crossRoots, projectForest } from '../../lib/project';
import type { TreeData } from '../../lib/types';
import { testStore } from '../../test/harness';
import expected from './parity.expected.json';

/**
 * M1 acceptance: the refactored pipeline (fixture → sendTurn → ScriptedProvider → analysis merge →
 * projection) behaves exactly like the prototype's store. `parity.expected.json` was captured from
 * the pre-M1 code (store.tsx + engine.ts) running the same script.
 */

type Store = ReturnType<typeof testStore>;

function norm(s: Store) {
  const tree = s.activeTrees()[0];
  const msgs = s.messages();
  return {
    branches: tree.branches.map((b) => ({ id: b.id, label: b.label, leaves: b.leaves.map((l) => ({ label: l.label, score: l.score, count: l.count })) })),
    pendingQuiz: s.state.session.pendingQuiz,
    replies: msgs.filter((m) => m.role === 'assistant').map((m) => m.text.slice(0, 40)),
    reflectOn: msgs.filter((m) => m.role === 'assistant').map((m) => m.reflectOn ?? null),
    modes: msgs.filter((m) => m.role === 'user').map((m) => m.classification!.mode),
  };
}

describe('scripted demo parity with the prototype', () => {
  it('seed conversation', () => {
    const s = testStore();
    // The capture script left reflectOn out of the seed; the prototype set it for "full" answers.
    expect({ ...norm(s), reflectOn: expected.seed.reflectOn }).toEqual(expected.seed);
    expect(norm(s).reflectOn).toEqual(['neuron', null, null]);
  });

  it('README demo script', async () => {
    const s = testStore();
    await s.send('Write me a summary of backpropagation for my exam', { veil: true });
    const veiled = s.messages().at(-1)!;
    expect(veiled.veiled).toBe(true);
    s.deps.dispatch({ type: 'reveal', id: veiled.id, guess: 'it goes backwards with the chain rule' });
    await s.send('Quiz me on loss');
    await s.send('it measures how far the predictions are from the targets');
    s.deps.dispatch({ type: 'reclassify', id: 'seed-0-u', mode: 'own' });
    await s.send("What's the weather like in Lisbon?");
    await s.send('Quiz me');
    await s.send("I don't know");
    await s.send('I think overfitting is when the model memorizes the training data instead of learning the pattern');
    await s.send('Write me a summary of everything so far');

    const got = norm(s);
    expect({ ...got, reflectOn: got.reflectOn.slice(3) }).toEqual({ ...expected.demo, reflectOn: expected.demo.reflectOn.slice(3) });
    expect(s.state.session.turn.status).toBe('idle');
  });

  it('starts empty with ?empty=1 and grows from a seed', async () => {
    const s = testStore({ empty: true });
    expect(s.messages()).toEqual([]);
    expect(s.activeTrees()).toEqual([]);
    await s.send('I think overfitting is when the model memorizes the training data instead of learning the pattern');
    const [tree] = s.activeTrees();
    expect(tree.id).toBe('nn');
    expect(tree.branches.map((b) => b.leaves.map((l) => [l.label, l.score]))).toEqual([[['Overfitting', 1]]]);
  });
});

describe('forest parity with the prototype', () => {
  const forestOf = (s: Store) => {
    const { trees, concepts, attempts, edges } = s.state.domain;
    const ids = s.activeTrees().map((t) => t.id);
    const forest = projectForest(trees, concepts, attempts, { conversationId: s.state.session.activeConversationId, liveTreeIds: ids });
    return { forest, roots: crossRoots(forest, edges, trees, attempts) };
  };

  it('past trees load from the fixture unchanged (ids, labels, scores, order)', () => {
    const { forest } = forestOf(testStore());
    const past = forest.slice(1).map((t) => ({
      id: t.id,
      title: t.title,
      grove: t.grove,
      branches: t.branches.map((b) => ({ id: b.id, label: b.label, leaves: b.leaves.map((l) => ({ id: l.id, label: l.label, score: l.score })) })),
    }));
    expect(past).toEqual(expected.past.map(({ updated: _, ...t }) => t));
    expect(forest[0]).toMatchObject({ id: 'nn', live: true });
  });

  /** The prototype matched roots by lower-cased label; the refactor matches concept ids via edges. */
  function labelRoots(forest: TreeData[]) {
    const out = new Map<string, Map<string, string[]>>();
    for (const a of forest) {
      const mine = new Map(a.branches.flatMap((b) => b.leaves.map((l) => [l.label.toLowerCase(), l.label] as const)));
      const row = new Map<string, string[]>();
      for (const b of forest) {
        if (a === b) continue;
        const shared = b.branches.flatMap((x) => x.leaves).map((l) => l.label.toLowerCase()).filter((k) => mine.has(k));
        if (shared.length) row.set(b.id, shared.map((k) => mine.get(k)!).sort());
      }
      out.set(a.id, row);
    }
    return out;
  }
  const idRoots = (roots: ReturnType<typeof crossRoots>) =>
    new Map([...roots].map(([a, row]) => [a, new Map([...row].map(([b, rs]) => [b, rs.map((r) => r.label).sort()]))]));

  it('roots by concept id are the same roots the prototype drew by label', async () => {
    const s = testStore();
    let { forest, roots } = forestOf(s);
    expect(idRoots(roots)).toEqual(labelRoots(forest));
    // Only "gradient descent" so far: "overfitting" is not a leaf on the live tree yet.
    expect(roots.get('reg')!.get('nn')!.map((r) => r.label)).toEqual(['Gradient descent']);

    await s.send('I think overfitting is when the model memorizes the training data instead of learning the pattern');
    ({ forest, roots } = forestOf(s));
    expect(idRoots(roots)).toEqual(labelRoots(forest));
    expect(roots.get('nn')!.get('reg')!.map((r) => r.label)).toEqual(['Gradient descent', 'Overfitting']);
  });
});
