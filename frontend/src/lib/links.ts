import type { Concept, ConceptAttempt, Id, ISO, KnowledgeTree } from './domain';

/**
 * Chats ↔ trees ↔ leaves (IMPLEMENTATION_PLAN.md, ADR-2). Never stored as links: every attempt
 * carries `conversationId + messageId`, so these are pure selectors over the attempts.
 */

/** Attempts that count: not superseded by a relabel, and on a concept that still exists. */
export function liveAttempts(attempts: ConceptAttempt[], concepts?: Record<Id, Concept>): ConceptAttempt[] {
  return attempts.filter((a) => !a.supersededBy && (!concepts || (concepts[a.conceptId] && !concepts[a.conceptId].deletedAt)));
}

/**
 * Which tree each concept belongs to: the nearest ancestor (or itself) that is a tree root.
 * Concepts above or outside every tree are not in the map.
 */
export function treeOfConcept(trees: KnowledgeTree[], concepts: Record<Id, Concept>): Map<Id, Id> {
  const rootOf = new Map<Id, Id>();
  for (const t of trees) if (!rootOf.has(t.rootConceptId)) rootOf.set(t.rootConceptId, t.id);
  const out = new Map<Id, Id>();
  for (const c of Object.values(concepts)) {
    if (c.deletedAt) continue;
    const seen = new Set<Id>();
    for (let cur: Concept | undefined = c; cur && !seen.has(cur.id); cur = cur.parentId ? concepts[cur.parentId] : undefined) {
      seen.add(cur.id);
      const t = rootOf.get(cur.id);
      if (t) {
        out.set(c.id, t);
        break;
      }
    }
  }
  return out;
}

export interface LinkIndex {
  attempts: ConceptAttempt[];
  /** From `treeOfConcept`. */
  membership: Map<Id, Id>;
}

export interface Ref {
  conversationId: Id;
  messageId: Id;
  at: ISO;
}

/** Every place a leaf was touched, one entry per message, oldest first. */
export function refsOfConcept(conceptId: Id, attempts: ConceptAttempt[]): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<Id>();
  for (const a of sortByTime(liveAttempts(attempts))) {
    if (a.conceptId !== conceptId || seen.has(a.messageId)) continue;
    seen.add(a.messageId);
    out.push({ conversationId: a.conversationId, messageId: a.messageId, at: a.createdAt });
  }
  return out;
}

/** "Chats this tree grew from", most recent first. */
export function conversationsOfTree(treeId: Id, { attempts, membership }: LinkIndex) {
  const by = new Map<Id, { conversationId: Id; lastAt: ISO; conceptIds: Id[] }>();
  for (const a of sortByTime(liveAttempts(attempts))) {
    if (membership.get(a.conceptId) !== treeId) continue;
    const e = by.get(a.conversationId) ?? { conversationId: a.conversationId, lastAt: a.createdAt, conceptIds: [] };
    e.lastAt = a.createdAt;
    if (!e.conceptIds.includes(a.conceptId)) e.conceptIds.push(a.conceptId);
    by.set(a.conversationId, e);
  }
  return [...by.values()].sort((x, y) => y.lastAt.localeCompare(x.lastAt));
}

/** "Trees this chat grew", most recently touched first. */
export function treesOfConversation(conversationId: Id, { attempts, membership }: LinkIndex): Id[] {
  const last = new Map<Id, ISO>();
  for (const a of sortByTime(liveAttempts(attempts))) {
    if (a.conversationId !== conversationId) continue;
    const t = membership.get(a.conceptId);
    if (t) last.set(t, a.createdAt);
  }
  return [...last.entries()].sort((x, y) => y[1].localeCompare(x[1])).map(([t]) => t);
}

/** Stable sort by `createdAt` (attempts of one message share a timestamp and keep their order). */
export function sortByTime<T extends { createdAt: ISO }>(xs: T[]): T[] {
  return xs
    .map((x, i) => [x, i] as const)
    .sort((a, b) => a[0].createdAt.localeCompare(b[0].createdAt) || a[1] - b[1])
    .map(([x]) => x);
}
