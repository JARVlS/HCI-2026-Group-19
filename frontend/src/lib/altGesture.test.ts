import { describe, expect, it } from 'vitest';
import { AltGesture, CHATS_WEDGE, OPEN_MS, OUTER_R, LONG_PRESS_MS, RING_MS, polar, ringAngle, wedgeAt, type Effect, type KeyLike, type Pt } from './altGesture';

/** A gesture with a fake clock: `tick(ms)` runs the timers that fall due. */
function setup(ring = 0) {
  let now = 1000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const effects: Effect[] = [];
  const g = new AltGesture({
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (h) => void timers.delete(h as number),
    emit: (e) => effects.push(e),
    fallbackCenter: () => ({ x: 500, y: 400 }),
    ringSize: () => ring,
  });
  const tick = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  const types = () => effects.map((e) => e.type);
  const last = <T extends Effect['type']>(t: T) => [...effects].reverse().find((e) => e.type === t) as Extract<Effect, { type: T }> | undefined;
  return { g, tick, effects, types, last };
}

const key = (k: string, mods: Partial<KeyLike> & { altGraph?: boolean } = {}): KeyLike => ({
  key: k,
  altKey: k === 'Alt' || Boolean(mods.altKey),
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  getModifierState: (m) => m === 'AltGraph' && Boolean(mods.altGraph),
  ...mods,
});
const ALT = key('Alt');
const C: Pt = { x: 300, y: 300 };
const toward = (wedge: number, r = 80): Pt => polar(C, wedge * 45, r);

describe('wedgeAt', () => {
  it('maps the eight directions, clockwise from up, with a dead zone', () => {
    expect(wedgeAt(C, { x: 300, y: 200 })).toBe(0);
    expect(wedgeAt(C, { x: 380, y: 220 })).toBe(1);
    expect(wedgeAt(C, { x: 400, y: 300 })).toBe(2);
    expect(wedgeAt(C, { x: 300, y: 400 })).toBe(4);
    expect(wedgeAt(C, { x: 200, y: 300 })).toBe(6);
    expect(wedgeAt(C, { x: 220, y: 220 })).toBe(7);
    expect(wedgeAt(C, { x: 310, y: 305 })).toBeNull();
  });
});

describe('AltGesture: opening and choosing', () => {
  it('hold Alt: the menu opens after OPEN_MS at the pointer; move, release: that wedge, Alt keyup prevented', () => {
    const { g, tick, types, last } = setup();
    g.pointermove(C);
    expect(g.keydown(ALT)).toBe(false);
    tick(OPEN_MS - 1);
    expect(types()).toEqual([]);
    tick(1);
    expect(last('open')).toEqual({ type: 'open', center: C, input: 'alt' });
    g.pointermove(toward(3));
    expect(last('hover')?.wedge).toBe(3);
    tick(400);
    expect(g.keyup(ALT)).toBe(true);
    expect(last('select')).toEqual({ type: 'select', wedge: 3, sub: null, via: 'radial', ms: OPEN_MS + 400 });
    expect(g.state).toBe('idle');
  });

  it('without a known pointer the menu opens at the fallback centre (the prompt or the viewport)', () => {
    const { g, tick, last } = setup();
    g.keydown(ALT);
    tick(OPEN_MS);
    expect(last('open')?.center).toEqual({ x: 500, y: 400 });
  });

  it('a pointer that left the window is unknown again', () => {
    const { g, tick, last } = setup();
    g.pointermove(C);
    g.pointerleave();
    g.keydown(ALT);
    tick(OPEN_MS);
    expect(last('open')?.center).toEqual({ x: 500, y: 400 });
  });

  it('release in the centre: cancelled, nothing chosen, keyup still prevented (the menu was drawn)', () => {
    const { g, tick, last, types } = setup();
    g.pointermove(C);
    g.keydown(ALT);
    tick(OPEN_MS + 100);
    g.pointermove({ x: C.x + 5, y: C.y });
    expect(g.keyup(ALT)).toBe(true);
    expect(types()).not.toContain('select');
    expect(last('cancel')).toMatchObject({ reason: 'centre', drawn: true });
  });

  it('expert flick: Alt + a quick move + release selects by direction and never draws the menu', () => {
    const { g, tick, types, last } = setup();
    g.pointermove(C);
    g.keydown(ALT);
    tick(60);
    g.pointermove(toward(5, 40));
    tick(40);
    expect(g.keyup(ALT)).toBe(true);
    expect(types()).toEqual(['select']);
    expect(last('select')).toMatchObject({ wedge: 5, via: 'radial_flick', ms: 100 });
  });

  it('a short wiggle is not a flick; a plain Alt tap does nothing and is not prevented', () => {
    const { g, tick, types } = setup();
    g.pointermove(C);
    g.keydown(ALT);
    g.pointermove({ x: C.x + 10, y: C.y });
    tick(50);
    expect(g.keyup(ALT)).toBe(false);
    expect(types()).toEqual([]);
  });

  it('keyboard: while open, arrows and 1–8 pick (prevented), Enter confirms, the later Alt keyup is prevented', () => {
    const { g, tick, last } = setup();
    g.keydown(ALT);
    tick(OPEN_MS);
    expect(g.keydown(key('ArrowLeft', { altKey: true }))).toBe(true);
    expect(last('hover')?.wedge).toBe(6);
    expect(g.keydown(key('4', { altKey: true }))).toBe(true);
    expect(last('hover')?.wedge).toBe(3);
    expect(g.keydown(key('Enter', { altKey: true }))).toBe(true);
    expect(last('select')).toMatchObject({ wedge: 3, via: 'radial' });
    expect(g.keyup(ALT)).toBe(true);
  });

  it('keyboard: arrow then release Alt goes there too', () => {
    const { g, tick, last } = setup();
    g.keydown(ALT);
    tick(OPEN_MS);
    g.keydown(key('ArrowDown', { altKey: true }));
    g.keyup(ALT);
    expect(last('select')?.wedge).toBe(4);
  });

  it('Esc while open cancels (prevented), and the Alt keyup after it is prevented', () => {
    const { g, tick, last } = setup();
    g.keydown(ALT);
    tick(OPEN_MS);
    expect(g.keydown(key('Escape', { altKey: true }))).toBe(true);
    expect(last('cancel')?.reason).toBe('escape');
    expect(g.keyup(ALT)).toBe(true);
  });

  it('a click on a wedge while Alt is held selects it', () => {
    const { g, tick, last } = setup();
    g.pointermove(C);
    g.keydown(ALT);
    tick(OPEN_MS);
    g.pointerdown(toward(2), false, false);
    expect(g.pointerup(toward(2))).toBe(true);
    expect(last('select')?.wedge).toBe(2);
  });
});

describe('AltGesture: never breaks typing', () => {
  it('AltGr is ignored (key AltGraph, modifier state AltGraph, Ctrl+Alt on Windows): @ { | [ type normally', () => {
    for (const altgr of [key('AltGraph'), key('Alt', { altGraph: true }), key('Alt', { ctrlKey: true })]) {
      const { g, tick, types } = setup();
      g.pointermove(C);
      expect(g.keydown(altgr)).toBe(false);
      for (const ch of ['@', '{', '|', '[', '\\', '#']) expect(g.keydown(key(ch, { altKey: true, ctrlKey: altgr.ctrlKey, altGraph: true }))).toBe(false);
      tick(1000);
      expect(g.keyup(altgr)).toBe(false);
      expect(types()).toEqual([]);
      expect(g.state).toBe('idle');
    }
  });

  it('Alt with Shift, Ctrl or Meta is a shortcut chord, not the menu', () => {
    for (const mods of [{ shiftKey: true }, { metaKey: true }]) {
      const { g, tick, types } = setup();
      g.keydown(key('Alt', mods));
      tick(1000);
      expect(types()).toEqual([]);
    }
  });

  it('Option+⌫, Option+←, Option+G (@ on a Swiss Mac), Alt+Tab: cancel the gesture, never prevented, nothing drawn', () => {
    for (const k of ['Backspace', 'ArrowLeft', 'g', 'Tab']) {
      const { g, tick, types } = setup();
      g.pointermove(C);
      g.keydown(ALT);
      tick(50);
      expect(g.keydown(key(k, { altKey: true }))).toBe(false);
      tick(1000);
      expect(types()).toEqual([]);
      expect(g.keyup(ALT)).toBe(false);
    }
  });

  it('holding Alt after a cancelling key does not re-arm on key repeat', () => {
    const { g, tick, types } = setup();
    g.keydown(ALT);
    g.keydown(key('Backspace', { altKey: true }));
    g.keydown(key('Alt', { repeat: true }));
    tick(1000);
    expect(types()).toEqual([]);
  });

  it('another key while the menu is open cancels it and keeps its meaning', () => {
    const { g, tick, last } = setup();
    g.keydown(ALT);
    tick(OPEN_MS);
    expect(g.keydown(key('Backspace', { altKey: true }))).toBe(false);
    expect(last('cancel')?.reason).toBe('key');
  });

  it('blur (Alt+Tab away) cancels, armed or open', () => {
    const a = setup();
    a.g.keydown(ALT);
    a.g.blur();
    a.tick(1000);
    expect(a.types()).toEqual([]);
    const b = setup();
    b.g.keydown(ALT);
    b.tick(OPEN_MS);
    b.g.blur();
    expect(b.last('cancel')?.reason).toBe('blur');
    expect(b.g.keyup(ALT)).toBe(false);
  });
});

describe('AltGesture: the chats ring', () => {
  it('resting on chats for RING_MS fans out the ring; moving out to a chat picks it', () => {
    const { g, tick, last } = setup(5);
    g.pointermove(C);
    g.keydown(ALT);
    tick(OPEN_MS);
    g.pointermove(toward(CHATS_WEDGE));
    expect(last('hover')?.ring).toBe(false);
    tick(RING_MS);
    expect(last('hover')).toMatchObject({ wedge: CHATS_WEDGE, ring: true });
    g.pointermove(polar(C, ringAngle(4, 5), OUTER_R));
    expect(last('hover')).toMatchObject({ wedge: CHATS_WEDGE, sub: 4 });
    g.keyup(ALT);
    expect(last('select')).toMatchObject({ wedge: CHATS_WEDGE, sub: 4 });
  });

  it('without resting, far out on chats is the chats wedge; going elsewhere folds the ring', () => {
    const { g, tick, last } = setup(5);
    g.pointermove(C);
    g.keydown(ALT);
    tick(OPEN_MS);
    g.pointermove(polar(C, 45, OUTER_R));
    expect(last('hover')).toMatchObject({ wedge: CHATS_WEDGE, sub: null });
    tick(RING_MS);
    g.pointermove(toward(4));
    expect(last('hover')).toMatchObject({ wedge: 4, ring: false });
    tick(RING_MS);
    expect(last('hover')?.ring).toBe(false);
  });

  it('no chats: no ring', () => {
    const { g, tick, last } = setup(0);
    g.pointermove(C);
    g.keydown(ALT);
    tick(OPEN_MS);
    g.pointermove(toward(CHATS_WEDGE));
    tick(RING_MS * 2);
    expect(last('hover')?.ring).toBe(false);
  });
});

describe('AltGesture: touch', () => {
  it('a long press on empty canvas opens a sticky menu; lifting keeps it; a tap on a wedge selects', () => {
    const { g, tick, last } = setup();
    g.pointerdown(C, true, true);
    tick(LONG_PRESS_MS);
    expect(last('open')).toEqual({ type: 'open', center: C, input: 'touch' });
    expect(g.pointerup(C)).toBe(true);
    expect(g.state).toBe('open');
    g.pointerdown(toward(7), true, false);
    g.pointerup(toward(7));
    expect(last('select')?.wedge).toBe(7);
  });

  it('a tap far outside closes it; a press that drifts or lifts early is no press; not on a button', () => {
    const a = setup();
    a.g.pointerdown(C, true, true);
    a.tick(LONG_PRESS_MS);
    a.g.pointerup(C);
    a.g.pointerdown({ x: 900, y: 900 }, true, false);
    a.g.pointerup({ x: 900, y: 900 });
    expect(a.last('cancel')?.reason).toBe('outside');

    const b = setup();
    b.g.pointerdown(C, true, true);
    b.g.pointermove({ x: C.x, y: C.y + 30 });
    b.tick(LONG_PRESS_MS);
    expect(b.types()).toEqual([]);

    const c = setup();
    c.g.pointerdown(C, true, true);
    c.tick(100);
    c.g.pointerup(C);
    c.tick(LONG_PRESS_MS);
    expect(c.types()).toEqual([]);

    const d = setup();
    d.g.pointerdown(C, true, false);
    d.tick(LONG_PRESS_MS);
    expect(d.types()).toEqual([]);
  });
});
