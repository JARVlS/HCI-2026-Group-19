import type { Provider } from '../ai/provider';
import type { TurnAnalysis } from '../ai/schemas/turnAnalysis';
import type { Message } from '../lib/domain';
import { createSession } from '../lib/session';
import type { Kind } from '../lib/sync';
import { apiError, fakeBackend, json, type Call } from './backend';

/**
 * The persistence part of the backend Worker in memory (backend/docs/api.md: `GET /api/state`,
 * `GET /api/conversations/:id/messages`, `PUT /api/sync`), behind the fake `fetch`.
 * `offline = true` makes every call fail like a dropped connection.
 */
export function fakeServer() {
  const db: Record<Kind, Map<string, Record<string, unknown>>> = {
    concepts: new Map(),
    edges: new Map(),
    trees: new Map(),
    conversations: new Map(),
    messages: new Map(),
    attempts: new Map(),
  };
  const server = {
    db,
    offline: false,
    /** Answer for the next calls to this path instead (one per call), e.g. an error. */
    fail: new Map<string, Response[]>(),
    calls: [] as Call[],
  };
  const byTime = (xs: Record<string, unknown>[]) => xs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const alive = (k: Kind) => byTime([...db[k].values()].filter((x) => !x.deletedAt));
  server.calls = fakeBackend((call) => {
    if (server.offline) throw new TypeError('Failed to fetch');
    const failure = server.fail.get(call.path)?.shift();
    if (failure) return failure;
    if (call.path === '/api/state' && call.method === 'GET') {
      return json({ concepts: alive('concepts'), edges: alive('edges'), trees: alive('trees'), conversations: alive('conversations'), attempts: alive('attempts') });
    }
    const m = /^\/api\/conversations\/(.+)\/messages$/.exec(call.path);
    if (m && call.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      if (!db.conversations.has(id)) return apiError(404, 'not_found', 'No such conversation.');
      return json({ messages: byTime([...db.messages.values()].filter((x) => x.conversationId === id)) });
    }
    if (call.path === '/api/sync' && call.method === 'PUT') {
      const body = call.body as Partial<Record<Kind, Record<string, unknown>[]>>;
      const rows = Object.values(body).reduce((n, l) => n + (l?.length ?? 0), 0);
      if (rows > 500) return apiError(413, 'too_many_rows', 'At most 500 rows.');
      for (const [kind, list] of Object.entries(body) as [Kind, Record<string, unknown>[]][]) {
        for (const row of list) {
          const old = db[kind].get(row.id as string);
          // Last write wins on updatedAt; messages and attempts: the incoming row wins.
          if (old && 'updatedAt' in row && String(old.updatedAt) > String(row.updatedAt)) continue;
          const { streaming: _, ...stored } = row;
          db[kind].set(row.id as string, stored);
        }
      }
      return json({ ok: true, serverTime: new Date().toISOString() });
    }
    return apiError(404, 'not_found', `No route ${call.method} ${call.path}`);
  });
  return server;
}

/** A session that already has a token (no `POST /api/session` in the calls). */
export const testSession = () => createSession(async () => 'tok', null);

/**
 * A live-like provider without the network: a fixed reply, and an analysis that files every
 * message under subject "Biology" → topic "Immunology" → concept "Vaccines" (an existing subject is
 * reused by id, the rest is deduplicated by label, as with the real model).
 */
export function biologyProvider(): Provider {
  return {
    kind: 'arbor',
    label: 'fake live',
    async chat(_req, onDelta) {
      await Promise.resolve();
      onDelta('Vaccines show the body ');
      await Promise.resolve();
      onDelta('a harmless copy.');
      return { text: 'Vaccines show the body a harmless copy.', model: 'fake' };
    },
    async json(_task, input) {
      const biology = input.graph.find((c) => c.kind === 'subject' && c.label === 'Biology');
      const analysis: TurnAnalysis = {
        message: { mode: 'own', confidence: 0.9, reasons: ['states a claim'], evidence: [] },
        subject: input.subjectId ? undefined : biology ? { existingId: biology.id } : { newLabel: 'Biology' },
        concepts: [
          {
            ref: { newNode: { label: 'Vaccines', kind: 'concept', parent: { newLabel: 'Immunology' }, description: '' } },
            mode: 'own',
            independence: 1,
            correctness: null,
            confidence: 0.9,
            reason: 'own words',
          },
        ],
      };
      return analysis as never;
    },
    canQuiz: () => false,
  };
}

/** Messages of one chat as the server has them. */
export const serverMessages = (server: ReturnType<typeof fakeServer>, conversationId: string) =>
  [...server.db.messages.values()].filter((m) => m.conversationId === conversationId) as unknown as Message[];
