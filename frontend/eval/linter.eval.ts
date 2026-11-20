import { expect, it, vi } from 'vitest';
import { ArborProvider } from '../src/ai/arbor/provider';
import { api } from '../src/lib/api';
import { classify } from '../src/lib/classify';
import { steadyMode, type Steady } from '../src/lib/draftScore';
import weights from '../src/lib/filter/weights.json';
import { thinkingMode } from '../src/lib/modes';
import { createSession } from '../src/lib/session';
import { rate, shipped, type Weights } from '../src/lib/thinkingFilter';
import type { Mode } from '../src/lib/types';
import { leaveOneOut } from './bayes';
import { LINTER_SET, type LinterCase } from './linter-set';
import { confusion, ORDER, perClass, summary } from './metrics';

/**
 * How well does who-is-thinking get judged while typing? (ADR-15, milestone M9)
 *   npm run eval:linter                                              # rules and naive Bayes, offline, free
 *   VITE_API_URL=https://hci-backend.leon-grass.workers.dev npm run eval:linter   # + the fast model
 * The fast model costs one score call per case (~150 calls of ~120 tokens, from the group's budget).
 * Compares, against the labels in linter-set.ts (draft labels until the team has rated them):
 *   rules   src/lib/classify.ts, what the linter shows today
 *   bayes   naive Bayes on words and word pairs, leave-one-out (a tiny learned model, the baseline)
 *   filter  the word filter, the composer's instant tier in live mode (src/lib/thinkingFilter.ts,
 *           fitted on synthetic messages only, research/thinking-filter), its shipped weights
 *   fast    the fast model's 1–5 "own thinking" scale (src/ai/prompts/score.ts), label by thinkingMode
 * plus: label changes while typing (rules and filter, word by word) and a cascade (rules first, the
 * fast model only when the rules are unsure). Prints markdown; copy it into eval/results/ when it matters.
 */

const pct = (x: number) => `${Math.round(x * 100)}`;
const k2 = (x: number) => x.toFixed(2);

function table(name: string, gold: Mode[], pred: Mode[]) {
  const s = summary(confusion(gold, pred));
  return `| ${name} | ${s.n} | ${pct(s.accuracy)} % | ${k2(s.kappa)} | ${k2(s.weightedKappa)} | ${k2(s.macroF1)} |`;
}

function matrix(name: string, gold: Mode[], pred: Mode[]) {
  const m = confusion(gold, pred);
  const pc = perClass(m);
  return [
    `**${name}** (rows: label, columns: predicted)`,
    '',
    `| | ${ORDER.join(' | ')} | recall | precision |`,
    '|---|---|---|---|---|---|',
    ...ORDER.map((g, i) => `| ${g} | ${m[i].join(' | ')} | ${pct(pc[i].recall)} % | ${pct(pc[i].precision)} % |`),
    '',
  ].join('\n');
}

const filterModel = shipped(weights as unknown as Weights);
/** The word filter's label of a draft (no tutor message before it: the set has none). */
const filterMode = (text: string) => thinkingMode(rate(filterModel, text, false, classify(text)).estimate);

/** How often a judge's label changes while the prompt is typed, checked at every word end. `steady`: as the score line shows the filter's (`steadyMode`). */
function flips(text: string, judge: (draft: string) => Mode, steady = false) {
  const ends = [...text.matchAll(/\S+/g)].map((w) => (w.index ?? 0) + w[0].length);
  let last: Mode | null = null;
  let st: Steady | null = null;
  let n = 0;
  for (const e of ends) {
    const raw = judge(text.slice(0, e));
    const m = steady ? (st = steadyMode(st, raw)).shown : raw;
    if (last && m !== last) n++;
    last = m;
  }
  return n;
}

it('linter eval', async () => {
  const cases: LinterCase[] = LINTER_SET;
  const gold = cases.map((c) => c.label);
  const rulesC = cases.map((c) => classify(c.text));
  const rules = rulesC.map((c) => c.mode);
  const bayes = leaveOneOut(cases);
  const filter = cases.map((c) => filterMode(c.text));
  const out: string[] = [];

  // The fast model, only when a backend is named (it spends the budget).
  const backend = import.meta.env.VITE_API_URL as string | undefined;
  let fast: Mode[] | null = null;
  let fastP: number[] = [];
  const tokens = { input: 0, output: 0 };
  const ms: number[] = [];
  let model = '';
  let firstError = '';
  if (backend) {
    vi.stubEnv('VITE_API_URL', backend);
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const res = await real(url, init);
      if (url.endsWith('/api/ai/score') && res.ok) {
        const { usage } = (await res.clone().json()) as { usage: { inputTokens: number; outputTokens: number } };
        tokens.input += usage.inputTokens;
        tokens.output += usage.outputTokens;
      }
      return res;
    });
    const provider = new ArborProvider(createSession(async () => (await api<{ token: string }>('/api/session', {})).token, null));
    fastP = [];
    for (const c of cases) {
      const t0 = performance.now();
      try {
        const r = await provider.score({ question: 'thinking', text: c.text, recent: [] }, new AbortController().signal);
        model = r.model ?? model;
        fastP.push(r.p);
      } catch (e) {
        firstError ||= e instanceof Error ? e.message : String(e);
        fastP.push(Number.NaN); // a failed call: counted as "together" (the middle) below
      }
      ms.push(performance.now() - t0);
    }
    // Every call failed (no key on the Worker, budget used up, …): no fast numbers at all, say why.
    fast = fastP.every(Number.isNaN) ? null : fastP.map((p) => (Number.isNaN(p) ? 'together' : thinkingMode(p)));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }

  const date = new Date().toISOString().slice(0, 10);
  out.push(`## Linter eval, ${date}`, '');
  out.push(`${cases.length} prompts (${ORDER.map((m) => `${gold.filter((g) => g === m).length} ${m}`).join(', ')}), labels: Claude's draft (not yet rated by the team).`);
  if (fast) {
    const sorted = [...ms].sort((a, b) => a - b);
    out.push(
      `Fast model: \`${model}\` via ${backend}; ${fastP.filter(Number.isNaN).length} failed calls; median ${Math.round(sorted[sorted.length >> 1])} ms per call; tokens ${tokens.input} in, ${tokens.output} out (${Math.round((tokens.input + tokens.output) / cases.length)} per call).`,
    );
  } else if (backend) out.push(`Fast model: every call to ${backend} failed, so it is left out. First error: ${firstError}`);
  else out.push('Fast model: not run (set VITE_API_URL to include it).');
  out.push('', '| judge | n | accuracy | kappa | weighted kappa | macro F1 |', '|---|---|---|---|---|---|');
  out.push(table('rules (classify.ts, today)', gold, rules));
  out.push(table('naive Bayes, leave-one-out', gold, bayes));
  out.push(table('word filter (synthetic only, live tier 0)', gold, filter));
  if (fast) out.push(table('fast model (1–5 scale)', gold, fast));
  out.push('');

  // Slices by tag: where each judge breaks.
  const tags = [...new Set(cases.flatMap((c) => c.tags ?? []))].sort();
  out.push('**By tag** (accuracy)', '', `| tag | n | rules | bayes | filter |${fast ? ' fast |' : ''}`, `|---|---|---|---|---|${fast ? '---|' : ''}`);
  for (const t of ['(all)', '(no tag)', ...tags]) {
    const idx = cases.flatMap((c, i) => (t === '(all)' || (t === '(no tag)' ? !c.tags?.length : c.tags?.includes(t)) ? [i] : []));
    const acc = (pred: Mode[]) => `${pct(idx.filter((i) => pred[i] === gold[i]).length / idx.length)} %`;
    out.push(`| ${t} | ${idx.length} | ${acc(rules)} | ${acc(bayes)} | ${acc(filter)} |${fast ? ` ${acc(fast)} |` : ''}`);
  }
  out.push('');

  out.push(matrix('rules', gold, rules));
  out.push(matrix('word filter', gold, filter));
  if (fast) out.push(matrix('fast model', gold, fast));

  // Calm while typing (ADR-14): label changes per prompt, word by word.
  const stability = (name: string, f: number[]) =>
    `**Typing stability (${name}):** ${(f.reduce((a, b) => a + b, 0) / f.length).toFixed(2)} label changes per prompt on average, checked at every word end; ${pct(f.filter((x) => x > 0).length / f.length)} % of prompts change label at least once, ${pct(f.filter((x) => x > 2).length / f.length)} % more than twice.`;
  out.push(
    stability('rules', cases.map((c) => flips(c.text, (d) => classify(d).mode))),
    '',
    stability('word filter', cases.map((c) => flips(c.text, filterMode))),
    '',
    stability('word filter as the line shows it, a new label after two words', cases.map((c) => flips(c.text, filterMode, true))),
    '',
  );

  // Cascade: the rules decide when they are sure; below the threshold the fast model decides.
  if (fast) {
    out.push('**Cascade** (rules first; the fast model only when the rules\' confidence is below the threshold)', '');
    out.push('| threshold | fast model calls | accuracy | kappa |', '|---|---|---|---|');
    for (const t of [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01]) {
      const pred = rulesC.map((c, i) => (c.confidence < t ? fast![i] : c.mode));
      const s = summary(confusion(gold, pred));
      out.push(`| ${t > 1 ? 'always' : t === 0 ? 'never' : t} | ${pct(rulesC.filter((c) => c.confidence < t).length / cases.length)} % | ${pct(s.accuracy)} % | ${k2(s.kappa)} |`);
    }
    out.push('');
  }

  // Every case some judge got wrong, so the team can check the labels too.
  out.push('**Cases with a miss**', '', `| label | rules | bayes | filter |${fast ? ' fast (p) |' : ''} text |`, `|---|---|---|---|${fast ? '---|' : ''}---|`);
  cases.forEach((c, i) => {
    if (rules[i] === gold[i] && bayes[i] === gold[i] && filter[i] === gold[i] && (!fast || fast[i] === gold[i])) return;
    const mark = (m: Mode) => (m === gold[i] ? m : `**${m}**`);
    const fp = fast ? ` ${mark(fast[i])} (${Number.isNaN(fastP[i]) ? 'failed' : pct(fastP[i])}) |` : '';
    out.push(`| ${c.label} | ${mark(rules[i])} | ${mark(bayes[i])} | ${mark(filter[i])} |${fp} ${c.text.replace(/\|/g, '\\|').slice(0, 90)} |`);
  });

  console.log(out.join('\n'));
  expect(rules).toHaveLength(cases.length);
});
