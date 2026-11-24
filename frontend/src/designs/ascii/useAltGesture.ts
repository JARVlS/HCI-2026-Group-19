import { useEffect, useRef, useState } from 'react';
import { AltGesture, type Effect, type Pt } from '../../lib/altGesture';

/** What the radial menu draws while it is open. */
export interface RadialState {
  center: Pt;
  wedge: number | null;
  sub: number | null;
  ring: boolean;
  input: 'alt' | 'touch';
}

/** Where a long press may open the menu: not on anything that has its own press, text or scroll. */
const OWN_PRESS = 'button, a, input, textarea, select, label, [contenteditable="true"], [role="button"], [role="dialog"], .at-grid, .a-msg, .a-radial';

/** The prompt's centre when it has focus (keyboard only), else the viewport's centre. */
function fallbackCenter(): Pt {
  const el = document.activeElement;
  const r = el instanceof HTMLElement && el.id === 'a-prompt' ? el.getBoundingClientRect() : null;
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/**
 * Binds `AltGesture` (lib/altGesture.ts) to the window. Keys go through the capture phase, so while
 * the menu is open its keys (arrows, 1–8, Enter, Esc) never reach the prompt or the app's shortcuts;
 * every other key is left alone. `on` gets selections, opens and cancels; the return value is what
 * to draw (null: closed).
 */
export function useAltGesture(on: { effect: (e: Effect) => void; ringSize: () => number; enabled: boolean }): RadialState | null {
  const [shown, setShown] = useState<RadialState | null>(null);
  const latest = useRef(on);
  latest.current = on;

  useEffect(() => {
    if (!on.enabled) return;
    const g = new AltGesture({
      now: () => performance.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      fallbackCenter,
      ringSize: () => latest.current.ringSize(),
      emit: (e) => {
        if (e.type === 'open') setShown({ center: e.center, wedge: null, sub: null, ring: false, input: e.input });
        else if (e.type === 'hover') setShown((s) => s && { ...s, wedge: e.wedge, sub: e.sub, ring: e.ring });
        else setShown(null);
        latest.current.effect(e);
      },
    });
    const own = (prevent: boolean, e: Event) => {
      if (!prevent) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const keydown = (e: KeyboardEvent) => own(g.keydown(e), e);
    const keyup = (e: KeyboardEvent) => own(g.keyup(e), e);
    const at = (e: PointerEvent): Pt => ({ x: e.clientX, y: e.clientY });
    const move = (e: PointerEvent) => g.pointermove(at(e));
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      own(g.pointerdown(at(e), e.pointerType === 'touch', !t?.closest?.(OWN_PRESS)), e);
    };
    const up = (e: PointerEvent) => own(g.pointerup(at(e)), e);
    const out = (e: PointerEvent) => {
      if (!e.relatedTarget) g.pointerleave();
    };
    const blur = () => g.blur();
    const hidden = () => document.visibilityState === 'hidden' && g.blur();
    // A long press would also open the browser's context menu; not while the radial menu is up.
    const context = (e: Event) => g.state !== 'idle' && e.preventDefault();
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', blur, true);
    document.addEventListener('pointerout', out);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('contextmenu', context, true);
    return () => {
      g.dispose();
      setShown(null);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', blur, true);
      document.removeEventListener('pointerout', out);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('contextmenu', context, true);
    };
  }, [on.enabled]);

  return shown;
}
