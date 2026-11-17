import type { AnalyzeInput, ChatRequest, Provider, TurnContext } from '../ai/provider';
import { isAbort, ProviderError } from '../ai/provider';
import type { TurnAnalysis } from '../ai/schemas/turnAnalysis';
import { looksLikeQuizAnswer } from './classify';
import type { Id, ISO, Message } from './domain';
import { resolveEvidence } from './evidence';
import { mergeAnalysis } from './graph';
import { treeOfConcept, treesOfConversation } from './links';
import { subjectOf } from './planner';
import { OTHER_BRANCH, projectForest } from './project';
import type { Action, State } from './state';
import type { Classification } from './types';

/**
 * One chat turn, end to end (IMPLEMENTATION_PLAN.md, M1):
 *   linter label → `user` → provider.chat (streamed deltas, AbortController) → `assistantDone`
 *   and, in parallel, provider.json('analyze') → merge into the graph → `analysisDone`.
 * The analysis is applied once the reply has started (or ended), so leaves grow when the answer
 * appears, as in the prototype. Persistence (enqueue sync) joins in M2.
 *
 * All effects go through `deps`, so tests run it with a fake provider and a plain reducer.
 */

export interface TurnDeps {
  provider: Provider;
  dispatch: (a: Action) => void;
  /** Must return the state after every dispatch so far (synchronous store). */
  getState: () => State;
  newId?: () => Id;
  now?: () => ISO;
}

export interface SendInput {
  text: string;
  /** The linter's label (shown until the analysis lands). */
  classification: Classification;
  /** Predict → reveal: hide the reply until the user guesses or reveals it. */
  veil?: boolean;
}

/** How many earlier turns the analysis sees (ADR-6). */
const RECENT_TURNS = 6;

const defaults = (deps: TurnDeps) => ({
  newId: deps.newId ?? (() => crypto.randomUUID()),
  now: deps.now ?? (() => new Date().toISOString()),
});

export async function sendTurn(deps: TurnDeps, input: SendInput, signal: AbortSignal): Promise<void> {
  const { newId, now } = defaults(deps);
  const text = input.text.trim();
  if (!text) return;
  const conversationId = deps.getState().session.activeConversationId;
  const user: Message = {
    id: newId(),
    role: 'user',
    text,
    classification: input.classification,
    conceptIds: [],
    conversationId,
    createdAt: now(),
    analysis: 'pending',
    provider: deps.provider.kind,
  };
  deps.dispatch({ type: 'user', msg: user });
  await reply(deps, user, Boolean(input.veil), signal);
}

/** Run the failed turn again: same user message, fresh reply. */
export async function retryTurn(deps: TurnDeps, signal: AbortSignal): Promise<void> {
  const { turn, activeConversationId } = deps.getState().session;
  if (turn.status !== 'error' || !turn.userMessageId || turn.conversationId !== activeConversationId) return;
  const user = deps.getState().domain.messagesByConv[activeConversationId]?.find((m) => m.id === turn.userMessageId);
  if (!user) return;
  deps.dispatch({ type: 'retryStart', conversationId: activeConversationId, userMessageId: user.id });
  await reply(deps, user, false, signal);
}

async function reply(deps: TurnDeps, user: Message, veil: boolean, signal: AbortSignal) {
  const { newId, now } = defaults(deps);
  const { provider, dispatch } = deps;
  const conversationId = user.conversationId;
  const before = deps.getState();
  const context = turnContext(before, conversationId, user);
  const transcript = (before.domain.messagesByConv[conversationId] ?? []).filter((m) => !m.error);
  const upto = transcript.slice(0, transcript.findIndex((m) => m.id === user.id) + 1);

  // The analysis is not stopped by the stop key: the user's message stands, and so does its label.
  const analysis = user.analysis === 'done' ? null : runAnalysis(provider, analyzeInput(before, user, context, upto));
  let applied = false;
  const apply = async () => {
    if (applied || !analysis) return;
    applied = true;
    const r = await analysis;
    if (r.ok) dispatch({ type: 'analysisDone', patch: patchOf(deps.getState(), user, r.value, context, provider, newId) });
    else dispatch({ type: 'analysisFailed', conversationId, userMessageId: user.id });
  };

  const req: ChatRequest = { conversationId, messages: upto.map((m) => ({ role: m.role, text: m.text })), context };
  let assistantId: Id | null = null;
  let text = '';
  const start = (first: string) => {
    assistantId = newId();
    dispatch({
      type: 'assistantStart',
      userMessageId: user.id,
      msg: {
        id: assistantId,
        role: 'assistant',
        text: first,
        conceptIds: [],
        streaming: true,
        veiled: veil || undefined,
        conversationId,
        createdAt: now(),
        provider: provider.kind,
      },
    });
    void apply();
  };

  try {
    const result = await provider.chat(
      req,
      (delta) => {
        text += delta;
        if (!assistantId) start(text);
        else dispatch({ type: 'stream', conversationId, id: assistantId, text });
      },
      signal,
    );
    if (!assistantId) start(result.text);
    dispatch({ type: 'assistantDone', conversationId, id: assistantId!, text: result.text || text, pendingQuiz: result.pendingQuiz, reflectOn: result.reflectOn, model: result.model });
  } catch (e) {
    if (signal.aborted || isAbort(e)) {
      if (assistantId) dispatch({ type: 'assistantDone', conversationId, id: assistantId, text, stopped: true });
      else dispatch({ type: 'turnStopped', conversationId, userMessageId: user.id });
    } else {
      dispatch({ type: 'turnError', conversationId, userMessageId: user.id, assistantMessageId: assistantId ?? undefined, error: errorText(e) });
    }
  } finally {
    await apply();
  }
}

async function runAnalysis(provider: Provider, input: AnalyzeInput): Promise<{ ok: true; value: TurnAnalysis } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await provider.json('analyze', input, new AbortController().signal) };
  } catch (error) {
    return { ok: false, error };
  }
}

export const isQuizAnswer = (provider: Provider, text: string, quizId: Id | null) =>
  Boolean(quizId) && (provider.isQuizAnswer ? provider.isQuizAnswer(text, quizId!) : looksLikeQuizAnswer(text, quizId));

export const DAILY_BUDGET = 'Your daily budget for live answers is used up. It resets at midnight UTC. Until then, switch to the scripted demo in settings.';
export const PROJECT_BUDGET =
  'The project’s budget for live answers is used up (all users together). It does not reset by itself. Switch to the scripted demo in settings.';

/** What the error line under a failed turn says. A used-up budget gets a sentence, not the raw error. */
export function errorText(e: unknown): string {
  if (e instanceof ProviderError && e.code === 'budget_exceeded') return /\b(project|total)\b/i.test(e.message) ? PROJECT_BUDGET : DAILY_BUDGET;
  return (e instanceof Error ? e.message : String(e)) || 'something went wrong';
}

/** What the assistant should know about this turn. */
export function turnContext(s: State, conversationId: Id, user: Message): TurnContext {
  const pendingQuiz = conversationId === s.session.activeConversationId ? s.session.pendingQuiz : null;
  const { trees, concepts, attempts } = s.domain;
  const membership = treeOfConcept(trees, concepts);
  const mine = new Set(treesOfConversation(conversationId, { attempts, membership }));
  const known = projectForest(trees.filter((t) => mine.has(t.id)), concepts, attempts)
    .flatMap((t) => t.branches.filter((b) => b.id !== OTHER_BRANCH.id).flatMap((b) => b.leaves))
    .map((l) => ({ id: l.id, label: l.label, score: l.score }));
  return {
    mode: user.classification?.mode ?? 'together',
    pendingQuiz,
    known,
    nudge: s.settings.enabled ? s.settings.nudge : 'off',
    studyMode: s.domain.conversations[conversationId]?.studyMode ?? false,
  };
}

function analyzeInput(s: State, user: Message, context: TurnContext, upto: Message[]): AnalyzeInput {
  const conv = s.domain.conversations[user.conversationId];
  const subjectId = conv?.subjectId ?? null;
  // The subject's part of the graph; a chat without a subject yet sees the subjects to pick from.
  const graph = Object.values(s.domain.concepts)
    .filter((c) => !c.deletedAt && (subjectId ? subjectOf(c.id, s.domain.concepts) === subjectId : c.kind === 'subject'))
    .map(({ id, label, kind, parentId }) => ({ id, label, kind, parentId }));
  return {
    conversationId: user.conversationId,
    text: user.text,
    linter: user.classification ?? { mode: 'together', confidence: 0, reasons: [] },
    recent: upto.slice(0, -1).slice(-RECENT_TURNS * 2).map((m) => ({ role: m.role, text: m.text })),
    context,
    graph,
    subjectId,
  };
}

function patchOf(s: State, user: Message, a: TurnAnalysis, context: TurnContext, provider: Provider, newId: () => Id) {
  const { concepts, trees, attempts, conversations } = s.domain;
  const conv = conversations[user.conversationId];
  const membership = treeOfConcept(trees, concepts);
  const home = treesOfConversation(user.conversationId, { attempts, membership })[0];
  const fallbackParentId = trees.find((t) => t.id === home)?.rootConceptId ?? conv?.subjectId ?? null;
  const quiz = context.pendingQuiz && isQuizAnswer(provider, user.text, context.pendingQuiz);
  const merged = mergeAnalysis(concepts, a, {
    conversationId: user.conversationId,
    messageId: user.id,
    text: user.text,
    now: user.createdAt,
    newId,
    source: quiz ? 'quiz' : 'prompt',
    fallbackParentId,
  });
  const classification: Classification = {
    mode: a.message.mode,
    confidence: a.message.confidence,
    reasons: a.message.reasons,
    evidence: resolveEvidence(user.text, a.message.evidence),
  };
  return { conversationId: user.conversationId, userMessageId: user.id, classification, ...merged, now: new Date().toISOString() };
}
