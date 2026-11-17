import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../test/storage';
import { createKeyStore, KEYS_KEY } from './keys';

const stores = () => ({ session: memoryStorage(), local: memoryStorage() });

describe('own-model keys', () => {
  it('are kept in sessionStorage by default, never in localStorage', () => {
    const s = stores();
    const keys = createKeyStore(s);
    keys.setKey('chat', '  sk-1  ');
    expect(keys.snapshot()).toEqual({ keys: { chat: 'sk-1' }, remember: false });
    expect(JSON.parse(s.session.getItem(KEYS_KEY)!)).toEqual({ chat: 'sk-1' });
    expect(s.local.getItem(KEYS_KEY)).toBeNull();
  });

  it('"remember on this device" moves them to localStorage, and unticking moves them back', () => {
    const s = stores();
    const keys = createKeyStore(s);
    keys.setKey('scores', 'sk-2');
    keys.setRemember(true);
    expect(JSON.parse(s.local.getItem(KEYS_KEY)!)).toEqual({ scores: 'sk-2' });
    expect(s.session.getItem(KEYS_KEY)).toBeNull();
    // A reload (a new store over the same storages) finds them remembered.
    expect(createKeyStore(s).snapshot()).toEqual({ keys: { scores: 'sk-2' }, remember: true });
    keys.setRemember(false);
    expect(s.local.getItem(KEYS_KEY)).toBeNull();
    expect(createKeyStore(s).snapshot()).toEqual({ keys: { scores: 'sk-2' }, remember: false });
  });

  it('a tab closed without remember: a new tab (empty sessionStorage) has no keys', () => {
    const s = stores();
    createKeyStore(s).setKey('chat', 'sk-1');
    expect(createKeyStore({ session: memoryStorage(), local: s.local }).snapshot()).toEqual({ keys: {}, remember: false });
  });

  it('an empty key removes it; the snapshot changes only on a change; listeners hear every change', () => {
    const keys = createKeyStore(stores());
    let heard = 0;
    keys.subscribe(() => heard++);
    keys.setKey('chat', 'sk-1');
    const snap = keys.snapshot();
    expect(keys.snapshot()).toBe(snap);
    keys.setKey('chat', '');
    expect(keys.snapshot().keys).toEqual({});
    keys.setRemember(false); // no change
    expect(heard).toBe(2);
  });

  it('blocked storage: the keys live as long as the page', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } };
    const keys = createKeyStore({ session: broken, local: broken });
    keys.setKey('chat', 'sk-1');
    expect(keys.snapshot().keys).toEqual({ chat: 'sk-1' });
  });
});
