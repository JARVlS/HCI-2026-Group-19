import type { Mode } from './types';

export const MODE_SCORE: Record<Mode, number> = { own: 1, together: 0.5, ai: 0 };

/**
 * Where the fast model's "thought along" score (0..1, a 5-step scale: 0, 25, 50, 75, 100 %) turns
 * into a label: own from OWN_FROM (an own claim, guess or reasoning: 75 % and up), ai up to AI_UP_TO
 * (hands the work over: 0 %, "explain X" about 14 %), together in between (a plain why or how
 * question about 25 %, a hint or quiz request about 50 %), as in the analysis rubric.
 */
export const OWN_FROM = 0.67;
export const AI_UP_TO = 0.2;

export function thinkingMode(p: number): Mode {
  if (p >= OWN_FROM) return 'own';
  if (p <= AI_UP_TO) return 'ai';
  return 'together';
}

/** One vocabulary, used everywhere (tags, legend, tree, forest) for consistency. */
export const MODE_META: Record<Mode, { label: string; short: string; lens: string; desc: string }> = {
  own: {
    label: 'Your thinking',
    short: 'You',
    lens: 'You’re thinking',
    desc: 'You brought your own reasoning — the AI reacted to it.',
  },
  together: {
    label: 'Thinking together',
    short: 'Together',
    lens: 'Thinking together',
    desc: 'You explored the idea with the AI instead of just taking an answer.',
  },
  ai: {
    label: 'Delegated to AI',
    short: 'AI',
    lens: 'Delegating to AI',
    desc: 'You handed the thinking to the AI. Totally fine — just good to know.',
  },
};

export const MODES: Mode[] = ['own', 'together', 'ai'];

export function scoreToMode(score: number): Mode {
  if (score >= 0.75) return 'own';
  if (score >= 0.25) return 'together';
  return 'ai';
}

export function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function pct(score: number): number {
  return Math.round(score * 100);
}
