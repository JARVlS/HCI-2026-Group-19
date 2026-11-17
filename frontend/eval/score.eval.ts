import { expect, it, vi } from 'vitest';
import { ArborProvider } from '../src/ai/arbor/provider';
import type { ScoreInput } from '../src/ai/provider';
import { api } from '../src/lib/api';
import { AI_UP_TO, OWN_FROM } from '../src/lib/modes';
import { createSession } from '../src/lib/session';

/**
 * A small eval of the fast scores (`src/ai/prompts/score.ts`) against a running backend:
 *   npm run eval:score                                   # local backend on http://localhost:8787
 *   VITE_API_URL=https://… npm run eval:score            # another backend (spends its budget)
 * About 30 calls of ~150 tokens each. Prints one row per case and how many landed in their band:
 * high from OWN_FROM, low up to AI_UP_TO, mid anywhere from 0.15 to 0.85 (the middle may be wide).
 * Not part of `npm test`: it needs the live backend and the fast model.
 */

type Band = 'high' | 'mid' | 'low';
interface Case {
  band: Band;
  input: ScoreInput;
}

const think = (band: Band, text: string, prompt?: string): Case => ({
  band,
  input: { question: 'thinking', text, recent: prompt ? [{ role: 'user', text: prompt }] : [] },
});
const right = (band: Band, statement: string, reference: string): Case => ({ band, input: { question: 'correct', statement, reference } });

const VACCINES = 'Write me a summary of how vaccines train the immune system';
const VACCINES_ANSWER =
  'A vaccine shows the immune system a harmless piece or copy of a germ. The body makes antibodies and memory cells against it, so when the real germ comes, the immune system recognises it and reacts much faster.';
const BACKPROP = 'Write me a summary of backpropagation for my exam';
const BACKPROP_ANSWER =
  'Backpropagation computes how much each weight contributed to the error: it applies the chain rule from the output layer back to the input, and gradient descent then changes every weight a little against its gradient.';

const CASES: Case[] = [
  // The 18 cases of the first probe (score_eval.py, 17 Nov), wording unchanged.
  think('high', 'I think dropout works because it forces the network to not rely on single neurons, is that right?'),
  think('high', 'My guess: tides come from the moon pulling the near water more than the earth. So there should be one bulge?'),
  think('high', 'In my own words: overfitting is when the model memorises the training data instead of the pattern.'),
  think('high', 'I tried the chain rule on this and got dL/dw = dL/da * da/dz * dz/dw. Did I set it up correctly?'),
  think('mid', 'Why does a smaller learning rate help? Is it because big steps overshoot?'),
  think('mid', "Give me a hint how the chain rule shows up in backprop, don't tell me the answer."),
  think('mid', 'Can you quiz me on gradient descent?'),
  think('low', 'Write me a summary of backpropagation for my exam.'),
  think('low', 'Explain neural networks.'),
  think('low', 'Solve exercise 3 for me and give me the final answer.'),
  think('low', 'What is the capital of Australia?'),
  think('low', 'Make this paragraph sound more academic: the model learns stuff from data.'),
  right('high', 'Ice floats because frozen water is less dense than liquid water.', 'Ice is less dense than liquid water because its hexagonal crystal structure holds the molecules further apart, so it floats.'),
  right('high', 'Backprop uses the chain rule to pass the error backwards layer by layer.', 'Backpropagation computes the gradient of the loss for every weight by applying the chain rule from the output layer back to the input.'),
  right('mid', 'Tides happen because the moon pulls the water on the near side.', 'The moon pulls the near water more than the earth, and the earth more than the far water, so there are two bulges, one on each side.'),
  right('low', 'The sky is blue because it reflects the ocean.', 'The sky is blue because air molecules scatter short blue wavelengths of sunlight much more than long red ones (Rayleigh scattering).'),
  right('low', 'A higher learning rate always makes training converge faster and better.', 'A learning rate that is too high makes the steps overshoot the minimum, so training can diverge; too low is slow.'),
  right('low', 'idk', 'Vaccines show the immune system a harmless piece of the germ so that memory cells react faster next time.'),
  // Predict → reveal: a guess typed before reading the answer, with the prompt as context.
  think('high', 'it shows the body a harmless copy of the germ so memory cells react faster next time', VACCINES),
  think('high', 'it goes backwards through the layers with the chain rule', BACKPROP),
  think('mid', 'something with the blood?', VACCINES),
  think('low', 'no idea', VACCINES),
  think('low', 'idk', BACKPROP),
  right('high', 'it shows the body a harmless copy of the germ so memory cells react faster next time', VACCINES_ANSWER),
  right('high', 'it goes backwards through the layers with the chain rule', BACKPROP_ANSWER),
  right('low', 'the vaccine kills the germs directly, like an antibiotic', VACCINES_ANSWER),
  right('low', 'it picks random weights until the error is small', BACKPROP_ANSWER),
  right('low', 'no idea', VACCINES_ANSWER),
];

const inBand = (band: Band, p: number) => (band === 'high' ? p >= OWN_FROM : band === 'low' ? p <= AI_UP_TO : p >= 0.15 && p <= 0.85);

it('fast scores land in their bands', async () => {
  vi.stubEnv('VITE_API_URL', import.meta.env.VITE_API_URL || 'http://localhost:8787');
  // Count the tokens the backend reports, to keep an eye on the budget.
  const tokens = { input: 0, output: 0 };
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

  const rows: string[] = [];
  let ok = 0;
  let model = '';
  for (const c of CASES) {
    const started = performance.now();
    const r = await provider.score(c.input, new AbortController().signal);
    const ms = Math.round(performance.now() - started);
    model = r.model ?? model;
    const good = inBand(c.band, r.p);
    ok += Number(good);
    const what = c.input.question === 'thinking' ? `${c.input.recent.length ? 'guess ' : ''}${c.input.text}` : c.input.statement;
    rows.push(`| ${c.input.question} | ${c.band} | ${r.p.toFixed(3)} | ${good ? 'ok' : 'OFF'} | ${ms} | ${what.slice(0, 70)} |`);
  }
  console.log(
    [
      `model ${model} · ${ok}/${CASES.length} in band · tokens ${tokens.input} in, ${tokens.output} out`,
      '| question | expected | P(1) | band | ms | text |',
      '|---|---|---|---|---|---|',
      ...rows,
    ].join('\n'),
  );
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(rows).toHaveLength(CASES.length);
});
