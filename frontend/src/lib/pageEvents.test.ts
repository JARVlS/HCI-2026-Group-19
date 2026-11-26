import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageEvent } from './events';
import { CLICK_CHAIN_MS, IDLE_MS, MAX_ERRORS, RESIZE_MS, watchUsage } from './pageEvents';

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

describe('clicks', () => {
  function clicks() {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const events: UsageEvent[] = [];
    const ctx = { view: 'chat' as const, panel: true };
    const stop = watchUsage({ win, doc }, (e) => events.push(e), () => ({ width: 1400, height: 900 }), {
      locate: (_t, x, y) => ({ region: 'pane', target: 'button.a-btn', rx: x / 1000, ry: y / 1000 }),
      context: () => ctx,
    });
    const press = (x: number, y: number, extra: object = {}) =>
      win.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, ...extra }));
    const payloads = () => events.filter((e) => e.type === 'click').map((e) => e.payload as Record<string, unknown>);
    return { win, events, stop, press, payloads };
  }

  it('a press: where, in which part, on what, in which view, and nothing before it', () => {
    const t = clicks();
    t.press(100.4, 200.6);
    expect(t.payloads()).toEqual([
      { x: 100, y: 201, width: 1400, height: 900, region: 'pane', target: 'button.a-btn', rx: 0.1004, ry: 0.2006, view: 'chat', panel: true, pointer: 'mouse', sincePrev: null, typed: false },
    ]);
  });

  it(`sincePrev: ms since the previous click, null past ${CLICK_CHAIN_MS / 1000} s`, async () => {
    const t = clicks();
    t.press(1, 1);
    await wait(1200);
    t.press(2, 2);
    await wait(CLICK_CHAIN_MS);
    t.press(3, 3);
    await wait(CLICK_CHAIN_MS + 1);
    t.press(4, 4);
    expect(t.payloads().map((p) => p.sincePrev)).toEqual([null, 1200, CLICK_CHAIN_MS, null]);
  });

  it('typed: a key between two clicks, reset by each click', () => {
    const t = clicks();
    t.press(1, 1);
    t.win.dispatchEvent(new Event('keydown'));
    t.press(2, 2);
    t.press(3, 3);
    expect(t.payloads().map((p) => p.typed)).toEqual([false, true, false]);
  });

  it('touch counts; other buttons and secondary pointers do not', () => {
    const t = clicks();
    t.press(1, 1, { pointerType: 'touch' });
    t.press(2, 2, { button: 2 });
    t.press(3, 3, { isPrimary: false });
    expect(t.payloads().map((p) => p.pointer)).toEqual(['touch']);
  });

  it('without the click options nothing is logged, and the cleanup stops it', () => {
    const plain = setup();
    plain.win.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, clientX: 1, clientY: 1 }));
    expect(plain.events.filter((e) => e.type === 'click')).toEqual([]);
    const t = clicks();
    t.stop();
    t.press(1, 1);
    expect(t.payloads()).toEqual([]);
  });
});
