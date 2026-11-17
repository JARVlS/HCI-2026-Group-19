import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { createSession, SESSION_KEY } from './session';

/** A Map behind the Storage methods the session uses. */
const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

/** A `create` that hands out token-1, token-2, … and counts its calls. */
const counter = () => {
  const c = { n: 0, create: async () => `token-${++c.n}` };
  return c;
};

const unauthorized = new ApiError(401, 'unauthorized', 'unknown token');

describe('session', () => {
  it('restores the saved token without creating a session', async () => {
    const c = counter();
    const s = createSession(c.create, memory({ [SESSION_KEY]: 'saved' }));
    expect(await s.run(async (t) => t)).toBe('saved');
    expect(c.n).toBe(0);
  });

  it('creates one session on first use, saves it and reuses it (also for parallel calls)', async () => {
    const c = counter();
    const store = memory();
    const s = createSession(c.create, store);
    expect(await Promise.all([s.run(async (t) => t), s.run(async (t) => t)])).toEqual(['token-1', 'token-1']);
    expect(await s.run(async (t) => t)).toBe('token-1');
    expect(c.n).toBe(1);
    expect(store.map.get(SESSION_KEY)).toBe('token-1');
  });

  it('after a 401 it gets a new session once and repeats the call', async () => {
    const c = counter();
    const store = memory({ [SESSION_KEY]: 'stale' });
    const s = createSession(c.create, store);
    const used: string[] = [];
    const result = await s.run(async (t) => {
      used.push(t);
      if (t === 'stale') throw unauthorized;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(used).toEqual(['stale', 'token-1']);
    expect(store.map.get(SESSION_KEY)).toBe('token-1');
  });

  it('a second 401 in a row is passed on, not retried forever', async () => {
    const c = counter();
    const s = createSession(c.create, memory());
    let calls = 0;
    await expect(
      s.run(async () => {
        calls++;
        throw unauthorized;
      }),
    ).rejects.toBe(unauthorized);
    expect(calls).toBe(2);
  });

  it('parallel calls that both get a 401 share one new session', async () => {
    const c = counter();
    const s = createSession(c.create, memory({ [SESSION_KEY]: 'stale' }));
    const call = async (t: string) => {
      await Promise.resolve();
      if (t === 'stale') throw unauthorized;
      return t;
    };
    expect(await Promise.all([s.run(call), s.run(call)])).toEqual(['token-1', 'token-1']);
    expect(c.n).toBe(1);
  });

  it('other errors are passed on as they are', async () => {
    const s = createSession(counter().create, memory({ [SESSION_KEY]: 't' }));
    const busy = new ApiError(429, 'budget_exceeded', 'used up');
    await expect(s.run(async () => Promise.reject(busy))).rejects.toBe(busy);
  });

  it('a failed create is not remembered: the next call tries again', async () => {
    let fail = true;
    const s = createSession(async () => {
      if (fail) throw new ApiError(0, 'network', 'offline');
      return 'fresh';
    }, memory());
    await expect(s.run(async (t) => t)).rejects.toMatchObject({ code: 'network' });
    fail = false;
    expect(await s.run(async (t) => t)).toBe('fresh');
  });

  it('works without storage (blocked localStorage): the token lives as long as the page', async () => {
    const c = counter();
    const s = createSession(c.create, null);
    expect(await s.run(async (t) => t)).toBe('token-1');
    expect(await s.run(async (t) => t)).toBe('token-1');
  });
});
