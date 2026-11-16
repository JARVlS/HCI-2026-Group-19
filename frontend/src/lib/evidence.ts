import type { Evidence, Mode } from './types';

/**
 * Turn quoted evidence into character offsets (IMPLEMENTATION_PLAN.md, ADR-6). Models quote
 * reliably but count characters badly, so the analysis returns quotes and we find them here:
 * exact match first, then case- and whitespace-insensitive; a quote that is not in the text is dropped.
 */
export function resolveQuote(text: string, quote: string, from = 0): { start: number; end: number } | null {
  const q = quote.trim();
  if (!q) return null;
  const exact = text.indexOf(q, from);
  if (exact >= 0) return { start: exact, end: exact + q.length };

  // Normalized copy of the text with a map back to original offsets.
  let norm = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (norm.endsWith(' ') || !norm) continue;
      norm += ' ';
    } else norm += ch.toLowerCase();
    at.push(i);
  }
  const nq = q.replace(/\s+/g, ' ').toLowerCase();
  const startFrom = at.findIndex((i) => i >= from);
  const k = startFrom < 0 ? -1 : norm.indexOf(nq, startFrom);
  if (k < 0) return null;
  return { start: at[k], end: at[k + nq.length - 1] + 1 };
}

export function resolveEvidence(text: string, items: { quote: string; mode: Mode; reason: string }[]): Evidence[] {
  const out: Evidence[] = [];
  for (const { quote, mode, reason } of items) {
    const r = resolveQuote(text, quote);
    if (r) out.push({ ...r, mode, reason });
  }
  return out;
}

/** The inverse, for providers that already have offsets (the scripted linter): spans → quotes. */
export const quotesOf = (text: string, evidence: Evidence[]) =>
  evidence.map((e) => ({ quote: text.slice(e.start, e.end), mode: e.mode, reason: e.reason }));
