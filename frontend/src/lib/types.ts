import type { OwnSetup } from '../ai/own/setup';

/** Who did the thinking for a prompt. */
export type Mode = 'own' | 'together' | 'ai';

/** A stretch of the prompt that made the classifier lean one way (character offsets). */
export interface Evidence {
  start: number;
  end: number;
  mode: Mode;
  reason: string;
}

export interface Classification {
  mode: Mode;
  /** 0..1 — how sure the heuristic is. Shown to the user for transparency. */
  confidence: number;
  /** Human-readable explanations ("Starts with 'write' …"). */
  reasons: string[];
  /** True once the user corrected the label by hand. */
  overridden?: boolean;
  /** Where in the text each reason comes from, so a design can point at the words. */
  evidence?: Evidence[];
}

/** A score from the fast model's rating scale (G-Eval): `p`, 0..1, how much the student thought along or how right it is. */
export interface Score {
  p: number;
  model?: string;
}

/** A score on its way, a failed score call, or the score. */
export type ScoreState = 'pending' | 'failed' | Score;

/**
 * The fast model's scores of one user message (live mode, providers that have `score`):
 * `thinking` did the student think along in the message, `guess` did they in a guess revealed at
 * predict → reveal, `correct` is the guess (if there is one) or else the message's own claim right.
 */
export type ScoreKey = 'thinking' | 'guess' | 'correct';
export type MessageScores = Partial<Record<ScoreKey, ScoreState>>;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** User messages only. */
  classification?: Classification;
  /** User messages only: the fast model's scores. Absent when the provider has none (demo, or a model without token probabilities). */
  scores?: MessageScores;
  /** Concepts this exchange touched. */
  conceptIds: string[];
  streaming?: boolean;
  /** Assistant only: concept the "Make it yours" actions refer to. */
  reflectOn?: string;
  /** Assistant only: the answer is hidden until the user guesses or reveals it (predict → reveal). */
  veiled?: boolean;
  /** Assistant only: what the user predicted before revealing the answer. */
  guess?: string;
  /** Assistant only: the user stopped the reply while it streamed. */
  stopped?: boolean;
  /** Assistant only: the reply failed (after `text` had partly arrived, if any). */
  error?: string;
}

/** Where a concept was touched: one user message in one conversation. */
export interface LeafRef {
  conversationId: string;
  messageId: string;
  /** ISO timestamp of the attempt. */
  at: string;
}

/**
 * The render contract for one leaf. Computed from the domain model by `lib/project.ts`,
 * never stored. `id` is the concept id, so it is stable across chats and tree splits.
 */
export interface Leaf {
  id: string;
  label: string;
  /** 0 = AI did the thinking, 0.5 = together, 1 = you. */
  score: number;
  /** The latest message that touched it (in the active chat if it was touched there). */
  messageId?: string;
  /** Number of distinct messages that touched it. */
  count?: number;
  /** Every place it was touched, oldest first. */
  refs?: LeafRef[];
  /** Touched in the active chat. */
  here?: boolean;
}

export interface Branch {
  id: string;
  label: string;
  leaves: Leaf[];
}

export interface TreeData {
  id: string;
  title: string;
  grove: string;
  /** ISO timestamp: when the tree last grew. */
  updatedAt: string;
  /** Touched by the active chat (or the active chat's subject tree). */
  live?: boolean;
  branches: Branch[];
}

export interface Grove {
  id: string;
  label: string;
}

export type NudgeLevel = 'off' | 'gentle' | 'active';
/** Design styles: each is its own UI over the same store (see src/designs/). */
export type Design = 'ascii' | 'classic';
export type Theme = 'system' | 'light' | 'dark';
/** Where answers come from: the scripted demo, Claude through the Arbor backend, or the user's own model (ADR-4, M7). */
export type ProviderChoice = 'scripted' | 'arbor' | 'own';

export interface Settings {
  enabled: boolean;
  nudge: NudgeLevel;
  showTags: boolean;
  theme: Theme;
  /** Show the squirrel mascot in the panel. */
  mascot: boolean;
  design: Design;
  /** Applies from the next message; a running reply finishes with the provider it started with. */
  provider: ProviderChoice;
  /** Provider `own`: the connection of each role (no keys: those stay in `ai/own/keys.ts`). */
  own: OwnSetup;
}
