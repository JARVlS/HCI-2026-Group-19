import { describe, expect, it } from 'vitest';
import { at, attempt, concept, graph, tree } from '../test/build';
import { conversationsOfTree, liveAttempts, refsOfConcept, treeOfConcept, treesOfConversation } from './links';

const concepts = graph(
  concept('ra', null, 'topic'),
  concept('a1', 'ra'),
  concept('a2', 'ra'),
  concept('rb', null, 'topic'),
  concept('b1', 'rb'),
  concept('loose', null),
);
const trees = [tree('A', 'ra'), tree('B', 'rb')];
const membership = treeOfConcept(trees, concepts);

const attempts = [
  attempt('a1', { conv: 'c1', msg: 'm1', t: 1 }),
  attempt('b1', { conv: 'c1', msg: 'm2', t: 2 }),
  attempt('a1', { conv: 'c2', msg: 'm3', t: 3 }),
  attempt('a2', { conv: 'c2', msg: 'm3', t: 3 }),
  { ...attempt('a1', { conv: 'c3', msg: 'm4', t: 4 }), supersededBy: 'gone' },
];

describe('treeOfConcept', () => {
  it('maps a concept to the nearest tree root above it (or itself)', () => {
    expect(Object.fromEntries(membership)).toEqual({ ra: 'A', a1: 'A', a2: 'A', rb: 'B', b1: 'B' });
  });

  it('survives a cycle in parent ids', () => {
    const cyclic = graph(concept('x', 'y'), concept('y', 'x'));
    expect(treeOfConcept([], cyclic).size).toBe(0);
  });
});

describe('links between chats, trees and leaves', () => {
  it('refsOfConcept: one ref per message, oldest first, superseded attempts ignored', () => {
    expect(refsOfConcept('a1', attempts)).toEqual([
      { conversationId: 'c1', messageId: 'm1', at: at(1) },
      { conversationId: 'c2', messageId: 'm3', at: at(3) },
    ]);
  });

  it('conversationsOfTree: the chats a tree grew from, most recent first', () => {
    expect(conversationsOfTree('A', { attempts, membership })).toEqual([
      { conversationId: 'c2', lastAt: at(3), conceptIds: ['a1', 'a2'] },
      { conversationId: 'c1', lastAt: at(1), conceptIds: ['a1'] },
    ]);
  });

  it('treesOfConversation: the trees a chat grew, most recently touched first', () => {
    expect(treesOfConversation('c1', { attempts, membership })).toEqual(['B', 'A']);
    expect(treesOfConversation('c2', { attempts, membership })).toEqual(['A']);
    expect(treesOfConversation('nope', { attempts, membership })).toEqual([]);
  });

  it('liveAttempts drops superseded attempts and those on deleted concepts', () => {
    const deleted = { ...concepts, a2: { ...concepts.a2, deletedAt: at(5) } };
    expect(liveAttempts(attempts, deleted).map((a) => a.conceptId)).toEqual(['a1', 'b1', 'a1']);
  });
});
