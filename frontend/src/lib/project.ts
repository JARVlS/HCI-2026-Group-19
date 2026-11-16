import type { Concept, ConceptAttempt, ConceptEdge, Conversation, Id, KnowledgeTree } from './domain';
import { liveAttempts, sortByTime, treeOfConcept } from './links';
import type { Branch, Leaf, LeafRef, TreeData } from './types';

/**
 * Projection: canonical entities → the render contract (`TreeData` / `Branch` / `Leaf`) that the
 * designs consume (IMPLEMENTATION_PLAN.md, ADR-2). Pure selectors; nothing here is stored.
 *
 *   branch = direct child of the tree's root; leaves hanging directly on the root go to the
 *            fallback branch `other` ("Side questions")
 *   leaf   = every attempted descendant, flattened onto its branch; leaf.id = concept id
 *   order  = by first attempt, so the tree grows in the order concepts came up
 */

export const OTHER_BRANCH = { id: 'other', label: 'Side questions' };

/**
 * How much of the thinking on a concept was the user's (drives the leaf glyph).
 * M1 keeps the prototype's rule, the best attempt (max), so the demo behaves exactly as before.
 * ADR-2 plans the mean across attempts; switch here once per-concept analysis exists (M4).
 */
export function leafScore(attempts: ConceptAttempt[]): number {
  return attempts.length ? Math.max(...attempts.map((a) => a.independence)) : 0;
}

/** The direct child of `rootId` on the way up from `conceptId` (itself if it hangs on the root), or null. */
export function topChild(conceptId: Id, rootId: Id, concepts: Record<Id, Concept>): Id | null {
  const seen = new Set<Id>();
  for (let c: Concept | undefined = concepts[conceptId]; c && !seen.has(c.id); c = c.parentId ? concepts[c.parentId] : undefined) {
    seen.add(c.id);
    if (c.parentId === rootId) return c.id;
  }
  return null;
}

/**
 * Leaves of one tree grouped by branch, in growth order. Branch nodes themselves are not leaves:
 * a direct child of the root with attempted descendants is a branch, otherwise (if attempted) a
 * leaf on the `other` branch.
 */
export function treeLeaves(
  tree: KnowledgeTree,
  concepts: Record<Id, Concept>,
  attempts: ConceptAttempt[],
  membership: Map<Id, Id>,
): { branchId: Id; conceptIds: Id[] }[] {
  const order: Id[] = [];
  for (const a of sortByTime(attempts)) {
    if (membership.get(a.conceptId) === tree.id && a.conceptId !== tree.rootConceptId && !order.includes(a.conceptId)) order.push(a.conceptId);
  }
  const top = new Map(order.map((id) => [id, topChild(id, tree.rootConceptId, concepts)]));
  const branchNodes = new Set([...top.entries()].filter(([id, t]) => t && t !== id).map(([, t]) => t!));
  const groups = new Map<Id, Id[]>();
  for (const id of order) {
    const t = top.get(id);
    if (!t) continue;
    if (t === id && branchNodes.has(id)) continue;
    const b = t === id ? OTHER_BRANCH.id : t;
    groups.set(b, [...(groups.get(b) ?? []), id]);
  }
  return [...groups.entries()].map(([branchId, conceptIds]) => ({ branchId, conceptIds }));
}

export interface ProjectOptions {
  /** The active chat: its leaves get `here`, and `messageId` points into it when possible. */
  conversationId?: Id;
  /** Precomputed `treeOfConcept`, when projecting many trees. */
  membership?: Map<Id, Id>;
  live?: boolean;
}

export function projectTree(tree: KnowledgeTree, concepts: Record<Id, Concept>, attempts: ConceptAttempt[], opts: ProjectOptions = {}): TreeData {
  const live = liveAttempts(attempts, concepts);
  const membership = opts.membership ?? treeOfConcept([tree], concepts);
  const byConcept = new Map<Id, ConceptAttempt[]>();
  for (const a of sortByTime(live)) byConcept.set(a.conceptId, [...(byConcept.get(a.conceptId) ?? []), a]);

  let updatedAt = tree.updatedAt;
  const leafOf = (id: Id): Leaf => {
    const as = byConcept.get(id) ?? [];
    const refs: LeafRef[] = [];
    for (const a of as) {
      if (!refs.some((r) => r.messageId === a.messageId)) refs.push({ conversationId: a.conversationId, messageId: a.messageId, at: a.createdAt });
      if (a.createdAt > updatedAt) updatedAt = a.createdAt;
    }
    const here = opts.conversationId ? refs.filter((r) => r.conversationId === opts.conversationId) : [];
    return {
      id,
      label: concepts[id].label,
      score: leafScore(as),
      messageId: (here.length ? here : refs).at(-1)?.messageId,
      count: refs.length,
      refs,
      here: here.length > 0 || undefined,
    };
  };

  const branches: Branch[] = treeLeaves(tree, concepts, live, membership).map(({ branchId, conceptIds }) => ({
    id: branchId,
    label: branchId === OTHER_BRANCH.id ? OTHER_BRANCH.label : (concepts[branchId]?.label ?? branchId),
    leaves: conceptIds.map(leafOf),
  }));

  return {
    id: tree.id,
    title: tree.title,
    grove: tree.groveId ?? 'other',
    updatedAt,
    live: opts.live || undefined,
    branches,
  };
}

/** Every tree, in the given order. `liveTreeIds`: trees to mark as touched by the active chat. */
export function projectForest(
  trees: KnowledgeTree[],
  concepts: Record<Id, Concept>,
  attempts: ConceptAttempt[],
  opts: { conversationId?: Id; liveTreeIds?: Id[] } = {},
): TreeData[] {
  const membership = treeOfConcept(trees, concepts);
  const live = new Set(opts.liveTreeIds ?? []);
  return trees
    .filter((t) => !concepts[t.rootConceptId]?.deletedAt)
    .map((t) => projectTree(t, concepts, attempts, { conversationId: opts.conversationId, membership, live: live.has(t.id) }));
}

export interface Root {
  /** What the root is labelled with: the shared concept (this tree's side), the split or the chat. */
  label: string;
  kind: 'edge' | 'split' | 'chat';
  /** For `edge`: the leaf in this tree and the leaf it connects to in the other tree. */
  fromLeafId?: Id;
  toLeafId?: Id;
}

/** tree id → other tree id → roots between them ("the wood wide web"). */
export type CrossRoots = Map<Id, Map<Id, Root[]>>;

/**
 * Roots between trees: prerequisite/related edges between leaves of different trees, split
 * provenance, and chats that grew both trees. Matched by concept id, never by label.
 */
export function crossRoots(
  forest: TreeData[],
  edges: ConceptEdge[],
  trees: KnowledgeTree[],
  attempts: ConceptAttempt[] = [],
  conversations: Record<Id, Conversation> = {},
): CrossRoots {
  const leafTree = new Map<Id, Id>();
  for (const t of forest) for (const b of t.branches) for (const l of b.leaves) leafTree.set(l.id, t.id);
  const adj = new Map<Id, Id[]>();
  for (const e of edges) {
    adj.set(e.fromId, [...(adj.get(e.fromId) ?? []), e.toId]);
    adj.set(e.toId, [...(adj.get(e.toId) ?? []), e.fromId]);
  }
  const treeById = new Map(trees.map((t) => [t.id, t]));
  const titleOf = (id: Id) => forest.find((t) => t.id === id)?.title ?? id;

  // Chats that touched leaves in more than one tree.
  const chatTrees = new Map<Id, Set<Id>>();
  for (const a of liveAttempts(attempts)) {
    const t = leafTree.get(a.conceptId);
    if (!t) continue;
    chatTrees.set(a.conversationId, (chatTrees.get(a.conversationId) ?? new Set()).add(t));
  }

  const out: CrossRoots = new Map();
  for (const a of forest) {
    const mine = a.branches.flatMap((b) => b.leaves);
    const row = new Map<Id, Root[]>();
    for (const b of forest) {
      if (a === b) continue;
      const roots: Root[] = [];
      for (const l of mine) {
        for (const other of adj.get(l.id) ?? []) {
          if (leafTree.get(other) !== b.id || roots.some((r) => r.fromLeafId === l.id && r.toLeafId === other)) continue;
          roots.push({ label: l.label, kind: 'edge', fromLeafId: l.id, toLeafId: other });
        }
      }
      const ta = treeById.get(a.id);
      const tb = treeById.get(b.id);
      if (ta?.splitFrom === b.id || tb?.splitFrom === a.id) roots.push({ label: ta?.splitFrom === b.id ? titleOf(a.id) : titleOf(b.id), kind: 'split' });
      for (const [conv, ts] of chatTrees) {
        if (ts.has(a.id) && ts.has(b.id)) roots.push({ label: conversations[conv]?.title ?? 'a chat', kind: 'chat' });
      }
      if (roots.length) row.set(b.id, roots);
    }
    out.set(a.id, row);
  }
  return out;
}
