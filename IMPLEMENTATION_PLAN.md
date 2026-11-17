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
| `scripted` | browser, wraps `engine.ts` + `classify.ts` + `matchConcepts` | builds `TurnAnalysis` directly | M1 (default until M3) |
| `arbor` | backend relay → Claude Messages API, department credits | tool use with `input_schema` | M3 (**study runs on this**) |
| `anthropic` (BYOK) | **browser → api.anthropic.com** with the user's key (`anthropic-dangerous-direct-browser-access: true`) | tool use | M7 |
| `openai-compatible` (BYOK / own server / local) | **browser → user's base URL**: OpenAI, OpenRouter, Groq, Mistral, a self-hosted vLLM/LiteLLM, Ollama or LM Studio on localhost | `response_format: json_schema` (Ollama: `format`); fallback "JSON only" prompt + `JSON.parse` + one repair retry | M7 |
| `chatgpt` | Sign in with ChatGPT; desktop shell only (ADR-10/11) | Responses API | S2 |

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

### ADR-8 Auth: anonymous sessions
`POST /api/session` creates a user (optionally with `participantId` and `condition` from the URL)
and returns `{ userId, token }`. Token = HMAC-SHA256(userId, `SESSION_SECRET`), stored in
localStorage and sent as `Authorization: Bearer`. No email or password in M4. "Sign in with
ChatGPT" identity could become the account system later.

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

---

## 4. API contract (backend ↔ frontend)

All routes under `/api`, JSON, `Authorization: Bearer <token>` except `session` and `health`.
Errors: `{ error: { code, message } }` with an HTTP status.

| Method & path | Body → Response | Notes |
|---|---|---|
| `GET /health` | → `{ ok, environment }` | exists |
| `POST /session` | `{ participantId?, condition? }` → `{ userId, token }` | ADR-8 |
| `GET /state` | → `{ concepts, edges, trees, conversations, attempts }` | bootstrap; messages excluded |
| `GET /conversations/:id/messages` | → `{ messages }` | lazy per conversation |
| `PUT /sync` | `{ concepts?, edges?, trees?, conversations?, messages?, attempts? }` → `{ ok, serverTime }` | idempotent upsert by client id, one `db.batch()`; last-write-wins on `updatedAt` |
| `POST /ai/complete` | `{ task: 'chat'\|'analyze'\|'tree'\|'quiz', system, messages, schema?, stream? }` | `chat` + `stream:true` → **SSE**: `event: delta {text}` … `event: done {usage}` / `event: error {code,message}`. Others → `{ output, usage }` (JSON outputs, see note below). 429 `budget_exceeded` when over budget. |
| `POST /events` | `{ events: StudyEvent[] }` → `{ ok }` | batched, fire-and-forget |
| `GET /admin/export?table=events\|attempts\|messages` | → CSV | header `X-Admin-Token` |

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
- [ ] `lib/session.ts` (create or restore a token), `lib/sync.ts` (debounced queue, retry with
      backoff, localStorage mirror so a reload never loses a turn), hydrate on boot.
      *17 Nov:* `lib/session.ts` built with M3 (create or restore, a new session once after a 401);
      `sync.ts` and hydrate not yet.
- [x] `api.ts`: auth header, typed errors, `apiStream()` for SSE. *17 Nov:* built with M3; one base
      URL (`VITE_API_URL`), `ApiError(status, code, message)`, SSE events split across chunks.
- [ ] **Chat history and revisit** (ASCII design, keyboard-first):
      - chat list: `/chats` (or `c`), grouped today / this week / earlier, each row showing its
        trees' glyph crowns; `/new` starts a chat; titles are auto-set from the first turn and
        editable with `/title`.
      - tree → chats: the tree detail in the forest lists **"grown in"** chats (from
        `conversationsOfTree`); enter opens the chat.
      - leaf → message: hover/enter on a leaf lists its refs (chat + snippet + date); choosing one
        opens that chat and `jumpTo`s the message, in any chat, not just the live one. This
        replaces the "past chats are read-only" toast.
      - chat → trees: the transcript header shows the trees this chat grew (`treesOfConversation`).
- [ ] Demo mode `?demo=1` keeps the scripted fixtures for offline demos.

*Acceptance:* create two chats about the same subject, reload, and both come back. Their tree
lists both under "grown in"; a leaf touched in both offers both messages and jumps correctly into
either chat. Offline edits sync after reconnect.

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
      `correctness`).
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
- [ ] Study task script: fixed topic plus seed subject; **live Claude via the `arbor` relay**
      (decided), with fixed models per task and temperature 0 for analysis; a session timer.
      (*16 Nov:* temperature cannot be set on API version 2026-10-21; fixed model and effort instead.)
      Log model ids per message so variance can be discussed in the report's limitations.
- [x] `GET /admin/export` CSVs feed straight into the analysis notebook. *16 Nov:* tables `events|usage|users`.
- [ ] Pilot checklist: full run in under 20 min, export opens in pandas, no absurd values.

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
- [ ] **R4 Classifier validity:** analyze the M4 eval harness output (agreement, Cohen's κ vs.
      team labels, confusion matrix). Goes into the report's apparatus/limitations.
- [ ] **R5 Study stats:** export → tests and plots per the lecture's analysis slides.

### M7 Bring your own key (FE, right after the freeze, before Demo Day) ⇢ M4
Cheap once M4 exists, because all prompts and schemas are already client-side. It can be pulled
before the freeze if the study doesn't need the time.
- [ ] `AnthropicProvider` (BYOK) and `OpenAICompatibleProvider` (base URL + key + model), per ADR-4.
- [ ] Settings → *model*: presets, test connection, a separate provider for chat vs. analysis,
      and "remember on this device".
- [ ] Docs in the README: Ollama needs `OLLAMA_ORIGINS=https://hci-2026-group-19.pages.dev`;
      LM Studio needs its CORS toggle; Chrome asks for local-network permission the first time a
      hosted page calls `localhost`; a remote self-hosted server needs HTTPS and CORS (or a
      tunnel, e.g. `cloudflared`).
- [ ] Error mapping: CORS/network → "your endpoint blocked the browser" with the fix; 401 → key;
      404 model → model list; no JSON support → automatic fallback mode.

*Acceptance:* the full flow (chat + analysis + tree) works with an OpenAI key, an OpenRouter key
and a local Ollama model, with no request to our backend except `/sync`.

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
