import type { ConceptJudgement, TurnAnalysis } from '../ai/schemas/turnAnalysis';
import type { Concept, ConceptAttempt, Id, ISO } from './domain';
import { resolveQuote } from './evidence';
import type { Evidence } from './types';

/**
 * The user's knowledge graph: merging a turn analysis into it (IMPLEMENTATION_PLAN.md, ADR-6).
 * Pure functions; the reducer applies their result.
 */

/** Normalized label for dedup: lowercase, ascii-folded, punctuation-free, singular-ish. */
export function slugify(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join('-');
}

/** At most this many concepts are created per turn, so trees stay readable. */
export const MAX_NEW_PER_TURN = 3;

export interface MergeContext {
  conversationId: Id;
  messageId: Id;
  /** The user message, to resolve evidence quotes against. */
  text: string;
  now: ISO;
  newId: () => Id;
  source: ConceptAttempt['source'];
  /** Where new nodes without a known parent go (the conversation's tree root or subject). */
  fallbackParentId: Id | null;
  maxNew?: number;
}

export interface MergeResult {
  /** Concepts to insert (new nodes, in creation order). */
  created: Concept[];
  /** One attempt per touched concept, in the analysis's order. */
  attempts: ConceptAttempt[];
  /** Subject chosen or created by this analysis, if any. */
  subjectId?: Id;
}

const alive = (c: Concept | undefined): c is Concept => Boolean(c && !c.deletedAt);

export function mergeAnalysis(concepts: Record<Id, Concept>, analysis: TurnAnalysis, ctx: MergeContext): MergeResult {
  const pool: Record<Id, Concept> = { ...concepts };
  const created: Concept[] = [];
  const maxNew = ctx.maxNew ?? MAX_NEW_PER_TURN;

  const findBySlug = (label: string, parentId?: Id | null): Concept | undefined => {
    const slug = slugify(label);
    const all = Object.values(pool).filter(alive);
    const match = (c: Concept) => c.slug === slug || c.aliases.some((a) => slugify(a) === slug);
    return all.find((c) => match(c) && (parentId === undefined || c.parentId === parentId)) ?? all.find(match);
  };

  const create = (label: string, kind: Concept['kind'], parentId: Id | null, description?: string): Concept | undefined => {
    if (created.length >= maxNew) return undefined;
    const c: Concept = {
      id: ctx.newId(),
      label: label.trim(),
      slug: slugify(label),
      aliases: [],
      kind,
      parentId,
      description: description || undefined,
      createdBy: 'llm',
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    pool[c.id] = c;
    created.push(c);
    return c;
  };

  let subjectId: Id | undefined;
  if (analysis.subject?.existingId && alive(pool[analysis.subject.existingId])) subjectId = analysis.subject.existingId;
  else if (analysis.subject?.newLabel) {
    const label = analysis.subject.newLabel;
    subjectId = (findBySlug(label, null) ?? create(label, 'subject', null))?.id;
  }

  const resolve = (j: ConceptJudgement): Id | undefined => {
    if ('existingId' in j.ref) return alive(pool[j.ref.existingId]) ? j.ref.existingId : undefined;
    const n = j.ref.newNode;
    let parentId: Id | null = ctx.fallbackParentId;
    if (n.parent.existingId && alive(pool[n.parent.existingId])) parentId = n.parent.existingId;
    else if (n.parent.newLabel) {
      const p = findBySlug(n.parent.newLabel) ?? create(n.parent.newLabel, 'topic', ctx.fallbackParentId);
      if (p) parentId = p.id;
    }
    return (findBySlug(n.label, parentId) ?? create(n.label, n.kind, parentId, n.description))?.id;
  };

  const attempts: ConceptAttempt[] = [];
  const seen = new Set<Id>();
  for (const j of analysis.concepts) {
    const conceptId = resolve(j);
    if (!conceptId || seen.has(conceptId)) continue;
    seen.add(conceptId);
    const at = j.evidenceQuote ? resolveQuote(ctx.text, j.evidenceQuote) : null;
    const evidence: Evidence[] = at ? [{ ...at, mode: j.mode, reason: j.reason }] : [];
    attempts.push({
      id: ctx.newId(),
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      conceptId,
      mode: j.mode,
      independence: clamp01(j.independence),
      correctness: j.correctness === null ? null : clamp01(j.correctness),
      confidence: clamp01(j.confidence),
      reasons: j.reason ? [j.reason] : [],
      evidence,
      source: ctx.source,
      createdAt: ctx.now,
    });
  }
  return { created, attempts, subjectId };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

/** Ancestors of a concept, nearest first (cycle-safe). */
export function ancestors(id: Id, concepts: Record<Id, Concept>): Concept[] {
  const out: Concept[] = [];
  const seen = new Set<Id>([id]);
  let p = concepts[id]?.parentId ?? null;
  while (p && !seen.has(p) && concepts[p]) {
    seen.add(p);
    out.push(concepts[p]);
    p = concepts[p].parentId;
  }
  return out;
}
