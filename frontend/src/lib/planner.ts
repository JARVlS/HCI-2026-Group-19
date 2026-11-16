import type { Concept, ConceptAttempt, Id, ISO, KnowledgeTree, TreePlan, TreePlanner } from './domain';
import { ancestors } from './graph';
import { liveAttempts, treeOfConcept } from './links';
import { OTHER_BRANCH, treeLeaves } from './project';

/**
 * Which trees exist (IMPLEMENTATION_PLAN.md, ADR-2 "Tree planner"). Runs after every analysis
 * merge; pure and deterministic. M3 delivers either parameters for `HeuristicPlanner` or an
 * `OptimalPlanner` behind the same interface.
 */

export const MAX_LEAVES = 18;
export const MAX_BRANCH_LEAVES = 7;

/**
 * Default policy until M3 lands:
 * - every attempted concept belongs to a tree; an uncovered one gets a tree rooted at its
 *   top-level topic (the ancestor right below its subject), or at the subject itself when the
 *   concept hangs directly on it;
 * - a tree with more than `maxLeaves` leaves, or with a branch of more than `maxBranchLeaves`,
 *   splits its largest branch off into a tree of its own (leaf ids stay the same);
 * - trees whose root concept is gone are removed.
 * One step per call; `runPlanner` repeats until the plan is empty.
 */
export class HeuristicPlanner implements TreePlanner {
  constructor(private readonly opts: { maxLeaves: number; maxBranchLeaves: number } = { maxLeaves: MAX_LEAVES, maxBranchLeaves: MAX_BRANCH_LEAVES }) {}

  plan({ concepts, attempts, trees }: { concepts: Concept[]; attempts: ConceptAttempt[]; trees: KnowledgeTree[] }): TreePlan {
    const byId: Record<Id, Concept> = Object.fromEntries(concepts.filter((c) => !c.deletedAt).map((c) => [c.id, c]));
    const remove = trees.filter((t) => !byId[t.rootConceptId]).map((t) => t.id);
    const kept = trees.filter((t) => byId[t.rootConceptId]);
    const live = liveAttempts(attempts, byId);
    const membership = treeOfConcept(kept, byId);

    const create: TreePlan['create'] = [];
    for (const a of live) {
      if (membership.has(a.conceptId)) continue;
      const root = homeRoot(a.conceptId, byId);
      if (!create.some((c) => c.rootConceptId === root)) create.push({ rootConceptId: root, title: byId[root].label });
    }
    if (create.length || remove.length) return { create, remove };

    const roots = new Set(kept.map((t) => t.rootConceptId));
    for (const t of kept) {
      const groups = treeLeaves(t, byId, live, membership);
      const total = groups.reduce((n, g) => n + g.conceptIds.length, 0);
      const splittable = groups
        .filter((g) => g.branchId !== OTHER_BRANCH.id && g.conceptIds.length >= 2 && !roots.has(g.branchId))
        .sort((x, y) => y.conceptIds.length - x.conceptIds.length);
      const tooBig = total > this.opts.maxLeaves || groups.some((g) => g.conceptIds.length > this.opts.maxBranchLeaves);
      if (tooBig && splittable.length) {
        const b = splittable[0].branchId;
        return { create: [{ rootConceptId: b, title: byId[b].label, splitFrom: t.id }], remove: [] };
      }
    }
    return { create: [], remove: [] };
  }
}

/** Where a new tree for this concept is rooted (see `HeuristicPlanner`). */
export function homeRoot(conceptId: Id, concepts: Record<Id, Concept>): Id {
  const c = concepts[conceptId];
  if (c.kind === 'subject') return c.id;
  const chain = [c, ...ancestors(conceptId, concepts)];
  const k = chain.findIndex((x) => x.kind === 'subject');
  if (k < 0) return chain[chain.length - 1].id;
  const below = chain[k - 1];
  return below.id === c.id && c.kind === 'concept' ? chain[k].id : below.id;
}

/** The subject above a concept (or itself), which is the tree's grove. */
export function subjectOf(conceptId: Id, concepts: Record<Id, Concept>): Id | null {
  const c = concepts[conceptId];
  if (!c) return null;
  if (c.kind === 'subject') return c.id;
  return ancestors(conceptId, concepts).find((a) => a.kind === 'subject')?.id ?? null;
}

/** Apply one plan. Tree ids are derived from the root concept, so replaying a plan is idempotent. */
export function applyPlan(trees: KnowledgeTree[], plan: TreePlan, concepts: Record<Id, Concept>, now: ISO): KnowledgeTree[] {
  const next = trees.filter((t) => !plan.remove.includes(t.id));
  for (const c of plan.create) {
    const id = `t:${c.rootConceptId}`;
    if (next.some((t) => t.id === id || t.rootConceptId === c.rootConceptId)) continue;
    next.push({ id, rootConceptId: c.rootConceptId, title: c.title, groveId: subjectOf(c.rootConceptId, concepts), splitFrom: c.splitFrom, createdAt: now, updatedAt: now });
  }
  return next;
}

/** Plan and apply until nothing changes (bounded, in case a policy never settles). */
export function runPlanner(
  planner: TreePlanner,
  domain: { concepts: Record<Id, Concept>; attempts: ConceptAttempt[]; trees: KnowledgeTree[] },
  now: ISO,
  maxSteps = 8,
): KnowledgeTree[] {
  let trees = domain.trees;
  const concepts = Object.values(domain.concepts);
  for (let i = 0; i < maxSteps; i++) {
    const plan = planner.plan({ concepts, attempts: domain.attempts, trees });
    if (!plan.create.length && !plan.remove.length) break;
    const next = applyPlan(trees, plan, domain.concepts, now);
    if (next.length === trees.length && next.every((t, j) => t === trees[j])) break;
    trees = next;
  }
  return trees;
}
