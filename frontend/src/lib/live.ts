import { api, ApiError } from './api';
import { latestConversation, mergeMessages, newConversation } from './chats';
import type { Concept, ConceptAttempt, ConceptEdge, Conversation, Id, ISO, KnowledgeTree, Message } from './domain';
import type { Session } from './session';
import { isBusy, type Action, type DomainState, type State } from './state';
import { changedRows, type Row, type SyncBody, type SyncQueue } from './sync';

/**
 * Live mode (IMPLEMENTATION_PLAN.md, M2): the user's own data, loaded from the backend and saved to
 * it. At start `GET /api/state` loads everything but messages; the rows still queued on this
 * device go on top (they are newer). Messages load per chat when it is opened, and stay for the
 * visit. Nothing here runs in demo mode.
 */

/** `GET /api/state` (backend/docs/api.md). */
export interface ServerState {
  concepts: Concept[];
  edges: ConceptEdge[];
  trees: KnowledgeTree[];
  conversations: Conversation[];
  attempts: ConceptAttempt[];
}

/** The three persistence calls. Tests use the real one over a fake `fetch`. */
export interface Backend {
  state(): Promise<ServerState>;
  messages(conversationId: Id): Promise<Message[]>;
  sync(body: SyncBody, opts: { keepalive: boolean }): Promise<unknown>;
}

export function remoteBackend(session: Session): Backend {
  return {
    state: () => session.run((token) => api<ServerState>('/api/state', undefined, { token })),
    async messages(id) {
      const { messages } = await session.run((token) => api<{ messages: Message[] }>(`/api/conversations/${encodeURIComponent(id)}/messages`, undefined, { token }));
      // Every message has `conceptIds` in this app; one saved without it must not break the transcript.
      return messages.map((m) => (Array.isArray(m.conceptIds) ? m : { ...m, conceptIds: [] }));
    },
    sync: (body, { keepalive }) => session.run((token) => api('/api/sync', body, { token, method: 'PUT', keepalive })),
  };
}

/** The user's world: the server's snapshot with the queued rows on top. Messages come per chat (`mergeMessages`). */
export function domainOf(server: ServerState, queued: Row[]): DomainState {
  const d: DomainState = {
    concepts: Object.fromEntries(server.concepts.map((c) => [c.id, c])),
    edges: [...server.edges],
    trees: [...server.trees],
    conversations: Object.fromEntries(server.conversations.map((c) => [c.id, c])),
    messagesByConv: {},
    attempts: [...server.attempts],
  };
  const put = <T extends { id: Id }>(list: T[], x: T) => {
    const i = list.findIndex((y) => y.id === x.id);
    if (i >= 0) list[i] = x;
    else list.push(x);
  };
  for (const r of queued) {
    if (r.kind === 'concepts') d.concepts[r.data.id] = r.data;
    else if (r.kind === 'conversations') d.conversations[r.data.id] = r.data;
    else if (r.kind === 'attempts') put(d.attempts, r.data);
    else if (r.kind === 'edges' && !d.edges.some((e) => e.id === r.data.id)) d.edges.push(r.data);
    else if (r.kind === 'trees') {
      const { deletedAt, ...tree } = r.data;
      if (deletedAt) d.trees = d.trees.filter((t) => t.id !== tree.id);
      else put(d.trees, tree);
    }
  }
  return d;
}

export interface StoreHandle {
  getState(): State;
  dispatch(a: Action): void;
}

export interface Live {
  /** Load the user's data (again): sends what an earlier visit left, loads, opens the latest chat. */
  boot(): Promise<void>;
  /** Leave live mode: stop sending, forget loads in flight. */
  stop(): void;
  /** Load a chat's messages once per visit (a failed load can be tried again). */
  loadMessages(conversationId: Id): Promise<void>;
  /** Called with every state change: queues what changed for saving. */
  observe(prev: State, next: State, a: Action): void;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createLive(
  store: StoreHandle,
  { backend, queue, newId, now }: { backend: Backend; queue: SyncQueue; newId: () => Id; now: () => ISO },
): Live {
  /** Bumped by every boot and stop, so an answer for an earlier one is dropped. */
  let generation = 0;
  /** The queue as this visit found it: the newest copies of what it holds, laid over every load. */
  let snapshot: Row[] = [];
  const queued = (id: Id) => [...snapshot, ...queue.rows()].some((r) => r.kind === 'conversations' && r.data.id === id);

  const live: Live = {
    async boot() {
      const gen = ++generation;
      store.dispatch({ type: 'bootStart' });
      snapshot = queue.rows();
      queue.start(); // what an earlier visit left goes out together with the load
      let server: ServerState;
      try {
        server = await backend.state();
      } catch (e) {
        if (gen === generation) store.dispatch({ type: 'bootFailed', error: reason(e) });
        return;
      }
      if (gen !== generation) return;
      const domain = domainOf(server, snapshot);
      let active = latestConversation(domain.conversations);
      if (!active) {
        // A first visit: one new, empty chat (saved with its first message).
        const c = newConversation(newId(), now());
        domain.conversations[c.id] = c;
        domain.messagesByConv[c.id] = [];
        active = c.id;
      }
      store.dispatch({ type: 'hydrate', domain, activeConversationId: active, demoPrompts: [] });
      await live.loadMessages(active);
    },

    stop() {
      generation++;
      queue.stop();
    },

    async loadMessages(id) {
      const s = store.getState();
      if (s.domain.messagesByConv[id] || s.session.chatLoad[id] === 'loading' || !s.domain.conversations[id]) return;
      const gen = generation;
      store.dispatch({ type: 'messagesLoading', conversationId: id });
      let server: Message[];
      try {
        server = await backend.messages(id);
      } catch (e) {
        if (gen !== generation) return;
        // A chat still in the queue has not reached the backend yet: nothing to load.
        if (e instanceof ApiError && e.status === 404 && queued(id)) server = [];
        else {
          store.dispatch({ type: 'messagesFailed', conversationId: id, error: reason(e) });
          return;
        }
      }
      if (gen !== generation) return;
      const mine = snapshot.flatMap((r) => (r.kind === 'messages' && r.data.conversationId === id ? [r.data] : []));
      store.dispatch({ type: 'messagesLoaded', conversationId: id, messages: mergeMessages(server, mine) });
    },

    observe(prev, next, a) {
      // Loads come from the backend; only what happens after them is saved.
      if (a.type === 'hydrate' || a.type === 'messagesLoaded') return;
      if (next.settings.provider !== 'arbor' || prev.session.boot !== 'ready' || next.session.boot !== 'ready') return;
      const rows = changedRows(prev.domain, next.domain, now());
      const ended = isBusy(prev.session.turn) && !isBusy(next.session.turn);
      if (rows.length || ended) queue.add(rows, { urgent: ended });
    },
  };
  return live;
}
