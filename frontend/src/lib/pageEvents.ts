import { MAX_ERROR, type Located, type UsageEvent } from './events';
import type { ViewKind } from './nav';

/**
 * The usage log's window-level events (IMPLEMENTATION_PLAN.md M6, "Event log"): the page hidden
 * or shown, online and offline, the window's size once it settles, uncaught errors, and idle time.
 * `app.ts` starts it with the page and passes its `track`, which records nothing in the demo.
 * Input only resets a clock (no timer per event), so pointer moves and typing cost nothing.
 * With `clicks`, every primary press is logged too (`click`: where, on what, and how long after the
 * previous one), for the logs page's heatmap.
 */

/** No pointer, key or wheel input for this long, while the page is visible: idle. */
export const IDLE_MS = 60_000;
/** A resize is logged once the size has not changed for this long. */
export const RESIZE_MS = 500;
/** At most this many `client_error` events per visit. */
export const MAX_ERRORS = 10;
/** Clicks further apart than this are unrelated: `sincePrev` is null and the heatmap draws no line. */
export const CLICK_CHAIN_MS = 10_000;

const INPUT = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export interface Page {
  win: EventTarget;
  doc: EventTarget & { visibilityState: string };
}

/** What a click needs besides the event: where it landed (the DOM, `locate.ts`) and the app's view at the time. */
export interface Clicks {
  locate: (target: EventTarget | null, x: number, y: number) => Located;
  context: () => { view: ViewKind; panel: boolean };
}

/** Listen. Returns the cleanup. */
export function watchUsage(page: Page, track: (e: UsageEvent) => void, size: () => { width: number; height: number }, clicks?: Clicks): () => void {
  const { win, doc } = page;
  const off: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, f: (e: Event) => void, opts?: AddEventListenerOptions) => {
    target.addEventListener(type, f, opts);
    off.push(() => target.removeEventListener(type, f, opts));
  };

  // Idle: one timer that looks at the time of the last input. A hidden page is never idle: hiding
  // and showing it count as input, so idle time is time on a visible page.
  let last = Date.now();
  let idle = false;
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    const wait = last + IDLE_MS - Date.now();
    if (wait > 0 || doc.visibilityState === 'hidden') {
      timer = setTimeout(check, wait > 0 ? wait : IDLE_MS);
      return;
    }
    idle = true;
    track({ type: 'idle_start', payload: {} });
  };
  const input = () => {
    const now = Date.now();
    if (idle) {
      idle = false;
      track({ type: 'idle_end', payload: { ms: now - last } });
      timer = setTimeout(check, IDLE_MS);
    }
    last = now;
  };
  timer = setTimeout(check, IDLE_MS);
  // Capture: overlays stop the keys they handle from reaching other listeners.
  for (const type of INPUT) listen(win, type, input, { capture: true, passive: true });

  // Registered before `watchPage` (app.ts), so `page_hidden` goes out with the keepalive send that hiding starts.
  listen(doc, 'visibilitychange', () => {
    input();
    track({ type: doc.visibilityState === 'hidden' ? 'page_hidden' : 'page_visible', payload: {} });
  });
  listen(win, 'online', () => track({ type: 'online', payload: {} }));
  listen(win, 'offline', () => track({ type: 'offline', payload: {} }));

  let resized: ReturnType<typeof setTimeout> | undefined;
  listen(win, 'resize', () => {
    clearTimeout(resized);
    resized = setTimeout(() => track({ type: 'resize', payload: size() }), RESIZE_MS);
  });

  if (clicks) {
    let prev: number | null = null;
    let typed = false;
    listen(win, 'keydown', () => (typed = true), { capture: true, passive: true });
    listen(
      win,
      'pointerdown',
      (e) => {
        const p = e as PointerEvent;
        if (p.button !== 0 || p.isPrimary === false) return;
        try {
          const now = Date.now();
          const gap = prev === null ? null : now - prev;
          prev = now;
          const x = Math.round(p.clientX);
          const y = Math.round(p.clientY);
          track({
            type: 'click',
            payload: {
              x,
              y,
              ...size(),
              ...clicks.locate(p.target, p.clientX, p.clientY),
              ...clicks.context(),
              pointer: p.pointerType || 'mouse',
              sincePrev: gap !== null && gap <= CLICK_CHAIN_MS ? gap : null,
              typed,
            },
          });
          typed = false;
        } catch (err) {
          console.error('[arbor events] could not log a click', err);
        }
      },
      { capture: true, passive: true },
    );
  }

  let errors = 0;
  const error = (message: string, source: string, line: number | null) => {
    if (errors++ < MAX_ERRORS) track({ type: 'client_error', payload: { message: message.slice(0, MAX_ERROR), source, line } });
  };
  listen(win, 'error', (e) => {
    const { message, filename, lineno } = e as ErrorEvent;
    error(String(message ?? ''), filename ?? '', lineno ?? null);
  });
  listen(win, 'unhandledrejection', (e) => {
    const { reason } = e as PromiseRejectionEvent;
    error(reason instanceof Error ? reason.message : String(reason), 'promise', null);
  });

  return () => {
    clearTimeout(timer);
    clearTimeout(resized);
    off.forEach((stop) => stop());
  };
}
