import { ApiError } from './api';
import type { Concept, ConceptAttempt, ConceptEdge, Conversation, Id, ISO, KnowledgeTree, Message } from './domain';
import type { DomainState } from './state';

/**
 * Saving (IMPLEMENTATION_PLAN.md, M2; backend/docs/api.md `PUT /api/sync`). In live mode every
 * state change is diffed against the one before (`changedRows`); the changed entities wait in a
 * queue (`SyncQueue`) that is mirrored in localStorage, so a reload never loses a turn, and are
 * sent in batches. The backend upserts by id, so sending a row twice is harmless: a row only
 * leaves the queue once a request that carried it succeeded.
 */

export type Row =
  | { kind: 'concepts'; data: Concept }
  | { kind: 'edges'; data: ConceptEdge }
  | { kind: 'trees'; data: KnowledgeTree }
  | { kind: 'conversations'; data: Conversation }
  | { kind: 'messages'; data: Message }
  | { kind: 'attempts'; data: ConceptAttempt };
export type Kind = Row['kind'];
/** The body of `PUT /api/sync`. */
export type SyncBody = { [K in Kind]?: Extract<Row, { kind: K }>['data'][] };

const KINDS: Kind[] = ['concepts', 'edges', 'trees', 'conversations', 'messages', 'attempts'];

/* ───────────── What changed ───────────── */

/** Entities of `next` that are new or replaced (the state is immutable, so a new object = a change). */
function changed<T extends { id: Id }>(prev: T[], next: T[]): T[] {
  if (prev === next) return [];
  const before = new Map(prev.map((x) => [x.id, x]));
  return next.filter((x) => before.get(x.id) !== x);
}

/** A message is saved once it is complete: never while it streams, and not a failed reply (a retry replaces it). */
const saveable = (m: Message) => !m.streaming && !m.error;

/** What is saved of a message: not its streaming flag, and not a score still on its way (after a reload it would wait forever). */
function wireMessage({ streaming: _, ...m }: Message): Message {
  if (!m.scores || !Object.values(m.scores).includes('pending')) return m;
  return { ...m, scores: Object.fromEntries(Object.entries(m.scores).filter(([, v]) => v !== 'pending')) };
}

/**
 * The rows to save after one state change. A tree the planner removed is sent once more with
 * `deletedAt`. A chat is saved from its first message on: an empty new chat stays on this device.
 */
export function changedRows(prev: DomainState, next: DomainState, now: ISO): Row[] {
  if (prev === next) return [];
  const rows: Row[] = [];
  if (prev.concepts !== next.concepts) {
    for (const c of Object.values(next.concepts)) if (prev.concepts[c.id] !== c) rows.push({ kind: 'concepts', data: c });
  }
  for (const e of changed(prev.edges, next.edges)) rows.push({ kind: 'edges', data: e });
  for (const t of changed(prev.trees, next.trees)) rows.push({ kind: 'trees', data: t });
  if (prev.trees !== next.trees) {
    const kept = new Set(next.trees.map((t) => t.id));
    for (const t of prev.trees) if (!kept.has(t.id)) rows.push({ kind: 'trees', data: { ...t, updatedAt: now, deletedAt: now } });
  }
  for (const a of changed(prev.attempts, next.attempts)) rows.push({ kind: 'attempts', data: a });

  const chats = new Set<Id>();
  if (prev.messagesByConv !== next.messagesByConv) {
    for (const [id, list] of Object.entries(next.messagesByConv)) {
      const old = prev.messagesByConv[id];
      if (old === list) continue;
      for (const m of changed(old ?? [], list)) if (saveable(m)) rows.push({ kind: 'messages', data: wireMessage(m) });
      if (!old?.length && list.length) chats.add(id);
    }
  }
  if (prev.conversations !== next.conversations) {
    for (const c of Object.values(next.conversations)) if (prev.conversations[c.id] !== c) chats.add(c.id);
  }
  for (const id of chats) {
    const c = next.conversations[id];
    // `undefined` messages = not loaded yet, so the chat is on the server already.
    if (c && next.messagesByConv[id]?.length !== 0) rows.push({ kind: 'conversations', data: c });
  }
  return rows;
}

/* ───────────── The queue ───────────── */

export const SYNC_KEY = 'arbor.sync.v1';
/** Most rows the backend takes in one request (413 `too_many_rows` above). */
export const MAX_ROWS = 500;
const DEBOUNCE_MS = 800;
/** Browsers allow 64 KB of keepalive bodies in flight; stay below that. */
const KEEPALIVE_BYTES = 60_000;

/** Wait before the n-th retry (0-based): 1 s, 2 s, 4 s … at most 30 s. */
export const backoff = (n: number) => Math.min(30_000, 1000 * 2 ** n);

export type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SyncStatus {
  /** Rows not saved yet (rejected ones included). */
  pending: number;
  /** Rows the backend refused (a bug): kept and shown, sent again only after the next start. */
  rejected: number;
  /** The last try could not reach the backend; it retries with backoff and when the browser is back online. */
  offline: boolean;
  /** Why the last try failed, or why rows were rejected. */
  error: string | null;
}

export interface QueueOptions {
  send: (body: SyncBody, opts: { keepalive: boolean }) => Promise<unknown>;
  /** Where the queue is mirrored (localStorage); null keeps it in memory only. */
  storage: KeyValue | null;
  /** Rows were refused with a 4xx: say so where the user sees it. */
  onReject?: (message: string) => void;
  debounceMs?: number;
}

interface Entry {
  row: Row;
  rejected?: string;
}

const keyOf = (r: Row) => `${r.kind}:${r.data.id}`;

function bodyOf(rows: Row[]): SyncBody {
  const body: Record<string, unknown[]> = {};
  for (const r of rows) (body[r.kind] ??= []).push(r.data);
  return body as SyncBody;
}

export const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 413: split the batch. Network, 401 (the session renews itself), 429 and 5xx: try again later. Any other 4xx is a bug. */
export function verdict(e: unknown): 'split' | 'retry' | 'reject' {
  if (!(e instanceof ApiError)) return 'reject';
  if (e.status === 413) return 'split';
  if (e.status === 0 || e.status === 401 || e.status === 429 || e.status >= 500) return 'retry';
  return 'reject';
}

export class SyncQueue {
  private readonly entries = new Map<string, Entry>();
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Backing off after a failure: new rows wait for the retry (or for `online`). */
  private waiting = false;
  private retries = 0;
  private running: Promise<void> | null = null;
  private offline = false;
  private failure: string | null = null;
  private storageError: string | null = null;
  private current: SyncStatus;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: QueueOptions) {
    for (const row of this.read()) this.entries.set(keyOf(row), { row });
    this.current = this.compute();
  }

  /** What is queued now (also what a reload would find in the mirror). */
  rows(): Row[] {
    return [...this.entries.values()].map((e) => e.row);
  }

  /** Queue rows (a newer row replaces a queued one with the same id). `urgent`: send now (a turn ended). */
  add(rows: Row[], { urgent = false } = {}) {
    for (const row of rows) this.entries.set(keyOf(row), { row });
    if (rows.length) {
      this.write();
      this.notify();
    }
    if (urgent || rows.length) this.schedule(urgent ? 0 : (this.opts.debounceMs ?? DEBOUNCE_MS));
  }

  /** Live mode: send what is queued, now and from here on. */
  start() {
    this.active = true;
    this.schedule(0);
  }

  /** Demo mode: send nothing. Queued rows stay in the mirror for the next live start. */
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

  /**
   * The page is being hidden or closed: send what is left with `keepalive`, so the request may
   * outlive the page. If it does not get through, the mirror still has the rows.
   */
  hide() {
    if (!this.active || this.running || !this.entries.size) return;
    this.waiting = false;
    this.clearTimer();
    void this.pump(true);
  }

  status = (): SyncStatus => this.current;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private schedule(ms: number) {
    if (!this.active || this.waiting) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump(false);
    }, ms);
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

  private async drain(keepalive: boolean) {
    let size = MAX_ROWS;
    while (this.active) {
      const batch = [...this.entries.entries()].filter(([, e]) => !e.rejected).slice(0, size);
      if (!batch.length) {
        size = MAX_ROWS;
        return;
      }
      const body = bodyOf(batch.map(([, e]) => e.row));
      try {
        await this.opts.send(body, { keepalive: keepalive && JSON.stringify(body).length < KEEPALIVE_BYTES });
      } catch (e) {
        const v = verdict(e);
        if (v === 'split' && batch.length > 1) {
          size = Math.ceil(batch.length / 2);
          continue;
        }
        if (v === 'retry') {
          this.offline = e instanceof ApiError && e.status === 0;
          this.failure = reason(e);
          this.retryLater();
          this.notify();
          return;
        }
        // A refused request is a bug in what we send. Keep the rows, stop sending them, say so.
        const message = `${batch.length} change${batch.length === 1 ? '' : 's'} not saved: ${reason(e)}`;
        for (const [k, entry] of batch) if (this.entries.get(k) === entry) entry.rejected = message;
        console.error(`[arbor sync] ${message}`, e, Object.fromEntries(KINDS.map((k) => [k, body[k]?.length ?? 0])));
        this.failure = message;
        this.notify();
        this.opts.onReject?.(message);
        continue;
      }
      // Done, unless a row changed while the request was on its way (then the newer one stays queued).
      for (const [k, entry] of batch) if (this.entries.get(k) === entry) this.entries.delete(k);
      this.retries = 0;
      this.offline = false;
      if (!this.rejectedCount()) this.failure = null;
      keepalive = false;
      this.write();
      this.notify();
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

  private rejectedCount() {
    let n = 0;
    for (const e of this.entries.values()) if (e.rejected) n++;
    return n;
  }

  private compute(): SyncStatus {
    return { pending: this.entries.size, rejected: this.rejectedCount(), offline: this.offline, error: this.storageError ?? this.failure };
  }

  private notify() {
    const next = this.compute();
    const c = this.current;
    if (c.pending === next.pending && c.rejected === next.rejected && c.offline === next.offline && c.error === next.error) return;
    this.current = next;
    this.listeners.forEach((l) => l());
  }

  /* The mirror: every queued row, rejected ones too (a reload sends them once more). */

  private read(): Row[] {
    const raw = safely(() => this.opts.storage?.getItem(SYNC_KEY));
    if (!raw) return [];
    try {
      const rows = JSON.parse(raw) as Row[];
      return rows.filter((r) => KINDS.includes(r?.kind) && typeof r.data?.id === 'string');
    } catch (e) {
      console.error('[arbor sync] the saved queue is unreadable and was ignored', e);
      return [];
    }
  }

  private write() {
    const { storage } = this.opts;
    if (!storage) return;
    try {
      if (this.entries.size) storage.setItem(SYNC_KEY, JSON.stringify(this.rows()));
      else storage.removeItem(SYNC_KEY);
      this.storageError = null;
    } catch (e) {
      // Still in memory and on its way; only a reload before it is saved would lose it.
      this.storageError = `this device could not keep unsaved changes (${reason(e)})`;
      console.error(`[arbor sync] ${this.storageError}`);
    }
  }
}

export function safely<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/** Page events that matter for a queue (saving, the usage log): back online → send now; hidden or closed → send with keepalive. */
export function watchPage(queue: { flush(): Promise<void>; hide(): void }, page: { win: EventTarget; doc: EventTarget & { visibilityState: string } }, onOnline?: () => void) {
  const online = () => {
    void queue.flush();
    onOnline?.();
  };
  const hide = () => queue.hide();
  const visibility = () => {
    if (page.doc.visibilityState === 'hidden') queue.hide();
  };
  page.win.addEventListener('online', online);
  page.win.addEventListener('pagehide', hide);
  page.doc.addEventListener('visibilitychange', visibility);
  return () => {
    page.win.removeEventListener('online', online);
    page.win.removeEventListener('pagehide', hide);
    page.doc.removeEventListener('visibilitychange', visibility);
  };
}
