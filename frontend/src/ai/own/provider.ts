import type { ProviderKind } from '../../lib/domain';
import { MODES } from '../../lib/modes';
import { ArborProvider, LIVE_PROMPTS } from '../arbor/provider';
import { ANALYZE_SYSTEM, analyzeMessage } from '../prompts/analyze';
import { chatMessages, chatSystem } from '../prompts/chat';
import { scorePrompt } from '../prompts/score';
import type { ChatRequest, ChatResult, JsonTask, JsonTasks, Provider, ProviderErrorCode, ScoreInput, ScoreResult } from '../provider';
import { ProviderError } from '../provider';
import { TURN_ANALYSIS_SCHEMA, toTurnAnalysis } from '../schemas/turnAnalysis';
import { Anthropic } from './anthropic';
import { withModelList, type Target } from './http';
import type { Keys } from './keys';
import { OpenAICompatible, SCORES_FIX } from './openai';
import { kindOf, resolve, type OwnSetup, type Role } from './setup';
import type { JsonCall, JsonMode, ModelApi } from './types';

/**
 * Provider choice `own` (IMPLEMENTATION_PLAN.md ADR-4, M7): live mode like `arbor` (chats are saved
 * on the group's backend), but each model call goes to the connection the user set for its role:
 * chat, analysis or scores. A connection is the group's backend (then `ArborProvider` answers), the
 * Anthropic API with the user's key, or any OpenAI-compatible endpoint. Prompts and schemas are the
 * same as for `arbor` (`ai/prompts/*`), so every connection behaves alike.
 * Setup and keys are read at each call, so a change in settings applies from the next call.
 */

export interface OwnState {
  setup: OwnSetup;
  keys: Keys;
}

/** What a role's connection is, ready to call. */
type Link = { kind: 'off' } | { kind: 'arbor' } | { kind: 'anthropic'; api: Anthropic } | { kind: 'openai-compatible'; api: OpenAICompatible };

export const CLAUDE_NO_SCORES = `Claude's API returns no token probabilities, so an Anthropic connection cannot give scores. ${SCORES_FIX}`;

/** The result of test connection for one role. */
export type RoleCheck =
  | { status: 'skipped'; why: 'arbor' | 'off' }
  | { status: 'ok'; model: string; ms: number; mode?: JsonMode; p?: number }
  | { status: 'failed'; error: string; code: ProviderErrorCode };
export type TestReport = Record<Role, RoleCheck>;

/** The tiny structured call of test connection: the schema features the turn analysis uses (enum, nullable, list of closed objects). */
const TEST_JSON: JsonCall<{ mode: string }> = {
  name: 'connection_test',
  system: 'You test a connection. Fill in the JSON as asked.',
  user: 'Set mode to "own", note to null and words to one item with the word "tree".',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'note', 'words'],
    properties: {
      mode: { type: 'string', enum: [...MODES] },
      note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      words: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['word'], properties: { word: { type: 'string' } } } },
    },
  },
  read(raw) {
    const r = raw as { mode?: unknown; words?: unknown } | null;
    if (!MODES.includes(r?.mode as never) || !Array.isArray(r?.words)) throw new ProviderError('the test answer did not fit its schema', 'invalid_output');
    return { mode: r.mode as string };
  },
};

const TEST_SCORE: ScoreInput = { question: 'correct', statement: 'Two plus two is four.', reference: 'Two plus two is four.' };

export class OwnProvider implements Provider {
  readonly label = 'your own model';
  readonly demoPrompts = LIVE_PROMPTS;

  constructor(
    private readonly own: () => OwnState,
    private readonly arbor: Provider = new ArborProvider(),
  ) {}

  /** Messages record where the reply came from: the chat connection's kind. */
  get kind(): ProviderKind {
    return kindOf(this.own().setup.chat);
  }

  private link(role: Role): Link {
    const { setup, keys } = this.own();
    const c = resolve(setup, role);
    if (c === 'off') return { kind: 'off' };
    const kind = kindOf(c);
    if (kind === 'arbor') return { kind };
    // "Same as chat" uses the chat's key too.
    const target: Target = { ...c, baseUrl: c.baseUrl.trim(), model: c.model.trim(), key: (setup[role] === 'same' ? keys.chat : keys[role]) ?? '' };
    return kind === 'anthropic' ? { kind, api: new Anthropic(target) } : { kind, api: new OpenAICompatible(target) };
  }

  /** Run a call; an unknown model gets the endpoint's list of models in its message. */
  private async run<T>(api: ModelApi, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      throw await withModelList(e, () => api.models());
    }
  }

  async chat(req: ChatRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<ChatResult> {
    const l = this.link('chat');
    if (l.kind === 'arbor') return this.arbor.chat(req, onDelta, signal);
    if (l.kind === 'off') throw new ProviderError('The chat has no connection.', 'unknown');
    const { text, model } = await this.run(l.api, () => l.api.chat({ system: chatSystem(req), messages: chatMessages(req) }, onDelta, signal));
    // No quiz task in live mode yet (see ArborProvider.canQuiz).
    return { text, model, pendingQuiz: null };
  }

  async json<K extends JsonTask>(task: K, input: JsonTasks[K]['input'], signal: AbortSignal): Promise<JsonTasks[K]['output']> {
    if (task !== 'analyze') throw new ProviderError(`The own-model provider has no task ${task}.`, 'unknown');
    const l = this.link('analysis');
    if (l.kind === 'arbor') return this.arbor.json(task, input, signal);
    if (l.kind === 'off') throw new ProviderError('The analysis has no connection.', 'unknown');
    const call: JsonCall<JsonTasks['analyze']['output']> = {
      name: 'turn_analysis',
      system: ANALYZE_SYSTEM,
      user: analyzeMessage(input),
      schema: TURN_ANALYSIS_SCHEMA,
      read: (raw) => toTurnAnalysis(raw, { hasSubject: Boolean(input.subjectId) }),
    };
    return (await this.run(l.api, () => l.api.json(call, signal))).value;
  }

  /** None while scores are off: then turns keep the analysis's numbers (turn.ts). */
  get score(): ((input: ScoreInput, signal: AbortSignal) => Promise<ScoreResult>) | undefined {
    return this.link('scores').kind === 'off' ? undefined : this.scoreWith;
  }

  private readonly scoreWith = async (input: ScoreInput, signal: AbortSignal): Promise<ScoreResult> => {
    const l = this.link('scores');
    if (l.kind === 'arbor') return this.arbor.score!(input, signal);
    if (l.kind === 'anthropic') throw new ProviderError(CLAUDE_NO_SCORES, 'no_scores');
    if (l.kind === 'off') throw new ProviderError('Scores are off.', 'unknown');
    return this.run(l.api, () => l.api.score(scorePrompt(input), signal));
  };

  /** See ArborProvider.canQuiz: no quiz task in live mode yet. */
  canQuiz() {
    return false;
  }

  /** The model ids of a role's endpoint, for the model field. The group's backend picks its own models: none. */
  async listModels(role: Role, signal?: AbortSignal): Promise<string[]> {
    const l = this.link(role);
    return l.kind === 'anthropic' || l.kind === 'openai-compatible' ? l.api.models(signal) : [];
  }

  /**
   * Test connection: per role one tiny call of the kind the role makes (a streamed chat, a
   * structured answer, a score), in parallel. Roles on the group's backend are not tested (its
   * tokens are the group's), nor are scores that are off.
   */
  async test(signal: AbortSignal): Promise<TestReport> {
    const timed = async (call: () => Promise<Omit<Extract<RoleCheck, { status: 'ok' }>, 'status' | 'ms'>>): Promise<RoleCheck> => {
      const start = performance.now();
      try {
        return { status: 'ok', ...(await call()), ms: Math.round(performance.now() - start) };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError(String(e));
        return { status: 'failed', error: err.message, code: err.code };
      }
    };
    const check = (role: Role, call: (l: Exclude<Link, { kind: 'off' | 'arbor' }>) => Promise<RoleCheck>): Promise<RoleCheck> => {
      const l = this.link(role);
      if (l.kind === 'off' || l.kind === 'arbor') return Promise.resolve({ status: 'skipped', why: l.kind });
      return call(l);
    };
    const [chat, analysis, scores] = await Promise.all([
      check('chat', (l) =>
        timed(async () => {
          const hello = { system: 'You test a connection. Answer in one word.', messages: [{ role: 'user' as const, content: 'Say hello.' }] };
          const { model } = await this.run(l.api, () => l.api.chat(hello, () => {}, signal));
          return { model };
        }),
      ),
      check('analysis', (l) =>
        timed(async () => {
          const { model, mode } = await this.run(l.api, () => l.api.json(TEST_JSON, signal));
          return { model, mode };
        }),
      ),
      check('scores', (l) =>
        timed(async () => {
          if (l.kind === 'anthropic') throw new ProviderError(CLAUDE_NO_SCORES, 'no_scores');
          const { p, model } = await this.run(l.api, () => l.api.score(scorePrompt(TEST_SCORE), signal));
          return { p, model: model ?? '' };
        }),
      ),
    ]);
    return { chat, analysis, scores };
  }
}
