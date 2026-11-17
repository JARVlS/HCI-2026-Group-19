import { GROVES, PAST_TREES } from '../../data/forest';
import { BRANCHES, CONCEPTS, CONCEPT_BY_ID, DEMO_PROMPTS, LIVE_TREE, SEED } from '../../data/scenario';
import { classify } from '../../lib/classify';
import type { Concept, ConceptAttempt, ConceptEdge, Conversation, Id, ISO, KnowledgeTree, Message, Mode } from '../../lib/domain';
import { slugify } from '../../lib/graph';
import { MODE_SCORE, scoreToMode } from '../../lib/modes';
import { daysAgo } from '../../lib/time';

/**
 * The demo world as canonical entities (IMPLEMENTATION_PLAN.md, M1): the scripted conversation
 * from `data/scenario.ts` and the past forest from `data/forest.ts`, loaded through the scripted
 * provider instead of being imported by the UI.
 *
 *   subjects (groves)  cs, stats, hci, …
 *   └ topic = tree root   nn "Neural networks", sql "SQL joins", …
 *     └ topic = branch      blocks "Building blocks", sql-b0 "Join types", …
 *       └ concept = leaf      neuron, backprop, sql-b0-l0 "Inner join", …
 *
 * Ids are the prototype's ids, so leaf identity (and the letter erosion seeded by it) is unchanged.
 * The same concept label in two trees is two concepts joined by a `related` edge: the hierarchy is
 * a strict forest, and the edge is what draws a root between the trees.
 */

export const LIVE_CONVERSATION_ID = 'c-nn';

export interface DemoFixture {
  concepts: Record<Id, Concept>;
  edges: ConceptEdge[];
  trees: KnowledgeTree[];
  conversations: Record<Id, Conversation>;
  messagesByConv: Record<Id, Message[]>;
  attempts: ConceptAttempt[];
  activeConversationId: Id;
  demoPrompts: string[];
}

export interface FixtureOptions {
  now?: number;
  /** The scripted conversation starts empty (`?empty=1`). */
  empty?: boolean;
}

export function demoFixture({ now = Date.now(), empty = false }: FixtureOptions = {}): DemoFixture {
  const today = new Date(now).toISOString();
  const concepts: Record<Id, Concept> = {};
  const add = (id: Id, label: string, kind: Concept['kind'], parentId: Id | null, at: ISO) => {
    concepts[id] = { id, label, slug: slugify(label), aliases: [], kind, parentId, createdBy: 'seed', createdAt: at, updatedAt: at };
  };

  for (const g of GROVES) add(g.id, g.label, 'subject', null, today);

  // The live conversation's subject tree: every scripted concept exists up front; leaves only
  // appear once a message touches them.
  add(LIVE_TREE.id, LIVE_TREE.title, 'topic', LIVE_TREE.grove, today);
  for (const [id, label] of Object.entries(BRANCHES)) if (id !== 'other') add(id, label, 'topic', LIVE_TREE.id, today);
  for (const c of CONCEPTS) add(c.id, c.label, 'concept', c.branch, today);

  const trees: KnowledgeTree[] = [
    { id: LIVE_TREE.id, rootConceptId: LIVE_TREE.id, title: LIVE_TREE.title, groveId: LIVE_TREE.grove, createdAt: today, updatedAt: today },
  ];
  const active: Conversation = {
    id: LIVE_CONVERSATION_ID,
    title: LIVE_TREE.chatTitle,
    subjectId: LIVE_TREE.grove,
    studyMode: false,
    createdAt: today,
    updatedAt: today,
  };
  const conversations: Record<Id, Conversation> = { [active.id]: active };
  const attempts: ConceptAttempt[] = [];
  const attempt = (conversationId: Id, messageId: Id, conceptId: Id, mode: Mode, at: ISO, id = `a:${messageId}:${conceptId}`): ConceptAttempt => ({
    id,
    conversationId,
    messageId,
    conceptId,
    mode,
    independence: MODE_SCORE[mode],
    correctness: null,
    confidence: 1,
    reasons: [],
    evidence: [],
    source: 'prompt',
    createdAt: at,
  });

  // Past chats: one conversation per tree, without messages (the demo has no transcript for them).
  for (const t of PAST_TREES) {
    const at = daysAgo(t.daysAgo, now);
    add(t.id, t.title, 'topic', t.grove, at);
    trees.push({ id: t.id, rootConceptId: t.id, title: t.title, groveId: t.grove, createdAt: at, updatedAt: at });
    const conversationId = `c-${t.id}`;
    conversations[conversationId] = { id: conversationId, title: t.title, subjectId: t.grove, studyMode: false, createdAt: at, updatedAt: at };
    for (const b of t.branches) {
      add(b.id, b.label, 'topic', t.id, at);
      for (const l of b.leaves) {
        add(l.id, l.label, 'concept', b.id, at);
        attempts.push(attempt(conversationId, `m:${l.id}`, l.id, scoreToMode(l.score), at, `a:${l.id}`));
      }
    }
  }

  // The live conversation, already under way.
  const messages: Message[] = [];
  if (!empty) {
    SEED.forEach((s, i) => {
      const at = new Date(now - (SEED.length - i) * 60_000).toISOString();
      const uid = `seed-${i}-u`;
      const classification = classify(s.user);
      const first = CONCEPT_BY_ID[s.concepts[0]];
      const base = { conversationId: LIVE_CONVERSATION_ID, createdAt: at, conceptIds: s.concepts, provider: 'scripted' as const };
      messages.push(
        { ...base, id: uid, role: 'user', text: s.user, classification, analysis: 'done' },
        { ...base, id: `seed-${i}-a`, role: 'assistant', text: first[s.variant], reflectOn: s.variant === 'full' ? first.id : undefined },
      );
      for (const c of s.concepts) attempts.push(attempt(LIVE_CONVERSATION_ID, uid, c, classification.mode, at));
    });
  }

  return {
    concepts,
    edges: relatedEdges(concepts, trees, today),
    trees,
    conversations,
    messagesByConv: { [active.id]: messages },
    attempts,
    activeConversationId: active.id,
    demoPrompts: [...DEMO_PROMPTS],
  };
}

/** Same-label concepts in different trees get a `related` edge (this is what draws roots). */
function relatedEdges(concepts: Record<Id, Concept>, trees: KnowledgeTree[], at: ISO): ConceptEdge[] {
  const roots = new Set(trees.map((t) => t.rootConceptId));
  const treeOf = (c: Concept) => {
    let cur: Concept | undefined = c;
    while (cur && !roots.has(cur.id)) cur = cur.parentId ? concepts[cur.parentId] : undefined;
    return cur?.id;
  };
  const bySlug = new Map<string, Concept[]>();
  for (const c of Object.values(concepts)) if (c.kind === 'concept') bySlug.set(c.slug, [...(bySlug.get(c.slug) ?? []), c]);
  const edges: ConceptEdge[] = [];
  for (const group of bySlug.values()) {
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        if (treeOf(group[i]) === treeOf(group[j])) continue;
        edges.push({ id: `e:${group[i].id}:${group[j].id}`, fromId: group[i].id, toId: group[j].id, kind: 'related', createdAt: at });
      }
  }
  return edges;
}
