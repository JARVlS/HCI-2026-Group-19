import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeBackend, json } from '../test/backend';
import { memoryStorage } from '../test/storage';
import { ACCOUNT_KEY, accountError, checkCredentials, continueAsGuest, logIn, logOut, readAccount, signUp } from './account';
import { ApiError } from './api';
import { SESSION_KEY } from './session';
import { SYNC_KEY } from './sync';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const creds = { username: 'leon', password: 'correct horse' };
const answer = (token: string) => json({ userId: token.split('.')[0], token, username: 'leon', participantId: null, condition: null });

describe('account', () => {
  it('a first visit has no account (the welcome screen shows)', () => {
    expect(readAccount(memoryStorage())).toBeNull();
  });

  it('a visitor from before accounts, with a session token, is a guest', () => {
    expect(readAccount(memoryStorage({ [SESSION_KEY]: 'u1.sig' }))).toEqual({ kind: 'guest' });
  });

  it('continue as guest is remembered', () => {
    const s = memoryStorage();
    continueAsGuest(s);
    expect(readAccount(s)).toEqual({ kind: 'guest' });
  });

  it('an unreadable saved account falls back to the token', () => {
    expect(readAccount(memoryStorage({ [ACCOUNT_KEY]: '{oops' }))).toBeNull();
    expect(readAccount(memoryStorage({ [ACCOUNT_KEY]: '{"kind":"admin"}', [SESSION_KEY]: 't' }))).toEqual({ kind: 'guest' });
  });

  it('sign up as a guest sends the guest token and keeps it', async () => {
    const calls = fakeBackend(() => answer('u1.sig'));
    const s = memoryStorage({ [SESSION_KEY]: 'u1.sig', [SYNC_KEY]: '{"rows":[1]}' });
    const r = await signUp(s, creds);
    expect(calls).toMatchObject([{ path: '/api/auth/signup', auth: 'Bearer u1.sig', body: creds }]);
    expect(r).toEqual({ account: { kind: 'account', username: 'leon' }, switched: false });
    expect(readAccount(s)).toEqual({ kind: 'account', username: 'leon' });
    expect(s.getItem(SYNC_KEY)).toBe('{"rows":[1]}'); // same user: its queued rows still belong to it
  });

  it('sign up on a first visit sends no token and stores the new one', async () => {
    const calls = fakeBackend(() => answer('u2.sig'));
    const s = memoryStorage();
    expect((await signUp(s, creds)).switched).toBe(true);
    expect(calls[0].auth).toBeNull();
    expect(s.getItem(SESSION_KEY)).toBe('u2.sig');
  });

  it('log in switches the token and drops the old user’s queued rows', async () => {
    fakeBackend(() => answer('u3.sig'));
    const s = memoryStorage({ [SESSION_KEY]: 'guest.sig', [SYNC_KEY]: '{"rows":[1]}' });
    const r = await logIn(s, creds);
    expect(r.switched).toBe(true);
    expect(s.getItem(SESSION_KEY)).toBe('u3.sig');
    expect(s.getItem(SYNC_KEY)).toBeNull();
  });

  it('a failed log in changes nothing', async () => {
    fakeBackend(() => apiError(401, 'invalid_credentials', 'Wrong username or password.'));
    const s = memoryStorage({ [SESSION_KEY]: 'guest.sig' });
    await expect(logIn(s, creds)).rejects.toBeInstanceOf(ApiError);
    expect(s.getItem(SESSION_KEY)).toBe('guest.sig');
    expect(s.getItem(ACCOUNT_KEY)).toBeNull();
  });

  it('log out forgets token, account and queue', () => {
    const s = memoryStorage({ [SESSION_KEY]: 't', [ACCOUNT_KEY]: '{"kind":"guest"}', [SYNC_KEY]: '{}' });
    logOut(s);
    expect(readAccount(s)).toBeNull();
    expect(s.getItem(SYNC_KEY)).toBeNull();
  });

  it('checks credentials like the backend, in plain words', () => {
    expect(checkCredentials(creds)).toBeNull();
    expect(checkCredentials({ username: 'a.b+c@uni.ch', password: '12345678' })).toBeNull();
    expect(checkCredentials({ username: 'ab', password: '12345678' })).toMatch(/at least 3/);
    expect(checkCredentials({ username: 'has space', password: '12345678' })).toMatch(/letters, digits/);
    expect(checkCredentials({ username: 'leon', password: 'short' })).toMatch(/at least 8/);
  });

  it('maps backend errors to the form’s words', () => {
    expect(accountError(new ApiError(401, 'invalid_credentials', 'x'))).toBe('wrong username or password');
    expect(accountError(new ApiError(409, 'username_taken', 'x'))).toBe('that username is taken');
    expect(accountError(new ApiError(404, 'not_found', 'Not Found'))).toMatch(/not on the backend yet/);
    expect(accountError(new ApiError(0, 'network', 'x'))).toMatch(/could not reach/);
  });
});
