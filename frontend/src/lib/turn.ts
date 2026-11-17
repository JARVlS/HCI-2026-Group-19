import type { AnalyzeInput, ChatRequest, Provider, ScoreInput, TurnContext } from '../ai/provider';
import { isAbort, ProviderError } from '../ai/provider';
import type { TurnAnalysis } from '../ai/schemas/turnAnalysis';
import { looksLikeQuizAnswer } from './classify';
import type { Id, ISO, Message } from './domain';
import { resolveEvidence } from './evidence';
import { mergeAnalysis } from './graph';
import { treeOfConcept, treesOfConversation } from './links';
import { subjectOf } from './planner';
import { OTHER_BRANCH, projectForest } from './project';
import { findMessage, type Action, type State } from './state';
import type { Classification, ScoreKey } from './types';

/**
 * One chat turn, end to end (IMPLEMENTATION_PLAN.md, M1):
 *   linter label → `user` → provider.chat (streamed deltas, AbortController) → `assistantDone`
 *   and, in parallel, provider.json('analyze') → merge into the graph → `analysisDone`.
 * The analysis is applied once the reply has started (or ended), so leaves grow when the answer
 * appears, as in the prototype. Saving is not done here: in live mode `sync.ts` sees every state
 * change and queues what changed (M2).
 *
 * Fast and slow (ADR-6): a provider with `score` also asks a fast model, in parallel, whether the
 * student thought along (`thinking`), and once the reply is complete whether an own claim that the
 * analysis found gradable is right (`correct`). A guess revealed at predict → reveal gets both
 * questions once the reply is complete (`scoreGuess`). Scores land on the user message as they
 * arrive; `scores.ts` turns them into the label and the attempts' numbers. Like the analysis, they
 * are not stopped by the stop key, and a failed score never fails the turn.
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
/** How many earlier messages the fast "thought along" score sees as context (a small, fast call). */
const SCORE_RECENT_MESSAGES = 4;

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
  // The fast score runs beside it (again on a retry, if it failed the first time).
  const thinking = user.scores?.thinking === undefined || user.scores.thinking === 'failed' ? scoreThinking(deps, user, upto) : null;
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

  let complete = false;
  let guessed: Promise<unknown> | null = null;
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
    complete = true;
  } catch (e) {
    if (signal.aborted || isAbort(e)) {
      if (assistantId) dispatch({ type: 'assistantDone', conversationId, id: assistantId, text, stopped: true });
      else dispatch({ type: 'turnStopped', conversationId, userMessageId: user.id });
    } else {
      dispatch({ type: 'turnError', conversationId, userMessageId: user.id, assistantMessageId: assistantId ?? undefined, error: errorText(e) });
    }
  } finally {
    // A guess revealed while the reply streamed is scored as soon as the reply is over.
    const replyId: Id | null = assistantId;
    if (replyId) guessed = scoreGuess(deps, replyId);
    await apply();
  }
  // With the analysis applied, an own claim it found gradable is graded against the complete
  // reply. A veiled reply is graded through its guess instead.
  const replyId: Id | null = assistantId;
  const graded = complete && !veil && replyId ? gradeClaim(deps, user.id, replyId) : null;
  await Promise.all([thinking, guessed, graded]);
}

/**
 * One fast score call. 'pending' is set at once (synchronously, so a second caller sees it), and
 * the score or the failure lands on the user message. Never rejects: a failed score is shown on
 * the message and leaves the analysis's numbers in place.
 */
function score(deps: TurnDeps, userMessageId: Id, key: ScoreKey, input: ScoreInput): Promise<void> {
  const { provider, dispatch } = deps;
  dispatch({ type: 'score', userMessageId, key, value: 'pending' });
  return provider.score!(input, new AbortController().signal).then(
    ({ p, model }) => dispatch({ type: 'score', userMessageId, key, value: model ? { p, model } : { p } }),
    () => dispatch({ type: 'score', userMessageId, key, value: 'failed' }),
  );
}

/** Did the student think along in this message? Earlier turns are context. */
function scoreThinking(deps: TurnDeps, user: Message, upto: Message[]) {
  if (!deps.provider.score) return null;
  const recent = upto.slice(0, -1).slice(-SCORE_RECENT_MESSAGES).map((m) => ({ role: m.role, text: m.text }));
  return score(deps, user.id, 'thinking', { question: 'thinking', text: user.text, recent });
}

/** An own claim the analysis found gradable: is it right, judged against the complete reply? */
function gradeClaim(deps: TurnDeps, userMessageId: Id, replyId: Id) {
  const { domain } = deps.getState();
  const user = findMessage(domain, userMessageId)?.msg;
  const reply = findMessage(domain, replyId)?.msg;
  const gradable = domain.attempts.some((a) => a.messageId === userMessageId && !a.supersededBy && a.correctness !== null);
  if (!user?.scores || !reply || !gradable || user.scores.correct !== undefined) return null;
  return score(deps, userMessageId, 'correct', { question: 'correct', statement: user.text, reference: reply.text });
}

/**
 * Predict → reveal with a scoring provider: once the reply is complete, a revealed guess gets two
 * questions: did the student think along in it (with their prompt as context; "no idea" scores
 * low), and is it right, judged against the reply. A stopped or failed reply is not the full
 * answer, so then there is no "right". Runs once per guess, from whichever comes last: the end of
 * the reply or the reveal.
 */
export function scoreGuess(deps: TurnDeps, replyId: Id): Promise<unknown> | null {
  if (!deps.provider.score) return null;
  const { domain } = deps.getState();
  const found = findMessage(domain, replyId);
  if (!found) return null;
  const reply = found.msg;
  const user = domain.messagesByConv[found.conversationId].slice(0, found.index).filter((m) => m.role === 'user').at(-1);
  if (!reply.guess || reply.streaming || !user?.scores || user.scores.guess !== undefined) return null;
  return Promise.all([
    score(deps, user.id, 'guess', { question: 'thinking', text: reply.guess, recent: [{ role: 'user', text: user.text }] }),
    reply.stopped || reply.error ? null : score(deps, user.id, 'correct', { question: 'correct', statement: reply.guess, reference: reply.text }),
  ]);
}

/** Reveal a veiled reply, with or without a guess. With a scoring provider the guess is scored (see `scoreGuess`). */
export async function revealTurn(deps: TurnDeps, replyId: Id, guess: string): Promise<void> {
  deps.dispatch({ type: 'reveal', id: replyId, guess });
  await scoreGuess(deps, replyId);
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
