// Live mode (`?live=1`): the assistant is Claude through the backend relay instead of the
// scripted engine. The prompt classifier stays local; which concepts a turn touched comes from
// one structured call after the answer.
import { LIVE_TREE } from '../data/scenario';
import { API_URL } from './api';
import { json, type Turn } from './arbor';
import { LIVE_BRANCH, branchLabel, type TouchedConcept } from './engine';
import type { LiveConcept } from './types';

export function liveMode(): boolean {
  try {
    return API_URL !== '' && new URLSearchParams(window.location.search).get('live') === '1';
  } catch {
    return false;
  }
}

export const CHAT_SYSTEM =
  `You are the assistant in a study chat called "${LIVE_TREE.chatTitle}". ` +
  'Help the student understand, do not just hand over answers. Be clear and concise: ' +
  'at most 150 words unless the student asks for more. Use plain Markdown, and put formulas in backticks.';

const CONCEPTS_SYSTEM =
  'You keep the knowledge tree of a study chat. Given the latest exchange, list the 0 to 3 concepts ' +
  'it was about. "label" is a short noun phrase (1 to 4 words, lower case). "branch" is the broader ' +
  'topic the concept belongs to (1 to 3 words, lower case). When the exchange is about a concept or ' +
  'branch that already exists, reuse its label exactly. Small talk has no concepts.';

const CONCEPTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concepts'],
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'branch'],
        properties: { label: { type: 'string' }, branch: { type: 'string' } },
      },
    },
  },
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Maps what the model returned onto the tree: existing concepts and branches keep their ids. */
export function toTouched(found: { label: string; branch: string }[], known: LiveConcept[]): TouchedConcept[] {
  const touched: TouchedConcept[] = [];
  for (const f of found.slice(0, 3)) {
    if (!slug(f.label)) continue;
    const existing = known.find((c) => same(c.label, f.label));
    const branch = known.find((c) => same(branchLabel(c.branchId), f.branch))?.branchId;
    const next = existing
      ? { id: existing.id, label: existing.label, branchId: existing.branchId }
      : { id: `live-${slug(f.label)}`, label: f.label.trim(), branchId: branch ?? `${LIVE_BRANCH}${f.branch.trim()}` };
    if (!touched.some((t) => t.id === next.id)) touched.push(next);
  }
  return touched;
}

export async function conceptsOf(user: string, reply: string, known: LiveConcept[]): Promise<TouchedConcept[]> {
  const existing = known.map((c) => ({ label: c.label, branch: branchLabel(c.branchId) }));
  const messages: Turn[] = [
    { role: 'user', content: JSON.stringify({ existing, exchange: { student: user, assistant: reply } }) },
  ];
  const out = await json<{ concepts: { label: string; branch: string }[] }>({
    task: 'analyze',
    system: CONCEPTS_SYSTEM,
    messages,
    schema: CONCEPTS_SCHEMA,
  });
  return toTouched(out.concepts, known);
}
