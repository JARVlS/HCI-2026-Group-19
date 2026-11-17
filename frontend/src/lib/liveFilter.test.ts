import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/storage';
import { classify } from './classify';
import updateVectors from './filter/update.vectors.json';
import { filterView, finishedWords, LEARNED_KEY, LiveFilter, MAX_LEARNED, tutorAsked, UNSURE_BELOW, type FilterState } from './liveFilter';
import { belief, features, rate, type Weights } from './thinkingFilter';
import type { ThinkingInput } from './turn';

const weights = async () => (await import('./filter/weights.json')).default as unknown as Weights;
const ASKED = [{ role: 'assistant' as const, text: 'Which rock is it?' }];
const ask = (text: string, recent: ThinkingInput['recent'] = []): ThinkingInput => ({ question: 'thinking', text, recent });
const dist = (...p: number[]) => Object.fromEntries(p.map((x, i) => [String(i + 1), x]));
const ready = (f: LiveFilter) => f.snapshot() as Extract<FilterState, { status: 'ready' }>;
const estimateOf = (f: LiveFilter, text: string, asked = false) => rate(ready(f).model, text, asked, classify(text)).estimate;
/** `learn` returns at once and applies once the weights are in: after `start()` has settled. */
const TEXTS: Record<number, string> = { 39: 'zxqv blorf gnarp', 37: 'no no no no', 5: "I think that's igneous rock, right?" };

afterEach(() => vi.restoreAllMocks());

describe('live filter: loading', () => {
  it('loads the weights only when started, once', async () => {
    const load = vi.fn(weights);
    const f = new LiveFilter(memoryStorage(), load);
    expect([f.snapshot(), load.mock.calls.length]).toEqual([null, 0]);
    const started = f.start();
    expect(f.snapshot()).toEqual({ status: 'loading' });
    await Promise.all([started, f.start()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(ready(f)).toMatchObject({ status: 'ready', learned: 0 });
    expect(ready(f).model.counts.size).toBe(2741);
  });

  it('a failed load or weights for another scale is a visible failure, and learning does nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = memoryStorage();
    const broken = new LiveFilter(storage, async () => Promise.reject(new Error('offline')));
    await broken.start();
    expect(broken.snapshot()).toEqual({ status: 'failed', error: 'offline' });
    broken.learn(ask('I think it is granite'), dist(0, 0, 0, 1, 0));
    await broken.start();
    expect(storage.getItem(LEARNED_KEY)).toBeNull();
    const other = new LiveFilter(storage, async () => ({ ...(await weights()), levelWeights: [0, 0.5, 1, 1, 1] }));
    await other.start();
    expect(other.snapshot()).toMatchObject({ status: 'failed', error: expect.stringContaining('do not fit') });
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe('live filter: learning from the judge', () => {
  it('learns as nb.update does (the reference vectors), keeps it in localStorage, and is back after a reload', async () => {
    const storage = memoryStorage();
    const f = new LiveFilter(storage, weights);
    await f.start();
    for (const step of updateVectors.learn) {
      // The three drafts of the reference: two first messages and a reply to a question.
      const text = TEXTS[step.case];
      const asked = step.features.includes('@tutor_asked');
      expect(features(text, asked, classify(text))).toEqual(step.features);
      f.learn(ask(text, asked ? ASKED : []), dist(...step.distribution));
    }
    await f.start();
    expect(ready(f).learned).toBe(3);
    const check = (g: LiveFilter) => {
      const after = updateVectors.after[1];
      expect(ready(g).model.counts.size).toBe(after.vocabSize);
      updateVectors.learn.forEach((step) => {
        const b = belief(step.features, ready(g).model);
        b.forEach((x, k) => expect(Math.abs(x - after.cases[step.case].belief[k])).toBeLessThan(1e-6));
      });
    };
    check(f);
    expect(JSON.parse(storage.getItem(LEARNED_KEY)!)).toMatchObject({ version: '2026-11-17.2', n: 3 });
    const reloaded = new LiveFilter(storage, weights);
    await reloaded.start();
    expect(ready(reloaded).learned).toBe(3);
    check(reloaded);
  });

  it('never learns twice from the same text', async () => {
    const f = new LiveFilter(memoryStorage(), weights);
    f.learn(ask('I think it is granite'), dist(0, 0, 0, 1, 0));
    f.learn(ask('I think it is granite'), dist(0, 0, 0, 1, 0));
    await f.start();
    const once = estimateOf(f, 'I think it is granite');
    f.learn(ask('I think it is granite', ASKED), dist(1, 0, 0, 0, 0));
    await f.start();
    expect([ready(f).learned, estimateOf(f, 'I think it is granite')]).toEqual([1, once]);
  });

  it('counts learned on other weights are dropped; reset forgets', async () => {
    const storage = memoryStorage({ [LEARNED_KEY]: JSON.stringify({ version: '2026-11-17', n: 7, prior: [1, 0, 0, 0, 0], counts: { granite: [9, 0, 0, 0, 0] } }) });
    const f = new LiveFilter(storage, weights);
    await f.start();
    const shipped = estimateOf(f, 'granite');
    expect([ready(f).learned, storage.getItem(LEARNED_KEY)]).toEqual([0, null]);
    f.learn(ask('granite'), dist(1, 0, 0, 0, 0));
    await f.start();
    expect(estimateOf(f, 'granite')).toBeLessThan(shipped);
    f.reset();
    expect([ready(f).learned, estimateOf(f, 'granite'), storage.getItem(LEARNED_KEY)]).toEqual([0, shipped, null]);
    // After a reset the same text teaches again.
    f.learn(ask('granite'), dist(1, 0, 0, 0, 0));
    await f.start();
    expect(ready(f).learned).toBe(1);
  });

  it('unreadable stored counts are reported and the filter starts from its shipped weights', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = new LiveFilter(memoryStorage({ [LEARNED_KEY]: '{"version":' }), weights);
    await f.start();
    expect([ready(f).learned, error.mock.calls.length]).toEqual([0, 1]);
  });

  it(`keeps at most ${MAX_LEARNED} learned features in storage`, async () => {
    const storage = memoryStorage();
    const f = new LiveFilter(storage, weights);
    for (let m = 0; m < 4; m++) f.learn(ask(Array.from({ length: 80 }, (_, i) => `w${m}x${i}`).join(' ')), dist(0, 0, 0.5, 0.5, 0));
    await f.start();
    const kept = JSON.parse(storage.getItem(LEARNED_KEY)!) as { n: number; counts: Record<string, number[]> };
    expect([kept.n, Object.keys(kept.counts).length]).toEqual([4, MAX_LEARNED]);
  });

  it('a distribution without every option of the scale is reported, not learned', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = new LiveFilter(memoryStorage(), weights);
    f.learn(ask('I think so'), { '1': 1 });
    await f.start();
    expect([ready(f).learned, String(error.mock.calls[0][0])]).toEqual([0, expect.stringContaining('without every option')]);
  });
});

describe('live filter: the draft', () => {
  it('rates up to the last finished word: a space, punctuation or a line break ends a word', () => {
    expect(['I will do noth', 'I will do', 'Define entropy.', 'yes,\nno', "don't", 'one two  ', ''].map(finishedWords)).toEqual([
      'I will do ',
      'I will ',
      'Define entropy.',
      'yes,\n',
      '',
      'one two  ',
      '',
    ]);
  });

  it('the tutor asked when its last message ends with a question mark', () => {
    expect([tutorAsked([]), tutorAsked(ASKED), tutorAsked([{ role: 'assistant', text: 'Why? Think.' }]), tutorAsked([...ASKED, { role: 'user', text: 'hm?' }])]).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it('a view needs a finished word; it says when the filter is unsure and how it rates the anchor', async () => {
    const f = new LiveFilter(memoryStorage(), weights);
    await f.start();
    const m = ready(f).model;
    expect(filterView(m, '  ', false, null)).toBeNull();
    const v = filterView(m, 'Define entropy.', false, 'Define')!;
    const r = rate(m, 'Define entropy.', false, classify('Define entropy.'));
    expect(v).toEqual({ you: r.estimate, unsure: r.certainty < UNSURE_BELOW, anchorYou: rate(m, 'Define', false, classify('Define')).estimate });
    expect(v.you).toBeLessThan(0.2);
  });
});
