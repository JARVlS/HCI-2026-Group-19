import type { Id, Mode } from '../../lib/domain';

/**
 * The authoritative judgement of one user turn (IMPLEMENTATION_PLAN.md, ADR-6): a message-level
 * label plus a per-concept judgement and where each concept sits in the user's graph.
 * Evidence comes back as quotes, never character offsets; `lib/evidence.ts` resolves them.
 *
 * M1: the type only. The JSON Schema for structured output lands with the `analyze` prompt in M4.
 */
export interface TurnAnalysis {
  message: {
    mode: Mode;
    confidence: number;
    reasons: string[];
    evidence: { quote: string; mode: Mode; reason: string }[];
  };
  /** Only on the first turn of a conversation. */
  subject?: { existingId?: Id; newLabel?: string };
  concepts: ConceptJudgement[];
}

export type ConceptRef =
  | { existingId: Id }
  | {
      newNode: {
        label: string;
        kind: 'topic' | 'concept';
        parent: { existingId?: Id; newLabel?: string };
        description: string;
      };
    };

export interface ConceptJudgement {
  ref: ConceptRef;
  mode: Mode;
  /** 0..1 */
  independence: number;
  /** 0..1 when the turn was gradable (quiz answer, prediction, own claim), else null. */
  correctness: number | null;
  confidence: number;
  reason: string;
  evidenceQuote?: string;
}
