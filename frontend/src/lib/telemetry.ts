import type { Id, ISO } from './domain';
import type { UsageEvent } from './events';
import { fnv1a } from './retention';
import { backoff, reason, safely, verdict, type KeyValue } from './sync';
import type { Design } from './types';

/**
 * The usage log (IMPLEMENTATION_PLAN.md M6, "Event log"; backend/docs/api.md `POST /api/events`).
 * An event from the catalogue (`events.ts`) gets an id, the client time and the envelope (`visit`:
 * this page load, `seq`: its place in the visit, `design`), waits in a queue mirrored in
 * localStorage, so a reload loses nothing, and goes out in batches a few seconds after the first
 * one waiting, and with `keepalive` when the page is hidden or closed. Live mode only: the app
 * starts and stops sending as it does `SyncQueue`, and records nothing in the demo.
 * - Network trouble, 401, 429 and 5xx: sent again with backoff, and at once when back online. Silent.
 * - Any other refusal is a bug in what we send: those events are dropped (a broken event is not
 *   worth keeping), the console says why, and one toast per visit.
 * - The mirror holds at most `cap` events and MIRROR_BYTES of JSON: it shares localStorage (about
 *   5 MB per site) with the sync queue that saves the chats (`arbor.sync.v1`), and events carry
 *   texts since 21 Nov, so it must never starve it. Past either cap the oldest go, and an
 *   `events_dropped` event says how many, so the loss shows in the data.
 * - With `keepalive` a batch stays within KEEPALIVE_BYTES; an event bigger than that goes alone.
 *   If its send fails, it stays queued and in the mirror (backoff, or the next visit).
 * - Users: the backend files an event under the token that sends it. This page's events go out
 *   with this page's session. The mirror carries the user it belongs to (a fingerprint of the
 *   token, never the token), and a page signed in as someone else discards it.
 */

export const EVENTS_KEY = 'arbor.events.v1';
/** Most events the backend takes in one request. */
export const MAX_BATCH = 200;
/** Most events the mirror keeps. */
export const CAP = 2000;
/** Most characters of JSON the mirror keeps (about 1 MB; localStorage has about 5 MB per site, shared with the sync queue). */
export const MIRROR_BYTES = 1_000_000;
/** Events are not urgent: the first one waiting goes out after this, with all that came since. */
export const DEBOUNCE_MS = 4000;
/** Browsers allow 64 KB of keepalive bodies per page in flight, and the sync queue may use 60 KB (sync.ts). */
export const KEEPALIVE_BYTES = 5000;

/** One event as `POST /api/events` takes it. */
export interface WireEvent {
  id: Id;
  type: UsageEvent['type'];
  payload: Record<string, unknown>;
  /** ISO time with zone (`toISOString`). */
  clientTs: ISO;
  conversationId?: Id;
}

export interface EventsBody {
  events: WireEvent[];
}

interface Mirror {
  owner: string | null;
  events: WireEvent[];
}

/** Tells users apart without keeping a copy of their token. */
export const fingerprint = (token: string | null) => (token ? fnv1a(token).toString(36) : null);

export interface EventLogOptions {
  send: (body: EventsBody, opts: { keepalive: boolean }) => Promise<unknown>;
  /** Where the queue is mirrored (localStorage); null keeps it in memory only. */
  storage: KeyValue | null;
  /** Who this browser is signed in as now (`fingerprint` of the session token); null before its first session. */
  owner: () => string | null;
  /** Read at every event: the design in use and the open chat. */
  context: () => { design: Design; conversationId: Id };
  /** Events were refused: say so where the user sees it (called once per visit). */
  onReject: (message: string) => void;
  now?: () => ISO;
  newId?: () => Id;
  debounceMs?: number;
  cap?: number;
  /** Tests: MIRROR_BYTES. */
  maxBytes?: number;
}

export class EventLog {
  private readonly visit: Id;
  private seq = 0;
  private queue: WireEvent[] = [];
  /** The user this page's events belong to; set once it is known, never changed (see the class comment). */
  private owner: string | null;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Backing off after a failure: new events wait for the retry (or for `online`). */
  private waiting = false;
  private retries = 0;
  private running: Promise<void> | null = null;
  private told = false;
  private storageFailed = false;

  constructor(private readonly opts: EventLogOptions) {
    this.visit = this.id();
    this.owner = opts.owner();
    const saved = this.read();
    if (saved && saved.owner === this.owner) this.queue = saved.events;
    else if (saved) {
      console.warn(`[arbor events] ${saved.events.length} events queued on this browser by another user were discarded`);
      this.write();
    }
  }

  /** What is queued now (also what a reload would find in the mirror). */
  pending(): WireEvent[] {
    return [...this.queue];
  }

  /** Queue one event. Never throws: logging must never break the app. */
  record(e: UsageEvent) {
    try {
      const { design, conversationId } = this.opts.context();
      this.queue.push(this.wire(e, design, e.conversationId ?? conversationId));
      // Past a cap, make room for a while (a tenth more), so a full queue does not log a drop with every event.
      const cap = this.opts.cap ?? CAP;
      if (this.queue.length > cap) this.drop(this.queue.length - cap + Math.ceil(cap / 10), design);
      const maxBytes = this.opts.maxBytes ?? MIRROR_BYTES;
      let json = this.json();
      if (json.length > maxBytes) {
        this.drop(this.oldest(json.length - maxBytes + Math.ceil(maxBytes / 10)), design);
        json = this.json();
      }
      this.write(json);
      this.schedule();
    } catch (err) {
      console.error(`[arbor events] could not log ${e.type}`, err);
    }
  }

  /** Live mode: send what is queued, now and from here on. */
  start() {
    this.active = true;
    this.schedule();
  }

  /** Demo mode: send nothing. Queued events stay in the mirror for the next live start. */
  stop() {
    this.active = false;
    this.waiting = false;
    this.clearTimer();
  }

  /** Send now (cancels the debounce and any backoff), e.g. when the browser is back online. */
  flush(): Promise<void> {
    if (!this.active) return Promise.resolve();
    this.waiting = false;
    this.retries = 0;
    this.clearTimer();
    return this.pump(false);
  }

  /** The page is being hidden or closed: send what is left with `keepalive`. If that fails, the mirror still has it. */
  hide() {
    if (!this.active || this.running || !this.queue.length) return;
    this.waiting = false;
    this.clearTimer();
    void this.pump(true);
  }

  private id() {
    return (this.opts.newId ?? (() => crypto.randomUUID()))();
  }

  private wire(e: UsageEvent, design: Design, conversationId: Id | undefined): WireEvent {
    return {
      id: this.id(),
      type: e.type,
      payload: { ...e.payload, visit: this.visit, seq: ++this.seq, design },
      clientTs: (this.opts.now ?? (() => new Date().toISOString()))(),
      ...(conversationId ? { conversationId } : {}),
    };
  }

  /** Drop the `count` oldest events, and say so in the data (`events_dropped`) and the console. */
  private drop(count: number, design: Design) {
    this.queue.splice(0, count);
    console.warn(`[arbor events] the queue is full: the ${count} oldest events were dropped`);
    this.queue.push(this.wire({ type: 'events_dropped', payload: { count } }, design, undefined));
  }

  /** How many of the oldest events take at least `chars` characters of the mirror. */
  private oldest(chars: number) {
    let n = 0;
    for (let sum = 0; sum < chars && n < this.queue.length; n++) sum += JSON.stringify(this.queue[n]).length + 1;
    return n;
  }

  private schedule() {
    if (!this.active || this.waiting || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump(false);
    }, this.opts.debounceMs ?? DEBOUNCE_MS);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private pump(keepalive: boolean): Promise<void> {
    this.running ??= this.drain(keepalive).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** The next batch: at most MAX_BATCH, and with `keepalive` only as many as fit its budget (at least one). */
  private batch(keepalive: boolean): WireEvent[] {
    const batch = this.queue.slice(0, MAX_BATCH);
    if (!keepalive) return batch;
    let bytes = '{"events":[]}'.length;
    const over = batch.findIndex((e) => (bytes += JSON.stringify(e).length + 1) > KEEPALIVE_BYTES);
    return over < 0 ? batch : batch.slice(0, Math.max(1, over));
  }

  private async drain(keepalive: boolean) {
    while (this.active) {
      const batch = this.batch(keepalive);
      if (!batch.length) return;
      try {
        await this.opts.send({ events: batch }, { keepalive });
      } catch (e) {
        if (verdict(e) === 'retry') {
          this.retryLater();
          return;
        }
        // A refusal is a bug in what we send: drop these events, say so once per visit.
        console.error(`[arbor events] ${batch.length} events refused and dropped: ${reason(e)}`, e);
        if (!this.told) {
          this.told = true;
          this.opts.onReject(`usage log not saved: ${reason(e)}`);
        }
      }
      const sent = new Set(batch.map((e) => e.id));
      this.queue = this.queue.filter((e) => !sent.has(e.id));
      this.retries = 0;
      keepalive = false;
      this.write();
    }
  }

  private retryLater() {
    this.clearTimer();
    this.waiting = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.waiting = false;
      void this.pump(false);
    }, backoff(this.retries++));
  }

  private read(): Mirror | null {
    const raw = safely(() => this.opts.storage?.getItem(EVENTS_KEY));
    if (!raw) return null;
    try {
      const m = JSON.parse(raw) as Mirror;
      if (!Array.isArray(m?.events)) throw new Error('no events list');
      return { owner: m.owner ?? null, events: m.events.filter((e) => typeof e?.id === 'string' && typeof e.type === 'string') };
    } catch (e) {
      console.error('[arbor events] the saved usage log is unreadable and was ignored', e);
      return null;
    }
  }

  /** The mirror as it is stored. */
  private json() {
    // A first visit gets its session after the page started: its events are that session's.
    this.owner ??= this.opts.owner();
    return JSON.stringify({ owner: this.owner, events: this.queue } satisfies Mirror);
  }

  /** `json`: the mirror, when the caller has it already. */
  private write(json?: string) {
    const { storage } = this.opts;
    if (!storage) return;
    try {
      if (this.queue.length) storage.setItem(EVENTS_KEY, json ?? this.json());
      else storage.removeItem(EVENTS_KEY);
      this.storageFailed = false;
    } catch (e) {
      // Still in memory and on its way; only a reload before it is sent would lose it.
      if (!this.storageFailed) console.error(`[arbor events] this device could not keep the usage log (${reason(e)})`);
      this.storageFailed = true;
    }
  }
}
