# Arbor — high-fidelity prototype

Arbor is a web app for learning with LLM chats. It looks like an overlay on a chat, and it does two things:

1. **Awareness: who is doing the thinking?** Every prompt is labelled as *your thinking* ●, *thinking together* ◑ or *delegated to AI* ○. Before you delegate, Arbor can offer a gentle speed bump: add your own take first.
2. **Organisation: a knowledge tree, zoomable to a forest.** Each concept you touch becomes a leaf on the conversation's tree. Filled leaves are ideas you reasoned through yourself; hollow leaves are still the AI's. Zoom out to see all your conversations as a forest, grouped into groves and connected by roots (shared concepts).

The prototype shows Arbor on top of a generic chat app inside a mock browser window. The answers come from one of two providers: the **scripted** assistant ("Wizard of Oz"), which runs offline and behaves the same way for every test participant, or **live** Claude through the group's backend (see [Live answers](#live-answers-provider-arbor)). In live mode your chats, trees and labels are saved on the backend and come back on the next visit; the scripted demo saves nothing (see [Demo and live](#demo-and-live-what-is-saved-where)). The plan for the rest (full turn analysis, study setup) is in [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md).

## Design styles

Arbor comes in several design styles that share one core: the conversation, the classifier and the scripted assistant live in one store (`src/lib/`, `src/data/`), and each style is its own UI under `src/designs/`. Switch with `?design=ascii|classic`, in settings, or by typing `/design classic`. The conversation carries over, so you can compare styles side by side in a user test.

| Style | What it is |
|---|---|
| **ascii** (default) | Everything on one character grid, in one monospace voice. Minimal chrome, keyboard first, and a set of interaction concepts built for the medium (see below). |
| **classic** | The first iteration: a mock browser with a chat app and the Arbor side panel, an SVG tree with hover tooltips, and the zoomable SVG forest. It has the newer additions too: the squirrel, which you can hover and poke for tips like in the ASCII style. |

To add a style, create `src/designs/<name>/App.tsx` (default export, reads `useStore()`), add it to `DESIGNS` in `src/App.tsx` and to the `Design` type in `src/lib/types.ts`. Prefix its CSS classes so styles never collide.

### Interaction concepts in the ASCII style

Press `?` in the app for the same list, each with a *try it* button that sets up the demo.

| # | Concept | Principle | What happens |
|---|---|---|---|
| 01 | **Thought linter** | Explainable feedforward | While you type, the words that make a prompt delegating get a wavy underline (dashed: together, solid: yours, so shape carries the meaning as well as colour), and the reason sits right below, like a spellchecker or compiler diagnostic. |
| 02 | **Modeline** | Ambient awareness, calm technology | Like vim's `-- INSERT --`, the status bar always says who is thinking right now and lists the keys that work in this moment. Even the caret takes the mode's colour. |
| 03 | **Predict → reveal** | Desirable difficulty, generation effect | With nudges on *active*, the answer to a prompt the linter reads as delegating arrives veiled (`░░░`): its shape is visible, its words are not. Type a hunch and reveal it, and a decode sweep uncovers the answer with the words you already had highlighted; the prompt becomes *thinking together* (live: the guess is scored instead, see [Fast and slow](#fast-and-slow-how-a-turn-is-judged)). Or just press ↵. It is never blocked. |
| 04 | **Two views, one tree** | Multiple views, object constancy | `t` switches between the growing plant and a `tree`-command outline. Every leaf keeps its identity and glides to its new place. |
| 05 | **Forgetting scrubber** | Feedforward of consequences | Drag time forward (`[` `]`): letters drop out of labels and forgotten leaves fall to the ground. What you delegated falls first. An illustrative Ebbinghaus-style model (`src/lib/retention.ts`), labelled as such. |
| 06 | **Semantic zoom** | Overview first, zoom & filter, details on demand | Pinch out or press `f`: the camera pulls back from your tree to the forest, where every chat is a crown of glyphs. Hover a tree and labelled roots run to chats that share a concept; zoom in for the full tree and a "revisit, most faded first" list. |
| 07 | **Drawn links** | Brushing & linking | Hover a message and a line is drawn in box characters to the leaves it grew; hover a leaf and the line finds its message, pointing up or down if it is scrolled away. |
| 08 | **Relabel in place** | User control, error recovery | Click the glyph next to a message: the evidence is underlined in your own words, with the confidence, and you can relabel it. The tree regrows. |
| 09 | **Command line** | Flexibility & efficiency, recognition over recall | `/` lists every command with what it does (`/quiz`, `/hint`, `/forest`, `/time 1w`, `/why`, `/nudge`, `/design`, …). `tab` cycles demo prompts. |
| 10 | **Squirrel** | Ambient presence, non-judgmental tone, details on demand | A squirrel in characters holds an acorn in the glyph language, lifts it when an answer is veiled and hops when you think for yourself. On its own it moves only when something changes. Hover it and it notices you once (ear twitch, blink, a ripple down the tail); poke it and it tosses its acorn and cycles through tips, each with an action: the leaf that is least yours (*quiz me*), what would fade (*skip ahead*), the forest. Poke it too often and it gets dizzy. |
| 11 | **Chats ↔ trees ↔ leaves** | Two-way links, information scent | Every chat is kept. `c` (or `/chats`) lists them by day, each with the crowns of the trees it grew; `/new` starts one, `/title` renames it. A chat names the trees it grew under its title; a tree in the forest lists the chats it was *grown in*; a leaf touched by several messages lists them (chat · snippet · date). Pick one and you land in that chat, on that message. |

## Run it

```bash
npm install
npm run dev        # → http://localhost:5173
npm run build      # type-check (tsc) + static build in dist/
npm test           # unit tests (vitest); npm run test:watch while developing
```

Requires Node 22.12+ (`.node-version` pins 22).

Tests sit next to the code they test (`src/lib/*.test.ts`). `classify.test.ts` snapshots the linter's output for the demo prompts; if you change a rule on purpose, update the snapshot with `npx vitest run -u` and check the diff.

## Deploy (Cloudflare Pages)

The app is the Cloudflare Pages project `hci-2026-group-19` (see `wrangler.toml`), connected to this GitHub repo: every push to `main` builds and deploys it, and other branches get preview URLs. The live prototype is at https://hci-2026-group-19.pages.dev; append the URL parameters below to set up test conditions.

Pages project settings: root directory `frontend`, build command `npm run build`, output directory `dist`. Two build-time variables. Production builds take their defaults from `vite.config.ts` (a variable set in the Pages project settings wins); `npm run dev` uses `.env.development`:

| Variable | Meaning |
|---|---|
| `VITE_API_URL` | Base URL of the backend Worker (`https://hci-backend.leon-grass.workers.dev`; locally `http://localhost:8787`) |
| `VITE_DEFAULT_PROVIDER` | `scripted` or `arbor`: where answers come from until a visitor picks in settings. Stays `scripted` for now, see the comment in `vite.config.ts` |

## Live answers (provider `arbor`)

Where answers come from is a setting: **answers: scripted | live** in the settings of both designs, `/provider scripted|arbor` in the ASCII style, or `?provider=arbor` / `?provider=scripted` for one visit. `?demo=1` beats everything else; then the URL parameter beats the saved choice, which beats the build default (`VITE_DEFAULT_PROVIDER`). Only a choice made in settings is saved (localStorage `arbor.provider.v1`). The choice is also the mode: switching stops a running reply and loads the other world at once (live: your saved chats; scripted: the demo).

With `arbor`, the answers are Claude through the backend relay (`../backend/docs/api.md`). The frontend writes the prompts and schemas; the backend picks the model, caps the tokens and keeps the budgets.

- **Session:** the first call creates an anonymous session (`POST /api/session`). The token stays in localStorage (`arbor.session.v1`); after a 401 (database reset) a new one is made once and the call repeats.
- **Chat:** streamed over SSE. The tutor prompt (`src/ai/prompts/chat.ts`) follows the linter's label for your message (your own reasoning: it reacts to it first; exploring: it explains and hands a question back; delegating: it answers fully; a hint request: a hint only), the nudge level (off or Arbor paused: a plain assistant) and study mode. `esc` (or `/stop`) cancels the request itself.
- **Analysis:** after each message one structured call (`src/ai/prompts/analyze.ts`, schema in `src/ai/schemas/turnAnalysis.ts`) labels who did the thinking, with reasons and quoted evidence, and names up to three concepts, each an existing node of your graph or a new one. That is what grows the leaves; the first message of a chat also picks its subject (the grove). An answer that does not fit the schema counts as a failed analysis, and the linter's label stays.
- **Start:** your saved chats load and the one you changed last opens (see below). The `tab` prompts are three generic ones instead of the script's.
- **Errors:** a failed reply shows `! failed · <why> · r retry` (classic: the reason and *Retry*). A used-up budget says whether it is your daily budget (resets at midnight UTC) or the project's total budget.
- **Predict → reveal** works on the stream: the answer keeps arriving under the veil, and a reveal shows what is there so far while the rest streams in. A guess is scored once the reply is complete (see [Fast and slow](#fast-and-slow-how-a-turn-is-judged)).

Not in live mode yet: quizzes on a leaf (`q`, the squirrel's *quiz me*, the forest), which need a `quiz` task that keeps the question pending so the answer is graded (M4/M5); `/quiz` still works as a plain chat message. Also not yet: "make it yours" after an answer, and sending study events. Trees are still shallow: most live leaves sit on the *side questions* branch until the M4 tree work.

Live mode needs a backend with the persistence routes (`GET /api/state`, `PUT /api/sync`, `GET /api/conversations/:id/messages`, M2 backend and its migration `0002`). Without them the start shows *could not load your chats*. To run both locally (the backend's CORS allows exactly `http://localhost:5173`):

```bash
cd ../backend && uv run pywrangler d1 migrations apply hci-grp19 --local && uv run pywrangler dev   # once per checkout, then just `dev`
cd ../frontend && npm run dev -- --port 5173 --strictPort    # .env.development points at http://localhost:8787
# then open http://localhost:5173/?provider=arbor&intro=0
```

Against the deployed backend (once it has the M2 routes): `VITE_API_URL=https://hci-backend.leon-grass.workers.dev npm run dev -- --port 5173 --strictPort`.

Every live message costs tokens from the group's budget: one chat call, one analysis call and one small score call (two more for a graded claim or a revealed guess). Measured on 17 Nov at the start of a chat: about 540 tokens for the reply, 2,560 for the analysis, 200 to 500 for each score. The reply and the analysis grow as the chat and the graph grow, because the transcript is sent again each time.

## Fast and slow: how a turn is judged

Three judges look at every message, from fast to slow:

1. **Linter, while you type** (`src/lib/classify.ts`): word rules underline the words and pick the label before you send. Free and instant; nothing goes to a model while you type.
2. **Probability scores, right after you send** (live mode, `Provider.score`, prompts in `src/ai/prompts/score.ts`): a fast model gets one yes/no question, *did the student think along?*, and must answer with the digit 1 (yes) or 2 (no). The backend (`POST /api/ai/score`) reads how likely each digit was as the model's answer, and P(1) / (P(1) + P(2)) is the score, as in G-Eval. That number is the message's **thought along** percent. It sets the label (yours from 67 %, delegated up to 33 %, together in between: `OWN_FROM` and `AI_UP_TO` in `src/lib/modes.ts`) and the independence of every concept the message touched. A second question, *is it right?*, runs once the reply is complete: for an own claim that the analysis found gradable (the student's message against the tutor's answer), and for a guess at predict → reveal. A revealed guess is also asked *did the student think along?* (with the prompt as context): a real guess raises the percent, it never lowers it, and "no idea" stays low. Each call takes about 0.3 s.
3. **Turn analysis, slow** (Claude, `analyze`): which concepts the message is about, where they go in the graph, reasons and quoted evidence. With scores it no longer decides the numbers; whichever of the two lands first, the result is the same.

What you see: the *why* of a message says *thought along 83%* and, when graded, *right 91%*; under a revealed answer the guess shows *right 98% · thought along 100%* (classic: a note under the answer). On its way: *…*; failed: *not checked*, and the analysis's numbers stay. A relabel by you always wins over a score. The scores are saved with the message (`scores` on the user message), so they are back after a reload.

Why a second model: Claude's API returns no token probabilities, so Claude cannot give these scores. A provider without `score` (the scripted demo; a Claude-only key in M7) keeps the analysis's own numbers, and a guess counts as *thinking together* as before.

**Eval:** `npm run eval:score` sends 28 labelled cases (`eval/score.eval.ts`) to a running backend (`VITE_API_URL`, default `http://localhost:8787`) and prints one row per case. It is not part of `npm test`. On 17 Nov with `zai.glm-4.7-flash`: 27 of 28 in their band; delegating requests scored 0.007 to 0.047, own reasoning 0.98 to 0.999, hint and quiz requests 0.62 to 0.73 (together), wrong statements and "idk" 0.000 to 0.004. The one miss: "Why does a smaller learning rate help? Is it because big steps overshoot?" scores 0.95 (yours), and it does carry an own idea. What the wording needs: one example per side (without them "Write me a short summary of …" sat at 0.5), and the tutor's answer *before* the student's statement (tutor answers often end with a question, and the model answered that one instead: a wrong claim scored 0.88, now 0.002).

## Demo and live: what is saved where

| | Demo (provider `scripted`) | Live (provider `arbor`) |
|---|---|---|
| Data | the scripted fixture: the "neural networks" chat and the demo forest | your own chats, concepts, trees and labels |
| Saved | nothing; a reload starts the demo again | on the backend (D1), through `PUT /api/sync` |
| Requests to the backend | none at all | session, load, save, model calls |
| Turn on | build default, `?provider=scripted`, or `?demo=1` (forces it for the visit, whatever is saved) | `?provider=arbor` or *answers: live* in settings |

**What live mode saves** (`src/lib/sync.ts`): after every change it compares the state with the one before and queues what changed: concepts, edges, trees (a tree the planner removed is sent once more with `deletedAt`), chats, messages and attempts (a relabel adds a new attempt that supersedes the old one). A chat is saved from its first message on; an empty chat stays on this device and is dropped when you leave it. A reply is saved once it is complete (never while it streams); a failed reply is not saved, its retry replaces it.

**When:** about 0.8 s after a change, and at once when a reply ends. Requests carry at most 500 rows. Network errors, 5xx and 401 are tried again after 1 s, 2 s, 4 s … (at most 30 s), and at once when the browser is back online; when the tab is hidden or closed, what is left goes out with `keepalive`. A 4xx is a bug in what we send: those rows stay queued, a toast and the browser console say why, the modeline shows `! n not saved`, and they are sent once more after the next reload. The ASCII modeline says `saved`, `saving…` or `offline · n unsaved`.

**A reload never loses a turn:** the queue is mirrored in localStorage (`arbor.sync.v1`) and goes out together with the next start. The start loads `GET /api/state` (everything but messages), puts the queued rows on top (they are newer) and opens the chat you changed last; a first visit gets one new, empty chat. Messages load per chat when you open it (`GET /api/conversations/:id/messages`) and stay for the visit. While loading, the page says *loading your chats…*; if the backend cannot be reached it says so with *retry* (and tries again by itself when the browser is back online). It never shows the demo instead. The device keeps only the queue, not a full copy of your data, so live mode does not work offline from a cold start.

localStorage keys: `arbor.session.v1` (the session token), `arbor.sync.v1` (changes not saved yet), `arbor.provider.v1`, `arbor.settings.v1`, `arbor.onboarded.v1`.

**Chat history in the ASCII style** (keyboard first; also in the `?` sheet, concept 11, and in the modeline):

| Key / command | What it does |
|---|---|
| `c` or `/chats` | the chat list: today, this week, earlier; each row shows the crowns (one glyph per leaf) of the trees the chat grew. `↑↓` move, `↵` open, `n` new chat, `esc` close |
| `/new` | start a new chat |
| `/title <name>` | rename the open chat (new chats are named after their first message) |
| *grew* line under the chat title | the trees this chat grew; click one to open it in the forest |
| forest → a tree → *grown in* | the chats this tree grew from; click one to open it |
| click or `↵` on a leaf | one message: open its chat at the message; several: list them (chat · snippet · date) to pick one, in any chat |

The classic style's sidebar opens these chats too, and its *New chat* button starts one. In the demo, the past chats of the forest have no transcript: opening one says so (classic: it opens their tree in the forest, as before).

## Demo script, ASCII style (≈ 3 minutes)

1. **Intro**: one screen explains the glyphs. `?` opens the concept list at any time.
2. **Lint**: press `tab` for *"Write me a summary of backpropagation…"*. The words *write* and *summary* get a wavy underline with the reasons below, the modeline says `○ DELEGATING`, and the squirrel holds a hollow acorn.
3. **Predict → reveal**: press ↵. The answer arrives veiled and the squirrel lifts its acorn. Type a hunch (*"it goes backwards with the chain rule"*) and press ↵: the answer decodes, the words you had light up, and the *Backpropagation* leaf grows half-filled.
4. **Retrieve**: `/quiz loss` (or press `q` on a leaf), then answer in your own words. The leaf fills.
5. **Relabel**: click any glyph next to *you*. See the underlined evidence and relabel it.
6. **Brush**: hover a message, and a line is drawn to its leaves. Hover a leaf, and the line runs back.
7. **Time**: press `]` a few times. Delegated leaves fade, then fall; your own stay.
8. **Zoom out**: pinch out on the tree or press `f`. Hover *linear regression*: a root labelled *gradient descent* runs to this chat. Click to zoom in, `esc` to step back out.
9. **Compare**: `/design classic` shows the same conversation in the classic style.

## Demo script, classic style (≈ 3 minutes)

1. **Intro**: the 3-step onboarding explains the glyphs (replay it any time with ⓘ in the panel).
2. **Read the panel**: the *Who's thinking* bar, the trail (one glyph per prompt), the squirrel and the tree, which already has four concepts. The squirrel holds an acorn in the glyph language (filled / half / hollow) and says what the last prompt meant.
3. **Delegate**: click the demo chip *"Write me a summary of backpropagation…"*. The composer lens turns violet and the squirrel's acorn turns hollow. Press ↵: the nudge appears and the squirrel lifts the acorn. Choose **Add my take**, type a guess, and send. The squirrel hops, the reply reacts to your guess and then gives the summary, and a *Backpropagation* leaf appears.
4. **Retrieve**: send *"Quiz me on the loss function"*, then answer in your own words. The leaf fills in completely.
5. **Correct Arbor**: click any label under a message to see *why* it was classified that way, and relabel it. The tree updates.
6. **Brushing & linking**: hover a leaf to light its path down to the roots, read its card and highlight its message, or click it to jump there.
7. **Zoom out**: click **Forest**, or pinch out on the tree. The camera starts on the current tree and pulls back to the whole forest. Hover a tree to highlight related trees. Click one to zoom in (labels appear, and a drawer lists concepts to revisit). Search for "gradient" to filter. Press `Esc` to step back out one level.

## URL parameters for user tests

| Parameter | Effect |
|---|---|
| `?intro=0` / `?intro=1` | skip / force the onboarding |
| `?provider=arbor\|scripted` | live Claude and your saved chats, or the scripted demo, for this visit (not saved) |
| `?demo=1` | the scripted demo for this visit, whatever is saved or in `?provider`: no request to the backend at all |
| `?empty=1` | start the demo from an empty chat (the tree grows from a seed); scripted only |
| `?nudge=off\|gentle\|active` | nudge level |
| `?arbor=off` | extension paused (baseline condition for A/B tests) |
| `?view=forest&tree=sql` | open the forest, optionally focused on a tree |
| `?theme=light\|dark` | force a theme |
| `?panel=0` | start with the panel closed |
| `?mascot=0` / `?mascot=1` | hide / show the squirrel (e.g. to test whether it changes behaviour) |
| `?design=ascii\|classic` | design style (the choice is remembered) |
| `?layout=outline` | ASCII style: start with the outline view of the tree |

Example baseline vs. treatment: `/?intro=0&arbor=off` and `/?intro=0&nudge=active`. In the ASCII style, `nudge=gentle` gives the linter only and `nudge=active` adds predict → reveal.

## Where to change things

| What | File |
|---|---|
| Scripted answers, concepts, demo prompts, seed conversation | `src/data/scenario.ts` |
| Past conversations (the rest of the forest) and groves | `src/data/forest.ts` |
| How the demo data becomes concepts, trees, chats and attempts | `src/ai/scripted/fixture.ts` |
| Classification rules ("who's thinking"), their explanations and the words they point at | `src/lib/classify.ts` |
| Scripted assistant behaviour (hint / quiz / feedback / full answer) | `src/ai/scripted/engine.ts` |
| What a turn does (send, stream, stop, retry, analysis, scores) | `src/lib/turn.ts` |
| Live tutor prompt, analysis prompt and its schema | `src/ai/prompts/chat.ts`, `src/ai/prompts/analyze.ts`, `src/ai/schemas/turnAnalysis.ts` |
| Score prompts, how scores set labels and numbers, their words, the thresholds | `src/ai/prompts/score.ts`, `src/lib/scores.ts`, `OWN_FROM` / `AI_UP_TO` in `src/lib/modes.ts` |
| Calls to the backend (base URL, errors, SSE) and the anonymous session | `src/lib/api.ts`, `src/lib/session.ts` |
| Which provider answers, and with it demo or live mode | `src/ai/providers.ts`, `initialState` and `createApp` in `src/lib/app.ts` |
| What is saved, when, retries, the localStorage mirror | `src/lib/sync.ts` |
| Loading at start, messages per chat, which chat opens | `src/lib/live.ts`, `src/lib/chats.ts` |
| ASCII style: chat list and a leaf's messages | `src/designs/ascii/Chats.tsx` |
| How leaves are scored and trees are drawn from the data | `src/lib/project.ts` |
| When a tree splits | `src/lib/planner.ts` (`MAX_LEAVES`, `MAX_BRANCH_LEAVES`) |
| Forgetting model (fading, fallen leaves) | `src/lib/retention.ts` |
| ASCII tree: layout (tree and outline), then drawing and motion | `src/lib/asciiTree.ts`, `src/shared/AsciiTreeView.tsx`, `src/shared/ascii-tree.css` |
| ASCII style: colours, type, dark mode | tokens at the top of `src/designs/ascii/ascii.css` |
| ASCII style: the interaction concepts and their *try it* actions | `src/designs/ascii/Concepts.tsx` |
| ASCII style: slash commands | `useCommands()` in `src/designs/ascii/Composer.tsx` |
| ASCII style: squirrel drawing and what it says | `src/designs/ascii/Squirrel.tsx`, `Companion` in `src/designs/ascii/Pane.tsx` |
| Classic style: colours, typography, dark mode | tokens at the top of `src/designs/classic/styles.css` |
| Classic style: squirrel | `src/designs/classic/components/Squirrel.tsx`, `Mascot` in `.../Panel.tsx` |
| Tree and forest geometry (classic) | `src/lib/layout.ts` |

Every model backend is a `Provider` (`src/ai/provider.ts`) that returns the same shapes: a streamed reply, and a `TurnAnalysis` for each prompt. `ScriptedProvider` and `ArborProvider` (live, through the backend) exist; bring-your-own-key providers follow in M7. The designs never talk to a provider or to `src/data/` directly.

### How the data flows

```
prompt ─▶ classify.ts (live linter, while typing)
       ─▶ turn.ts ─▶ Provider.chat ──── streamed reply ───────────▶ messages
                  ├▶ Provider.score (fast: thought along? right?) ─▶ scores.ts ─▶ label + attempt numbers
                  └▶ Provider.json('analyze') ─▶ graph.ts merge ─▶ concepts + attempts
                                                                   │  planner.ts: which trees exist
designs ◀── TreeData / Leaf ◀── project.ts, links.ts (pure selectors) ◀┘
```

The store (`lib/state.ts`) keeps canonical entities (concepts, attempts, trees, conversations, messages: `lib/domain.ts`), and the trees the designs draw are computed from them, never stored. A leaf's id is its concept id, and every attempt records the chat and message it came from, so chats, trees and leaves link to each other in both directions.

## Design rationale (HCI principles)

| Principle | How Arbor applies it |
|---|---|
| **Visibility of system status** (Nielsen #1) | Live lens in the composer while typing, balance bar, trail, streaming replies, leaves sprouting as topics come up. The squirrel mirrors the lens live, even in the periphery |
| **Match with the real world** (#2) | Tree → grove → forest metaphor. Your own thinking makes leaves "grow in", delegated knowledge stays hollow. Shared concepts are roots (the "wood wide web") |
| **User control & freedom** (#3) | Nudges are skippable (*Send anyway* ↵, *Don't interrupt me*). Three nudge levels. Arbor can be paused. Every label can be corrected |
| **Consistency & standards** (#4) | One glyph language (●◑○) and one vocabulary everywhere: tags, lens, tree, forest, sidebar, legend. Two meaning colours only |
| **Error prevention** (#5) | The nudge is *feedforward*: it appears before delegating, not after |
| **Recognition over recall** (#6) | The tree shows what you covered. The legend is always visible. Labels are readable at every zoom level (screen-space names) |
| **Flexibility & efficiency** (#7) | Keyboard: ↵ send, ↵ again = send anyway, `Esc` steps back a level, `+`/`−`/`0` zoom. Pinch to zoom out of the tree |
| **Aesthetic & minimalist design** (#8) | Neutral palette, green = you, violet = AI, thin lines, lots of whitespace. Details only on demand |
| **Recognize, diagnose, recover** (#9) | Every label explains *why* (rules + confidence) and can be relabelled. The tree recomputes from the correction |
| **Help & documentation** (#10) | 3-step onboarding, replayable. "Why this label?" popovers. Tooltips |
| **Shneiderman's mantra** | *Overview first* (forest) → *zoom & filter* (groves, search, "mostly you / mostly AI") → *details on demand* (hover cards, drawer, jump to message) |
| **Brushing & linking** | Hovering a message highlights its leaves (their path lights up to the roots), and hovering a leaf highlights its message |
| **Non-paternalistic tone** | Delegation is never blocked or judged ("Totally fine — just good to know"). The goal is awareness, not restriction. When you delegate, the squirrel just holds a hollow acorn and never looks sad |
| **Ambient awareness** (calm technology) | The squirrel sits in the periphery and its acorn changes with who is thinking, so you notice the shift without reading anything. It is drawn in the tree's neutral bark colours and only the acorn (the ●◑○ glyph) is coloured, so it adds no new visual language. It moves only when something changes, never on a loop, and it can be hidden in settings |
| **Accessibility** | Meaning is encoded in shape (filled/half/hollow) as well as colour. WCAG-AA text contrast. Keyboard-reachable trees and controls. `prefers-reduced-motion` respected (the squirrel keeps its poses but doesn't hop, and everything it says is real text). Light & dark themes |

Learning-science background for the interventions: the *generation effect* (a first guess helps the answer stick) and *retrieval practice* (quizzes fill leaves in).

## Project structure

```
src/
  App.tsx                 one store, then the chosen design (lazy-loaded, so only its CSS is on the page)
  lib/                    shared by every design; pure modules have a *.test.ts next to them
    store.tsx             React side of the store: context and memoized projections (chat list, grown in, crowns)
    app.ts                the store without React: initial state from URL + storage, turns, chats, demo vs live mode
    state.ts              state slices (domain / session / ui) and the pure reducer
    sync.ts               live mode: what changed → queue → PUT /api/sync (batches, backoff, localStorage mirror)
    live.ts               live mode: load at start (queue on top), messages per chat
    chats.ts              new chat, title from the first message, merging loaded messages
    turn.ts               one chat turn: linter label → streamed reply → analysis → merge
    domain.ts             canonical data model (concepts, attempts, trees, chats; ADR-2)
    types.ts              render contract the designs consume (TreeData, Branch, Leaf, ChatMessage, …)
    project.ts            domain → TreeData (projection), leaf scores, roots between trees
    links.ts              chats ↔ trees ↔ leaves, derived from attempts
    graph.ts              merging an analysis into the concept graph (slug dedup, new-node cap)
    planner.ts            which trees exist; splits big trees (the M3 optimization plugs in here)
    evidence.ts           quoted evidence → character offsets
    classify.ts           rule-based "who's thinking" linter with explanations and evidence spans
    retention.ts          illustrative forgetting model
    time.ts               ISO date helpers
    api.ts, session.ts    calls to the backend Worker (typed errors, SSE) and the anonymous session
    asciiTree.ts          the tree on a character grid: botanical layout and outline
    layout.ts, camera.ts  SVG tree + forest layout and camera (classic)
  ai/
    provider.ts           the Provider interface every model backend implements
    providers.ts          which provider answers (URL parameter, setting, build default)
    schemas/              structured outputs (TurnAnalysis, its wire schema for LLMs)
    prompts/              the live tutor prompt and the turn analysis prompt
    arbor/                the live provider: Claude through the backend relay
    scripted/             the offline "Wizard of Oz" provider: engine, demo fixture, parity test
  data/
    scenario.ts           live conversation script (demo fixture)
    forest.ts             past trees (demo fixture)
  test/                   test helpers: a store without React, graph builders, a fake backend (also an in-memory one with persistence), localStorage
  shared/
    AsciiTreeView.tsx     the animated ASCII tree (ASCII style; kept here so other styles can reuse it)
  designs/
    ascii/
      App.tsx             layout, global keys, browser line, toast
      Transcript.tsx      the log: evidence, why + relabel, predict → reveal, make it yours, failed/stopped replies, the trees a chat grew
      Chats.tsx           chat list (c, /chats) and a leaf's messages: one keyboard-first picker sheet
      Composer.tsx        thought linter, slash commands, demo prompts
      Pane.tsx            balance, trail, squirrel, tree, forgetting scrubber, settings
      Forest.tsx          semantic zoom: forest of glyph crowns, roots, tree detail
      Links.tsx           drawn links between messages and leaves
      Modeline.tsx        status bar: mode + the keys that work now
      Concepts.tsx        interaction concepts sheet and intro
      Squirrel.tsx, Md.tsx, ui.tsx, ascii.css
    classic/
      App.tsx, styles.css
      components/         Host, Chat, Panel, Forest, TreeSvg, Glyph, Overlays, Squirrel
```
