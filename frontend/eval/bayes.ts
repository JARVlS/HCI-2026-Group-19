import type { Mode } from '../src/lib/types';
import { ORDER } from './metrics';

/**
 * A multinomial naive Bayes text classifier over words and word pairs, the "spam filter" option of
 * ADR-15. Only a baseline for the eval: how far does a tiny learned model get on this little data?
 * Each word's log-odds per class would also give the linter its underlines.
 */

export function tokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .match(/[a-zäöüß0-9']+/g) ?? [];
  const pairs = words.slice(1).map((w, i) => `${words[i]}_${w}`);
  return [...words, ...pairs];
}

export interface Bayes {
  predict(text: string): { mode: Mode; p: Record<Mode, number> };
}

export function trainBayes(examples: { text: string; label: Mode }[], alpha = 1): Bayes {
  const counts = new Map<Mode, Map<string, number>>(ORDER.map((m) => [m, new Map()]));
  const totals = new Map<Mode, number>(ORDER.map((m) => [m, 0]));
  const docs = new Map<Mode, number>(ORDER.map((m) => [m, 0]));
  const vocab = new Set<string>();
  for (const { text, label } of examples) {
    docs.set(label, docs.get(label)! + 1);
    for (const t of tokens(text)) {
      vocab.add(t);
      const c = counts.get(label)!;
      c.set(t, (c.get(t) ?? 0) + 1);
      totals.set(label, totals.get(label)! + 1);
    }
  }
  const n = examples.length;
  return {
    predict(text) {
      const logs = ORDER.map((m) => {
        let s = Math.log((docs.get(m)! + alpha) / (n + alpha * ORDER.length));
        for (const t of tokens(text)) {
          if (!vocab.has(t)) continue;
          s += Math.log(((counts.get(m)!.get(t) ?? 0) + alpha) / (totals.get(m)! + alpha * vocab.size));
        }
        return s;
      });
      const top = Math.max(...logs);
      const exp = logs.map((l) => Math.exp(l - top));
      const sum = exp.reduce((a, b) => a + b, 0);
      const p = Object.fromEntries(ORDER.map((m, i) => [m, exp[i] / sum])) as Record<Mode, number>;
      return { mode: ORDER[logs.indexOf(top)], p };
    },
  };
}

/** Leave-one-out: every case is predicted by a model trained on all the others. */
export function leaveOneOut(examples: { text: string; label: Mode }[]): Mode[] {
  return examples.map((_, i) => trainBayes(examples.filter((__, j) => j !== i)).predict(examples[i].text).mode);
}
