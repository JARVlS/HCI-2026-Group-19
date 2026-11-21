import { MAX_ERROR, type UsageEvent } from './events';

/**
 * The usage log's window-level events (IMPLEMENTATION_PLAN.md M6, "Event log"): the page hidden
 * or shown, online and offline, the window's size once it settles, uncaught errors, and idle time.
 * `app.ts` starts it with the page and passes its `track`, which records nothing in the demo.
 * Input only resets a clock (no timer per event), so pointer moves and typing cost nothing.
 */

/** No pointer, key or wheel input for this long, while the page is visible: idle. */
export const IDLE_MS = 60_000;
/** A resize is logged once the size has not changed for this long. */
export const RESIZE_MS = 500;
/** At most this many `client_error` events per visit. */
export const MAX_ERRORS = 10;

const INPUT = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export interface Page {
  win: EventTarget;
  doc: EventTarget & { visibilityState: string };
}

/** Listen. Returns the cleanup. */
export function watchUsage(page: Page, track: (e: UsageEvent) => void, size: () => { width: number; height: number }): () => void {
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
