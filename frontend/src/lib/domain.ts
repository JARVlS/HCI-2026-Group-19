/**
 * Canonical data model (IMPLEMENTATION_PLAN.md, ADR-2). The frontend owns it; the backend mirrors it.
 * JSON field names are camelCase on the wire.
 *
 * `TreeData` / `Branch` / `Leaf` in `types.ts` stay the render contract the designs consume; from M1
 * on they are computed from these entities by pure selectors (`lib/project.ts`), never stored.
 */
import type { ChatMessage, Evidence, Mode } from './types';

export type { Evidence, Mode };

/** crypto.randomUUID(), generated on the client (optimistic UI, offline/scripted mode). */
export type Id = string;
/** ISO-8601 UTC timestamp. */
export type ISO = string;

export type ConceptKind = 'subject' | 'topic' | 'concept';

/** Where model calls go (ADR-4). */
export type ProviderKind = 'scripted' | 'arbor' | 'anthropic' | 'openai-compatible' | 'chatgpt';

/** One node of the user's knowledge graph. The hierarchy (parentId) is a strict forest of trees. */
export interface Concept {
  id: Id;
  /** Display label. */
  label: string;
  /** Normalized label for dedup: lowercase, ascii-folded, singular-ish. */
  slug: string;
  aliases: string[];
  kind: ConceptKind;
  /** subject → topic → concept (→ concept…); subjects have null. */
  parentId: Id | null;
  description?: string;
  createdBy: 'seed' | 'llm' | 'user';
  createdAt: ISO;
  updatedAt: ISO;
  deletedAt?: ISO;
}

/** Cross-links that are not hierarchy (prerequisite / related). Drawn as roots between trees. */
export interface ConceptEdge {
  id: Id;
  fromId: Id;
  toId: Id;
  kind: 'prerequisite' | 'related';
  createdAt: ISO;
}

export interface Conversation {
  id: Id;
  title: string;
  /** Grove in the forest; assigned by the first analysis or picked by the user. */
  subjectId: Id | null;
  studyMode: boolean;
  /** 'split-chats' policy (ADR-9): the conversation this one continues. */
  continuedFrom?: Id;
  carrySummary?: string;
  createdAt: ISO;
  updatedAt: ISO;
}

/** ChatMessage, extended. Its `classification` is the message-level summary (the glyph next to the message). */
export interface Message extends ChatMessage {
  conversationId: Id;
  createdAt: ISO;
  provider?: ProviderKind;
  model?: string;
  analysis?: 'pending' | 'done' | 'failed';
}

/** THE core record: how independently the student handled ONE concept in ONE message. */
export interface ConceptAttempt {
  id: Id;
  conversationId: Id;
  messageId: Id;
  conceptId: Id;
  mode: Mode;
  /** 0..1 (own ≈ 1, together ≈ 0.5, ai ≈ 0; continuous allowed). */
  independence: number;
  /** 0..1 when the turn was gradable (quiz answer, prediction, own claim), else null. */
  correctness: number | null;
  /** 0..1, classifier confidence. */
  confidence: number;
  reasons: string[];
  /** Character offsets into the USER message (resolved client-side from quotes, ADR-6). */
  evidence: Evidence[];
  source: 'prompt' | 'reveal' | 'quiz' | 'override';
  /** Relabels never delete; they supersede (keeps study data). */
  supersededBy?: Id;
  createdAt: ISO;
}

/**
 * A tree in the forest = the subtree of the graph below one root concept (until the next tree root).
 * Trees are NOT 1:1 with chats: one chat can grow several trees, one tree collects many chats.
 * When to split a tree, and how, is decided by the TreePlanner.
 */
export interface KnowledgeTree {
  id: Id;
  /** A subject or topic. */
  rootConceptId: Id;
  /** Defaults to the root's label. */
  title: string;
  /** Subject id → grove in the forest. */
  groveId: Id | null;
  /** Provenance when the planner split it off another tree. */
  splitFrom?: Id;
  createdAt: ISO;
  updatedAt: ISO;
}

/** Decides which trees exist (the M3 seam). Pure and deterministic; runs after every analysis merge. */
export interface TreePlanner {
  plan(input: { concepts: Concept[]; attempts: ConceptAttempt[]; trees: KnowledgeTree[] }): TreePlan;
}

export interface TreePlan {
  create: { rootConceptId: Id; title: string; splitFrom?: Id }[];
  /** Ids of trees to remove. */
  remove: Id[];
}
