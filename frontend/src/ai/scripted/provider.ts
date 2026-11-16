import { CONCEPT_BY_ID, LIVE_TREE } from '../../data/scenario';
import { quotesOf } from '../../lib/evidence';
import { MODE_SCORE } from '../../lib/modes';
import type { AnalyzeInput, ChatRequest, ChatResult, JsonTask, JsonTasks, Provider, TurnContext } from '../provider';
import { sleep } from '../provider';
import type { TurnAnalysis } from '../schemas/turnAnalysis';
import { gradeQuizAnswer, looksLikeQuizAnswer, respond } from './engine';

export interface ScriptedTiming {
  /** Pause before the reply starts, in ms: [min, max). */
  think: [number, number];
  /** Pause between streamed chunks, in ms. */
  tick: number;
  /** Tokens per chunk, where words and runs of whitespace each count as one. */
  tokensPerTick: number;
}

const DEMO_TIMING: ScriptedTiming = { think: [650, 1050], tick: 28, tokensPerTick: 4 };

/**
 * The "Wizard of Oz" assistant behind the Provider seam: scripted replies (`engine.ts`), the
 * rule-based classifier as its analysis, and fake streaming. Offline, deterministic apart from
 * the think pause, and the default until the backend relay lands (M3). Also the fallback for
 * demos (`?demo=1`, M2) and the fake provider in tests (timing 0).
 */
export class ScriptedProvider implements Provider {
  readonly kind = 'scripted' as const;
  readonly label = 'scripted demo';

  constructor(private readonly timing: ScriptedTiming = DEMO_TIMING) {}

  private reply(text: string, ctx: TurnContext) {
    const pendingQuiz = ctx.pendingQuiz && looksLikeQuizAnswer(text, ctx.pendingQuiz) ? ctx.pendingQuiz : null;
    return { pendingQuiz, result: respond({ text, mode: ctx.mode, pendingQuiz, known: ctx.known.map(({ id, score }) => ({ id, score })) }) };
  }

  async chat(req: ChatRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<ChatResult> {
    const text = req.messages.at(-1)?.text ?? '';
    const { result } = this.reply(text, req.context);
    const [lo, hi] = this.timing.think;
    await sleep(lo + Math.random() * (hi - lo), signal);
    const tokens = result.reply.split(/(\s+)/);
    for (let i = 0; i < tokens.length; ) {
      const j = Math.min(tokens.length, i + this.timing.tokensPerTick);
      onDelta(tokens.slice(i, j).join(''));
      i = j;
      if (i < tokens.length) await sleep(this.timing.tick, signal);
    }
    return { text: result.reply, pendingQuiz: result.pendingQuiz, reflectOn: result.reflectOn, model: 'script' };
  }

  async json<K extends JsonTask>(task: K, input: JsonTasks[K]['input'], signal: AbortSignal): Promise<JsonTasks[K]['output']> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (task !== 'analyze') throw new Error(`scripted provider: no task ${task}`);
    return this.analyze(input) as JsonTasks[K]['output'];
  }

  /** The linter's label, applied to every concept the scripted reply touched. */
  private analyze(input: AnalyzeInput): TurnAnalysis {
    const { pendingQuiz, result } = this.reply(input.text, input.context);
    const { mode, confidence, reasons } = input.linter;
    const correctness = pendingQuiz ? gradeQuizAnswer(input.text, pendingQuiz) : null;
    return {
      message: { mode, confidence, reasons, evidence: quotesOf(input.text, input.linter.evidence ?? []) },
      concepts: result.concepts.map((c) => ({
        ref: CONCEPT_BY_ID[c.id]
          ? { existingId: c.id }
          : { newNode: { label: c.label, kind: 'concept' as const, parent: { existingId: LIVE_TREE.id }, description: '' } },
        mode,
        independence: MODE_SCORE[mode],
        correctness,
        confidence,
        reason: reasons[0] ?? '',
      })),
    };
  }

  canQuiz(conceptId: string) {
    return Boolean(CONCEPT_BY_ID[conceptId]);
  }

  isQuizAnswer(text: string, quizConceptId: string) {
    return looksLikeQuizAnswer(text, quizConceptId);
  }
}
