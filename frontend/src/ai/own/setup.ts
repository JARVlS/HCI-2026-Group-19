/**
 * "Your own model" (IMPLEMENTATION_PLAN.md ADR-4, M7): which endpoint answers each of the three
 * model calls of a turn. Chats are still saved on the group's backend; only model calls change.
 *   chat     the tutor's streamed reply
 *   analysis the structured turn analysis (concepts, reasons, quotes)
 *   scores   the fast model's rating-scale scores (needs token probabilities)
 * This part is plain data, saved with the other settings. Keys are not in here: they stay on the
 * device in `keys.ts`.
 */

export type Role = 'chat' | 'analysis' | 'scores';
export const ROLES: readonly Role[] = ['chat', 'analysis', 'scores'];

/** How a connection talks: the group's backend, the Anthropic Messages API, or the OpenAI chat completions API. */
export type ConnectionKind = 'arbor' | 'anthropic' | 'openai-compatible';

export type PresetId = 'arbor' | 'anthropic' | 'openai' | 'openrouter' | 'groq' | 'ollama' | 'lmstudio' | 'custom';

export interface Preset {
  label: string;
  kind: ConnectionKind;
  /** Filled in when the preset is picked; the user can change it. */
  baseUrl: string;
  /** A suggestion; the endpoint's model list (`/models`) has the rest. */
  model: string;
  /** Calls without a key are refused before they go out. */
  needsKey: boolean;
}

export const PRESETS: Record<PresetId, Preset> = {
  arbor: { label: 'group backend', kind: 'arbor', baseUrl: '', model: '', needsKey: false },
  anthropic: { label: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', needsKey: true },
  openai: { label: 'openai', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', needsKey: true },
  openrouter: { label: 'openrouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini', needsKey: true },
  groq: { label: 'groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
  ollama: { label: 'ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', needsKey: false },
  lmstudio: { label: 'lm studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: '', needsKey: false },
  custom: { label: 'custom', kind: 'openai-compatible', baseUrl: '', model: '', needsKey: false },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export interface Connection {
  preset: PresetId;
  baseUrl: string;
  model: string;
}

/** Analysis and scores can use the chat's connection; scores can be off (turns keep the analysis's numbers). */
export interface OwnSetup {
  chat: Connection;
  analysis: Connection | 'same';
  scores: Connection | 'same' | 'off';
}

export const connectionOf = (preset: PresetId): Connection => ({ preset, baseUrl: PRESETS[preset].baseUrl, model: PRESETS[preset].model });

export const DEFAULT_SETUP: OwnSetup = { chat: connectionOf('openai'), analysis: 'same', scores: 'same' };

export const kindOf = (c: Connection): ConnectionKind => PRESETS[c.preset].kind;

/** The connection a role uses ('same' resolved), or 'off'. */
export function resolve(setup: OwnSetup, role: Role): Connection | 'off' {
  const r = setup[role];
  return r === 'same' ? setup.chat : r;
}

/**
 * Claude's API returns no token probabilities, so an `anthropic` connection cannot give scores
 * (the same reason the group's backend has a separate fast model, ADR-6).
 */
export const canScore = (c: Connection) => kindOf(c) !== 'anthropic';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function connection(raw: unknown): Connection | null {
  if (!isObject(raw) || typeof raw.preset !== 'string' || !Object.hasOwn(PRESETS, raw.preset)) return null;
  const preset = raw.preset as PresetId;
  const text = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
  return { preset, baseUrl: text(raw.baseUrl, PRESETS[preset].baseUrl), model: text(raw.model, PRESETS[preset].model) };
}

/** A saved setup (localStorage, any shape) → a valid one. Parts that do not fit get their default. */
export function parseSetup(raw: unknown): OwnSetup {
  if (!isObject(raw)) return DEFAULT_SETUP;
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null);
  return {
    chat: connection(raw.chat) ?? DEFAULT_SETUP.chat,
    analysis: pick(raw.analysis, ['same'] as const) ?? connection(raw.analysis) ?? DEFAULT_SETUP.analysis,
    scores: pick(raw.scores, ['same', 'off'] as const) ?? connection(raw.scores) ?? DEFAULT_SETUP.scores,
  };
}
