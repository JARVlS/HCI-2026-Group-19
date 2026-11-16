import type { Concept, ConceptAttempt, Id, KnowledgeTree, Mode } from '../lib/domain';
import { slugify } from '../lib/graph';
import { MODE_SCORE } from '../lib/modes';

/** Tiny builders for hand-made graphs in tests. */

const T0 = Date.parse('2026-11-01T10:00:00Z');
/** ISO time `n` minutes after a fixed start. */
export const at = (n: number) => new Date(T0 + n * 60_000).toISOString();

export function concept(id: Id, parentId: Id | null, kind: Concept['kind'] = 'concept', label = id): Concept {
  return { id, label, slug: slugify(label), aliases: [], kind, parentId, createdBy: 'seed', createdAt: at(0), updatedAt: at(0) };
}

export const graph = (...cs: Concept[]): Record<Id, Concept> => Object.fromEntries(cs.map((c) => [c.id, c]));

let n = 0;
export function attempt(conceptId: Id, opts: { conv?: Id; msg?: Id; mode?: Mode; t?: number; id?: Id } = {}): ConceptAttempt {
  const mode = opts.mode ?? 'own';
  return {
    id: opts.id ?? `att${++n}`,
    conversationId: opts.conv ?? 'c1',
    messageId: opts.msg ?? `m-${conceptId}-${opts.t ?? 0}`,
    conceptId,
    mode,
    independence: MODE_SCORE[mode],
    correctness: null,
    confidence: 1,
    reasons: [],
    evidence: [],
    source: 'prompt',
    createdAt: at(opts.t ?? 0),
  };
}

export const tree = (id: Id, rootConceptId: Id, extra: Partial<KnowledgeTree> = {}): KnowledgeTree => ({
  id,
  rootConceptId,
  title: rootConceptId,
  groveId: null,
  createdAt: at(0),
  updatedAt: at(0),
  ...extra,
});
