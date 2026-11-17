import type { Id, Mode } from '../../lib/domain';
import { MODES } from '../../lib/modes';
import { ProviderError } from '../provider';

/**
 * The authoritative judgement of one user turn (IMPLEMENTATION_PLAN.md, ADR-6): a message-level
 * label plus a per-concept judgement and where each concept sits in the user's graph.
 * Evidence comes back as quotes, never character offsets; `lib/evidence.ts` resolves them.
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

/* ───────────── Wire format for LLM providers ───────────── */

/**
 * What an LLM returns for the `analyze` task. Structured outputs only take flat, closed objects
 * (every property required, `additionalProperties: false`, no number ranges), so optional values
 * are nullable fields and the union above is built in `toTurnAnalysis`, which also clamps to 0..1.
 */
const str = { type: 'string' };
const num = { type: 'number' };
const mode = { type: 'string', enum: [...MODES] };
const orNull = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const list = (items: object) => ({ type: 'array', items });
const closed = (properties: Record<string, object>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const TURN_ANALYSIS_SCHEMA = closed({
  mode,
  confidence: num,
  reasons: list(str),
  evidence: list(closed({ quote: str, mode, reason: str })),
  subject: orNull(closed({ existingId: orNull(str), newLabel: orNull(str) })),
  concepts: list(
    closed({
      existingId: orNull(str),
      newLabel: orNull(str),
      newKind: orNull({ type: 'string', enum: ['topic', 'concept'] }),
      parentId: orNull(str),
      parentLabel: orNull(str),
      description: orNull(str),
      mode,
      independence: num,
      correctness: orNull(num),
      confidence: num,
      reason: str,
      evidenceQuote: orNull(str),
    }),
  ),
});

/** At most this many reasons and concepts are kept per turn (the prompt asks for 1–3 and 0–3). */
const MAX_ITEMS = 3;

const fail = (what: string): never => {
  throw new ProviderError(`The analysis did not fit its schema: ${what}.`, 'invalid_output');
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const object = (v: unknown, at: string) => (isObject(v) ? v : fail(`${at} is not an object`));
const array = (v: unknown, at: string) => (Array.isArray(v) ? v : fail(`${at} is not a list`));
const text = (v: unknown, at: string) => (typeof v === 'string' ? v.trim() : fail(`${at} is not text`));
/** Nullable text; empty text counts as null. */
const optText = (v: unknown, at: string) => (v === null ? null : text(v, at) || null);
const modeOf = (v: unknown, at: string) => (MODES.includes(v as Mode) ? (v as Mode) : fail(`${at} is not own, together or ai`));
const unit = (v: unknown, at: string) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fail(`${at} is not a number`);

function judgement(raw: unknown, at: string): ConceptJudgement {
  const c = object(raw, at);
  const existingId = optText(c.existingId, `${at}.existingId`);
  const label = optText(c.newLabel, `${at}.newLabel`);
  const kind = c.newKind === null || c.newKind === 'concept' ? 'concept' : c.newKind === 'topic' ? 'topic' : fail(`${at}.newKind is not topic or concept`);
  const parentId = optText(c.parentId, `${at}.parentId`);
  const parentLabel = optText(c.parentLabel, `${at}.parentLabel`);
  const description = optText(c.description, `${at}.description`) ?? '';
  let ref: ConceptRef;
  if (existingId) ref = { existingId };
  else if (label) ref = { newNode: { label, kind, parent: { ...(parentId && { existingId: parentId }), ...(parentLabel && { newLabel: parentLabel }) }, description } };
  else return fail(`${at} names neither an existing node nor a new one`);
  const evidenceQuote = optText(c.evidenceQuote, `${at}.evidenceQuote`);
  return {
    ref,
    mode: modeOf(c.mode, `${at}.mode`),
    independence: unit(c.independence, `${at}.independence`),
    correctness: c.correctness === null ? null : unit(c.correctness, `${at}.correctness`),
    confidence: unit(c.confidence, `${at}.confidence`),
    reason: text(c.reason, `${at}.reason`),
    ...(evidenceQuote && { evidenceQuote }),
  };
}

/**
 * The wire answer → `TurnAnalysis`. Anything that does not fit is a `ProviderError('invalid_output')`:
 * no silent fallback, `turn.ts` keeps the linter's label for a failed analysis.
 * `hasSubject`: the conversation already has one, so a `subject` in the answer is ignored.
 */
export function toTurnAnalysis(raw: unknown, { hasSubject }: { hasSubject: boolean }): TurnAnalysis {
  const a = object(raw, 'the answer');
  const out: TurnAnalysis = {
    message: {
      mode: modeOf(a.mode, 'mode'),
      confidence: unit(a.confidence, 'confidence'),
      reasons: array(a.reasons, 'reasons')
        .map((r, i) => text(r, `reasons[${i}]`))
        .filter(Boolean)
        .slice(0, MAX_ITEMS),
      evidence: array(a.evidence, 'evidence').map((raw, i) => {
        const e = object(raw, `evidence[${i}]`);
        return { quote: text(e.quote, `evidence[${i}].quote`), mode: modeOf(e.mode, `evidence[${i}].mode`), reason: text(e.reason, `evidence[${i}].reason`) };
      }),
    },
    concepts: array(a.concepts, 'concepts')
      .slice(0, MAX_ITEMS)
      .map((c, i) => judgement(c, `concepts[${i}]`)),
  };
  if (a.subject !== null && !hasSubject) {
    const s = object(a.subject, 'subject');
    const existingId = optText(s.existingId, 'subject.existingId');
    const newLabel = optText(s.newLabel, 'subject.newLabel');
    if (existingId) out.subject = { existingId };
    else if (newLabel) out.subject = { newLabel };
  }
  return out;
}
