import { describe, expect, it } from 'vitest';
import { chooseProvider, createProvider } from './providers';

describe('provider choice', () => {
  it('the URL parameter beats the saved setting, which beats the build default', () => {
    expect(chooseProvider({ url: 'arbor', saved: 'scripted', build: 'scripted' })).toBe('arbor');
    expect(chooseProvider({ url: null, saved: 'arbor', build: 'scripted' })).toBe('arbor');
    expect(chooseProvider({ url: null, saved: null, build: 'arbor' })).toBe('arbor');
    expect(chooseProvider({ url: 'scripted', saved: 'arbor', build: 'arbor' })).toBe('scripted');
  });

  it('?demo=1 forces the scripted demo, whatever the URL, the saved choice or the build say', () => {
    expect(chooseProvider({ demo: true, url: 'arbor', saved: 'arbor', build: 'arbor' })).toBe('scripted');
    expect(chooseProvider({ demo: false, url: null, saved: 'arbor' })).toBe('arbor');
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
