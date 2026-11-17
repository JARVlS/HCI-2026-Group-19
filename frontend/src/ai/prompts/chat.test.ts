import { describe, expect, it } from 'vitest';
import type { ChatRequest, TurnContext } from '../provider';
import { ACTIVE, BY_MODE, chatMessages, chatSystem, FORMAT, HINT, PLAIN, QUIZ_ANSWER, STUDY } from './chat';

const req = (text: string, ctx: Partial<TurnContext> = {}): ChatRequest => ({
  conversationId: 'c',
  messages: [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'Hello!' },
    { role: 'user', text },
  ],
  context: { mode: 'together', pendingQuiz: null, known: [], nudge: 'gentle', studyMode: false, ...ctx },
});

describe('chat prompt', () => {
  it('steers by who is thinking', () => {
    for (const mode of ['own', 'together', 'ai'] as const) {
      const system = chatSystem(req('What is entropy?', { mode }));
      expect(system).toContain(BY_MODE[mode]);
      for (const other of ['own', 'together', 'ai'] as const) if (other !== mode) expect(system).not.toContain(BY_MODE[other]);
    }
  });

  it('a hint request gets a hint only, whatever the mode', () => {
    const system = chatSystem(req('Give me a hint, not the full answer: how does entropy grow?', { mode: 'ai', nudge: 'active' }));
    expect(system).toContain(HINT);
    expect(system).not.toContain(BY_MODE.ai);
    expect(system).not.toContain(ACTIVE);
  });

  it('nudge level: off is the plain assistant, active adds a question back', () => {
    expect(chatSystem(req('What is entropy?', { nudge: 'off' }))).toContain(PLAIN);
    expect(chatSystem(req('What is entropy?', { nudge: 'off' }))).not.toContain(BY_MODE.together);
    expect(chatSystem(req('What is entropy?', { nudge: 'gentle' }))).not.toContain(ACTIVE);
    expect(chatSystem(req('What is entropy?', { nudge: 'active' }))).toContain(ACTIVE);
  });

  it('study mode asks for checks of understanding', () => {
    expect(chatSystem(req('What is entropy?', { studyMode: true }))).toContain(STUDY);
    expect(chatSystem(req('What is entropy?'))).not.toContain(STUDY);
  });

  it('an answer to a pending quiz question gets feedback, a new request does not', () => {
    expect(chatSystem(req('It measures disorder', { pendingQuiz: 'entropy' }))).toContain(QUIZ_ANSWER);
    expect(chatSystem(req('Quiz me on enthalpy', { pendingQuiz: 'entropy' }))).not.toContain(QUIZ_ANSWER);
  });

  it('always states length and the markdown the chat can show', () => {
    const system = chatSystem(req('What is entropy?'));
    expect(system).toContain('under 120 words');
    expect(system).toContain(FORMAT);
    expect(FORMAT).toMatch(/No headings, tables, numbered lists, code blocks or LaTeX/);
  });

  it('sends the transcript without empty messages', () => {
    const r = req('What is entropy?');
    r.messages.splice(1, 0, { role: 'assistant', text: '  ' });
    expect(chatMessages(r)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'What is entropy?' },
    ]);
  });
});
