import { describe, expect, it } from 'vitest';
import { at } from '../test/build';
import { testStore } from '../test/harness';
import { latestConversation, NEW_CHAT_TITLE, newConversation, titleFrom } from './chats';
import type { Message } from './domain';

describe('chat titles', () => {
  it('come from the first message: one line, cut at a word boundary, no model call', () => {
    expect(titleFrom('  What is   recursion?\n')).toBe('What is recursion?');
    expect(titleFrom('Why do some vaccines need a booster shot after a few years, and others do not?')).toBe('Why do some vaccines need a booster shot after a…');
    expect(titleFrom('Supercalifragilisticexpialidocious'.repeat(3))).toHaveLength(49);
    expect(titleFrom('   ')).toBe(NEW_CHAT_TITLE);
  });

  it('a new chat takes its first message as its title; later messages and a name set with /title stay', async () => {
    const s = testStore({ fresh: true });
    const id = s.state.session.activeConversationId;
    await s.send('What is recursion, in plain words?');
    expect(s.state.domain.conversations[id].title).toBe('What is recursion, in plain words?');
    await s.send('And what is a base case?');
    expect(s.state.domain.conversations[id].title).toBe('What is recursion, in plain words?');

    const t = testStore({ fresh: true });
    const tid = t.state.session.activeConversationId;
    t.deps.dispatch({ type: 'conversationTitle', id: tid, title: 'my name', at: at(1) });
    await t.send('What is recursion?');
    expect(t.state.domain.conversations[tid].title).toBe('my name');
  });

  it('the demo chat keeps its scripted title', async () => {
    const s = testStore();
    const title = s.state.domain.conversations['c-nn'].title;
    await s.send('Write me a summary of backpropagation for my exam');
    expect(s.state.domain.conversations['c-nn'].title).toBe(title);
  });

  it('/title moves updatedAt forward only (last write wins on the server)', () => {
    const s = testStore({ fresh: true });
    const id = s.state.session.activeConversationId;
    const before = s.state.domain.conversations[id].updatedAt;
    s.deps.dispatch({ type: 'conversationTitle', id, title: 'x', at: '2000-01-01T00:00:00.000Z' });
    expect(s.state.domain.conversations[id]).toMatchObject({ title: 'x', updatedAt: before });
    s.deps.dispatch({ type: 'conversationTitle', id, title: 'y', at: '2030-01-01T00:00:00.000Z' });
    expect(s.state.domain.conversations[id].updatedAt).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('which chat opens, and empty chats', () => {
  it('the latest chat opens at start', () => {
    expect(latestConversation({})).toBeNull();
    const a = { ...newConversation('a', at(1)), updatedAt: at(5) };
    const b = newConversation('b', at(3));
    expect(latestConversation({ a, b })).toBe('a');
  });

  it('a chat left without a message is dropped; one with messages stays', async () => {
    const s = testStore({ fresh: true });
    const first = s.state.session.activeConversationId;
    s.deps.dispatch({ type: 'conversationNew', conversation: newConversation('second', at(2)) });
    expect(s.state.domain.conversations[first]).toBeUndefined();
    await s.send('What is recursion?');
    s.deps.dispatch({ type: 'conversationNew', conversation: newConversation('third', at(3)) });
    expect(Object.keys(s.state.domain.conversations).sort()).toEqual(['second', 'third']);
    expect(s.state.ui.view).toEqual({ kind: 'chat' });
  });

  it('loaded messages merge with what is here (this device wins)', () => {
    const s = testStore({ fresh: true });
    const id = s.state.session.activeConversationId;
    const mine: Message = { id: 'm1', role: 'user', text: 'mine', conceptIds: [], conversationId: id, createdAt: at(2) };
    s.deps.dispatch({ type: 'user', msg: mine });
    s.deps.dispatch({ type: 'messagesLoading', conversationId: id });
    expect(s.state.session.chatLoad[id]).toBe('loading');
    s.deps.dispatch({
      type: 'messagesLoaded',
      conversationId: id,
      messages: [
        { ...mine, text: 'old copy' },
        { id: 'm0', role: 'user', text: 'earlier', conceptIds: [], conversationId: id, createdAt: at(1) },
      ],
    });
    expect(s.messages().map((m) => m.text)).toEqual(['earlier', 'mine']);
    expect(s.state.session.chatLoad[id]).toBeUndefined();
  });
});
