import { describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from './own/setup';
import { OwnProvider } from './own/provider';
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

  it('own is a choice like the other two: in the URL, saved, or as the build default; ?demo=1 still wins', () => {
    expect(chooseProvider({ url: 'own', saved: 'arbor', build: 'scripted' })).toBe('own');
    expect(chooseProvider({ url: null, saved: 'own', build: 'scripted' })).toBe('own');
    expect(chooseProvider({ build: 'own' })).toBe('own');
    expect(chooseProvider({ url: 'arbor', saved: 'own' })).toBe('arbor');
    expect(chooseProvider({ demo: true, url: 'own', saved: 'own', build: 'own' })).toBe('scripted');
  });

  it('creates the chosen provider; own is the one passed in', () => {
    const own = new OwnProvider(() => ({ setup: DEFAULT_SETUP, keys: {} }));
    expect(createProvider('scripted', own).kind).toBe('scripted');
    expect(createProvider('arbor', own).kind).toBe('arbor');
    expect(createProvider('own', own)).toBe(own);
  });
});
