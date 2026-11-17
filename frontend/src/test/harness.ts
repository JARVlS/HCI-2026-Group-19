import { DEFAULT_SETUP } from '../ai/own/setup';
import { demoFixture } from '../ai/scripted/fixture';
import { ScriptedProvider } from '../ai/scripted/provider';
import type { Provider } from '../ai/provider';
import { newConversation } from '../lib/chats';
import { classify } from '../lib/classify';
import { treeOfConcept, treesOfConversation } from '../lib/links';
import { projectForest } from '../lib/project';
import { activeMessages, reducer, type Action, type State } from '../lib/state';
import { isQuizAnswer, revealTurn, sendTurn, type TurnDeps } from '../lib/turn';

/**
 * A store without React: the reducer plus a synchronous getState, as `turn.ts` expects.
 * Default: the scripted demo world. `fresh`: what a first live visit starts with, one new empty chat.
 */
export function testStore(opts: { empty?: boolean; fresh?: boolean; provider?: Provider; now?: number } = {}) {
  const now = opts.now ?? Date.parse('2026-11-07T12:00:00Z');
  const chat = newConversation('chat-1', new Date(now).toISOString());
  const f = opts.fresh
    ? { conversations: { [chat.id]: chat }, messagesByConv: { [chat.id]: [] }, concepts: {}, edges: [], trees: [], attempts: [], activeConversationId: chat.id, demoPrompts: [] }
    : demoFixture({ empty: opts.empty, now });
  let state: State = {
    domain: { conversations: f.conversations, messagesByConv: f.messagesByConv, concepts: f.concepts, edges: f.edges, trees: f.trees, attempts: f.attempts },
    session: { activeConversationId: f.activeConversationId, pendingQuiz: null, turn: { status: 'idle' }, demoPrompts: f.demoPrompts, boot: 'ready', chatLoad: {} },
    ui: {
      panelOpen: true,
      forest: { open: false, focus: null },
      draft: { text: '', nonce: 0 },
      highlight: [],
      composer: { lens: null, nudge: false },
      flash: null,
      onboarding: false,
      toast: null,
      paneTreeId: null,
      chats: false,
    },
    settings: { enabled: true, nudge: 'active', showTags: true, theme: 'system', mascot: true, design: 'ascii', provider: 'scripted', own: DEFAULT_SETUP },
  };
  const actions: Action[] = [];
  const provider = opts.provider ?? new ScriptedProvider({ think: [0, 0], tick: 0, tokensPerTick: 4 });
  let n = 0;
  const deps: TurnDeps = {
    provider,
    dispatch: (a) => {
      actions.push(a);
      state = reducer(state, a);
    },
    getState: () => state,
    newId: () => `id${++n}`,
  };
  const classifyDraft = (text: string) => {
    const pq = state.session.pendingQuiz;
    return classify(text, { pendingQuiz: isQuizAnswer(provider, text, pq) ? pq : null });
  };
  return {
    deps,
    actions,
    get state() {
      return state;
    },
    send: (text: string, opts: { veil?: boolean; signal?: AbortSignal } = {}) =>
      sendTurn(deps, { text, classification: classifyDraft(text), veil: opts.veil }, opts.signal ?? new AbortController().signal),
    /** Reveal a veiled reply the way the app does (a scoring provider scores the guess). */
    reveal: (id: string, guess: string) => revealTurn(deps, id, guess),
    messages: () => activeMessages(state),
    /** The trees the active chat grew, projected. */
    activeTrees: () => {
      const { trees, concepts, attempts } = state.domain;
      const ids = treesOfConversation(state.session.activeConversationId, { attempts, membership: treeOfConcept(trees, concepts) });
      const forest = projectForest(trees, concepts, attempts, { conversationId: state.session.activeConversationId, liveTreeIds: ids });
      return ids.map((id) => forest.find((t) => t.id === id)!);
    },
  };
}
