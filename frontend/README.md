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
| 01 | **Thought linter** | Explainable feedforward | While you type, the words that make a prompt delegating get a wavy underline (dashed: together, solid: yours, so shape carries the meaning as well as colour), and hovering a word shows its reason, like a spellchecker. One line of fixed height above the prompt shows the live score (you ↔ ai) and what sending will do, so nothing moves while you type (ADR-14). |
| 02 | **Modeline** | Ambient awareness, calm technology | Like vim's `-- INSERT --`, the status bar always says who is thinking right now and lists the keys that work in this moment. Even the caret takes the mode's colour. |
| 03 | **Predict → reveal** | Desirable difficulty, generation effect | With nudges on *active*, the answer to a prompt the linter reads as delegating arrives veiled (`░░░`): its shape is visible, its words are not. Type a hunch and reveal it, and a decode sweep uncovers the answer with the words you already had highlighted; the prompt becomes *thinking together* (live: the guess is scored instead, see [Fast and slow](#fast-and-slow-how-a-turn-is-judged)). Or just press ↵. It is never blocked. |
| 04 | **Two views, one tree** | Multiple views, object constancy | `t` switches between the growing plant and a `tree`-command outline. Every leaf keeps its identity and glides to its new place. |
| 05 | **Forgetting scrubber** | Feedforward of consequences | Drag time forward (`[` `]`): letters drop out of labels and forgotten leaves fall to the ground. What you delegated falls first. An illustrative Ebbinghaus-style model (`src/lib/retention.ts`), labelled as such. |
| 06 | **Semantic zoom** | Overview first, zoom & filter, details on demand | Pinch out or press `f`: the camera pulls back from your tree to the forest, where every chat is a crown of glyphs. Hover a tree and labelled roots run to chats that share a concept; zoom in for the full tree and a "revisit, most faded first" list. |
| 07 | **Drawn links** | Brushing & linking | Hover a message and a line is drawn in box characters to the leaves it grew; hover a leaf and the line finds its message, pointing up or down if it is scrolled away. |
| 08 | **Relabel in place** | User control, error recovery | Click the glyph next to a message: the evidence is underlined in your own words, with the confidence, and you can relabel it. The tree regrows. |
| 09 | **Command line** | Flexibility & efficiency, recognition over recall | `/` lists every command with what it does (`/quiz`, `/hint`, `/forest`, `/time 1w`, `/why`, `/nudge`, `/design`, …). `tab` cycles demo prompts; the faint hint for it above the prompt only shows while the prompt (a drawn box) has focus, so nobody clicks it for the input. |
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
| `VITE_DEFAULT_PROVIDER` | `scripted` or `arbor`: where answers come from until a visitor picks in settings. Production builds use `arbor` since 17 Nov 2026 (live Claude, M8; see the comment in `vite.config.ts`). Local `npm run dev` keeps `scripted` unless `.env.development.local` sets it |

## Live answers (provider `arbor`)

Where answers come from is a setting: **answers: scripted | live | own model** in the settings of both designs, `/provider scripted|arbor|own` in the ASCII style, or `?provider=arbor` / `?provider=own` / `?provider=scripted` for one visit (*own model*: see [Your own model](#your-own-model-provider-own)). `?demo=1` beats everything else; then the URL parameter beats the saved choice, which beats the build default (`VITE_DEFAULT_PROVIDER`). Only a choice made in settings is saved (localStorage `arbor.provider.v1`). The choice is also the mode: switching between demo and live stops a running reply and loads the other world at once (live: your saved chats; scripted: the demo); between `arbor` and `own` your chats stay and the next message goes to the other models.

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

Every live message costs tokens from the group's budget: one chat call, one analysis call and one small score call (two more for a graded claim or a revealed guess). Measured on 17 Nov at the start of a chat: about 540 tokens for the reply, 2,560 for the analysis, 250 to 500 for each score. The reply and the analysis grow as the chat and the graph grow, because the transcript is sent again each time. The live rating while you type adds one score call per pause, and a draft it rated is sent without the score call (see [Fast and slow](#fast-and-slow-how-a-turn-is-judged)).

## Your own model (provider `own`)

*answers: own model* in settings (or `?provider=own`, or `/provider own`) is live mode with your own model: your chats are still saved on the group's backend and come back as with `arbor`, but every model call goes from your browser straight to an endpoint you choose, with your key. The group's backend sees only the saving and loading calls (`/api/session`, `/api/state`, `/api/sync`, messages), never a model call and never your key. Set it up in the ASCII style: settings → answers → own model → *set up your model*, or `/model` (code: `src/ai/own/`, the sheet: `src/designs/ascii/Model.tsx`). The classic style shows the choice and says where to set it up.

**Three roles, one connection each.** A turn makes three kinds of model calls, and each can go somewhere else:

| Role | What it does | What the endpoint needs |
|---|---|---|
| chat | the tutor's streamed reply | streaming chat |
| analysis | who did the thinking, which concepts grow on the tree | JSON output (a JSON schema, or prompt mode, see below) |
| scores | the fast *thought along* and *is it right* percent | token probabilities (`logprobs`, `top_logprobs`); Claude has none |

Analysis and scores can be *same as chat*; scores can be *off* (then turns keep the analysis's own numbers, as with any provider without scores) or any role can stay on the *group backend*. Anthropic is not offered for scores, and *same as chat* with an Anthropic chat says so in the sheet.

**Presets** fill in the base URL and a suggested model; every field stays editable, and *list* asks the endpoint for its models (`GET {base}/models`, Anthropic `GET {base}/v1/models`) to pick from:

| Preset | Base URL | Format | Key |
|---|---|---|---|
| anthropic | `https://api.anthropic.com` (model `claude-sonnet-5-5`) | Anthropic Messages API, with `anthropic-dangerous-direct-browser-access: true` | needed |
| openai | `https://api.openai.com/v1` (`gpt-4.1-mini`) | OpenAI chat completions | needed |
| openrouter | `https://openrouter.ai/api/v1` (`openai/gpt-4.1-mini`) | OpenAI chat completions | needed |
| groq | `https://api.groq.com/openai/v1` (`llama-3.3-70b-versatile`) | OpenAI chat completions | needed |
| ollama | `http://localhost:11434/v1` (`llama3.2`) | OpenAI chat completions | none |
| lm studio | `http://localhost:1234/v1` (whatever is loaded) | OpenAI chat completions | none |
| custom | yours (a self-hosted vLLM or LiteLLM, any OpenAI-compatible server) | OpenAI chat completions | optional |

The Anthropic requests have the same shape as the backend's (`backend/src/llm.py`): `anthropic-version: 2026-10-21`, JSON through `output_config.format`, no `temperature`, no `thinking`, no `effort`. Scores on an OpenAI-compatible endpoint work like the backend's fast slot (`backend/src/scoring.py`): one token with its top 20 logprobs, tokens matched to the scale's digits after trimming whitespace, each digit's share of their summed probability; if the digits hold less than half of the first token (e.g. `openai.gpt-oss-20b` starts with a control token) or there are no logprobs, the model *cannot give scores*.

**Structured output on OpenAI-compatible endpoints:** the analysis asks with `response_format: { type: 'json_schema', … strict: true }`. If the endpoint refuses that (a 400 about `response_format`) or ignores it and answers in prose, that endpoint and model switch to **prompt mode** for the rest of the visit: the schema goes into the system prompt with "answer with one JSON object", the answer is parsed (a `<think>` block or a code fence around it is dropped), and an answer that is not valid JSON or does not fit the schema gets one repair retry; after that the analysis fails like any other (the linter's label stays).

**Keys stay on this device:** one per role, in sessionStorage (`arbor.keys.v1`, gone when the tab closes) unless you tick *remember on this device*, which moves them to localStorage. They are never sent to the group's backend, never part of the settings (`arbor.settings.v1` holds the rest of the setup: preset, base URL, model per role), never in saved chats (messages carry the model's name, as with `arbor`) and never in an error message (an endpoint's error text is shown with the key replaced by `[key]`).

**Test connection** runs one tiny call per role, in parallel (a few hundred tokens): a streamed hello for chat, a small structured answer for analysis (enum, nullable field, list of objects: the features the turn analysis uses), a score of a right statement for scores. Each role then says *works · model · time* (analysis: *json schema* or *prompt mode*; scores: how right it rated the right statement) or what failed and how to fix it. Roles on the group backend and scores that are off are not tested.

**When it fails**, the message says what to fix (in the failed turn's line, and per role in test connection):

| What happened | What you see |
|---|---|
| no answer, or blocked by CORS (the browser does not say which) | *did not answer, or did not allow this page to call it*, with the fix for the preset: Ollama: start it with `OLLAMA_ORIGINS=https://hci-2026-group-19.pages.dev` (the page's own address); LM Studio: switch on CORS in its server settings; your own server: CORS headers for this page, and HTTPS unless it runs on your computer (or a tunnel such as `cloudflared`). Chrome asks for local network access the first time a hosted page calls `localhost`: allow it |
| an `http://` endpoint that is not on your computer, from the HTTPS site | refused before the call: the browser blocks it (mixed content); give the server HTTPS or use a tunnel |
| 401 or 403 | the key was refused; check it |
| 404, or "model not found" | the model name (or the base URL, which usually ends in `/v1`), with the models the endpoint lists |
| 429 | the provider's limit; wait or check your plan |
| no logprobs | *cannot give scores*: set scores to off or to the group backend |

**What was tested, and what was not (17 Nov):** in a browser against a local stand-in that forwards to Amazon Bedrock, which speaks both formats: OpenAI-compatible with `zai.glm-4.7` and `qwen.qwen3-32b` (streaming, `json_schema`, logprobs), Anthropic-format with `anthropic.claude-haiku-4-5` and `anthropic.claude-sonnet-5` (test connection on both), a full turn in each format (reply, leaf, percent, saved; no `/api/ai/*` request), a wrong model name, an Ollama that is not running, and `openai.gpt-oss-20b` for scores. Not tested with real keys or servers: OpenAI, OpenRouter, Groq, Anthropic's own API, Ollama, LM Studio, a remote server behind HTTPS and CORS, and Chrome's local network prompt on the hosted site. The prompt-mode fallback is covered by unit tests only: no stand-in model refused `json_schema`.

## Fast and slow: how a turn is judged

Three judges look at every message, from fast to slow:

1. **Linter, while you type** (`src/lib/classify.ts`): word rules underline the words and pick the label before you send. Free and instant. In live mode they only hold the score line until the fast model has answered (next point).
   **Live rating, when you pause** (ASCII design, `src/lib/draftScore.ts`): 600 ms after your last keystroke the fast model rates the draft on the same scale, with the same context, as a sent message (below), and the score line above the prompt (bar, *you X · ai Y*, label) takes its number; the hover says *rated by the fast model*. While newer words wait for their rating, the last one stays, dimmed. No call for a command, an empty draft or a single word, never twice for the same text, and a keystroke aborts the call in flight. Sending a draft the model has rated hands that rating to the message: its label decides the veil, and the turn does not ask again. Cost: one call per pause, about 250 tokens in a new chat and up to about 650 with four earlier messages as context (measured 17 Nov: 249 to 262 without context, 380 with two); a prompt typed in one go makes one call, one typed with pauses one per pause. A call the browser aborts may still be billed. A call over 5 s is given up quietly (the slow tail, see below); after 2 failed calls in a row the visit stops asking, and the line stays on the word rules with *the model rating is not available* in the hover. Demo mode, *own model* with scores off and the classic design keep the word rules only.
2. **Scores from a fast model, right after you send** (live mode, `Provider.score`, prompts and scales in `src/ai/prompts/score.ts`): the fast model (`zai.glm-4.7`) rates the message on a **rating scale**: *how much of the thinking in this message is the student's own?*, from 1 = none (hands the work over: a summary, a solution, a bare fact) through 2 = little (a why or how question without an own idea), 3 = some (asks for a hint or a quiz, or a vague idea) and 4 = much (an own claim, guess or prediction) to 5 = all (own reasoning or a worked attempt). Whether the student is right does not matter here: a wrong claim is still their own thinking. The model answers with one digit; the backend (`POST /api/ai/score`) returns how likely each digit was as that answer, and the score is the sum of each digit's probability times its weight (0, 25, 50, 75, 100 %), as in G-Eval. That is the message's **thought along** percent. It sets the label (yours from 67 %, delegated up to 20 %, together in between: `OWN_FROM` and `AI_UP_TO` in `src/lib/modes.ts`), the independence of every concept the message touched, and the *who's thinking* bar, trail and status line. A second scale, *is it right?* (right 100 %, partly right 50 %, wrong or no answer 0 %), runs once the reply is complete: for an own claim that the analysis found gradable (judged against the tutor's answer), and for a guess at predict → reveal. A revealed guess is also rated on the first scale (with the question as context): a real guess raises the percent, it never lowers it, and "no idea" stays at 0. A call takes about 0.4 s (median of 80 eval calls), but the fast model is sometimes slow: 7 of those 80 took 3 to 42 s, and the why then shows *…* until the score lands.
3. **Turn analysis, slow** (Claude, `analyze`): which concepts the message is about, where they go in the graph, reasons and quoted evidence. With scores it no longer decides the numbers; whichever of the two lands first, the result is the same.

What you see: the *why* of a message says *thought along 75%* and, when graded, *right 0%*; under a revealed answer the guess shows *right 100% · thought along 91%* (classic: a note under the answer), and *with your guess* when the guess changed the label. On its way: *…*; failed: *not checked*, and the analysis's numbers stay. A relabel by you always wins over a score. The scores are saved with the message (`scores` on the user message), so they are back after a reload.

Why a scale and not a yes/no question: a good model answers *did the student think along, yes or no?* with 0 or 1, so there is no percent left; a weak model gives numbers in between, but they are its uncertainty, not a degree (it put short wrong claims like "My guess is that antibiotics kill viruses" at 18 %, the one case this tool must never punish). On the scale the same claims land at 72 to 79 %. Why a second model at all: Claude's API returns no token probabilities, so Claude cannot give these scores. A provider without `score` (the scripted demo; *own model* with scores off) keeps the analysis's own numbers, and a guess counts as *thinking together* as before.

**Eval:** `npm run eval:score` sends 40 labelled cases (`eval/score.eval.ts`: 21 messages, 6 guesses, 13 statements to grade) to a running backend (`VITE_API_URL`, default `http://localhost:8787`) and prints one row per case with its score and label. It is not part of `npm test`. On 17 Nov with `zai.glm-4.7`: 37 of 40 in their band. Wrong own claims 72 to 79 % (yours), own reasoning 77 to 100 %, hint and quiz requests about 50 %, plain why and how questions 24 % (together), "explain X" 8 %, delegation 0 %; right statements 92 to 100 %, half right (tides) 46 %, wrong ones and "idk" 0 %. The misses: two worked attempts at 77 and 83 % (expected 85 % and up; still yours) and the vague guess "something with the blood?" at 25 % (together; expected 35 to 80 %). What the wording needs: the tutor's answer *before* the student's statement (tutor answers often end with a question, and the model rated that one instead).

## Accounts and the welcome screen

A first visit in live mode starts at the welcome screen (`src/Welcome.tsx`): **log in**, **sign up**, or **continue as guest**. Nothing loads before the choice. A guest is the anonymous session from before (a token in localStorage, `arbor.session.v1`); visitors who already had one skip the screen. An account is a username and password on top of that (ADR-8 amended, `backend/docs/api.md`):

- **Sign up as a guest keeps your chats:** the guest becomes the account (same user, same token). In the ASCII style: settings → *account* → *sign up*, or `/signup`.
- **Log in** switches this browser to the account; the chats you made as a guest stay with the guest. `/login`, or settings → *account*.
- **Log out** forgets the token on this device and returns to the welcome screen (`/logout`, settings → *account*). It waits until your last changes are saved.
- No email: nobody can reset a forgotten password. The rules (3 to 64 characters `A-Z a-z 0-9 . _ - @ +`, password at least 8) are checked in the form first (`src/lib/account.ts`).
- The intro no longer opens by itself in live mode: a fresh user lands on an empty, open chat with no trees. The empty chat links to *how arbor works*; `?intro=1` forces the intro.

Until migration `0003_accounts.sql` is applied to the backend database, sign up and log in answer with "accounts are not on the backend yet"; *continue as guest* works either way.

## Demo and live: what is saved where

| | Demo (provider `scripted`) | Live (provider `arbor`, or `own`) |
|---|---|---|
| Data | the scripted fixture: the "neural networks" chat and the demo forest | your own chats, concepts, trees and labels |
| Saved | nothing; a reload starts the demo again | on the backend (D1), through `PUT /api/sync` |
| Requests to the backend | none at all | session, load, save, and with `arbor` the model calls (`own` sends those to your endpoint) |
| Turn on | `?provider=scripted`, *answers: scripted* in settings, or `?demo=1` (forces it for the visit, whatever is saved) | the build default (`arbor`), `?provider=arbor` or *answers: live* in settings; `?provider=own` or *answers: own model* |

Switching between `arbor` and `own` keeps your chats on screen: the next message goes to the other models.

**What live mode saves** (`src/lib/sync.ts`): after every change it compares the state with the one before and queues what changed: concepts, edges, trees (a tree the planner removed is sent once more with `deletedAt`), chats, messages and attempts (a relabel adds a new attempt that supersedes the old one). A chat is saved from its first message on; an empty chat stays on this device and is dropped when you leave it. A reply is saved once it is complete (never while it streams); a failed reply is not saved, its retry replaces it.

**When:** about 0.8 s after a change, and at once when a reply ends. Requests carry at most 500 rows. Network errors, 5xx and 401 are tried again after 1 s, 2 s, 4 s … (at most 30 s), and at once when the browser is back online; when the tab is hidden or closed, what is left goes out with `keepalive`. A 4xx is a bug in what we send: those rows stay queued, a toast and the browser console say why, the modeline shows `! n not saved`, and they are sent once more after the next reload. The ASCII modeline says `saved`, `saving…` or `offline · n unsaved`.

**A reload never loses a turn:** the queue is mirrored in localStorage (`arbor.sync.v1`) and goes out together with the next start. The start loads `GET /api/state` (everything but messages), puts the queued rows on top (they are newer) and opens the chat you changed last; a first visit gets one new, empty chat. Messages load per chat when you open it (`GET /api/conversations/:id/messages`) and stay for the visit. While loading, the page says *loading your chats…*; if the backend cannot be reached it says so with *retry* (and tries again by itself when the browser is back online). It never shows the demo instead. The device keeps only the queue, not a full copy of your data, so live mode does not work offline from a cold start.

localStorage keys: `arbor.session.v1` (the session token), `arbor.sync.v1` (changes not saved yet), `arbor.provider.v1`, `arbor.settings.v1` (with the own-model setup, without keys), `arbor.onboarded.v1`; `arbor.keys.v1` (own-model keys) only with *remember on this device*, otherwise in sessionStorage.

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
| `?provider=arbor\|own\|scripted` | live Claude and your saved chats, your own model and your saved chats, or the scripted demo, for this visit (not saved) |
| `?demo=1` | the scripted demo for this visit, whatever is saved or in `?provider`: no request to the backend at all |
| `?welcome=1` | show the welcome screen (log in, sign up, continue as guest) again; live mode only |
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
| Your own model: presets, roles, keys, the two wire formats, error messages, test connection | `src/ai/own/` (`setup.ts`, `keys.ts`, `anthropic.ts`, `openai.ts`, `http.ts`, `provider.ts`); the sheet: `src/designs/ascii/Model.tsx` |
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

Every model backend is a `Provider` (`src/ai/provider.ts`) that returns the same shapes: a streamed reply, and a `TurnAnalysis` for each prompt. `ScriptedProvider`, `ArborProvider` (live, through the backend) and `OwnProvider` (your own endpoints, per role) exist. The designs never talk to a provider or to `src/data/` directly.

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
  App.tsx                 the welcome screen on a first live visit, then one store and the chosen design (lazy-loaded, so only its CSS is on the page)
  Welcome.tsx, welcome.css  log in, sign up, continue as guest (also as an overlay from settings and /signup, /login)
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
    account.ts            guest or account, sign up, log in, log out (tokens in localStorage)
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
      Composer.tsx        thought linter (underlines, hover reasons, the score line), slash commands, demo prompts
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
