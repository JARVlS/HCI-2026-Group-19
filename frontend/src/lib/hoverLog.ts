import type { HoverName, UsageEvent } from './events';
import type { ViewKind } from './nav';

/**
 * How long the pointer stays on the places that do something on hover, for the usage log
 * (`hover`): the score line and the underlined words in the prompt, messages, leaves, forest trees
 * (their leaves count as `leaf`), the "why" list, the squirrel, and the radial menu's options. One open stay per
 * name (as `restOn` in the ASCII design keeps one place per slot); a stay ends when its name moves
 * to another place or to none, or when the page is hidden (`endAll`). No React, so tests drive it.
 */

/** Shorter stays are the pointer passing by, not a hover. */
export const HOVER_MIN_MS = 300;
/** Per name, where it differs: every option the radial menu pointed at counts, however briefly. */
export const HOVER_MIN: Partial<Record<HoverName, number>> = { radial: 0 };

interface Stay {
  id: string;
  start: number;
  x: number | null;
  y: number | null;
  view: ViewKind;
}

export interface HoverClockOptions {
  track: (e: UsageEvent) => void;
  /** Where the pointer is now (null: not known yet). */
  pointer: () => { x: number; y: number } | null;
  view: () => ViewKind;
  now?: () => number;
}

export class HoverClock {
  private readonly open = new Map<HoverName, Stay>();

  constructor(private readonly o: HoverClockOptions) {}

  /** The pointer is on `id` of `name` (null: on none of them). The same id again changes nothing. */
  set(name: HoverName, id: string | null) {
    const stay = this.open.get(name);
    if ((stay?.id ?? null) === id) return;
    if (stay) this.end(name, stay);
    if (id === null) return;
    const p = this.o.pointer();
    this.open.set(name, { id, start: this.now(), x: p ? Math.round(p.x) : null, y: p ? Math.round(p.y) : null, view: this.o.view() });
  }

  /** End every stay (the page was hidden, or the design unmounts). */
  endAll() {
    for (const [name, stay] of [...this.open]) this.end(name, stay);
  }

  private end(name: HoverName, stay: Stay) {
    this.open.delete(name);
    const ms = Math.round(this.now() - stay.start);
    if (ms < (HOVER_MIN[name] ?? HOVER_MIN_MS)) return;
    this.o.track({ type: 'hover', payload: { name, id: stay.id, ms, x: stay.x, y: stay.y, view: stay.view } });
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }
}
