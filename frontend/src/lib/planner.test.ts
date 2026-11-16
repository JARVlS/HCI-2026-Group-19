import { describe, expect, it } from 'vitest';
import { at, attempt, concept, graph, tree } from '../test/build';
import type { Concept, ConceptAttempt, KnowledgeTree } from './domain';
import { HeuristicPlanner, applyPlan, homeRoot, runPlanner } from './planner';
import { projectForest } from './project';

const plan = (concepts: Record<string, Concept>, attempts: ConceptAttempt[], trees: KnowledgeTree[], p = new HeuristicPlanner()) =>
  p.plan({ concepts: Object.values(concepts), attempts, trees });

describe('homeRoot', () => {
  const cs = graph(concept('s', null, 'subject'), concept('t', 's', 'topic'), concept('b', 't', 'topic'), concept('c', 'b'), concept('d', 's'), concept('free', null, 'topic'), concept('e', 'free'));
  it('roots a tree at the topic right below the subject', () => expect(homeRoot('c', cs)).toBe('t'));
  it('roots at the subject when the concept hangs directly on it', () => expect(homeRoot('d', cs)).toBe('s'));
  it('roots at the topmost ancestor when there is no subject', () => expect(homeRoot('e', cs)).toBe('free'));
  it('a subject is its own root', () => expect(homeRoot('s', cs)).toBe('s'));
});

describe('HeuristicPlanner', () => {
  it('creates a tree for an attempted concept no tree covers', () => {
    const cs = graph(concept('s', null, 'subject'), concept('t', 's', 'topic', 'Topic'), concept('c', 't'));
    expect(plan(cs, [attempt('c')], [])).toEqual({ create: [{ rootConceptId: 't', title: 'Topic' }], remove: [] });
  });

  it('does nothing when everything is covered and small', () => {
    const cs = graph(concept('t', null, 'topic'), concept('c', 't'));
    expect(plan(cs, [attempt('c')], [tree('T', 't')])).toEqual({ create: [], remove: [] });
  });

  it('removes trees whose root concept is gone', () => {
    const cs = graph({ ...concept('t', null, 'topic'), deletedAt: at(1) });
    expect(plan(cs, [], [tree('T', 't')]).remove).toEqual(['T']);
  });

  it('splits the largest branch off when a branch grows past the limit, keeping leaf ids', () => {
    const big = Array.from({ length: 8 }, (_, i) => concept(`c${i}`, 'b1'));
    const cs = graph(concept('t', null, 'topic'), concept('b1', 't', 'topic', 'Big branch'), concept('b2', 't', 'topic'), concept('x', 'b2'), ...big);
    const attempts = [...big.map((c, i) => attempt(c.id, { t: i })), attempt('x', { t: 20 })];
    const trees = [tree('T', 't')];
    const p = plan(cs, attempts, trees);
    expect(p.create).toEqual([{ rootConceptId: 'b1', title: 'Big branch', splitFrom: 'T' }]);

    const after = runPlanner(new HeuristicPlanner(), { concepts: cs, attempts, trees }, at(30));
    expect(after.map((t) => [t.id, t.rootConceptId, t.splitFrom])).toEqual([
      ['T', 't', undefined],
      ['t:b1', 'b1', 'T'],
    ]);
    const forest = projectForest(after, cs, attempts);
    const ids = (i: number) => forest[i].branches.flatMap((b) => b.leaves.map((l) => l.id));
    expect(ids(0)).toEqual(['x']);
    expect(ids(1)).toEqual(big.map((c) => c.id));
  });

  it('splits when the whole tree is too big, even if no branch is', () => {
    const p = new HeuristicPlanner({ maxLeaves: 3, maxBranchLeaves: 10 });
    const cs = graph(concept('t', null, 'topic'), concept('b1', 't', 'topic'), concept('b2', 't', 'topic'), concept('a', 'b1'), concept('b', 'b1'), concept('c', 'b2'), concept('d', 'b2'), concept('e', 'b2'));
    const attempts = ['a', 'b', 'c', 'd', 'e'].map((id, t) => attempt(id, { t }));
    expect(plan(cs, attempts, [tree('T', 't')], p).create).toEqual([{ rootConceptId: 'b2', title: 'b2', splitFrom: 'T' }]);
  });

  it('never splits the side-questions branch', () => {
    const p = new HeuristicPlanner({ maxLeaves: 2, maxBranchLeaves: 2 });
    const cs = graph(concept('t', null, 'topic'), concept('a', 't'), concept('b', 't'), concept('c', 't'));
    expect(plan(cs, ['a', 'b', 'c'].map((id, t) => attempt(id, { t })), [tree('T', 't')], p).create).toEqual([]);
  });
});

describe('applyPlan / runPlanner', () => {
  const cs = graph(concept('s', null, 'subject'), concept('t', 's', 'topic', 'Topic'), concept('c', 't'));

  it('derives tree ids from the root, assigns the grove and is idempotent', () => {
    const p = { create: [{ rootConceptId: 't', title: 'Topic' }], remove: [] };
    const once = applyPlan([], p, cs, at(1));
    expect(once).toEqual([{ id: 't:t', rootConceptId: 't', title: 'Topic', groveId: 's', splitFrom: undefined, createdAt: at(1), updatedAt: at(1) }]);
    expect(applyPlan(once, p, cs, at(2))).toEqual(once);
  });

  it('settles: running the planner twice changes nothing more', () => {
    const domain = { concepts: cs, attempts: [attempt('c')], trees: [] as KnowledgeTree[] };
    const trees = runPlanner(new HeuristicPlanner(), domain, at(1));
    expect(runPlanner(new HeuristicPlanner(), { ...domain, trees }, at(2))).toBe(trees);
  });
});
