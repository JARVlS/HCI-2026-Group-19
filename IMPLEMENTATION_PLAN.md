# Arbor hi-fi prototype: implementation plan (Project Milestone 4)

> Starting point for the `hifi` branch. Written for the team and for Claude Opus implementing it,
> one milestone per PR. Sections 2–4 are **decisions**: change them by editing this file in a PR,
> not silently in code.

**Hard dates** (course): M3 hand-in Dec 3 · study design to TA Dec 4/8 · deliverables Dec 17.
**Our dates:** feature freeze **Sat Dec 5** · pilot Dec 6–8 · study Dec 9–14.
Everything below the "stretch" line is post-study.

---

## 1. Where we start

| Part | State today |
|---|---|
| `frontend/` | React 19 + Vite + TS. Arbor prototype (Jonas): two designs (`ascii` default, `classic`) over one store. Fully scripted ("Wizard of Oz"), offline, single conversation. Deployed on Cloudflare Pages (`hci-2026-group-19`). |
| `backend/` | FastAPI on Cloudflare Python Workers (`hci-backend`). Only `/api/health` and `/api/echo`. CORS for localhost + Pages already set. |
| `frontend/src/lib/api.ts` | `api<T>(path, body?)`: JSON fetch against `VITE_API_URL`. No auth, no streaming. |
| branch `graph-prototype` | Leon's Vue + `force-graph` concept graph with `independence: 0–100` per node and hierarchical links. Not merged; its **data idea** is merged into §3. |

---

## 2. Honest assessment: build on it or rewrite?

**Verdict: build on it.** The UI and interaction layer (~75 % of the code) is good and stays.
The **logic core** (orchestration, assistant, concept identity, scoring, time) was written to fake
a single scripted chat. It has to be **re-implemented behind the existing types**, not patched.
The README says *"replace `respond()` and `classify()` with LLM calls that return the same shapes;
the UI does not need to change"*. That is true for the shapes but false in five places.

### Keep as is (UI and interaction layer)
- `designs/ascii/*`: transcript, composer, pane, forest, links, modeline, concepts sheet, squirrel.
- `shared/AsciiTreeView.tsx`, `lib/asciiTree.ts`: they consume `TreeData` only. Good seam.
- `lib/modes.ts` (glyph vocabulary), `lib/text.ts`, `lib/hooks.ts`.
- `lib/classify.ts` **as the live linter** (feedforward while typing must be instant and free; an
  LLM per keystroke is not an option). It stops being the authoritative label (see ADR-6).
- `lib/retention.ts` math (`stability`, `retention`, `eroded`, scrubber helpers).

### Refactor (keep shape, change internals)
| File | Problem | Change |
|---|---|---|
| `lib/store.tsx` | One conversation; `send()` is synchronous, with `setTimeout` fake streaming; no errors, abort or persistence; client-only ids; `liveTree` is a single hard-wired tree. | Split into domain / UI / session slices; `send` becomes an async turn orchestrator (`lib/turn.ts`) over a `Provider`; normalized multi-conversation state; sync queue. The action names `user / assistantStart / stream / assistantDone / reclassify / reveal` map 1:1 onto streaming and **survive**. |
| `lib/types.ts` | `Leaf.id` is a per-tree string (`sql-b0-l1`), so forest "roots" match by **label**; `TreeData.updated` is a display string (`"Oct 28"`). | `TreeData` stays the **render contract**, but it is computed by projection from canonical entities (ADR-2); leaf id = concept id; ISO timestamps. |
| `lib/retention.ts` | Hard-coded `TODAY = Nov 7` and `daysSince("Oct 28")`. | Takes ISO dates and `now`. |

### Replace
| File | Why |
|---|---|
| `lib/engine.ts` | Scripted replies and keyword `matchConcepts`. Becomes `ScriptedProvider` (kept for offline demo, tests and a deterministic fallback); the live path uses the LLM. |
| `data/scenario.ts`, `data/forest.ts` | Hard-coded concepts and past trees. They become **seed fixtures** loaded through the scripted provider / demo mode, not imports in the UI. |
| `conceptScore()` in `store.tsx` | `max(message-level mode)` over messages. **Concepts are never judged individually**, which is our core feature. Replaced by per-concept attempts plus help-aware BKT (ADR-7). |

### The five places where "same shapes, UI unchanged" breaks (fix list for M1; 1, 2 and 5 done in M1, 3 is M2, 4 has its data model and gets real judgements in M4)
1. **Async and streaming**: the network can fail, be slow or be aborted. The UI needs error and retry states and a stop key.
2. **UI imports scripted data directly.** These must go through the store:
   - `Pane.tsx:2,172,310`: quiz availability = `CONCEPT_BY_ID[l.id]`
   - `Transcript.tsx:2,49,224`: chat title from `LIVE_TREE`; "make it yours" reads `CONCEPT_BY_ID`
   - `Forest.tsx:2-3,54,96,104,349,510,622`: `LIVE_TREE.id`, `PAST_TREES`, `CONCEPT_BY_ID`
   - `Composer.tsx:2-3,71,170`: the veil decision uses `matchConcepts`; tab cycling uses `DEMO_PROMPTS`
   - `classic/components/{Forest,Host}.tsx`: `PAST_TREES`, `HOST_HISTORY`
3. **Single conversation; chat tracking is faked.** Only the live chat has messages. Its leaves
   link back to messages via `Leaf.messageId` + `jumpTo()`, and that part works and stays. Past
   trees have **no** chats behind them (`Forest.tsx:636` toasts "past chats are read-only";
   classic's `HOST_HISTORY` sidebar lists chats it can't open, `Host.tsx:73`). The forest is
   `[liveTree, ...PAST_TREES]`, and one tree is assumed per chat.
4. **Per-concept attribution doesn't exist.** A message has one `Classification`, and every concept it touched inherits it.
5. **Time is fake.** That breaks retention, the "revisit" list and anything spanning days.

**Classic design:** frozen. It must keep compiling against the new store, but it gets no new features.
The A/B study runs entirely in `ascii`.

---

## 3. Fixed architecture decisions (ADRs)

### ADR-1 Platform: web app (PWA-capable), no browser extension for M4
One codebase that works on desktop and iOS Safari, with full control over the input box and
rendering (linter, veil, modeline need that). Arbor stays visually "an overlay on a chat". The
mock-browser chrome in `ascii/App.tsx` stays for the study. An extension or MCP server is stretch work.

### ADR-2 Canonical data model (frontend owns it; backend shares or generates it, see ADR-12)
Defined once in `frontend/src/lib/domain.ts` and mirrored by Pydantic models in
`backend/src/models.py`. **JSON field names are camelCase on the wire** (Pydantic `alias_generator`).

```ts
export type Id = string;            // crypto.randomUUID(), generated on the CLIENT (optimistic UI, offline/scripted mode)
export type ISO = string;           // ISO-8601 UTC
export type Mode = 'own' | 'together' | 'ai';          // unchanged
export type ConceptKind = 'subject' | 'topic' | 'concept';

/** One node of the user's knowledge graph. The hierarchy (parentId) is a strict forest of trees. */
export interface Concept {
  id: Id;
  label: string;                    // display
  slug: string;                     // normalized label for dedup: lowercase, ascii-folded, singular-ish
  aliases: string[];
  kind: ConceptKind;
  parentId: Id | null;              // subject → topic → concept (→ concept…); subjects have null
  description?: string;
  createdBy: 'seed' | 'llm' | 'user';
  createdAt: ISO; updatedAt: ISO; deletedAt?: ISO;
}

/** Cross-links that are not hierarchy (prerequisite / related). Drawn as roots between trees. */
export interface ConceptEdge { id: Id; fromId: Id; toId: Id; kind: 'prerequisite' | 'related'; createdAt: ISO }

export interface Conversation {
  id: Id; title: string;
  subjectId: Id | null;             // grove in the forest; assigned by the first analysis or picked by the user
  studyMode: boolean;
  continuedFrom?: Id;               // 'split-chats' policy (ADR-9)
  carrySummary?: string;
  createdAt: ISO; updatedAt: ISO;
}

/** Existing ChatMessage, extended. Classification = message-level summary (the glyph next to the message). */
export interface Message extends ChatMessage {
  conversationId: Id;
  createdAt: ISO;
  provider?: ProviderKind; model?: string;
  analysis?: 'pending' | 'done' | 'failed';
}

/** THE core record: how independently the student handled ONE concept in ONE message. */
export interface ConceptAttempt {
  id: Id;
  conversationId: Id; messageId: Id; conceptId: Id;
  mode: Mode;
  independence: number;             // 0..1  (own≈1, together≈0.5, ai≈0; continuous allowed)
  correctness: number | null;       // 0..1 when the turn was gradable (quiz answer, prediction, own claim), else null
  confidence: number;               // 0..1, classifier confidence
  reasons: string[];
  evidence: Evidence[];             // char offsets into the USER message (resolved client-side, see ADR-6)
  source: 'prompt' | 'reveal' | 'quiz' | 'override';
  supersededBy?: Id;                // relabels never delete; they supersede (keeps study data)
  createdAt: ISO;
}

/** A tree in the forest = the subtree of the graph below one root concept (until the next tree root).
 *  Trees are NOT 1:1 with chats: one chat can grow several trees, one tree collects many chats.
 *  When to split a tree, and how, is decided by the TreePlanner (the subject of our M3 optimization). */
export interface KnowledgeTree {
  id: Id;
  rootConceptId: Id;                // a subject or topic
  title: string;                    // defaults to the root's label
  groveId: Id | null;               // subject id → grove in the forest
  splitFrom?: Id;                   // provenance when the planner split it off another tree
  createdAt: ISO; updatedAt: ISO;
}
```

**Scale:** independence and mastery are **0..1 floats everywhere** (DB, API, store). The
graph-prototype's 0–100 is a view concern (`×100`). `MODE_SCORE` and `scoreToMode` stay as they are.

**Chats ↔ trees are derived, never stored as a link.** Every attempt carries
`conversationId + messageId`, so (pure selectors in `lib/links.ts`):
```ts
conversationsOfTree(treeId)  → { conversationId, lastAt, conceptIds }[]  // "chats this tree grew from"
treesOfConversation(convId)  → treeId[]                                     // "trees this chat grew"
refsOfConcept(conceptId)     → { conversationId, messageId, at }[]          // every place a leaf was touched
```
Revisiting a chat from a tree is therefore always possible: leaf → `refsOfConcept` → open the
conversation and `jumpTo(messageId)`, which works across conversations now.

**Projection (render contract unchanged):** `TreeData` / `Branch` / `Leaf` remain what the
designs consume, produced by pure selectors in `lib/project.ts`:

```ts
projectTree(tree, concepts, attempts, opts?: { conversationId?: Id }): TreeData
//  tree.id = KnowledgeTree.id, grove = tree.groveId ?? 'other'
//  branch = direct child of the root (fallback branch id 'other' = "side questions"); branch.id = that concept's id
//  leaf   = every attempted descendant, flattened onto its branch; leaf.id = concept.id (stable across splits!)
//  leaf.score = mean independence across all chats (glyph); leaf.mastery = BKT P(L) (fading), ADR-7
//    (M1 keeps the prototype's max for parity: `leafScore()` in project.ts; switch to mean in M4)
//  leaf.refs  = refsOfConcept(id); leaf.messageId = latest ref (kept for existing code)
//  opts.conversationId → leaves touched in that chat are marked `here: true` (the pane highlights them)
projectForest(trees, concepts, attempts): TreeData[]
crossRoots(forest, edges, trees, attempts?, conversations?): Map<treeId, Map<otherTreeId, Root[]>>
//  Root = { label, kind: 'edge' | 'split' | 'chat', fromLeafId?, toLeafId? }; takes the projected forest so only leaves (attempted) connect
//  roots between trees: prerequisite/related edges crossing trees, split provenance, chats that touched both
```
`TreeData` changes: `updated: string` becomes `updatedAt: ISO`; `live?: boolean` means "touched
by the active chat"; `Leaf` gains `refs`, `here?` and `mastery`. The two-level branch→leaf shape stays,
because `asciiTree.ts` assumes it. Deeper hierarchy is visible in the knowledge-graph view (M5).

**Tree planner (the M3 seam):**
```ts
export interface TreePlanner {
  plan(input: { concepts: Concept[]; attempts: ConceptAttempt[]; trees: KnowledgeTree[] }): TreePlan;
}
export interface TreePlan { create: { rootConceptId: Id; title: string; splitFrom?: Id }[]; remove: Id[] }
```
Runs after every analysis merge (pure, client-side, deterministic). `HeuristicPlanner`
(default until M3 lands): one tree per subject; split a branch off into its own tree when the tree
exceeds `MAX_LEAVES = 18` or a branch exceeds `MAX_BRANCH_LEAVES = 7`. M3 delivers either
parameters for this planner or a policy implemented as `OptimalPlanner`. The Gurobi IP itself
stays in the notebook (no runtime dependency). Splits must keep leaf ids, so the ASCII tree can
animate leaves gliding into the new tree (object constancy, as with the outline toggle).

### ADR-3 The frontend orchestrates a turn; the backend is a thin, guarded relay plus persistence
Prompts, JSON schemas and turn logic live in **TypeScript** (`frontend/src/ai/`). That's the only
way every provider (backend Claude, BYOK, local Ollama, ChatGPT) behaves identically without
duplicating prompts in Python. The backend:
- holds the department **Anthropic key** (Worker secret) and relays `chat` (streaming) and
  `analyze` / `tree` / `quiz` (structured) calls;
- **fixes the model per task server-side**, caps `max_tokens`, allowlists `task`, and enforces a
  per-user daily token budget (table `usage`);
- persists entities through an idempotent batch sync;
- collects study events and exports CSV.

*Trade-off (accepted for a course prototype):* the client supplies the system prompt, so a
logged-in session could use the relay as a general chatbot **within its budget**. Mitigated by
auth, budget and fixed models. Revisit if this ever goes public.

*Built 16 Nov:* structured calls use JSON outputs (`output_config.format`), not forced tool use,
which returns a 400 on `claude-sonnet-5-5` (keep in mind for the BYOK `anthropic` provider too).

### ADR-4 Provider abstraction
```ts
export type ProviderKind = 'scripted' | 'arbor' | 'anthropic' | 'openai-compatible' | 'chatgpt';
export interface Provider {
  kind: ProviderKind;
  label: string;
  chat(req: ChatRequest, onDelta: (text: string) => void, signal: AbortSignal): Promise<ChatResult>;
  json<K extends JsonTask>(task: K, input: JsonTasks[K]['input'], signal: AbortSignal): Promise<JsonTasks[K]['output']>;
  // structured output; requests are structured (no prompt strings), LLM providers render them with ai/prompts/*
  models?(): Promise<string[]>;
}
```
| Kind | Where it runs | Structured output via | When |
|---|---|---|---|
| `scripted` | browser, wraps `engine.ts` + `classify.ts` + `matchConcepts` | builds `TurnAnalysis` directly | M1 (build default until 17 Nov; now `?demo=1` or a choice in settings) |
| `arbor` | backend relay → Claude Messages API, department credits | tool use with `input_schema` | M3 (**study runs on this**) |
| `anthropic` (BYOK) | **browser → api.anthropic.com** with the user's key (`anthropic-dangerous-direct-browser-access: true`) | tool use | M7 |
| `openai-compatible` (BYOK / own server / local) | **browser → user's base URL**: OpenAI, OpenRouter, Groq, Mistral, a self-hosted vLLM/LiteLLM, Ollama or LM Studio on localhost | `response_format: json_schema` (Ollama: `format`); fallback "JSON only" prompt + `JSON.parse` + one repair retry | M7 |
| `chatgpt` | Sign in with ChatGPT; desktop shell only (ADR-10/11) | Responses API | S2 |

**Default (amended 17 Nov 2026, M8):** the production build defaults to `arbor`
(`VITE_DEFAULT_PROVIDER` in `frontend/vite.config.ts`), so a new visitor gets live Claude and an
empty chat, not the scripted demo. Cost control stays on the backend (`DAILY_TOKEN_BUDGET` per
user, `TOTAL_TOKEN_BUDGET` for everyone); when it runs out, answers fail with the budget message
and `?demo=1` still works offline.

**Transport:** a provider is pure TS against `fetch`. In the desktop shell (ADR-11) the same
providers run in the Electron main process and are reached over IPC (`window.arbor.provider.*`),
so they're not affected by CORS or local-network rules. The store never knows which transport it
is using.

**BYOK rules:** keys stay on the device. They're stored in sessionStorage by default, in
localStorage only if the user ticks "remember on this device", and they're never sent to our
backend. Settings → *model* offers presets (Anthropic, OpenAI, OpenRouter, Ollama, LM Studio,
custom) with a **test connection** button that runs one tiny `json` call. That catches CORS,
wrong model names and missing JSON support before the first chat. Chat and analysis may use
different providers (e.g. a local model for chat, the department relay for analysis) because
analysis quality is what the tree depends on.

### ADR-5 Database: Cloudflare D1 behind the Worker
D1 is not an alternative to "a database the frontend talks to via the backend". It **is** that:
the browser never talks to D1, the Worker does, through a binding (supported in Python Workers).

- **Why D1:** it lives on the same platform as Pages and the Worker, with zero extra vendors,
  SQLite semantics, free tier, local dev via `wrangler`, and migrations as `.sql` files.
- **Does it scale for multiple users?** Each D1 database is single-threaded (one query at a
  time; ~1 000 q/s at 1 ms per query) and capped at 10 GB (500 MB on Free). Our write pattern is
  a handful of rows per chat turn, batched in one `db.batch()` call, so one database comfortably
  serves the study (≈12 users), Demo Day and well into hundreds of concurrent users. Cloudflare's
  intended scale-out is one database per tenant or user (up to 1M databases on Paid), and our
  schema is already user-scoped, so sharding later is mechanical. If we ever need cross-user
  analytics or heavy concurrency: Postgres (Neon/Supabase) through Hyperdrive.
- **Rule:** every query is scoped by `user_id`; every write goes through `db.batch()`.

### ADR-6 Classification has two tiers
1. **Linter (client, instant, free):** `classify.ts` while typing → modeline, underlines, veil
   decision, squirrel. Unchanged UX.
2. **Turn analysis (LLM, after send, authoritative):** one structured call per user turn returns
   a message-level label **and a per-concept judgement** (mode, independence, correctness,
   confidence, reason, evidence) plus concept placement in the user's graph (existing id or a
   new node). This drives attempts, the tree and mastery. The UI shows the linter label
   until the analysis lands (`analysis: 'pending'`), then swaps with a subtle transition. If the
   two disagree, the analysis wins and the linter's evidence is kept as "what you saw".

**Evidence is returned as quotes, never char offsets** (LLMs miscount). `lib/evidence.ts`
resolves each quote to `{start,end}` with exact match, then case- and whitespace-insensitive
match, otherwise it drops the span.

```ts
interface TurnAnalysis {               // JSON schema in frontend/src/ai/schemas/turnAnalysis.ts
  message: { mode: Mode; confidence: number; reasons: string[]; evidence: { quote: string; mode: Mode; reason: string }[] };
  subject?: { existingId?: Id; newLabel?: string };               // only on the first turn of a conversation
  concepts: {
    ref: { existingId: Id } | { newNode: { label: string; kind: 'topic' | 'concept'; parent: { existingId?: Id; newLabel?: string }; description: string } };
    mode: Mode; independence: number; correctness: number | null; confidence: number;
    reason: string; evidenceQuote?: string;
  }[];
}
```
Context sent with the analysis: the last *N* turns (default 6), plus the **relevant subtree** of
the user's graph (subject of this conversation, ids + labels only; prompt-cache it), plus the
current quiz if one is pending. Merge rules (`lib/graph.ts`): prefer `existingId`; for
`newNode`, dedupe by `slug`/`aliases` before inserting; cap new nodes per turn (default 3)
to keep trees readable.

*17 Nov:* a third element sits between the two tiers, **scores from a fast model**
(`Provider.score`, `POST /api/ai/score`, G-Eval): right after send it rates "how much of the
thinking is the student's own?" on a 1–5 scale (weights 0, .25, .5, .75, 1; a wrong claim still
counts as own), and the probability-weighted sum over the digits sets the message label (own ≥ 0.67,
ai ≤ 0.2) and every attempt's `independence`. "Is it right?" (right / partly / wrong: 1, .5, 0,
against the tutor's reply) sets `correctness` for own claims the analysis marks gradable and for
guesses at predict → reveal (a guess can only raise independence). A scale, because a yes/no
question gives 0 or 1 on a good model and a weak model's uncertainty otherwise. The analysis keeps
choosing concepts, reasons and quotes. Scores are stored on the user message; a relabel wins.
Claude returns no token probabilities, so providers without `score` keep the analysis's numbers.

### ADR-7 Knowledge state = help-aware Bayesian Knowledge Tracing (client-side, from attempts)
Two quantities per concept, kept apart on purpose:
- **Independence:** who did the thinking (mean of attempt `independence`). This drives the leaf
  **glyph** `●◑○`, unchanged Arbor semantics: awareness.
- **Mastery `P(L)`:** BKT's probability that the concept is known. This drives **fading**
  (scrubber, letter erosion, fallen leaves), "revisit, most faded first", the squirrel's
  "least yours" tip and study-mode task selection. It replaces the illustrative Ebbinghaus model
  in `retention.ts` with a principled one; the visuals stay.

Pure module `lib/bkt.ts`. The backend stores only raw attempts; `P(L)` is recomputed by
replaying a concept's attempts in time order (cheap, and relabels/overrides just work).

```ts
interface BktParams {
  pL0: number;                         // prior P(known) for a new concept
  learn: Record<Mode, number>;         // P(T): transition per opportunity, by who did the thinking (generation effect: own > together > ai)
  guess: Record<Mode, number>;         // P(G): correct although not known; high for 'ai' (the AI did it)
  slip:  Record<Mode, number>;         // P(S): wrong although known
  forgetPerDay: number;                // continuous-time forgetting (extension; standard BKT forgets per opportunity)
}
// Starting values (replace with fitted ones from research/, R2):
// pL0 .2 · learn {own .15, together .10, ai .03} · guess {own .2, together .3, ai .9} · slip {own .1, together .1, ai .05} · forgetPerDay .02

function step(L: number, a: ConceptAttempt, p: BktParams): number {
  let post = L;
  if (a.correctness !== null) {                         // gradable → emission update
    const o = a.correctness >= 0.5, G = p.guess[a.mode], S = p.slip[a.mode];
    post = o ? (L * (1 - S)) / (L * (1 - S) + (1 - L) * G)
             : (L * S) / (L * S + (1 - L) * (1 - G));
  }                                                     // not gradable (e.g. a delegated question) → exposure only
  return post + (1 - post) * p.learn[a.mode];           // learning transition
}
mastery(conceptId, attempts, now, p) → { pL: number; n: number; lastAt: ISO | null }
//  replay: L = pL0; for each live attempt (time order): L *= (1-F)^Δdays; L = step(L, a, p); finally decay to `now`
```
**Why "help-aware":** in a chat, a correct answer means little if the AI produced it. Giving each
mode its own guess/slip (an emission model conditioned on help) and its own learn rate is the
established way to model tutor help in BKT, and it's directly fittable with pyBKT
(`multigs` / `multilearn` with `mode` as the class column). The old weighted-mean score stays
available as `baselineScore()` so the report can compare the two.

### ADR-8 Auth: anonymous sessions, optional accounts (amended 17 Nov 2026)
`POST /api/session` creates a user (optionally with `participantId` and `condition` from the URL)
and returns `{ userId, token }`. Token = HMAC-SHA256(userId, `SESSION_SECRET`), stored in
localStorage and sent as `Authorization: Bearer`.

**Amendment (M8):** an account is an optional **username + password** on top of such a user
(table `accounts`, migration 0003; `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/me`).
- A first visit in live mode starts at a **welcome screen**: log in, sign up, or **continue as
  guest**. Nothing loads before the choice, so logging in never leaves an empty guest behind.
  Visitors from before (a token, no choice) count as guests and skip the screen.
- **Signing up as a guest keeps the guest:** same `userId`, same token, the chats stay. Logging
  in switches the browser to the account's token; the guest's chats stay with the guest (not
  merged). Logging out forgets the token on the device (tokens are stateless; no server logout).
- **No email:** nothing to verify and no personal data needed for the study, but also no password
  reset. Usernames may be email addresses; the export never includes the `accounts` table.
- Passwords: PBKDF2-HMAC-SHA256, 100 000 iterations (the WebCrypto maximum in Workers), random
  salt, hashed in WebCrypto through the Pyodide FFI. No rate limit yet: fine for the course, needed
  before anything public. Study participants keep using `participantId`; accounts are for
  everyone else (demo day, testers, the team).
- "Sign in with ChatGPT" (S2) could still become a second way to log in.

### ADR-9 The study is configuration, not a fork, and organization is a policy
`lib/study.ts` reads `?pid=P07&cond=A|B` (plus the existing URL params) into an immutable
`StudyConfig`. Both conditions are the **same build**. Every user-visible difference is a field
of `StudyConfig`, so the report can list the independent variable exactly.

**A/B candidate (team's choice): what happens when the knowledge grows a new branch-worthy topic.**
```ts
type OrganizationPolicy =
  | 'split-trees'   // chats stay free-form; the planner splits trees; one chat may grow several trees
  | 'split-chats';  // invariant: one tree per chat; a new tree ALSO opens a new chat
```
- **Shared trigger (important for a clean IV):** both conditions use the **same split decision**,
  the M3-optimal `TreePlanner`, so both contain the M3 design and differ **only** in the
  consequence (tree-only vs. tree + chat). If M3's decision is size-based rather than
  topic-based, `split-chats` would need a separate topic-shift trigger. Then trigger and
  consequence change together and the IV is confounded, so settle this with the TA.
- **`split-chats` mechanics:** the turn that triggered the split moves into a new conversation
  (`continuedFrom = old id`). The old chat ends with a marker `↳ continued in "<topic>"`, and the
  new chat starts with `↰ from "<old title>"`. The LLM context of the new chat starts from a short
  carry-over summary (`tree`-task side output), not the whole old transcript. Going back to the
  old topic later shows a non-blocking offer in the modeline (`this belongs to "<chat>" · tab to
  switch`); it never moves messages automatically after the fact.
- **`split-trees` mechanics:** as in ADR-2. The pane switcher shows every tree the chat grew.
- **Data model:** `Conversation` gains `continuedFrom?: Id` and `carrySummary?: string`. Nothing
  else changes, because chats ↔ trees are derived from attempts anyway.

**Second A/B candidate (Salomon, 17 Nov 2026, PROPOSED): does seeing your score make you think more?**
```ts
type ScoreFeedback =
  | 'shown'    // A: the person sees the score Arbor gives their thinking
  | 'hidden';  // B: the same score is computed and logged, but never shown
```
- **Question:** do people do more of the thinking themselves, measured by our own "thought along"
  score (ADR-6, 17 Nov note), when they can see that score than when they cannot?
- **The app first checks which group the person is in, then decides what to render.** The group is
  a field of the user on the server (`users.condition`, returned by `POST /session` and `GET /me`),
  so it survives a reload and another device (accounts, ADR-8). Nothing score-related renders
  before the group is known. Outside a study (no participant id) the score is shown.
- **Same judge in both groups:** the fast model rates every sent message (and every rated draft)
  in A and in B, with the same prompt and model, and the result is saved with the message. B only
  hides it. So the dependent variable is measured the same way in both.
- **What B hides, exactly:** the live score line under the composer (label, bar, split), the
  label glyph and the "why" with its percentages on messages, the "who's thinking" bar and trail,
  the squirrel's reactions to the label, and the leaf fill that encodes whose thinking a leaf was
  (leaves are drawn neutral). **Identical in both:** the chat, the tutor and its prompt, which
  concepts the tree shows, saving, the task.
- **Not part of this IV:** the veil (predict → reveal) and the nudges are consequences of the
  score that a person can read their rating from. For a clean comparison they are the same in
  both groups; recommended: off in both during this test (open question 9).
- **If A beats B, follow-up tests of how the score is shown:** the fourth candidate below (the
  squirrel's reaction, colour, wording, timing). Each is one more `StudyConfig` field, not a fork.
- **Threats to name in the report:** (1) the score is our own judge, so "thinks more" means
  "is rated higher": it needs the validity check of M9/R4, a learning measure that does not come
  from the judge (a short quiz after the task), and a sample of turns rated by two team members
  who do not know the group. (2) People in A can learn to phrase prompts so the judge likes them
  ("I think …" in front of a request): compare the score with correctness and the quiz. (3) With
  about 12 participants only a large effect is detectable; report effect size and interval, and
  consider each person doing both groups on two topics in balanced order (twice the data, but
  whoever saw the score once may behave differently afterwards). (4) Praise for a score can
  crowd out the wish to learn: ask about pressure and motivation in the questionnaire.

**Third A/B candidate (Salomon, 17 Nov 2026, PROPOSED): tree or outline, which one gets used?**
```ts
type PaneView = 'tree' | 'outline';  // the drawing the knowledge pane opens with
```
- **Question:** the pane draws the same knowledge as a plant (`tree`) or as an indented list
  (`outline`, key `t`). Which one do people actually use, and does the one they start with change
  how much they use the pane at all?
- **A: the pane opens as the tree. B: it opens as the outline.** Everything else is the same, and
  `t`, `/outline` and the switcher in the pane change the view in both groups. Today the start
  view is the tree, or the outline with `?layout=outline`.
- **Measure use, not opinion:** (1) pane actions per minute of task time (rest on a leaf, open a
  concept, jump from a leaf to its chat, scrubber, forest); (2) the share of task time spent in
  each view, how many people leave their start view, and when; (3) time and errors in the finding
  task ("where did you learn X, and in which chat?"), which the organization test already uses;
  (4) one questionnaire item per view.
- **Logged for everyone, test or not:** `view_change` and the seconds per view. So "how often is
  the outline used compared with the tree" is a number we get from the pilot and from the live
  site even if this test never runs.
- **Threats:** (1) people stay with what they are given, so the time share alone mostly shows the
  default; the pane-use rate and the finding task carry the comparison. (2) The plant is new and
  the outline is familiar: novelty favours the tree in a 20-minute session. (3) Ten leaves read
  fine either way; the outline's advantage grows with size, so seed a subject that is large
  enough (M4) and report the tree size.

**Fourth candidate, a family (Salomon, 17 Nov 2026, PROPOSED): how Arbor says who did the thinking.**
These change only how the label is presented, for people who see it (group A of the second
candidate). The judge, the score and the measure stay the same: mean "thought along" percent per
participant, plus the share of delegated turns. One factor at a time; each is one `StudyConfig`
field whose first value is today's behaviour.

| Field | Values (first = today) | What changes |
|---|---|---|
| `squirrel` | `mirror` \| `mad` \| `proud` \| `both` | `mirror`: it holds the matching acorn and hops once after an own turn, without a word of judgement. `mad`: after a delegated turn it turns its back, stamps once and says one line ("you gave that one away"). `proud`: after an own turn it also says "I'm proud of you". `both`: both. |
| `aiColour` | `purple` \| `red` | The colour of everything that marks "the AI did the thinking" (`--ai`: label, bar, leaf, prompt border). Purple is a neutral hue, red reads as a warning. The glyph ●◑○ stays, so colour is never the only signal. |
| `scoreForm` | `both` \| `label` \| `percent` \| `loss` | Label and number, only "delegating to ai", only "you 23", or the loss framing "ai 77". |
| `scoreTiming` | `live` \| `after` | The score while typing (the draft can still be reworked) or only on the sent message. |
| `leafFill` | `mode` \| `neutral` | The leaf shows whose thinking it was, or every leaf looks the same. |

- **First:** `squirrel` (`mirror` vs. `mad`) and `aiColour`. They are the cheapest to build and
  ask the same thing from two sides: does disapproval change behaviour more than neutral
  information does?
- **Design:** twelve people do not carry five factors between groups. Two ways that work:
  (1) within a person: the task is cut into blocks of about six turns, the variant changes per
  block in a balanced order (Latin square), the unit of analysis is the turn (mixed model,
  participant as random effect); (2) on the live site with everyone who uses it (accounts and
  guests, the group in `users.condition`, a consent line on the welcome screen), where the
  numbers grow over time.
- **Threats:** (1) carry-over: a person scolded in block 1 stays careful in block 2; balance the
  order and test for an order effect. (2) Scolding and red can make people feel judged, so they
  quit or learn to please the label: log drop-outs, ask about pressure, and stop a variant that
  makes people leave. (3) Red means "error" in most interfaces: people may read it as "my answer
  is wrong", so ask what they thought the colour meant. (4) Many small tests on one sample: name
  one primary comparison beforehand and call the rest exploratory.
- **Condition format with several factors:** `users.condition` holds a list such as
  `org:trees,score:shown,view:outline,squirrel:mad`, parsed in `study/conditions.ts`; a field
  that is missing has its default.


### ADR-10 "Continue with ChatGPT": assessment and decision
What the docs actually say (Nov 2026):
- **Plan usage** (running requests on the user's ChatGPT plan) is offered to **open-source
  projects and local personal apps**. The OAuth flow requires an **HTTP loopback callback on
  `127.0.0.1`**, a local listening process, and credentials stored on disk. The DevKit's
  `@siwc/local` is a Node package for a local process. Paid or **remotely hosted** apps join a
  waitlist.
- **Sign-in on a website** is **identity-only** and limited to selected commercial partners
  (waitlist).
- Inference goes through the public **Responses API** with tight constraints: `store:false`,
  `stream:true`, full history in `input`, no `temperature`/`max_output_tokens`, system prompt via
  `instructions`.
- The DevKit is under a **noncommercial** license. That's fine for the course, but it matters if
  Arbor ever becomes a product.

**Consequence:** open source alone does not make our hosted Cloudflare app eligible. A browser
tab can't listen on `127.0.0.1`. **Decision:** the web app ships **BYOK instead** (M7). ChatGPT
plan usage arrives with the desktop shell (ADR-11), which is exactly the setup OpenAI's own
reference app uses (Electron, SDK in the main process). In parallel, someone can submit the SIWC
interest form for the hosted case.

### ADR-11 Desktop shell (Electron), post-study, but design for it now
An Electron app that loads the **same React build** solves both "local" problems:
- **ChatGPT plan:** `@siwc/local` runs in the main process; the loopback callback works; an
  open-source local app is the eligible category.
- **Local and own models:** requests leave from Node, so there's no CORS, no `OLLAMA_ORIGINS`,
  no Chrome local-network prompt and no mixed-content issues. The shell can also detect a
  running Ollama or LM Studio and list its models.

It does **not** replace the web app. It doesn't help iOS/mobile, participants would have to
install it for the study, macOS builds need signing and notarization to avoid Gatekeeper
warnings, and the SIWC DevKit is noncommercial-licensed. So: web app = primary (study, mobile,
zero install); desktop = optional power-user shell (S2).

**Constraints that keep it cheap later (binding from M1 on):** no Node APIs in `frontend/src`;
all model access goes through `Provider`; asset paths stay relative (`vite base: './'` is
already set); the backend URL is configurable at runtime, not just via `VITE_API_URL`; secrets go
through a `SecretStore` interface (browser storage now, OS keychain via `safeStorage` in Electron).

### ADR-12 Backend language: TypeScript Worker for the app, Python for research. **PROPOSED, team confirms in M0**
With ADR-3 the request path is thin: auth, relay, sync, events, export. No request needs
Python's ecosystem, while Python Workers (Pyodide) bring costs we can't use yet: a Pydantic
mirror of every TS type, which drifts; slower cold starts; native packages only if
cross-compiled; and SSE passthrough that is unverified (the M0 spike). A **TypeScript Worker
(Hono)** shares `domain.ts` and the zod/JSON schemas with the frontend directly, streams with a
plain `ReadableStream`, and is the most-trodden path on Cloudflare. Today the backend has only
`/health` and `/echo`, so switching costs about an hour now and grows with every endpoint.

**Where the TS API lives:** either as **Pages Functions** (`frontend/functions/api/*.ts`, same
Pages project, same origin, so no CORS and one deploy) or as a Worker serving the static assets
and `/api/*` together. Either way it's the same runtime, D1 binding and streaming. Same-origin is
the simpler choice for the study. A side benefit: the turn and graph modules (`turn.ts`,
`graph.ts`, `bkt.ts`) could also run server-side unchanged if we ever need it (e.g. to stop
clients tampering with attempts).

**Python is where it pays: `research/`** (uv project, notebooks + small CLIs, never deployed):
- **BKT** (pyBKT): fit help-aware parameters, cross-validate, simulate, plots for the report (R1–R3).
- **M3:** the Gurobi notebook (native solver, so it can't run in a Worker anyway). It exports the
  optimal planner policy/parameters as `frontend/src/study/planner-params.json`.
  *25 Nov:* built in `research/forest-building/` (pip venv, not uv; lean version of 25 Nov, its
  README lists what is open). A judge scores and proposes; a per-step IP (Gurobi) decides: add,
  new branch, new tree, new group or restructure. Input is one hand-made ideal forest (25
  prompts) with an arrival order. It exports the IP's forest after every step as
  `outputs/forests/<run>/sequence.json` (its own JSON). Open: the LLM judge (provider and budget
  undecided; all results so far use an oracle judge built from the ideal forest), the review of
  the drafted session, and the format the prototype loads (a frontend PR of its own).
- **Classifier eval** analysis (agreement, confusion matrices) on the M4 harness output.
- **Study analysis:** export CSV → pandas → tests (scipy/pingouin) → figures for the report.

If the team prefers to keep the Python Worker: the API contract (§4) is language-neutral, so
that works. Then generate the Pydantic models from the JSON Schemas (`datamodel-code-generator`)
instead of hand-mirroring them, and keep the M0 SSE spike mandatory.

**Decided 16 Nov: keep the Python Worker for now.** Spike result: the D1 binding and SSE
passthrough work locally under `pywrangler dev` (see M0); the deployed Worker is not checked yet.
Open risk: the CPU limit on the Cloudflare Free plan (10 ms per request), not measured for this Worker.

### ADR-13 One navigation model; the radial menu is a client of it
Today views are scattered state flags (`forest.open`, `panelOpen`, `onboarding`…), and there's
no URL per view. Introduce **one** model in `lib/nav.ts`, used by the radial menu, `/commands`,
squirrel actions, links in the forest, and the browser back button:
```ts
type View =
  | { kind: 'chat'; conversationId: Id; messageId?: Id }   // #/chat/<id>[/<msg>]
  | { kind: 'chats' }                                       // #/chats
  | { kind: 'forest'; treeId?: Id }                         // #/forest[/<tree>]
  | { kind: 'tree'; treeId: Id; layout?: 'plant' | 'outline' } // #/tree/<id>
  | { kind: 'graph' }                                       // #/graph (M5, optional)
  | { kind: 'study'; conceptId?: Id }                       // #/study[/<concept>]
  | { kind: 'concepts' }                                    // the "?" sheet
  | { kind: 'settings'; section?: 'model' | 'nudges' | 'appearance' };
navigate(view: View, opts?: { replace?: boolean }): void    // hash routing; no router library needed
```
URL params for the study (`?pid&cond&…`) stay in the query string; the hash only holds the view.

**Radial navigation (interaction concept #11, "marking menu").**
- **Trigger:** hold **Alt/Option** ≥ 180 ms with no other key → the menu opens centred on the
  pointer (keyboard-only, or pointer outside the window: centred on the caret, else the viewport).
  Move toward a wedge and **release Alt to go there**; release in the centre dead zone or press
  `Esc` to cancel. **Experts don't wait:** Alt + a quick flick + release selects without drawing
  the menu (Kurtenbach & Buxton's marking menus). Selection is by direction, not distance, so
  every target is effectively large (Fitts's law). This gives a novice → expert path in the
  report's rationale.
- **Must not break typing.** These rules are the acceptance tests:
  - **Ignore AltGr** (`e.getModifierState('AltGraph')`, or Ctrl+Alt on Windows). Swiss and German
    layouts type `@ # [ ] { } \ |` with it, so this is critical for our users.
  - Any other key pressed while Alt is down (Option+⌫, Option+←, Alt+Tab, shortcuts) cancels
    the gesture, and the key keeps its normal meaning.
  - Cancel on `blur` / `visibilitychange` (Alt+Tab away).
  - `preventDefault` on the lone Alt keyup only when the menu was used, so Firefox
    (Windows/Linux) doesn't focus its menu bar.
- **Items:** max **8 wedges** (directional reliability drops beyond 8), stable positions so
  muscle memory forms. Proposed: ↑ chat · ↗ chats · → tree · ↘ forest · ↓ study · ↙ graph/concepts ·
  ← settings · ↖ new chat. One level of nesting at most: hovering *chats* for 300 ms fans out the
  5 most recent chats as a second ring. Context-dependent items are **not** allowed; positions
  never move.
- **Look:** ASCII design tokens; a ring of glyphs with lowercase labels, the active wedge in
  the "you" colour, the current view marked. `prefers-reduced-motion`: no scale-in animation.
- **Accessibility and touch:** while it's open, arrow keys or `1`–`8` pick a wedge and Enter
  confirms. Every target stays reachable via `/` commands and the modeline lists `alt nav`.
  Touch: long-press on empty canvas opens the same menu (no Alt key on iOS).

### ADR-14 The thought linter never moves the layout (17 Nov 2026)
The linter used to print its verdict and a word-by-word diagnostics list **under** the prompt.
Its height changed with every debounce (empty → verdict → list → empty), so the prompt jumped up
and down while the student typed. A tool that is meant to make thinking visible must not get in
the way of it. Rules, for every design:
- **The words explain themselves:** the classifier's evidence stays underlined in the text
  (solid = you, dashed = together, wavy = ai). Hovering a word shows its reason in a small pop-up
  above it; nothing is laid out for it.
- **One live score line of fixed height above the prompt**: glyph, label, a you ↔ ai bar with
  the split (`draftShare` in `lib/modes.ts`), and what sending will do. It is always there (empty
  when there is nothing to say), so the prompt never moves when the linter changes its mind. As the
  prompt grows the line moves up with it. Hovering it lists every reason (the old diagnostics).
- **Nothing under the prompt.** The command menu floats above it.
- The prompt spans the chat column and grows with its text up to half the screen height, then
  scrolls.
- Screen readers get the verdict through a visually hidden live region instead of the visible list.

### ADR-15 Judging while typing: measure first, then a cascade (17 Nov 2026, **PROPOSED**)
ADR-6 keeps the linter (tier 1) on word rules: instant and free. After send, the fast model's
scale sets the label (ADR-6, 17 Nov note) and Claude picks concepts and reasons. While typing, the
rules alone decide, and they often disagree with what lands after send. That undermines the one
intervention students see on every prompt.

**Measured baseline** (`npm run eval:linter`, `frontend/eval/`, 136 prompts, labels still Claude's
draft): the rules agree 68 % of the time (Cohen's κ 0.52, weighted 0.58). They miss own thinking
most: only 46 % of own messages are labelled own, half of them become "together" (claims without
"I think", worked steps, corrections, German). Hedged delegation ("I think you should just write
it") is right 31 % of the time, German 42 %. A naive Bayes model trained leave-one-out on the same
136 prompts reaches 57 % (κ 0.35): too little data for a learned model yet. The fast model could
not be measured yet (see M9).

**Options weighed** (cost per message on top of today's chat + analysis + one score):
| Option | Cost | Quality | Explains words? |
|---|---|---|---|
| Rules (today) | 0 | κ 0.52 on the draft set | yes |
| Fast model on a typing pause (PR #14, 600 ms) | ~1–3 extra score calls of ~250 tokens | to be measured; on the 21 thinking cases of `eval:score` 19 in band | no: a score only |
| Naive Bayes / logistic regression on words, in the browser | 0, ~100 KB of weights | κ 0.35 at 136 examples; needs several hundred labelled prompts | yes (word log-odds) |
| Sentence embeddings in the browser (MiniLM-class, ~25 MB) | 0 per call, a big first download | unknown; better with context | only with attribution |
| Decision trees on hand-made features | 0 | bounded by the features, like the rules | yes |

**Direction (to be confirmed by M9's numbers):** a cascade. Tier 0 on every keystroke stays local
(the rules, later a learned model when there is data), with smoothing so the label does not
flicker. Tier 1, the fast model, rates the draft after a typing pause (PR #14), and if its share of
the budget matters, only when tier 0 is unsure. The rating sent with the message is reused on send,
so a draft rated once costs nothing extra. Tier 2, the after-send analysis, stays authoritative.
The underlines keep coming from tier 0 (the fast model returns a number, not words); where tier 1
and the underlines disagree, the score line follows tier 1 and says so on hover.

**Decision rule:** adopt tier 1 as the default for the score line if the fast model beats the
rules by at least 10 points of agreement on the team-rated set and its median latency stays under
1 s; otherwise keep the rules and gate tier 1 to unsure drafts. Train a local model only once a
labelled set of 500 or more prompts exists (study data needs consent first).

### ADR-16 A revealed guess is judged by meaning, not by shared words (17 Nov 2026, **PROPOSED**)
At predict → reveal the student types a guess, then sees the answer. Today two things judge it,
and neither says *which* idea of the guess was right:
- **What the student sees** is word-stem overlap (`guessStems` / `markHits` in
  `designs/ascii/Transcript.tsx`): the first 5 letters of every longer word of the guess are
  matched against the answer. A right guess in other words gets "no direct overlap. what did you
  miss?"; a wrong guess that reuses the answer's words ("the vaccine kills the germ" against an
  answer about germs) lights up as if it had been right.
- **The number** comes from the fast model (`scoreGuess`: the 1–5 thinking scale and the 1–3
  "is it right" scale against the reply). That does judge meaning, but it is a single number,
  and on the live site it failed on every call until `FAST_API_KEY` was set on 20 Nov (M9).

**Decision:** after the reveal, once the reply is complete, one structured LLM call grades the
guess against the answer (new task `grade` on `POST /api/ai/complete`, `MODEL_ANALYZE`, JSON
output like `analyze`):
```ts
interface GuessGrade {                     // schema in frontend/src/ai/schemas/guessGrade.ts
  verdict: 'right' | 'partly' | 'wrong' | 'no_guess';
  matches: { guessQuote: string; answerQuote: string; relation: 'same' | 'partly' | 'contradicts' }[];
  missed?: string;        // the key idea of the answer the guess did not have, in one short sentence
  misconception?: string; // only when the guess states something the answer contradicts
}
```
- Quotes, never offsets (ADR-6): `lib/evidence.ts` resolves `answerQuote` and `guessQuote` to
  spans. The answer highlights the matched ideas by relation (same: the "you" colour; contradicts:
  marked as such), and "what you missed" replaces "no direct overlap".
- **Numbers stay with the fast model** (G-Eval scales, calibrated, cheap): `correct` and the
  thinking raise as today. When the fast score is missing or failed, the grade's verdict sets
  `correctness` (right 1, partly .5, wrong / no_guess 0) and a non-empty guess still counts as
  thinking together. If the two disagree, the fast score wins for the number and the grade's
  quotes stay as the explanation.
- **While the grade is on its way** the lexical overlap shows, labelled honestly as "words in
  common", then the semantic result replaces it (like the linter label before the analysis).
  Demo mode and providers without `json` keep the lexical version.
- **Cost:** one call per revealed guess, only with nudges on *active* and a delegating prompt, so a
  few per session; input = question + guess + answer (capped like the analysis), output about 200
  tokens.
- **Rejected:** embeddings alone. A paraphrase of a misconception is as close to the answer as a
  right guess ("vaccines kill germs" vs. an answer about vaccines), so similarity cannot say right
  or wrong. They could still pre-select which answer sentence to compare, if the call gets too big.
- The grade feeds the attempt of every concept of that turn (`source: 'reveal'`, `correctness`),
  which is the open M4 item "predict → reveal and quiz answers feed the analysis"; the same call
  shape can later grade quiz answers.

---

## 4. API contract (backend ↔ frontend)

All routes under `/api`, JSON, `Authorization: Bearer <token>` except `session` and `health`.
Errors: `{ error: { code, message } }` with an HTTP status.

| Method & path | Body → Response | Notes |
|---|---|---|
| `GET /health` | → `{ ok, environment }` | exists |
| `POST /session` | `{ participantId?, condition? }` → `{ userId, token }` | ADR-8 |
| `POST /auth/signup` | `{ username, password }` (+ optional guest token) → `{ userId, token, username, … }` | ADR-8 amended (M8): the guest becomes the account |
| `POST /auth/login` | `{ username, password }` → `{ userId, token, username, … }` | 401 `invalid_credentials` |
| `GET /me` | → `{ userId, username \| null, participantId, condition }` | null: a guest |
| `GET /state` | → `{ concepts, edges, trees, conversations, attempts }` | bootstrap; messages excluded |
| `GET /conversations/:id/messages` | → `{ messages }` | lazy per conversation |
| `PUT /sync` | `{ concepts?, edges?, trees?, conversations?, messages?, attempts? }` → `{ ok, serverTime }` | idempotent upsert by client id, one `db.batch()`; last-write-wins on `updatedAt` |
| `POST /ai/complete` | `{ task: 'chat'\|'analyze'\|'tree'\|'quiz', system, messages, schema?, stream? }` (task `grade` proposed, ADR-16) | `chat` + `stream:true` → **SSE**: `event: delta {text}` … `event: done {usage}` / `event: error {code,message}`. Others → `{ output, usage }` (JSON outputs, see note below). 429 `budget_exceeded` when over budget. |
| `POST /events` | `{ events: StudyEvent[] }` → `{ ok }` | batched, fire-and-forget |
| `GET /admin/export?table=events\|attempts\|messages` | → CSV | header `X-Admin-Token` |
| `GET /admin/visits?limit&before` | → `{ visits: [{ visit, userId, participantId, condition, username, design, first, last, lastServerTs, events, turns }], next }` | header `X-Admin-Token`; the logs page (M6, *21 Nov*); newest first, opaque cursor |
| `GET /admin/events?visit&userId&type&after&limit` | → `{ events: [{ id, userId, condition, type, payload, clientTs, serverTs }], next }` | header `X-Admin-Token`; the logs page (*21 Nov*); by `(serverTs, id)`, filters AND |

*Built 16 Nov* (`backend/docs/api.md`): `health`, `session`, `ai/complete`, `events`, `admin/export`;
*17 Nov:* `state`, `conversations/:id/messages`, `sync`. All routes of this table exist now.
Where it differs: structured calls use JSON outputs (`output_config.format`), not forced tool use
(400 on Sonnet 5.5); `temperature` cannot be set on API version 2026-10-21; export tables are all
nine tables; the token is `<userId>.<hex HMAC-SHA256(userId, SESSION_SECRET)>`; the schema comes
as `0001_users_usage_events.sql` (users, usage, events) and `0002_graph_and_chats.sql` (the other
six tables, columns unchanged, plus indexes `trees_user` and `conversations_user`); the Pydantic
models live in `backend/src/schemas.py`. Sync details: at most 500 rows per request (413
`too_many_rows`); optional (`?`) fields are left out of responses when empty; messages store every
field beyond the core (`id`, `conversationId`, `role`, `text`, `classification`, `createdAt`) in
`meta_json`, so new frontend fields need no backend change, and `streaming` is dropped; trees take
an optional `deletedAt`; edges are insert or ignore; another user's row with the same id is
skipped, never replaced.

### D1 schema (`backend/migrations/0001_init.sql`)
```sql
CREATE TABLE users        (id TEXT PRIMARY KEY, participant_id TEXT UNIQUE, condition TEXT, created_at TEXT NOT NULL);
CREATE TABLE concepts     (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL, label TEXT NOT NULL,
                           slug TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', description TEXT, created_by TEXT NOT NULL,
                           created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX concepts_user_slug ON concepts(user_id, slug);
CREATE TABLE concept_edges(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
                           created_at TEXT NOT NULL, UNIQUE(user_id, from_id, to_id, kind));
CREATE TABLE trees        (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, root_concept_id TEXT NOT NULL, title TEXT NOT NULL, grove_id TEXT,
                           split_from TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE conversations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject_id TEXT, title TEXT NOT NULL, study_mode INTEGER NOT NULL DEFAULT 0,
                           continued_from TEXT, carry_summary TEXT,
                           created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE messages     (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
                           classification_json TEXT, meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX messages_conv ON messages(conversation_id, created_at);
CREATE TABLE attempts     (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
                           concept_id TEXT NOT NULL, mode TEXT NOT NULL, independence REAL NOT NULL, correctness REAL, confidence REAL NOT NULL,
                           source TEXT NOT NULL, reasons_json TEXT NOT NULL, evidence_json TEXT NOT NULL, superseded_by TEXT, created_at TEXT NOT NULL);
CREATE INDEX attempts_user_concept ON attempts(user_id, concept_id, created_at);
CREATE TABLE events       (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, condition TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
                           client_ts TEXT NOT NULL, server_ts TEXT NOT NULL);
CREATE TABLE usage        (user_id TEXT NOT NULL, day TEXT NOT NULL, task TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
                           output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day, task));
```
`meta_json` on messages holds `veiled`, `guess`, `reflectOn`, `provider`, `model`, `analysis`.

**Worker config:** secrets `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `ADMIN_TOKEN`. Vars
`MODEL_CHAT`, `MODEL_ANALYZE` (a small, cheap model), `DAILY_TOKEN_BUDGET`. D1 binding `DB`.

---

## 5. What to build first

**Not UX features first.** The prototype already has more interaction concepts than the study can
test; what it lacks is a real core. And not tree generation in a vacuum, because it needs real
conversations to run against. The order:

1. **Seam first (M1):** domain model, store refactor, `Provider` with the scripted provider, zero
   visible change. Everything else plugs into this, and it's the riskiest refactor, so do it
   while the behaviour is still deterministic and easy to compare.
2. **Thin live-chat slice (M3, in parallel with M2):** one day of work. It de-risks the two real
   unknowns early (SSE through a Python Worker, the Claude call) and gives M4 real text.
3. **Turn analysis + tree generation (M4):** the main effort and our actual contribution
   (per-concept independence). Most of the time goes here.
4. **Mastery (BKT) + study mode (M5), then study instrumentation (M6).**
5. UX polish only where the pilot shows friction.

---

## 6. Milestones

Legend: **FE** = frontend, **BE** = backend, **⇢** = depends on. Each milestone: own branch off
`hifi`, one PR, acceptance criteria all green, `npm run build` (includes `tsc`) and
`npm test` pass.

### M0 Foundations and spikes (Nov 16–18)
**Decide ADR-12 first** (TS Worker vs. keep Python). If TS: port `/health` to Hono, set up D1, done.
The spikes below then shrink to the D1 check. **If Python stays, these spikes are mandatory,
each time-boxed to half a day, results noted in this file:**
- [x] D1 binding from the Python Worker (`wrangler d1 create arbor`, read and write one row locally and deployed).
      *Result 16 Nov:* works locally under `pywrangler dev` (`run`, `first`, `all`, `batch`, upserts) and on
      the deployed Worker (database `hci-grp19`: session, events stored and exported as CSV).
- [x] **SSE passthrough:** stream a Claude response through the Python Worker to the browser
      (try returning the upstream `fetch` body stream directly; avoid buffering in FastAPI).
      *Decision rule:* if it doesn't stream cleanly within the time box, use fallback A:
      non-streaming relay plus the existing client-side chunked reveal (the UX already does this).
      Fallback B, a small TypeScript Worker just for `/ai/*`, is only worth it if A feels too slow
      in the pilot.
      *Result 16 Nov:* streams chunk by chunk locally under `pywrangler dev`, also with CORS
      (`backend/tests/smoke.sh`), and on the deployed Worker: 59 deltas over 2.4 s with the CORS
      header for the Pages origin, no fallback needed.
- [x] Anthropic call via raw `httpx`/`fetch` (don't depend on the SDK working in Pyodide).
      *Result 16 Nov:* built on the Workers `fetch`, not the SDK; live on the deployed Worker: chat
      and structured JSON (flat and nested schemas) on Claude Sonnet 5 through Amazon Bedrock (the
      stopgap until the group's Anthropic key). Results in `backend/docs/testing.md`.

**FE housekeeping:**
- [x] Add `vitest`; tests for `classify.ts` (snapshot of the demo prompts), `retention.ts`.
- [x] `lib/domain.ts` with the ADR-2 types (types only, unused yet).
- [x] Fix stale docs: README says "browser extension concept" and GitHub Pages, but deploy is
      Cloudflare Pages; `frontend/workflows/deploy.yml` is not in `.github/` so it never runs.
      Delete it or move it. *(Deleted; Pages deploys through its Git integration.)*
- [x] Commit or revert the stray `frontend/package-lock.json` change on `main`. *(Already clean.)*

### M1 Store refactor and provider seam (FE, Nov 17–21) ⇢ M0
- [x] Normalize state: `conversations`, `messagesByConv`, `concepts`, `edges`, `attempts`,
      `activeConversationId`; separate `ui` slice (panel, forest, draft, toast, highlight,
      composer, flash, onboarding).
- [x] `lib/project.ts` + `lib/links.ts` (ADR-2 selectors) replace `buildLiveTree`; `liveTree` in
      context becomes `activeTrees` (trees touched by the active chat; the pane shows the most
      recent one, with a switcher if a chat grew several), plus a new `forestTrees`.
      `HeuristicPlanner` with the scripted fixtures: one tree per subject, so the demo looks as it does today.
- [x] `lib/turn.ts` async orchestrator: linter classify → `user` → `provider.chat` (stream deltas,
      `AbortController`) → `assistantDone` → `provider.json(analyze)` → `analysisDone` (attempts +
      concept merge) → enqueue sync. New actions: `hydrate`, `conversationNew/Open`,
      `analysisDone`, `turnError`, `abort`.
- [x] `ScriptedProvider` wraps `engine.ts`/`classify.ts`/`matchConcepts` and returns a
      `TurnAnalysis`; seed data (`scenario.ts`, `forest.ts`) loads as fixture entities through it.
- [x] Remove every UI import of `data/*` and `engine.ts` (fix list in §2). The veil decision
      becomes `linter.mode === 'ai' && nudge === 'active' && !pendingQuiz` (no keyword match).
      `DEMO_PROMPTS` comes from the active fixture.
- [x] `retention.ts` on ISO dates and `now`.
- [x] Error UI in the transcript (`! failed · r retry`), plus `esc` to stop streaming (modeline shows it).

*Acceptance:* both designs look and behave **identically** to today with the scripted provider
(manual run of the README demo scripts), and forest roots are matched by concept id. Unit tests
cover `projectTree`, `crossRoots`, `links.ts`, `HeuristicPlanner`, and `turn.ts` with a fake
provider (success, error, abort).

*Done 16 Nov.* Parity is a test, not only a manual run: `src/ai/scripted/parity.test.ts`
replays the seed chat and the README demo script through the new pipeline and compares with
output captured from the pre-M1 store (`parity.expected.json`); forest roots by concept id are
checked against the old label matching. Still to do by hand: click through both README demo
scripts in a browser (headless Chromium renders both builds the same, but does not draw the
animated tree). Decisions taken on the way (change them here if the team disagrees):
- **Leaf score stays the max** of a concept's attempts (prototype rule) instead of ADR-2's mean,
  because "identical" was the acceptance criterion; `leafScore()` in `project.ts`, switch in M4.
- **Same label in two trees = two concepts + a `related` edge** in the fixture: the hierarchy is a
  strict forest, so a concept can't sit in two trees; the edge draws the root.
- **The analysis runs in parallel with the reply** and is applied once the reply starts (not after
  it ends), so leaves still grow when the answer appears. It is not cancelled by `esc`.
- **Turn order:** relabels never delete (an `override` attempt supersedes the old one and keeps
  its timestamp, so leaf order doesn't move); a relabel or a revealed guess made before a late
  analysis lands wins over it.
- **Pane for a chat with no tree yet:** its subject's most recent tree (the old "live tree" in `?empty=1`).
- **Abort** is the `turnStopped` action (or `assistantDone` with `stopped`); `/stop` and `/retry`
  join `esc` and `r`.
- **Fixture dates** are "days ago", so the forest fades the same whatever day the demo runs.
  The classic sidebar's groups are now computed (this week = last 7 days), so *Usability
  testing* (8 days) moved to *Earlier*.
- **Enqueue sync** is left for M2 (no persistence yet).

### M2 Persistence and multi-conversation (BE + FE, Nov 19–24) ⇢ M1 types, M0 D1 spike
**BE**
- [x] Migration `0001_init.sql`, Pydantic models (camelCase aliases), `POST /session`,
      `GET /state`, `GET /conversations/:id/messages`, `PUT /sync` (batched, idempotent, user-scoped).
      *16 Nov:* migration 0001 (users, usage, events), camelCase models and `POST /session` built;
      `/state`, `/conversations`, `/sync` not yet.
      *17 Nov:* migration `0002_graph_and_chats.sql` and the three routes built: one `db.batch()` per
      sync, last write wins on `updatedAt`, rows of other users never touched, 500 rows per request;
      the export covers the new tables. Tested with pytest and under `pywrangler dev` (local D1);
      the migration still has to be applied to `hci-grp19` after the merge (`backend/README.md`).
- [x] Auth dependency (HMAC token), CORS allows `Authorization`.

**FE**
- [x] `lib/session.ts` (create or restore a token), `lib/sync.ts` (debounced queue, retry with
      backoff, localStorage mirror so a reload never loses a turn), hydrate on boot.
      *17 Nov:* `lib/session.ts` built with M3 (create or restore, a new session once after a 401).
      `sync.ts` diffs every state change by reference into rows (a reply only once complete, a
      failed reply never; a removed tree once more with `deletedAt`; a chat from its first message
      on), 0.8 s debounce or at once when a turn ends, ≤ 500 rows per request, backoff up to 30 s,
      `online` and `pagehide` (keepalive) flush; a 4xx keeps the rows and shows them. `live.ts` loads
      `GET /api/state` with the queue on top; messages per chat when opened. The device mirrors only
      the queue, so live mode needs the backend at start (error + retry, never the demo).
      `lib/app.ts` holds the store without React, so all of this is tested without a DOM.
- [x] `api.ts`: auth header, typed errors, `apiStream()` for SSE. *17 Nov:* built with M3; one base
      URL (`VITE_API_URL`), `ApiError(status, code, message)`, SSE events split across chunks.
- [x] **Chat history and revisit** (ASCII design, keyboard-first):
      - chat list: `/chats` (or `c`), grouped today / this week / earlier, each row showing its
        trees' glyph crowns; `/new` starts a chat; titles are auto-set from the first turn and
        editable with `/title`.
      - tree → chats: the tree detail in the forest lists **"grown in"** chats (from
        `conversationsOfTree`); enter opens the chat.
      - leaf → message: hover/enter on a leaf lists its refs (chat + snippet + date); choosing one
        opens that chat and `jumpTo`s the message, in any chat, not just the live one. This
        replaces the "past chats are read-only" toast.
      - chat → trees: the transcript header shows the trees this chat grew (`treesOfConversation`).
      *17 Nov:* built as one picker sheet (`designs/ascii/Chats.tsx`) for the chat list and a leaf's
      messages; a leaf with one message jumps straight to it. Titles: the first message, cut at a
      word boundary (no model call). An empty chat is not saved and is dropped when you leave it.
      Classic: its sidebar opens real chats and starts new ones (no new UI).
- [x] Demo mode `?demo=1` keeps the scripted fixtures for offline demos.
      *17 Nov:* demo = provider `scripted` (still the build default): fixture, nothing saved, no
      request at all (tested). `?demo=1` forces it over `?provider` and the saved choice. Live =
      `arbor`: no demo forest any more. Switching the provider switches the world at once.

*Acceptance:* create two chats about the same subject, reload, and both come back. Their tree
lists both under "grown in"; a leaf touched in both offers both messages and jumps correctly into
either chat. Offline edits sync after reconnect.
*17 Nov (FE):* all of it checked in a browser against the M2 backend under `pywrangler dev` with
live Claude, also a reload while the backend is unreachable (error, retry, nothing lost). Needs
the M2 backend and migration `0002` deployed before live mode works on the deployed site.

### M2b Navigation model and radial menu (FE, Nov 23–27) ⇢ M1 (needs views from M2 as they land)
- [ ] `lib/nav.ts` (ADR-13): `View`, hash routing, `navigate()`, back/forward. Migrate
      `forest.open`, `panelOpen`, the `?` sheet, settings and the chat list onto it. `/forest`,
      `/chats`, etc. call `navigate()`.
- [ ] `designs/ascii/Radial.tsx` + `lib/useAltGesture.ts`: trigger, direction picking, flick
      selection, nested *chats* ring, keyboard and touch fallbacks, per ADR-13.
- [ ] Tests for the gesture hook (fake timers + synthetic key/pointer events): AltGr ignored,
      Alt+other key cancels, blur cancels, the flick path selects without opening.
- [ ] Add to the `?` concepts sheet (#11, *try → hold alt*) and to the modeline.

*Acceptance:* on a Swiss German layout, typing `@`, `{`, `|` in the composer never opens the
menu; Option+⌫ deletes a word on macOS; every view can be reached in one gesture and returned
from with the browser back button.

### M3 Live chat via backend Claude (BE + FE, Nov 20–25) ⇢ M0 SSE spike, M1
**BE**
- [x] `POST /ai/complete`: task allowlist, model per task from env, `max_tokens` cap, budget check
      and accounting in `usage`, SSE for `chat` (or fallback A), tool-use structured output for
      `analyze`/`tree`/`quiz`. *16 Nov:* JSON outputs instead of tool use; live Claude not run yet.

**FE**
- [x] `ArborProvider` (chat + json); provider picker in settings (scripted | arbor); default
      `arbor` outside demo mode.
      *17 Nov:* the default is the build variable `VITE_DEFAULT_PROVIDER`, `scripted` in
      `vite.config.ts` until the group has its own API key and a higher token cap (with `arbor`
      every visitor spends tokens). `?provider=arbor|scripted` for one visit.
- [x] `ai/prompts/chat.ts`: tutor system prompt parameterized by the linter mode, nudge level
      and study mode. This replaces `engine.ts`'s variants: `own` → react to their reasoning
      first, `together` → explain and hand a question back, `ai` → answer fully, `hint` →
      hint only, `/quiz` → separate `quiz` task.
      *17 Nov:* the `quiz` task is left for M4/M5: live mode does not offer quizzes on a leaf
      (`canQuiz` is false), `/quiz` is a plain chat message. A small first `analyze` prompt and
      its JSON schema came with it (`ai/prompts/analyze.ts`), because every turn runs one.
- [x] Veil works with streamed text (the stream fills while veiled; reveal shows what has arrived so far).

*Acceptance:* a real conversation on an arbitrary topic streams, can be stopped, survives a
network error with retry, and the budget limit shows a friendly message.
*17 Nov (FE):* checked in both designs against the deployed Worker (`?provider=arbor`): streams,
`esc`/stop cancels the request, a cut connection fails with retry, the budget errors (simulated
429s) show which budget is used up. A live chat starts empty and is not saved yet (M2).

### M4 Turn analysis and tree generation (FE-heavy + BE task, Nov 24–Dec 1) ⇢ M2, M3. **Core milestone.**
- [ ] `ai/schemas/turnAnalysis.ts` (ADR-6) and `ai/prompts/analyze.ts`: graph subtree in
      context, per-concept judgement, quotes as evidence, explicit rubric for own / together / ai
      with 2–3 examples each (take them from our needfinding).
- [ ] `lib/evidence.ts` (quote → offsets), `lib/graph.ts` (merge, slug dedup, new-node cap, subject assignment).
- [ ] Message glyph shows `pending` (linter label, dimmed), then the analysis label; the
      "why" popover lists **per-concept** judgements.
- [ ] **Relabel per concept:** in the why popover, each concept row gets its own `●◑○`; a
      relabel writes a `source:'override'` attempt that supersedes the old one, and the tree
      regrows. Message-level relabel stays and applies to all of that message's concepts.
- [ ] **Seed a subject** (`/learn <topic>` or "start studying X"): `tree` task generates topic →
      concept skeleton (≈3–6 topics, 3–6 concepts each) as unvisited, hollow-outline leaves. Leaves
      only grow in once attempted. The forest and graph show what's ahead.
- [ ] Predict → reveal and quiz answers feed the analysis (`source:'reveal'|'quiz'`, with
      `correctness`). *17 Nov:* the semantic guess grade that provides it is ADR-16 / M10.
- [ ] `OrganizationPolicy` (ADR-9): `split-chats` moves the triggering turn into a new chat
      with markers + carry-over summary; `split-trees` only creates the tree. Switchable with
      `/policy` in `?debug=1`, so both are demoable before M6.
- [ ] Planner runs after every merge; a split animates (the branch lifts off into a new tree in
      the forest with a `split` root back to its origin) and is logged as an event.
- [ ] **Eval harness** `npm run eval:analyze`: ~30 team-labelled prompts (fixtures in
      `frontend/eval/`), run against the provider, report agreement with our labels per concept.
      This number goes into the study report as classifier validity.

*Acceptance:* on a fresh account, a 10-turn conversation produces a sensible 2-level tree; the
same concept mentioned in two chats is **one** concept (one leaf, two refs); pushing a tree past
the thresholds splits it without losing a leaf or a ref; eval agreement ≥ 70 % on
message mode (tune prompts until it is, or report honestly).

### M5 Mastery (BKT) and study mode (FE, Nov 28–Dec 4) ⇢ M4
- [ ] `lib/bkt.ts` (ADR-7) plus tests (hand-computed sequences, replay = incremental, overrides);
      `retention.ts` visuals driven by `mastery`; the scrubber previews `P(L)` decay to
      now + Δ; leaf hover shows `known ≈ 72 %` next to the glyph. Params from
      `study/bkt-params.json` (defaults until R2 lands).
- [ ] Squirrel tips and "revisit, most faded first" use `mastery` instead of `CONCEPT_BY_ID`.
      Study mode picks the lowest-`P(L)` concept.
- [ ] **Study mode** (a conversation flag, `/study [concept]` or from a leaf with `q`): pick the
      weakest or chosen concept → `quiz` task generates a task (question + expected key points)
      → the student answers → the analysis grades `correctness` → the next task adapts
      (ladder: retrieval question → apply/transfer → explain back). Hints are available and
      lower the independence of that attempt, so they're visible, never blocked.
- [ ] Optional, team decision: **knowledge-graph view** porting the `graph-prototype`
      `force-graph` canvas into React (`designs/ascii/Graph.tsx`), with color = mastery `P(L)` and
      edges = hierarchy + prerequisites. Read-only in M4.

### M6 Study instrumentation and conditions (FE + BE, Dec 1–5) ⇢ M5, M3 results
- [ ] `lib/study.ts`: `StudyConfig` from `?pid&cond` (ADR-9); a visible but unobtrusive
      participant badge only in `?debug=1`.
- [ ] **Conditions as data** in `study/conditions.ts`: both use the M3-optimal planner
      (`planner-params.json` from `research/`); **A = `split-chats`**, **B = `split-trees`**
      (ADR-9; confirm with TA). Same prototype, same task. Candidate DVs: time and errors to
      find a concept and the chat it came from; revisit accuracy; perceived overview and
      disruption (questionnaire); #chats / #trees produced; conversational continuity (did the
      user return to the old chat or topic?).
- [ ] Log BKT trajectories (`P(L)` after every attempt) per participant for the descriptive
      section. Don't use mastery as the primary DV; 20 min is too short to show learning
      differences between organization policies.
- [ ] Event log (`lib/telemetry.ts` → `POST /events`): `turn_sent`, `analysis_shown`,
      `relabel`, `veil_shown`, `reveal` (guess length, time-to-reveal), `veil_skip`,
      `nudge_shown`/`nudge_action`, `quiz_answer` (correctness), `forest_open`, `scrubber_move`,
      `nav` (from → to, via `radial`|`radial_flick`|`command`|`click`, time-to-select),
      `task_start`/`task_end`. Each event has `pid`, `cond`, `clientTs`, `conversationId`.
      *16 Nov:* backend `POST /events` built; `cond` comes from the session on the server, `pid` via
      `users.participant_id` (join on `user_id`).
      *20 Nov:* frontend built, for everyone in live mode (not only the study; the demo logs nothing):
      the catalogue `lib/events.ts` (`UsageEvent`; `eventsOf` derives events from store changes), the
      queue `lib/telemetry.ts` (batches of 200, localStorage mirror, keepalive on hide, backoff, a
      mirror never sent under another user's token), and the ASCII design's own events through
      `useStore().track`. Payloads hold ids, counts, lengths and labels, never texts. Events and
      fields: `frontend/README.md` "Usage log". Of this list: `turn_sent`, `analysis_shown`,
      `relabel`, `veil_shown`, `reveal`, `veil_skip`, `forest_open` are built; `nudge_shown` fires
      only in the classic design (the ASCII nudge is the veil); `scrubber_move` is `pane_action`
      `scrub`. Each event has `clientTs`, `conversationId` and in its payload `visit`, `seq`,
      `design`; `pid` and `cond` stay on the server. Still open: `task_start`/`task_end`,
      `quiz_answer`, `nudge_action`, `nav` (waits for `navigate()`, M2b), and the conditions
      (`StudyConfig`).
      *21 Nov:* the log now carries the texts, on Salomon's word ("Log anything potentially
      relevant"; this replaces "never texts" of 20 Nov): message, reply, the draft as rated,
      guess, titles, labels, reasons, command arguments, toasts, each cut to 8,000 characters
      with the real length beside it. Never: the session token, passwords, own-model keys, a full
      endpoint URL (only its host), the username. New events: `reply_first`, `load_failed`,
      `toast`, `draft_fill`, `message_jump`, `draft_paste`, `transcript_copy`, `filter_rated`,
      `compose`, `draft_abandoned`, `hint_hover`, `message_rest`, `shortcut`, `forest_zoom`,
      `forest_filter`, `squirrel_tip`, `concept_try`, `model_test`, `online`, `offline`,
      `resize`, `idle_start`/`idle_end`, `client_error`; `session_start` has the browser and
      screen. The mirror keeps at most 1 MB of JSON, so the sync queue keeps its room.
      *21 Nov:* logs page for the team at `/logs` (`frontend/logs.html`, `src/logs/`; Salomon:
      "add a page to see the logs / access them for our members"): admin token gate, visits
      newest first, one visit's timeline with readable lines, full texts, filters and raw JSON,
      the legend of every event, JSON and CSV downloads. Backend: `GET /admin/visits`,
      `GET /admin/events` (§4). Not linked from the app.
- [ ] Study task script: fixed topic plus seed subject; **live Claude via the `arbor` relay**
      (decided), with fixed models per task and temperature 0 for analysis; a session timer.
      (*16 Nov:* temperature cannot be set on API version 2026-10-21; fixed model and effort instead.)
      Log model ids per message so variance can be discussed in the report's limitations.
- [x] `GET /admin/export` CSVs feed straight into the analysis notebook. *16 Nov:* tables `events|usage|users`.
- [ ] Pilot checklist: full run in under 20 min, export opens in pandas, no absurd values.

- [ ] **Score visibility test** (ADR-9, second candidate; PROPOSED 17 Nov, runs only if the team
      and the TA agree, open question 9):
      - Assignment: `POST /session` with a participant id and no condition assigns the group on
        the server, balanced (the smaller group gets the next person, a coin decides a tie), and
        stores it in `users.condition`; `?cond=` on the study link overrides it for the
        experimenter. If the organization test runs too, the condition names both
        (e.g. `trees.shown`).
      - `StudyConfig.scoreFeedback: 'shown' | 'hidden'`, and ONE selector (`showScore`) that every
        place listed in ADR-9 asks. A test renders both designs in `hidden` and asserts that no
        label, percent, bar or filled leaf appears; the judge still runs and the scores are saved.
      - Measures: per participant the mean "thought along" percent over the task's turns
        (primary); share of delegated and of own turns; first vs. sent rating of a draft (did they
        rework it before sending); correctness of own claims; turns and words per prompt; a short
        quiz on the topic after the task; questionnaire (noticed a score? felt pressure? useful?).
      - Events: `draft_rated` (first and last rating per prompt), `turn_sent` with the rating,
        `score_shown` (A only); each with `cond`.
      - Analysis in `research/`: per-participant means, a permutation or Mann-Whitney test,
        effect size with interval, one plot per measure; the turn sample rated blind by two people.
      - Follow-ups only if A beats B: the thinking feedback variants below, one at a time.
- [ ] **Pane view test** (ADR-9, third candidate; PROPOSED 17 Nov, open question 10):
      - `StudyConfig.paneView: 'tree' | 'outline'` sets the start value of `ui.view`
        (`designs/ascii/ui.tsx`, today only `?layout=`). `t`, `/outline` and the pane switcher
        keep working in both groups.
      - Events, for everyone and not only in the test: `view_change` (from, to, via
        `key`|`command`|`click`), `pane_action` (`rest_on_leaf` after 400 ms, `open_refs`,
        `jump_to_message`, `scrub`; with the view), and the seconds per view, worked out in the
        analysis from `view_start`, `view_change`, `page_hidden` and `page_visible`. *20 Nov:* built
        (names as here; see the Event log item).
      - Analysis in `research/`: pane actions per minute by group, share of time per view, how
        many leave the start view and when, finding-task time and errors. The pilot's numbers
        come first, as plain description.
- [ ] **Thinking feedback variants** (ADR-9, fourth candidate; PROPOSED 17 Nov, open question 10):
      - `StudyConfig` fields `squirrel`, `aiColour`, `scoreForm`, `scoreTiming`, `leafFill`; the
        default of each is today's behaviour. One selector per field next to `showScore`, and a
        test per field that the default renders exactly as before.
      - `squirrel: 'mad'`: a new `Pose` in `Squirrel.tsx` (back turned, one stamp, never on a
        loop; with reduced motion only the line) plus one spoken line. `proud` adds its line to
        today's `cheer` hop. Both react to the judge's label of the sent message, never to the draft.
      - `aiColour: 'red'`: an attribute on the root swaps `--ai` and `--ai-soft` in the light and
        the dark theme (contrast at least 4.5:1). Nothing else changes colour.
      - Blocks: `study/conditions.ts` can change one field every N turns in a balanced order per
        participant (`block_start` event with the variant); every `turn_sent` carries the
        variant that was active.
      - Build `squirrel` and `aiColour` first; the other three only if the team wants them.

**Freeze Dec 5.** After that: bug fixes only, until the study ends.

### R Research track (Python, `research/`, parallel to M4–M6, owner: whoever writes the report sections)
- [ ] **R1 BKT notebook:** model, help-aware extension, a worked example on a synthetic student
      (own vs. delegated sequence → diverging `P(L)` curves). This becomes the report figure that
      explains Arbor's fading.
- [ ] **R2 Parameter priors from public data:** fit pyBKT on ASSISTments (skill-builder data has
      hint usage). Map: no hint = `own`, hint(s) = `together`, bottom-out hint/answer shown =
      `ai`. Fit with `multigs='mode', multilearn='mode', forgets=True`, 5-fold CV vs. plain BKT
      (AUC/RMSE). Export the fitted means as `frontend/src/study/bkt-params.json`. This makes
      our defaults justified rather than invented. Check the dataset's license and cite it.
- [ ] **R3 Study data:** after the study, replay our attempts with the R2 params, check
      calibration on the gradable attempts we have (descriptive only; n is far too small to
      fit or validate per-concept parameters, so say so in Limitations).
- [ ] **R4 Classifier validity:** analyze the M4 eval harness output and M9's `eval:linter` (agreement, Cohen's κ vs.
      team labels, confusion matrix). Goes into the report's apparatus/limitations.
- [ ] **R5 Study stats:** export → tests and plots per the lecture's analysis slides.

### M7 Bring your own key (FE, right after the freeze, before Demo Day) ⇢ M4
Cheap once M4 exists, because all prompts and schemas are already client-side. It can be pulled
before the freeze if the study doesn't need the time.
- [x] `AnthropicProvider` (BYOK) and `OpenAICompatibleProvider` (base URL + key + model), per ADR-4.
      *17 Nov:* built as provider choice `own` (`src/ai/own/`): live mode, chats still saved on the
      backend; chat, analysis and scores each go to their own connection (group backend, Anthropic
      key, or OpenAI-compatible), so the fast scores can come from a model of the user's too
      (logprobs; Anthropic cannot). Anthropic uses `output_config.format`, not tool use.
- [x] Settings → *model*: presets, test connection, a separate provider for chat vs. analysis,
      and "remember on this device". *17 Nov:* the ASCII sheet (`/model`); classic shows the
      choice and where to set it up.
- [x] Docs in the README: Ollama needs `OLLAMA_ORIGINS=https://hci-2026-group-19.pages.dev`;
      LM Studio needs its CORS toggle; Chrome asks for local-network permission the first time a
      hosted page calls `localhost`; a remote self-hosted server needs HTTPS and CORS (or a
      tunnel, e.g. `cloudflared`).
- [x] Error mapping: CORS/network → "your endpoint blocked the browser" with the fix; 401 → key;
      404 model → model list; no JSON support → automatic fallback mode.

*17 Nov:* checked in a browser against a Bedrock stand-in in both formats (`zai.glm-4.7`,
`qwen.qwen3-32b`, Claude Haiku 4.5 and Sonnet 5): full turns with no `/api/ai/*` request, the
key only in sessionStorage. Acceptance with real OpenAI, OpenRouter and Ollama is still open.

*Acceptance:* the full flow (chat + analysis + tree) works with an OpenAI key, an OpenRouter key
and a local Ollama model, with no request to our backend except `/sync`.

### M8 First run: live by default, accounts, a calmer composer (BE + FE, 17 Nov) ⇢ M2, M3
What a new visitor sees on the deployed site: until now the scripted demo with its demo forest,
a prompt squeezed to two words, and a linter that made the prompt jump.
- [x] **Live by default** (ADR-4 amended): `VITE_DEFAULT_PROVIDER = arbor`; the demo stays
      behind `?demo=1` and in settings.
- [x] **Accounts** (ADR-8 amended): migration `0003_accounts.sql`, `/api/auth/signup|login`,
      `/api/me`; PBKDF2 in WebCrypto; tests and smoke checks.
- [x] **Welcome screen** (`src/Welcome.tsx`): log in, sign up, continue as guest; later as an
      overlay from settings → account and `/signup`, `/login`, `/logout` (ASCII design).
- [x] **A fresh user starts on an open, empty chat with no trees**: live mode already starts with
      one empty chat; the intro no longer opens by itself in live mode (the empty chat links to it,
      `?intro=1` forces it).
- [x] **Composer** (ADR-14): full width, grows to half the screen; the model sheet's `.a-field`
      class had given the prompt a 9ch column (renamed `.a-form-row`).
- [x] **Linter rework** (ADR-14): underlines with hover reasons, one fixed score line above the
      prompt, nothing below it.
- [ ] Apply migration 0003 to `hci-grp19` and check T-39 on the deployed Worker (needs the
      Cloudflare login). *20 Nov:* the migration is applied (on Salomon's go); one signup on the
      deployed Worker answered 200 and its account was removed again. Still open of T-39: login,
      and the CPU time of both.
- [ ] Rate limit for `/api/auth/login` before the site is shared widely.
- [ ] Classic design: an account entry in its settings (the welcome screen already covers both
      designs; §8 says no new features in classic, so only if the team wants it).

*Acceptance:* a new browser on the deployed site sees the welcome screen; "continue as guest"
opens an empty chat whose first message gets a live Claude answer and grows the first tree; sign
up keeps that chat; log out and log in on another browser shows it again; typing a long prompt
never moves anything but the prompt itself.

### M9 Linter v2: measure, then judge drafts better (FE, 17 Nov →) ⇢ M8, ADR-15
- [x] Labelled prompt set `frontend/eval/linter-set.ts`: 136 prompts (46 own, 42 together,
      48 ai), tags for the hard cases (hedge, negation, German, boundary, …). *17 Nov:* labels are
      Claude's draft from the rubric in the file.
- [x] Eval harness `npm run eval:linter` (`eval/linter.eval.ts`, `eval/metrics.ts`): accuracy,
      Cohen's κ (plain and linearly weighted), per-class recall and precision, accuracy per tag,
      label changes while typing, a rules → fast model cascade at several thresholds, and every
      missed case. Rules and naive Bayes run offline; the fast model with `VITE_API_URL`.
- [x] First numbers (`eval/results/linter-2026-11-17.md`): rules 68 % / κ 0.52, naive Bayes
      57 % / κ 0.35, rules change label in 63 % of prompts while typing (at most twice).
- [x] **Set `FAST_API_KEY` on the deployed Worker** (`uv run pywrangler secret put FAST_API_KEY`).
      *17 Nov:* it is missing, so every fast score fails on the live site (the after-send percent
      and PR #14's score line), and the eval could not measure the fast model.
      *20 Nov:* set (the Bedrock key, as for Claude). On the live site the score line gets the
      fast model's rating after a pause and a sent message gets its percent. The eval with the
      fast model is still to run.
- [ ] Two team members label the 136 prompts independently (without the draft labels); report
      their κ, settle disagreements, record `rater`. Add real-looking prompts from the pilot
      (with consent) toward 300.
- [ ] Run `eval:linter` with the fast model; apply ADR-15's decision rule; tick ADR-15 or amend it.
- [ ] Depending on the result: gate PR #14's pause rating to unsure drafts, smooth the rules'
      label over time, and fix the rules' biggest misses (own claims without "I think", corrections,
      German).

*Acceptance:* a team-rated set with inter-rater κ reported, the three judges compared on it, and
ADR-15 decided with those numbers. The same numbers feed R4.

### M10 Semantic guess feedback at predict → reveal (BE + FE) ⇢ M3, ADR-16
- [ ] Backend: task `grade` in the task allowlist (`schemas.py` `Task`), mapped to
      `MODEL_ANALYZE` / `EFFORT_ANALYZE` / `MAX_TOKENS_JSON`; tests; `docs/api.md`.
- [ ] `ai/schemas/guessGrade.ts` + `ai/prompts/grade.ts`; `Provider.json('grade')` for `arbor`
      and `own` (scripted: none, keeps the lexical overlap).
- [ ] `turn.ts`: run the grade once the reply is complete and a guess was revealed (next to
      `scoreGuess`; never fails the turn); store it on the reply; `correctness` from the verdict
      when the fast score is missing.
- [ ] Transcript (ASCII): highlights from the resolved `answerQuote`s by relation, "what you
      missed", a misconception line; "words in common" while the grade is pending; same in the
      classic design only if the team wants it (§8).
- [ ] Eval: `npm run eval:grade` with about 30 question / answer / guess triples (right in other
      words, partly right, wrong with shared words, misconception, "idk"), expected verdict and the
      idea that should match; report verdict agreement and how often the expected idea is quoted.
      Run the lexical overlap on the same triples as the baseline.
- [x] Set `FAST_API_KEY` on the Worker (M9), so the guess's numbers work on the live site too.
      *20 Nov:* set.

*Acceptance:* on the eval triples the verdict agrees with the expected one at least 85 % of the
time, every "right in other words" case highlights the matching idea, and no "wrong with shared
words" case is shown as right; in the browser the semantic result replaces the overlap within
about 3 s of the reveal.

### Stretch (post-study)
- **S2 Desktop shell (ADR-11):** Electron wrapper around the same build; providers in the main
  process over IPC; ChatGPT plan via `@siwc/local`; local model discovery; keys in the OS keychain.
- **S3 PWA and mobile:** manifest, install prompt, responsive ASCII layout under 600 px (pane
  becomes a bottom sheet).
- **S4 MCP server:** expose `get_concepts` / `log_attempt` so Claude or ChatGPT apps can feed
  the graph (self-reported, lower trust).
- **S5** Remove the classic design if nobody needs it.

---

## 7. Open questions for the team (decide before the named milestone)

1. **M3 output format (M4 → M6):** what exactly does the optimization decide? Split thresholds,
   which branch becomes a new tree, or tree assignment of concepts? And does it ship as
   parameters for `HeuristicPlanner` or as a policy we implement as `OptimalPlanner`? Is the
   decision topic-based (needed for a clean `split-chats` vs `split-trees` IV, ADR-9)?
   *25 Nov (proposal, `research/forest-building/`):* topic-based. Every step decides where the
   prompt goes and whether prompts or topics move (also under a newly inserted topic). It ships
   as per-step forest snapshots plus parameters, so an `OptimalPlanner` can either replay the
   sequence or apply the same IP policy.
2. **A/B conditions (M6):** is "`split-chats` vs `split-trees`, same M3 trigger" OK with the TA?
3. **ADR-12:** TS Worker for the app API, or keep the Python Worker? Decide in M0.
4. **Study topic and seed subject (M4/M6):** one fixed topic for everyone (recommended), so trees
   are comparable.
5. **Graph view (M5):** port `force-graph` into the ASCII design, or keep everything as trees and
   forest?
6. **Consent and data (M6):** transcripts land in D1. We need a consent line in the protocol,
   and should delete the study data after grading.
7. **Radial items (M2b):** are the 8 proposed wedges right? It's the same menu in both conditions
   (not part of the IV).
8. **Demo Day date:** decides whether M7 (BYOK) lands before or after it.
9. **Score visibility test (M6, ADR-9, proposed by Salomon 17 Nov):** (a) Does it run next to the
   organization test (`split-chats` vs `split-trees`, which carries the course's M3 requirement),
   as a second factor, as a second session, or instead of it? Twelve participants do not carry
   two factors at once. (b) Are veil and nudges off in both groups during this test, so that the
   only difference is the visible score? (c) One group per person, or both groups per person on
   two topics? Ask the TA with the study design (Dec 4/8).
10. **More test candidates (M6, ADR-9 third and fourth, proposed by Salomon 17 Nov):** (a) Which
    ONE comparison is the primary A/B of the course study: organization, score visibility, pane
    view (tree vs. outline) or one feedback variant (squirrel mad, red vs. purple)? The others run
    as blocks within a person, on the live site, or not at all. (b) May the feedback variants run
    on the live site with everyone who uses it (consent line, groups assigned by the server)?
    (c) Is a scolding squirrel acceptable to the team and the TA? It can make people feel judged.

**Decided:** the study runs on live Claude through the backend relay (department credits);
ChatGPT sign-in is not viable for the hosted app, so BYOK covers "use your own model" (M7) and
ChatGPT plan usage moves to the desktop shell (S2).

---

## 8. Conventions for the implementing agent

- Read §2–§4 before touching code; they are binding. If a decision blocks you, stop and propose
  an edit to this file instead of working around it.
- New logic goes in pure, tested modules under `src/lib/` or `src/ai/`; components stay thin.
  The reducer stays pure; side effects live in `turn.ts`, `sync.ts` and `telemetry.ts`.
- Designs read **only** from the store and selectors. They never import `data/`, `engine.ts` or a provider.
- No secrets in the frontend except a user's own BYOK key (M7). The backend reads secrets from
  `request.scope["env"]`.
- Keep the ASCII design's vocabulary: lowercase UI copy, glyph language `●◑○`, keyboard-first,
  every new action reachable via `/command`, and listed in the modeline and the `?` sheet.
- Views change only through `navigate()` (ADR-13). A new view = a new `View` kind + hash route +
  (if top-level) a radial wedge, never another boolean in the store.
- `classic` must compile; don't add features to it.
- Update `frontend/README.md` / `backend/README.md` and this file's checkboxes in the same PR.
