import { api, ApiError, apiStream } from '../../lib/api';
import { session as browserSession, type Session } from '../../lib/session';
import { ANALYZE_SYSTEM, analyzeMessage } from '../prompts/analyze';
import { chatMessages, chatSystem } from '../prompts/chat';
import { NO, scorePrompt, YES } from '../prompts/score';
import type { ChatRequest, ChatResult, JsonTask, JsonTasks, Provider, ScoreInput, ScoreResult } from '../provider';
import { ProviderError } from '../provider';
import { TURN_ANALYSIS_SCHEMA, toTurnAnalysis } from '../schemas/turnAnalysis';

/**
 * Claude through the group's backend relay (IMPLEMENTATION_PLAN.md ADR-3/ADR-4, backend/docs/api.md):
 * the frontend renders prompts and schemas, the backend picks the model, caps tokens and keeps the
 * budgets. Chat streams over SSE; the analysis is one structured call. Scores come from a fast
 * non-Claude model behind `/api/ai/score`, because Claude's API returns no token probabilities.
 */

const COMPLETE = '/api/ai/complete';
const SCORE = '/api/ai/score';

interface Done {
  model: string;
  truncated: boolean;
}

/** Any failure → a ProviderError the UI can explain. The budget errors keep the backend's message (it says which budget). */
export function toProviderError(e: unknown, signal?: AbortSignal): ProviderError {
  if (e instanceof ProviderError) return e;
  if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return new ProviderError('stopped', 'aborted');
  if (!(e instanceof ApiError)) return new ProviderError(e instanceof Error ? e.message : String(e), 'unknown');
  if (e.status === 429) return new ProviderError(e.message, 'budget_exceeded');
  if (e.code === 'network') return new ProviderError(e.message, 'network');
  if (e.code === 'invalid_model_output' || e.code === 'output_truncated') return new ProviderError(e.message, 'invalid_output');
  if (e.status >= 500 || e.code.startsWith('upstream') || e.code === 'bad_stream') return new ProviderError(e.message, 'upstream');
  return new ProviderError(e.message, 'unknown');
}

/** Generic prompts for `tab`: one delegating, one exploring, one of your own. The scripted ones only fit its script. */
export const LIVE_PROMPTS = [
  'Write me a short summary of how vaccines train the immune system',
  'Why do some vaccines need a booster shot?',
  'I think a vaccine shows the body a harmless copy of the germ, so it reacts faster the next time',
];

export class ArborProvider implements Provider {
  readonly kind = 'arbor' as const;
  readonly label = 'Claude via the Arbor backend';
  readonly demoPrompts = LIVE_PROMPTS;

  constructor(private readonly session: Session = browserSession) {}

  async chat(req: ChatRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<ChatResult> {
    const body = { task: 'chat', stream: true, system: chatSystem(req), messages: chatMessages(req) };
    let text = '';
    try {
      const done = await this.session.run(async (token) => {
        for await (const { event, data } of apiStream(COMPLETE, body, { token, signal })) {
          const d = data as Record<string, unknown>;
          if (event === 'delta' && typeof d.text === 'string') {
            text += d.text;
            onDelta(d.text);
          } else if (event === 'done') return d as unknown as Done;
          else if (event === 'error') throw new ApiError(200, String(d.code ?? 'upstream_error'), String(d.message ?? 'The reply failed.'));
        }
        // The backend always ends with done or error; without one, the connection broke.
        throw new ApiError(0, 'network', 'The reply broke off before it was complete.');
      });
      // A quiz needs a concept to grade against; the live tutor only asks one in plain chat (see canQuiz).
      return { text, model: done.model, pendingQuiz: null };
    } catch (e) {
      throw toProviderError(e, signal);
    }
  }

  async json<K extends JsonTask>(task: K, input: JsonTasks[K]['input'], signal: AbortSignal): Promise<JsonTasks[K]['output']> {
    if (task !== 'analyze') throw new ProviderError(`The arbor provider has no task ${task}.`, 'unknown');
    const body = { task, system: ANALYZE_SYSTEM, messages: [{ role: 'user', content: analyzeMessage(input) }], schema: TURN_ANALYSIS_SCHEMA };
    let output: unknown;
    try {
      ({ output } = await this.session.run((token) => api<{ output: unknown }>(COMPLETE, body, { token, signal })));
    } catch (e) {
      throw toProviderError(e, signal);
    }
    return toTurnAnalysis(output, { hasSubject: Boolean(input.subjectId) });
  }

  async score(input: ScoreInput, signal: AbortSignal): Promise<ScoreResult> {
    const body = { ...scorePrompt(input), options: [YES, NO] };
    let answer: { probabilities?: Record<string, unknown>; model?: unknown };
    try {
      answer = await this.session.run((token) => api<typeof answer>(SCORE, body, { token, signal }));
    } catch (e) {
      throw toProviderError(e, signal);
    }
    const p = answer.probabilities?.[YES];
    if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new ProviderError(`The score answer has no probability for "${YES}".`, 'invalid_output');
    return { p, ...(typeof answer.model === 'string' && { model: answer.model }) };
  }

  /**
   * Quizzes on a leaf need a `quiz` task that asks about that concept and keeps it pending, so the
   * answer is graded (M4/M5). Until then the live tutor does not offer them; `/quiz` still works as
   * a plain chat message.
   */
  canQuiz() {
    return false;
  }
}
