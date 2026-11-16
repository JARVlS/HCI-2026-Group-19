import { describe, expect, it } from 'vitest';
import { DEMO_PROMPTS } from '../data/scenario';
import { classify } from './classify';

/** The words each evidence span points at, read back from the raw text. */
const spans = (text: string) => (classify(text).evidence ?? []).map((e) => text.slice(e.start, e.end));

describe('classify: demo prompts', () => {
  // Locks in the linter's behaviour before the M1 refactor. If a rule changes on purpose,
  // update the snapshot with `npx vitest run -u` and review the diff.
  it.each(DEMO_PROMPTS)('%s', (prompt) => {
    expect(classify(prompt)).toMatchSnapshot();
  });

  it('labels the README demo prompts as the demo script expects', () => {
    expect(classify('Write me a summary of backpropagation for my exam').mode).toBe('ai');
    expect(classify('Quiz me on the loss function').mode).toBe('together');
    expect(classify('I think overfitting is when the model memorizes the training data instead of learning the pattern').mode).toBe('own');
    expect(classify('Give me a hint: how does the learning rate affect training?').mode).toBe('together');
    expect(classify('What is dropout?').mode).toBe('ai');
  });
});

describe('classify: evidence', () => {
  it('points at the delegating words in the raw text', () => {
    expect(spans('Write me a summary of backpropagation for my exam')).toEqual(['Write', 'summary']);
  });

  it('keeps offsets aligned with leading whitespace', () => {
    expect(spans('   Write me a summary')).toEqual(['Write', 'summary']);
  });

  it('treats curly apostrophes like straight ones, with offsets into the original', () => {
    const curly = 'I’d say the gradient points uphill';
    const straight = "I'd say the gradient points uphill";
    expect(classify(curly).mode).toBe('own');
    expect(classify(curly).mode).toBe(classify(straight).mode);
    expect(spans(curly)).toEqual(['I’d say']);
  });

  it('only returns spans with real positions', () => {
    // Short request: a reason without particular words → no evidence span.
    const c = classify('dropout');
    expect(c.reasons).toHaveLength(1);
    expect(c.evidence).toEqual([]);
  });
});

describe('classify: edge cases', () => {
  it('returns an empty, zero-confidence label for empty input', () => {
    for (const text of ['', '   ', '\n\t']) {
      expect(classify(text)).toEqual({ mode: 'together', confidence: 0, reasons: [], evidence: [] });
    }
  });

  it('ignores the untouched nudge template', () => {
    expect(classify('my first guess:').confidence).toBe(0);
    expect(classify('Write me a summary\n\nmy first guess:')).toEqual(classify('Write me a summary'));
  });

  it('caps confidence below 1', () => {
    const c = classify('I think my guess is that in my own words, I tried this: is that right?');
    expect(c.mode).toBe('own');
    expect(c.confidence).toBeLessThanOrEqual(0.95);
  });

  it('turns own thinking plus a stronger delegation into "together"', () => {
    // own: "i think" (1) < ai: leading "Write" (1) + "summary" (0.8)
    const c = classify('Write a summary of backprop, I think it is the chain rule');
    expect(c.mode).toBe('together');
  });
});

describe('classify: pending quiz', () => {
  it('counts an answer to a quiz question as own thinking', () => {
    const c = classify('it measures how far off the predictions are', { pendingQuiz: 'loss' });
    expect(c.mode).toBe('own');
    expect(c.confidence).toBe(0.9);
  });

  it('counts giving up as delegating, with evidence', () => {
    const text = "honestly I don't know";
    const c = classify(text, { pendingQuiz: 'loss' });
    expect(c.mode).toBe('ai');
    expect(c.evidence?.map((e) => text.slice(e.start, e.end))).toEqual(["I don't know"]);
  });

  it('asking for another quiz bypasses the quiz path', () => {
    expect(classify('quiz me on dropout', { pendingQuiz: 'loss' })).toEqual(classify('quiz me on dropout'));
  });
});
