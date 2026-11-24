/**
 * The radial menu's gesture (IMPLEMENTATION_PLAN.md ADR-13, M2b): a marking menu on the Alt/Option
 * key (Kurtenbach & Buxton). Pure: it gets key, pointer and focus events plus a clock, and says what
 * happened through `emit` and whether the browser's default action must be prevented. The React
 * binding is `designs/ascii/useAltGesture.ts`; the drawing is `designs/ascii/Radial.tsx`.
 *
 *   hold Alt ≥ OPEN_MS, no other key   → the menu opens, centred on the pointer
 *   move toward a wedge, release Alt   → go there
 *   Alt + quick flick + release        → go there without the menu ever being drawn (experts)
 *   release in the centre, esc         → nothing happens
 *
 * It must never break typing:
 *   - AltGr is ignored (Swiss and German layouts type @ # [ ] { } \ | with it): the key `AltGraph`,
 *     the modifier state `AltGraph`, and Ctrl+Alt (how Windows reports AltGr).
 *   - Any other key while Alt is held (Option+⌫, Option+←, Option+G = @ on a Swiss Mac, Alt+Tab)
 *     cancels the gesture and keeps its normal meaning: it is never prevented. Only once the menu is
 *     drawn do arrows, 1–8, Enter and Esc belong to it.
 *   - Losing focus cancels. The Alt keyup is prevented only when the gesture was used (so Firefox on
 *     Windows/Linux does not focus its menu bar), never for a plain Alt tap.
 * Touch has no Alt key: a long press on empty canvas opens the same menu, and it stays open until a tap.
 */

export const OPEN_MS = 180;
export const RING_MS = 300;
export const LONG_PRESS_MS = 500;
/** Pointer travel (px) before the menu is drawn that counts as a flick. */
export const FLICK_PX = 24;
/** Around the centre nothing is chosen (px); drawn as the hub. */
export const DEAD_ZONE = 40;
/** A long press that drifts further is a scroll or a drag, not a press (px). */
export const PRESS_DRIFT = 10;
/** The slices run from the hub (`DEAD_ZONE`) out to this radius (px). Direction alone chooses, so pointing past them still counts. */
export const SLICE_R = 170;
/** Where the second ring's chats sit, and from how far out one is chosen (px): beyond the slices. */
export const OUTER_R = 222;
export const OUTER_PICK = 182;
/** A tap further out than this closes the sticky (touch) menu. */
export const OUTSIDE_R = 290;
/** Degrees between the chats on the second ring. */
export const RING_SPREAD = 22;
/**
 * The fan's middle: a little clockwise of the chats wedge (45°), so its labels, which grow to the
 * right, stack with room between them instead of crowding at the top of the circle.
 */
export const RING_CENTER = 60;
/** Eight directions; beyond eight, directional selection gets unreliable. 0 = up, clockwise. */
export const WEDGES = 8;
/** The wedge that fans out the recent chats (↗). */
export const CHATS_WEDGE = 1;

export interface Pt {
  x: number;
  y: number;
}

/** The parts of a KeyboardEvent the gesture reads. */
export interface KeyLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  getModifierState?: (key: string) => boolean;
}

export type CancelReason = 'centre' | 'escape' | 'key' | 'blur' | 'outside';
export type Via = 'radial' | 'radial_flick';

export type Effect =
  | { type: 'open'; center: Pt; input: 'alt' | 'touch' }
  /** The wedge (and chat on the second ring) the menu points at now. */
  | { type: 'hover'; wedge: number | null; sub: number | null; ring: boolean }
  | { type: 'select'; wedge: number; sub: number | null; via: Via; ms: number }
  /** `drawn`: the menu was on screen (a plain Alt tap that did nothing is not one). */
  | { type: 'cancel'; reason: CancelReason; ms: number; drawn: boolean };

export interface GestureOptions {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  emit: (e: Effect) => void;
  /** Where the menu opens when the pointer is unknown (keyboard only): the prompt, else the viewport's centre. */
  fallbackCenter: () => Pt;
  /** How many chats the second ring shows right now (0: no second ring). */
  ringSize: () => number;
}

type State =
  | { s: 'idle' }
  /** Alt is down, the menu not drawn yet. `start`: the pointer when Alt went down. */
  | { s: 'armed'; t0: number; start: Pt | null; flick: number | null; timer: unknown }
  /** A finger is down on empty canvas, waiting to become a long press. */
  | { s: 'press'; at: Pt; timer: unknown }
  | {
      s: 'open';
      t0: number;
      center: Pt;
      wedge: number | null;
      sub: number | null;
      ring: boolean;
      ringTimer: unknown;
      /** Touch: open without a held key, closed by a tap. `lifted`: the opening press's finger is up. */
      sticky: boolean;
      lifted: boolean;
    };

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
/** Degrees from up, clockwise, in [0, 360). */
const angleOf = (c: Pt, p: Pt) => ((Math.atan2(p.x - c.x, c.y - p.y) * 180) / Math.PI + 360) % 360;
const angleGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** The wedge in the direction from `c` to `p` (null inside the dead zone). */
export function wedgeAt(c: Pt, p: Pt, deadZone = DEAD_ZONE): number | null {
  if (dist(c, p) < deadZone) return null;
  return Math.round(angleOf(c, p) / (360 / WEDGES)) % WEDGES;
}

/** The angle (degrees from up, clockwise) of chat `i` of `n` on the second ring. */
export function ringAngle(i: number, n: number): number {
  return RING_CENTER + (i - (n - 1) / 2) * RING_SPREAD;
}

/** A point at `deg` (from up, clockwise) and `r` from `c`. */
export function polar(c: Pt, deg: number, r: number): Pt {
  const rad = (deg * Math.PI) / 180;
  return { x: c.x + Math.sin(rad) * r, y: c.y - Math.cos(rad) * r };
}

const ARROWS: Record<string, number> = { ArrowUp: 0, ArrowRight: 2, ArrowDown: 4, ArrowLeft: 6 };

/** A lone Alt/Option, not AltGr and not part of a chord with another modifier. */
function isPlainAlt(e: KeyLike): boolean {
  if (e.key !== 'Alt') return false;
  if (e.getModifierState?.('AltGraph')) return false;
  return !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

export class AltGesture {
  private st: State = { s: 'idle' };
  private pointer: Pt | null = null;
  /** The menu was used while Alt is still down (esc, Enter, a click): its keyup is prevented too. */
  private swallowAltUp = false;
  constructor(private o: GestureOptions) {}

  get state(): State['s'] {
    return this.st.s;
  }

  /** Returns true when the browser's default action must be prevented. */
  keydown(e: KeyLike): boolean {
    const st = this.st;
    if (st.s === 'idle' || st.s === 'press') {
      if (e.repeat || !isPlainAlt(e)) return false;
      this.swallowAltUp = false;
      if (st.s === 'press') this.o.clearTimer(st.timer);
      const t0 = this.o.now();
      this.st = { s: 'armed', t0, start: this.pointer, flick: null, timer: this.o.setTimer(() => this.openFromAlt(), OPEN_MS) };
      return false;
    }
    if (st.s === 'armed') {
      if (e.key === 'Alt' && e.repeat) return false;
      // Another key (or AltGr turning up late): the user is typing or using a shortcut.
      this.reset();
      return false;
    }
    // Open.
    if (e.key === 'Alt') return e.repeat;
    if (e.key in ARROWS) return this.pick(ARROWS[e.key]), true;
    if (/^[1-8]$/.test(e.key)) return this.pick(Number(e.key) - 1), true;
    if (e.key === 'Enter') {
      if (st.wedge === null && st.sub === null) this.cancel('centre');
      else this.select('radial');
      return true;
    }
    if (e.key === 'Escape') return this.cancel('escape'), true;
    this.cancel('key');
    return false;
  }

  keyup(e: KeyLike): boolean {
    const st = this.st;
    if (e.key !== 'Alt') return false;
    if (this.swallowAltUp && st.s === 'idle') {
      this.swallowAltUp = false;
      return true;
    }
    if (st.s === 'armed') {
      const flick = st.flick;
      this.reset();
      if (flick === null) return false;
      this.o.emit({ type: 'select', wedge: flick, sub: null, via: 'radial_flick', ms: this.o.now() - st.t0 });
      return true;
    }
    if (st.s === 'open' && !st.sticky) {
      if (st.wedge === null && st.sub === null) this.cancel('centre');
      else this.select('radial');
      return true;
    }
    return false;
  }

  pointermove(p: Pt) {
    this.pointer = p;
    const st = this.st;
    if (st.s === 'press') {
      if (dist(st.at, p) > PRESS_DRIFT) this.reset();
      return;
    }
    if (st.s === 'armed') {
      if (st.start && dist(st.start, p) > FLICK_PX) st.flick = wedgeAt(st.start, p);
      return;
    }
    if (st.s === 'open') this.aim(p);
  }

  /** The pointer left the window: where it is is unknown. */
  pointerleave() {
    this.pointer = null;
  }

  /**
   * `touch`: a finger. `empty`: on empty canvas (not a button, a text field or a scroll area).
   * Returns true when the browser's default action must be prevented.
   */
  pointerdown(p: Pt, touch: boolean, empty: boolean): boolean {
    this.pointer = p;
    const st = this.st;
    if (st.s === 'idle') {
      if (touch && empty) this.st = { s: 'press', at: p, timer: this.o.setTimer(() => this.openFromPress(p), LONG_PRESS_MS) };
      return false;
    }
    if (st.s === 'open') {
      this.aim(p);
      return true;
    }
    return false;
  }

  pointerup(p: Pt): boolean {
    const st = this.st;
    if (st.s === 'press') {
      this.reset();
      return false;
    }
    if (st.s !== 'open') return false;
    // Touch: a tap well away from the ring closes it (with Alt held, any distance points the way).
    if (st.sticky && st.lifted && dist(st.center, p) > OUTSIDE_R) return this.cancel('outside'), true;
    this.aim(p);
    const now = this.st;
    if (now.s !== 'open') return false;
    if (now.wedge !== null || now.sub !== null) return this.select('radial'), true;
    if (now.sticky && !now.lifted && dist(now.center, p) < DEAD_ZONE * 2) {
      // The finger that opened the menu is lifting: the menu stays for a tap.
      now.lifted = true;
      return true;
    }
    this.cancel(dist(now.center, p) > OUTSIDE_R ? 'outside' : 'centre');
    return true;
  }

  /** The window lost focus (Alt+Tab) or the page was hidden. */
  blur() {
    const st = this.st;
    if (st.s === 'open') this.cancel('blur');
    else this.reset();
  }

  /** Close without a choice (the binding is going away). */
  dispose() {
    this.reset();
  }

  private openFromAlt() {
    const st = this.st;
    if (st.s !== 'armed') return;
    const center = st.start ?? this.o.fallbackCenter();
    this.st = { s: 'open', t0: st.t0, center, wedge: null, sub: null, ring: false, ringTimer: null, sticky: false, lifted: true };
    this.o.emit({ type: 'open', center, input: 'alt' });
    // Already moving: point where the pointer is (a slow flick).
    if (this.pointer) this.aim(this.pointer);
  }

  private openFromPress(at: Pt) {
    if (this.st.s !== 'press') return;
    this.st = { s: 'open', t0: this.o.now(), center: at, wedge: null, sub: null, ring: false, ringTimer: null, sticky: true, lifted: false };
    this.o.emit({ type: 'open', center: at, input: 'touch' });
  }

  /** Point the open menu at `p`. */
  private aim(p: Pt) {
    const st = this.st;
    if (st.s !== 'open') return;
    const d = dist(st.center, p);
    let wedge = wedgeAt(st.center, p);
    let sub: number | null = null;
    const n = this.o.ringSize();
    if (st.ring && n > 0 && d >= OUTER_PICK) {
      const a = angleOf(st.center, p);
      let best = 0;
      for (let i = 1; i < n; i++) if (angleGap(ringAngle(i, n), a) < angleGap(ringAngle(best, n), a)) best = i;
      // Only near the fan: far to the side of it is another wedge.
      if (angleGap(ringAngle(best, n), a) <= RING_SPREAD) {
        sub = best;
        wedge = CHATS_WEDGE;
      }
    }
    this.setHover(wedge, sub);
  }

  private pick(wedge: number) {
    const st = this.st;
    if (st.s !== 'open') return;
    this.setHover(wedge, null);
  }

  private setHover(wedge: number | null, sub: number | null) {
    const st = this.st;
    if (st.s !== 'open') return;
    // The second ring fans out after resting on the chats wedge, and folds when the pointer goes elsewhere.
    if (wedge === CHATS_WEDGE && !st.ring && st.ringTimer === null && this.o.ringSize() > 0) {
      st.ringTimer = this.o.setTimer(() => {
        const now = this.st;
        if (now.s !== 'open' || now.wedge !== CHATS_WEDGE) return;
        now.ring = true;
        now.ringTimer = null;
        this.o.emit({ type: 'hover', wedge: now.wedge, sub: now.sub, ring: true });
      }, RING_MS);
    }
    if (wedge !== CHATS_WEDGE) {
      if (st.ringTimer !== null) this.o.clearTimer(st.ringTimer);
      st.ringTimer = null;
      st.ring = false;
    }
    if (wedge === st.wedge && sub === st.sub) return;
    st.wedge = wedge;
    st.sub = sub;
    this.o.emit({ type: 'hover', wedge, sub, ring: st.ring });
  }

  private select(via: Via) {
    const st = this.st;
    if (st.s !== 'open' || st.wedge === null) return;
    const e: Effect = { type: 'select', wedge: st.wedge, sub: st.sub, via, ms: this.o.now() - st.t0 };
    this.swallowAltUp = !st.sticky;
    this.reset();
    this.o.emit(e);
  }

  private cancel(reason: CancelReason) {
    const st = this.st;
    const drawn = st.s === 'open';
    const ms = st.s === 'open' || st.s === 'armed' ? this.o.now() - st.t0 : 0;
    this.swallowAltUp = drawn && !st.sticky && reason !== 'blur';
    this.reset();
    if (drawn) this.o.emit({ type: 'cancel', reason, ms, drawn });
  }

  private reset() {
    const st = this.st;
    if (st.s === 'armed' || st.s === 'press') this.o.clearTimer(st.timer);
    if (st.s === 'open' && st.ringTimer !== null) this.o.clearTimer(st.ringTimer);
    this.st = { s: 'idle' };
  }
}
