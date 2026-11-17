import { describe, expect, it } from 'vitest';
import { at, attempt, concept, tree } from '../test/build';
import type { Conversation, Message } from './domain';
import { mergeMessages } from './chats';
import { domainOf, type ServerState } from './live';

const chat = (id: string, title = id): Conversation => ({ id, title, subjectId: null, studyMode: false, createdAt: at(0), updatedAt: at(0) });
const msg = (id: string, createdAt: string, text = id): Message => ({ id, role: 'user', text, conceptIds: [], conversationId: 'c1', createdAt });

describe('domainOf: what loads, with the queued rows on top', () => {
  const server: ServerState = {
    concepts: [concept('s', null, 'subject'), concept('k', 's')],
    edges: [],
    trees: [tree('t-old', 's'), tree('t-keep', 'k')],
    conversations: [chat('c1', 'from the server')],
    attempts: [attempt('k', { id: 'a1', conv: 'c1' })],
  };

  it('without a queue it is the server state, normalized (records by id, no messages yet)', () => {
    const d = domainOf(server, []);
    expect(Object.keys(d.concepts)).toEqual(['s', 'k']);
    expect(d.conversations.c1.title).toBe('from the server');
    expect(d.messagesByConv).toEqual({});
    expect(d.trees.map((t) => t.id)).toEqual(['t-old', 't-keep']);
  });

  it('queued rows are newer: they replace, add, and a queued tree deletion removes the tree', () => {
    const relabelled = { ...concept('k', 's'), label: 'renamed', updatedAt: at(5) };
    const superseded = { ...attempt('k', { id: 'a1', conv: 'c1' }), supersededBy: 'a1~own' };
    const d = domainOf(server, [
      { kind: 'concepts', data: relabelled },
      { kind: 'concepts', data: concept('new', 's') },
      { kind: 'conversations', data: chat('c1', 'renamed offline') },
      { kind: 'conversations', data: chat('c2') },
      { kind: 'attempts', data: superseded },
      { kind: 'attempts', data: { ...superseded, id: 'a1~own', supersededBy: undefined, mode: 'own' } },
      { kind: 'trees', data: { ...tree('t-old', 's'), deletedAt: at(6), updatedAt: at(6) } },
      { kind: 'trees', data: tree('t-new', 'new') },
      { kind: 'edges', data: { id: 'e1', fromId: 'k', toId: 'new', kind: 'related', createdAt: at(1) } },
      { kind: 'messages', data: msg('m1', at(1)) },
    ]);
    expect(d.concepts.k.label).toBe('renamed');
    expect(d.concepts.new).toBeDefined();
    expect(d.conversations.c1.title).toBe('renamed offline');
    expect(Object.keys(d.conversations)).toEqual(['c1', 'c2']);
    expect(d.attempts.map((a) => [a.id, a.supersededBy ?? null])).toEqual([
      ['a1', 'a1~own'],
      ['a1~own', null],
    ]);
    expect(d.trees.map((t) => t.id)).toEqual(['t-keep', 't-new']);
    expect(d.trees.every((t) => !('deletedAt' in t))).toBe(true);
    expect(d.edges.map((e) => e.id)).toEqual(['e1']);
    // Messages wait for their chat to be opened.
    expect(d.messagesByConv).toEqual({});
  });
});

describe('mergeMessages', () => {
  it('by id, the second list wins, oldest first', () => {
    const loaded = [msg('m1', at(1)), msg('m3', at(3))];
    const mine = [msg('m3', at(3), 'edited here'), msg('m2', at(2))];
    expect(mergeMessages(loaded, mine).map((m) => [m.id, m.text])).toEqual([
      ['m1', 'm1'],
      ['m2', 'm2'],
      ['m3', 'edited here'],
    ]);
    expect(mergeMessages(loaded, [])).toBe(loaded);
  });
});
