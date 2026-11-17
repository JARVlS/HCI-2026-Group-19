import { describe, expect, it } from 'vitest';
import { demoFixture } from './scripted/fixture';
import { chooseProvider, createProvider } from './providers';

describe('provider choice', () => {
  it('the URL parameter beats the saved setting, which beats the build default', () => {
    expect(chooseProvider({ url: 'arbor', saved: 'scripted', build: 'scripted' })).toBe('arbor');
    expect(chooseProvider({ url: null, saved: 'arbor', build: 'scripted' })).toBe('arbor');
    expect(chooseProvider({ url: null, saved: null, build: 'arbor' })).toBe('arbor');
    expect(chooseProvider({ url: 'scripted', saved: 'arbor', build: 'arbor' })).toBe('scripted');
  });

  it('unknown or missing values count as unset; nothing set means the scripted demo', () => {
    expect(chooseProvider({ url: 'claude', saved: 'gpt', build: 'arbor' })).toBe('arbor');
    expect(chooseProvider({})).toBe('scripted');
    expect(chooseProvider({ build: '' })).toBe('scripted');
  });

  it('creates the chosen provider', () => {
    expect(createProvider('scripted').kind).toBe('scripted');
    expect(createProvider('arbor').kind).toBe('arbor');
  });
});

describe('where a live provider starts', () => {
  it('a new, untitled chat without subject or messages, next to the demo forest', () => {
    const scripted = demoFixture();
    const f = demoFixture({ fresh: true });
    const chat = f.conversations[f.activeConversationId];
    expect(chat).toMatchObject({ title: 'New chat', subjectId: null, studyMode: false });
    expect(f.messagesByConv[f.activeConversationId]).toEqual([]);
    expect(f.conversations[scripted.activeConversationId]).toBeUndefined();
    expect(f.demoPrompts).toEqual([]);
    // The past trees stay; the scripted chat's tree does not.
    expect(f.trees.map((t) => t.id)).toEqual(scripted.trees.slice(1).map((t) => t.id));
  });
});
