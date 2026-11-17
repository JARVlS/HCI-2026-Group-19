import { expect, it, vi } from 'vitest';
import { ArborProvider } from '../src/ai/arbor/provider';
import type { ScoreInput } from '../src/ai/provider';
import { api } from '../src/lib/api';
import { thinkingMode } from '../src/lib/modes';
import { createSession } from '../src/lib/session';

/**
 * A small eval of the fast scores (`src/ai/prompts/score.ts`, rating scales) against a running backend:
 *   npm run eval:score                                   # local backend on http://localhost:8787
 *   VITE_API_URL=https://… npm run eval:score            # another backend (spends its budget)
 * About 40 calls of ~300 tokens each. Prints one row per case (score in percent, the label it gives
 * for "thinking" and "guess") and how many landed in their band. Not part of `npm test`: it needs
 * the live backend and the fast model.
 */

/** Expected score in percent, [low, high]. */
type Band = [number, number];
interface Case {
  band: Band;
  input: ScoreInput;
}

const think = (band: Band, text: string): Case => ({ band, input: { question: 'thinking', text, recent: [] } });
const guess = (band: Band, prompt: string, g: string): Case => ({ band, input: { question: 'guess', prompt, guess: g } });
const right = (band: Band, statement: string, reference: string): Case => ({ band, input: { question: 'correct', statement, reference } });

const VACCINES = 'Write me a short summary of how vaccines train the immune system';
const VACCINES_ANSWER =
  'A vaccine shows the immune system a harmless piece or copy of a germ. The body makes antibodies and memory cells against it, so when the real germ comes, the immune system recognises it and reacts much faster. Why do you think some vaccines need a booster?';
const BACKPROP = 'Write me a summary of backpropagation for my exam';
const BACKPROP_ANSWER =
  'Backpropagation computes how much each weight contributed to the error: it applies the chain rule from the output layer back to the input, and gradient descent then changes every weight a little against its gradient.';

const CASES: Case[] = [
  // The 21 thinking and 8 correctness cases of scale_eval.py (17 Nov), bands unchanged.
  think([60, 100], 'I think the seasons happen because the earth is closer to the sun in summer.'),
  think([60, 100], 'I think heavier objects fall faster than light ones.'),
  think([60, 100], 'My guess is that antibiotics kill viruses.'),
  think([60, 100], 'I believe a neural network with more layers always performs better.'),
  think([60, 100], 'The moon makes its own light, right?'),
  think([60, 100], 'So basically evolution means animals change because they want to.'),
  think([85, 100], 'I think dropout works because it forces the network to not rely on single neurons, is that right?'),
  think([85, 100], 'In my own words: overfitting is when the model memorises the training data instead of the pattern.'),
  think([85, 100], 'I tried the chain rule on this and got dL/dw = dL/da * da/dz * dz/dw. Did I set it up correctly?'),
  think([50, 90], 'Why does a smaller learning rate help? Is it because big steps overshoot?'),
  think([35, 65], "Give me a hint how the chain rule shows up in backprop, don't tell me the answer."),
  think([35, 65], 'Can you quiz me on gradient descent?'),
  think([10, 40], 'Why is the sky blue?'),
  think([10, 40], 'How does backpropagation work?'),
  think([0, 15], 'Write me a summary of backpropagation for my exam.'),
  think([0, 15], VACCINES),
  think([0, 30], 'Explain neural networks.'),
  think([0, 15], 'Solve exercise 3 for me and give me the final answer.'),
  think([0, 15], 'What is the capital of Australia?'),
  think([0, 15], 'Make this paragraph sound more academic: the model learns stuff from data.'),
  think([0, 15], 'no idea, just tell me'),
  right([80, 100], 'Ice floats because frozen water is less dense than liquid water.', 'Ice is less dense than liquid water because its hexagonal crystal structure holds the molecules further apart, so it floats.'),
  right([80, 100], 'Backprop uses the chain rule to pass the error backwards layer by layer.', 'Backpropagation computes the gradient of the loss for every weight by applying the chain rule from the output layer back to the input.'),
  right(
    [30, 70],
    'Tides happen because the moon pulls the water on the near side.',
    'The moon pulls the near water more than the earth, and the earth more than the far water, so there are two bulges, one on each side. Can you say why the far side bulges too?',
  ),
  right(
    [0, 20],
    'The sky is blue because it reflects the ocean.',
    'The sky is blue because air molecules scatter short blue wavelengths of sunlight much more than long red ones (Rayleigh scattering). What do you think happens at sunset?',
  ),
  right(
    [0, 20],
    'The seasons happen because the earth is closer to the sun in summer.',
    "That is a common idea, but it is not the cause. The earth is closest to the sun in January. Seasons come from the tilt of the earth's axis. Which hemisphere leans toward the sun in June?",
  ),
  right([0, 20], 'A higher learning rate always makes training converge faster and better.', 'A learning rate that is too high makes the steps overshoot the minimum, so training can diverge; too low is slow.'),
  right([0, 10], 'idk', 'Vaccines show the immune system a harmless piece of the germ so that memory cells react faster next time.'),
  right([0, 10], 'no idea', 'Vaccines show the immune system a harmless piece of the germ so that memory cells react faster next time.'),
  // Predict → reveal: a guess typed before reading the answer, rated with the question as context.
  guess([60, 100], VACCINES, 'it shows the body a harmless copy of the germ so memory cells react faster next time'),
  guess([60, 100], BACKPROP, 'it goes backwards through the layers with the chain rule'),
  guess([60, 100], VACCINES, 'the vaccine itself kills the germs, like an antibiotic'),
  guess([35, 80], VACCINES, 'something with the blood?'),
  guess([0, 15], VACCINES, 'no idea'),
  guess([0, 15], BACKPROP, 'idk'),
  right([80, 100], 'it shows the body a harmless copy of the germ so memory cells react faster next time', VACCINES_ANSWER),
  right([80, 100], 'it goes backwards through the layers with the chain rule', BACKPROP_ANSWER),
  right([0, 20], 'the vaccine itself kills the germs, like an antibiotic', VACCINES_ANSWER),
  right([0, 20], 'it picks random weights until the error is small', BACKPROP_ANSWER),
  right([0, 10], 'no idea', VACCINES_ANSWER),
];

const about = (x: ScoreInput) => (x.question === 'thinking' ? x.text : x.question === 'guess' ? `guess: ${x.guess}` : x.statement);

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
    const percent = Math.round(r.p * 100);
    const good = percent >= c.band[0] && percent <= c.band[1];
    ok += Number(good);
    const label = c.input.question === 'correct' ? '' : thinkingMode(r.p);
    rows.push(`| ${c.input.question} | ${c.band[0]}–${c.band[1]} | ${percent} | ${label} | ${good ? 'ok' : 'OFF'} | ${ms} | ${about(c.input).slice(0, 70)} |`);
  }
  console.log(
    [
      `model ${model} · ${ok}/${CASES.length} in band · tokens ${tokens.input} in, ${tokens.output} out`,
      '| question | band % | score % | label | in band | ms | text |',
      '|---|---|---|---|---|---|---|',
      ...rows,
    ].join('\n'),
  );
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(rows).toHaveLength(CASES.length);
});
