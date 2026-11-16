import { describe, expect, it } from 'vitest';
import { at, attempt, concept, graph, tree } from '../test/build';
import type { ConceptEdge } from './domain';
import { crossRoots, projectForest, projectTree } from './project';

//  s (subject)
//  └ r (tree root)
//    ├ b1: c1, c2 ── c2a (grandchild, flattened onto b1)
//    ├ b2: c3
//    └ side (hangs on the root → "Side questions")
const concepts = graph(
  concept('s', null, 'subject'),
  concept('r', 's', 'topic', 'Root'),
  concept('b1', 'r', 'topic', 'Branch one'),
  concept('b2', 'r', 'topic', 'Branch two'),
  concept('c1', 'b1'),
  concept('c2', 'b1'),
  concept('c2a', 'c2'),
  concept('c3', 'b2'),
  concept('side', 'r'),
);
const t = tree('T', 'r', { title: 'My tree', groveId: 's', updatedAt: at(0) });

const leaves = (d: ReturnType<typeof projectTree>) => d.branches.map((b) => [b.id, b.leaves.map((l) => l.id)]);

describe('projectTree', () => {
  it('groups attempted descendants by branch, in the order they came up', () => {
    const d = projectTree(t, concepts, [
      attempt('c3', { t: 1 }),
      attempt('c1', { t: 2 }),
      attempt('side', { t: 3 }),
      attempt('c2a', { t: 4 }),
    ]);
    expect(leaves(d)).toEqual([
      ['b2', ['c3']],
      ['b1', ['c1', 'c2a']],
      ['other', ['side']],
    ]);
    expect(d.branches.map((b) => b.label)).toEqual(['Branch two', 'Branch one', 'Side questions']);
    expect(d).toMatchObject({ id: 'T', title: 'My tree', grove: 's' });
  });

  it('does not show unattempted concepts', () => {
    expect(projectTree(t, concepts, []).branches).toEqual([]);
  });

  it('scores a leaf by its best attempt and counts distinct messages', () => {
    const d = projectTree(t, concepts, [
      attempt('c1', { mode: 'ai', msg: 'm1', t: 1 }),
      attempt('c1', { mode: 'together', msg: 'm2', t: 2 }),
      attempt('c1', { mode: 'together', msg: 'm2', t: 2 }),
    ]);
    const [leaf] = d.branches[0].leaves;
    expect(leaf.score).toBe(0.5);
    expect(leaf.count).toBe(2);
    expect(leaf.refs?.map((r) => r.messageId)).toEqual(['m1', 'm2']);
  });

  it('ignores superseded attempts and deleted concepts', () => {
    const old = { ...attempt('c1', { mode: 'own', t: 1 }), supersededBy: 'x' };
    const d = projectTree(t, { ...concepts, c3: { ...concepts.c3, deletedAt: at(9) } }, [old, attempt('c1', { mode: 'ai', t: 1, id: 'x' }), attempt('c3', { t: 2 })]);
    expect(leaves(d)).toEqual([['b1', ['c1']]]);
    expect(d.branches[0].leaves[0].score).toBe(0);
  });

  it('marks leaves touched in the active chat and points messageId into it', () => {
    const d = projectTree(
      t,
      concepts,
      [attempt('c1', { conv: 'here', msg: 'h1', t: 1 }), attempt('c1', { conv: 'there', msg: 'x1', t: 2 }), attempt('c3', { conv: 'there', msg: 'x2', t: 3 })],
      { conversationId: 'here' },
    );
    const [c1, c3] = d.branches.flatMap((b) => b.leaves);
    expect(c1).toMatchObject({ here: true, messageId: 'h1' });
    expect(c3.here).toBeUndefined();
    expect(c3.messageId).toBe('x2');
  });

  it('a branch node with attempted children is not also a leaf', () => {
    const d = projectTree(t, concepts, [attempt('b1', { t: 1 }), attempt('c1', { t: 2 })]);
    expect(leaves(d)).toEqual([['b1', ['c1']]]);
  });

  it('updatedAt follows the latest attempt', () => {
    expect(projectTree(t, concepts, [attempt('c1', { t: 30 })]).updatedAt).toBe(at(30));
  });

  it('stops at the root of another tree (a split keeps its leaves out of the parent)', () => {
    const split = tree('T2', 'b1');
    const forest = projectForest([t, split], concepts, [attempt('c1', { t: 1 }), attempt('c3', { t: 2 })]);
    expect(forest.map(leaves)).toEqual([[['b2', ['c3']]], [['other', ['c1']]]]);
  });
});

describe('crossRoots', () => {
  //  two trees with a related edge between x (in A) and y (in B), a third tree C split from A
  const cs = graph(concept('ra', null, 'topic'), concept('x', 'ra', 'concept', 'Shared'), concept('rb', null, 'topic'), concept('y', 'rb', 'concept', 'Shared too'), concept('rc', null, 'topic'), concept('z', 'rc'));
  const trees = [tree('A', 'ra', { title: 'Tree A' }), tree('B', 'rb', { title: 'Tree B' }), tree('C', 'rc', { title: 'Tree C', splitFrom: 'A' })];
  const edges: ConceptEdge[] = [{ id: 'e', fromId: 'x', toId: 'y', kind: 'related', createdAt: at(0) }];

  it('draws an edge between leaves of different trees, labelled from each side', () => {
    const attempts = [attempt('x', { conv: 'c1', t: 1 }), attempt('y', { conv: 'c2', t: 2 })];
    const roots = crossRoots(projectForest(trees, cs, attempts), edges, trees, attempts);
    expect(roots.get('A')!.get('B')).toEqual([{ label: 'Shared', kind: 'edge', fromLeafId: 'x', toLeafId: 'y' }]);
    expect(roots.get('B')!.get('A')).toEqual([{ label: 'Shared too', kind: 'edge', fromLeafId: 'y', toLeafId: 'x' }]);
  });

  it('only connects leaves that exist (attempted)', () => {
    const attempts = [attempt('x', { t: 1 })];
    const roots = crossRoots(projectForest(trees, cs, attempts), edges, trees, attempts);
    expect(roots.get('A')!.has('B')).toBe(false);
  });

  it('adds split provenance and chats that grew both trees', () => {
    const attempts = [attempt('x', { conv: 'both', t: 1 }), attempt('z', { conv: 'both', t: 2 })];
    const roots = crossRoots(projectForest(trees, cs, attempts), [], trees, attempts, {
      both: { id: 'both', title: 'One chat', subjectId: null, studyMode: false, createdAt: at(0), updatedAt: at(0) },
    });
    expect(roots.get('C')!.get('A')).toEqual([
      { label: 'Tree C', kind: 'split' },
      { label: 'One chat', kind: 'chat' },
    ]);
    expect(roots.get('A')!.get('C')!.map((r) => r.kind)).toEqual(['split', 'chat']);
  });
});
