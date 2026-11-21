import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageEvent } from './events';
import { IDLE_MS, MAX_ERRORS, RESIZE_MS, watchUsage } from './pageEvents';

/** The usage log's window-level events: visibility, online/offline, resize, errors, idle time. */

function setup() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const events: UsageEvent[] = [];
  const size = { width: 1400, height: 900 };
  const stop = watchUsage({ win, doc }, (e) => events.push(e), () => size);
  const fire = (target: EventTarget, type: string, extra: object = {}) => target.dispatchEvent(Object.assign(new Event(type), extra));
  const show = (state: 'hidden' | 'visible') => {
    doc.visibilityState = state;
    fire(doc, 'visibilitychange');
  };
  const types = () => events.map((e) => e.type);
  return { win, doc, events, size, stop, fire, show, types };
}

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-21T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('window-level usage events', () => {
  it('hidden and visible, online and offline', () => {
    const t = setup();
    t.show('hidden');
    t.show('visible');
    t.fire(t.win, 'offline');
    t.fire(t.win, 'online');
    expect(t.types()).toEqual(['page_hidden', 'page_visible', 'offline', 'online']);
  });

  it(`resize: once, with the size it settled on, ${RESIZE_MS} ms after the last change`, async () => {
    const t = setup();
    t.fire(t.win, 'resize');
    await wait(RESIZE_MS - 100);
    t.size.width = 600;
    t.fire(t.win, 'resize');
    await wait(RESIZE_MS - 1);
    expect(t.events).toEqual([]);
    await wait(1);
    expect(t.events).toEqual([{ type: 'resize', payload: { width: 600, height: 900 } }]);
  });

  it(`errors and rejected promises: the message cut to 500 characters, at most ${MAX_ERRORS} per visit`, () => {
    const t = setup();
    t.fire(t.win, 'error', { message: 'x'.repeat(700), filename: 'http://localhost:5173/src/lib/app.ts', lineno: 12 });
    t.fire(t.win, 'unhandledrejection', { reason: new Error('boom') });
    t.fire(t.win, 'unhandledrejection', { reason: 'plain' });
    expect(t.events).toEqual([
      { type: 'client_error', payload: { message: 'x'.repeat(500), source: 'http://localhost:5173/src/lib/app.ts', line: 12 } },
      { type: 'client_error', payload: { message: 'boom', source: 'promise', line: null } },
      { type: 'client_error', payload: { message: 'plain', source: 'promise', line: null } },
    ]);
    for (let i = 0; i < 20; i++) t.fire(t.win, 'error', { message: 'again' });
    expect(t.types().filter((x) => x === 'client_error')).toHaveLength(MAX_ERRORS);
  });

  it(`idle: no input for ${IDLE_MS / 1000} s starts it, the next input ends it with the whole quiet time`, async () => {
    const t = setup();
    await wait(30_000);
    t.fire(t.win, 'pointermove');
    await wait(IDLE_MS - 1);
    expect(t.events).toEqual([]); // the input reset the clock
    await wait(1);
    expect(t.types()).toEqual(['idle_start']);
    await wait(40_000);
    t.fire(t.win, 'keydown');
    t.fire(t.win, 'wheel'); // already active again: nothing
    expect(t.events.at(-1)).toEqual({ type: 'idle_end', payload: { ms: IDLE_MS + 40_000 } });
    expect(t.types()).toEqual(['idle_start', 'idle_end']);
    await wait(IDLE_MS);
    expect(t.types()).toEqual(['idle_start', 'idle_end', 'idle_start']);
  });

  it('a hidden page is never idle; hiding ends an idle stretch', async () => {
    const t = setup();
    await wait(IDLE_MS);
    t.show('hidden');
    expect(t.types()).toEqual(['idle_start', 'idle_end', 'page_hidden']);
    await wait(5 * IDLE_MS);
    expect(t.types()).toEqual(['idle_start', 'idle_end', 'page_hidden']);
    t.show('visible');
    await wait(IDLE_MS);
    expect(t.types()).toEqual(['idle_start', 'idle_end', 'page_hidden', 'page_visible', 'idle_start']);
  });

  it('the cleanup removes every listener and timer', async () => {
    const t = setup();
    t.stop();
    t.show('hidden');
    t.fire(t.win, 'resize');
    t.fire(t.win, 'error', { message: 'x' });
    await wait(10 * IDLE_MS);
    expect(t.events).toEqual([]);
  });
});
