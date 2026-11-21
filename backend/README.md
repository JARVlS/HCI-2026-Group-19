# Arbor API (Python Worker)

FastAPI running on Cloudflare Python Workers (Pyodide), with a Cloudflare D1 database. Deployed
separately from the frontend (Cloudflare Pages); the frontend calls it through `frontend/src/lib/api.ts`.

What it does today (IMPLEMENTATION_PLAN.md, ADR-3/5/8): anonymous sessions, optional accounts
(username and password on top of a guest, no email), a guarded relay to
Claude with a daily token budget per user, G-Eval-style scores from a fast model's token
probabilities, persistence of the frontend's data model (concepts, edges, trees, conversations,
messages, attempts: one idempotent batch sync, a bootstrap read and messages per conversation),
study event logging and CSV export.

## Structure

```
wrangler.toml            Worker config: D1 binding, [vars] (models, limits, budget)
pyproject.toml           runtime deps (only fastapi), dev + test dependency groups
migrations/              D1 schema as .sql files, applied with `d1 migrations apply`
src/main.py              Worker entry point (the only module that imports `workers` besides upstream.py)
src/app.py               create_app(): CORS, routers, the error format
src/config.py            vars and secrets from the Worker env
src/schemas.py           request/response models (camelCase on the wire), incl. the synced entities and their limits
src/entities.py          how a synced entity maps to its D1 row and back, and the SQL to upsert and read it
src/auth.py              session tokens, the `current_user` dependency, the admin token check
src/passwords.py         PBKDF2 password hashing (WebCrypto under Workers, hashlib in tests)
src/db.py                small async functions over D1
src/llm.py               Claude request bodies, response and SSE parsing (pure logic)
src/scoring.py           the fast slot: OpenAI-format request body and logprob scoring (pure logic)
src/upstream.py          the HTTP call to the model APIs through the Workers `fetch`
src/routes/              health, session, accounts (signup, login, me), ai, events, sync (state, messages, sync), admin
tests/                   pytest suite, fake model APIs (Claude and the fast model), smoke test (see docs/testing.md)
docs/api.md              the API reference
docs/testing.md          how to test, manual checklist, results table
```

Claude is called over plain HTTP, not with the `anthropic` SDK: in a Python Worker the request goes
through the Workers `fetch` and the chat stream is passed through to the browser as it arrives. The
SDK is not verified in that runtime. The fast model is called the same way (no `openai` SDK).

### Model slots

| Slot | Used by | Vars | API and key |
|---|---|---|---|
| chat (slow) | `/ai/complete`, task `chat` | `MODEL_CHAT`, `EFFORT_CHAT`, `MAX_TOKENS_CHAT` | Anthropic Messages API at `ANTHROPIC_BASE_URL`, secret `ANTHROPIC_API_KEY` |
| analyze (slow) | `/ai/complete`, tasks `analyze`, `tree`, `quiz` | `MODEL_ANALYZE`, `EFFORT_ANALYZE`, `MAX_TOKENS_JSON` | the same |
| fast | `/ai/score` (one token, its probabilities are the score) | `MODEL_FAST` | OpenAI-compatible chat completions with `logprobs` at `FAST_BASE_URL`, secret `FAST_API_KEY` |

Claude's API returns no token probabilities, hence the third slot with another API format. Any
endpoint that speaks OpenAI chat completions and returns `logprobs` works there (OpenAI, Groq, a
self-hosted vLLM or Ollama); today it is `zai.glm-4.7` in Amazon Bedrock (eu-north-1).

## Run locally

Needs uv ≥ 0.13.4 (`uv self update`) and Node 20+.

```bash
npm install                                        # wrangler, used by pywrangler under the hood
cp .dev.vars.example .dev.vars                     # fill in values (see "Secrets and vars")
uv run pywrangler d1 migrations apply hci-grp19 --local   # creates the local D1 database
uv run pywrangler dev                              # → http://localhost:8787/api/health
```

`.dev.vars` is gitignored. Locally any made-up values work for `SESSION_SECRET` and `ADMIN_TOKEN`.
Without the group's `ANTHROPIC_API_KEY`, point `ANTHROPIC_BASE_URL` at the fake Claude API
(`uv run python tests/fake_anthropic.py --port 8790`, then `ANTHROPIC_BASE_URL=http://127.0.0.1:8790`).
The same fake plays the fast model: `FAST_BASE_URL=http://127.0.0.1:8790/v1` and any `FAST_API_KEY`.
Run the frontend (`npm run dev` in `frontend/`) next to it; it reads the API URL from
`frontend/.env.development`. Interactive API docs: http://localhost:8787/api/docs.

Tests: `uv run --group test pytest` (seconds, no network) and `bash tests/smoke.sh` (real Workers
runtime). Details in [docs/testing.md](docs/testing.md).

## Endpoints

Full reference with request and response shapes, error codes and `curl` examples: [docs/api.md](docs/api.md).

| Route | Auth | What |
|---|---|---|
| `GET /api/health` | none | liveness check, `{"ok": true, "environment": ...}` |
| `POST /api/session` | none | create (or, with a known `participantId`, fetch) an anonymous user and its token |
| `POST /api/ai/complete` | token | one Claude call: `chat` (optionally streamed as SSE), `analyze`, `tree`, `quiz` (JSON) |
| `POST /api/ai/score` | token | one fast-model call: the probability of each answer option (G-Eval style) |
| `PUT /api/sync` | token | idempotent upsert of the user's entities (up to 500 rows) in one `db.batch()` |
| `GET /api/state` | token | bootstrap: the user's concepts, edges, trees, conversations, attempts (no messages) |
| `GET /api/conversations/{id}/messages` | token | the messages of one of the user's conversations |
| `POST /api/events` | token | store study events, idempotent by event id |
| `GET /api/admin/export?table=...` | `X-Admin-Token` | one table as CSV: `events`, `usage`, `users`, `conversations`, `messages`, `attempts`, `concepts`, `concept_edges`, `trees` |
| `GET /api/admin/visits` | `X-Admin-Token` | the usage log's visits (page loads), newest first, page by page (the logs page) |
| `GET /api/admin/events` | `X-Admin-Token` | usage events as JSON, filtered by visit, user and type, page by page (the logs page) |

New routes go into `src/routes/` and are mounted in `src/app.py`. Dependencies go in
`pyproject.toml` (`uv add <pkg>`); only pure-Python packages or ones Pyodide supports work in the
Worker. Test-only packages go in the `test` group (`uv add --group test <pkg>`); they never reach
the Worker bundle (pywrangler bundles only `[project.dependencies]`, see `pylock.toml`).

## Secrets and vars

| Name | Kind | What |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | the key for the model API (today a Bedrock key, see the stopgap note in docs/api.md "Budget and cost") |
| `SESSION_SECRET` | secret | signs session tokens; changing it logs everybody out |
| `ADMIN_TOKEN` | secret | for `/api/admin/*` (the CSV export and the logs page) |
| `FAST_API_KEY` | secret | Bearer key for the fast slot (`FAST_BASE_URL`); read only by `/api/ai/score`, so without it everything else still works |
| `ENVIRONMENT` | var | shown by `/api/health` |
| `MODEL_CHAT`, `MODEL_ANALYZE` | var | planned: `claude-sonnet-5-5` for chat, `claude-haiku-5-5` for analyze/tree/quiz; today both `anthropic.claude-sonnet-5` (Bedrock stopgap) |
| `EFFORT_CHAT`, `EFFORT_ANALYZE` | var | how much Claude thinks: `low` (also `medium`, `high`), or `none` to send no effort at all (needed for models without the parameter, e.g. Claude Haiku 4.5, which answers 400 "This model does not support the effort parameter") |
| `MAX_TOKENS_CHAT`, `MAX_TOKENS_JSON` | var | output cap per call (4096); thinking counts against it |
| `MAX_INPUT_CHARS` | var | max characters of system + messages per call (200000) |
| `DAILY_TOKEN_BUDGET` | var | tokens per user per UTC day (200000), see docs/api.md "Budget and cost" |
| `TOTAL_TOKEN_BUDGET` | var | tokens for all users together, never resets (900000, at most 10 USD) |
| `ANTHROPIC_BASE_URL` | var | planned: `https://api.anthropic.com`; today the Bedrock endpoint; locally the fake API |
| `MODEL_FAST` | var | the fast slot's model: `zai.glm-4.7` (picked on 17 Nov 2026, see the comment in `wrangler.toml`) |
| `FAST_BASE_URL` | var | OpenAI-compatible API base, `/chat/completions` is appended: `https://bedrock-mantle.eu-north-1.api.aws/v1`; locally the fake API (`http://127.0.0.1:8790/v1`) |

Vars live in `[vars]` in `wrangler.toml`. Secrets never go in a file that is committed: on Cloudflare
use `uv run pywrangler secret put NAME` (or the Worker's settings in the dashboard), locally
`.dev.vars`. A missing value makes the affected endpoints answer 500 `server_misconfigured` with the
variable's name.

## Deployment (automatic)

Workers Builds deploys on every push to `main` that touches `backend/`. One-time setup in
Cloudflare: **Workers & Pages → Create → Worker → Import a repository**, then:

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Build command | `pip install uv && npm ci` |
| Deploy command | `uv run pywrangler deploy` |
| Build watch paths | `backend/*` |

Pushes to other branches also start a build, which runs `npx wrangler preview` and fails with
"missing a `previews` block". That red check on a pull request is expected and does not touch the
deployed Worker. We left the `previews` block out on purpose: it would need a second database, or
previews would write into the real one.

Then set `VITE_API_URL` to the Worker's URL (`https://hci-backend.leon-grass.workers.dev`)
in the **Pages** project's environment variables and redeploy the frontend.

### First deploy checklist (for whoever has the Cloudflare account)

Merging to `main` deploys automatically. Do steps 3 and 4 before the merge, otherwise the deployed
endpoints answer with errors until they are done:

1. The D1 database exists: `hci-grp19` (created 16 Nov 2026).
2. Its id is in `wrangler.toml`.
3. `npx wrangler login`, then apply the schema to the real database:
   `uv run pywrangler d1 migrations apply hci-grp19 --remote`.
   Do this again for every new file in `migrations/`, before the code that needs it goes live.
4. Set the four secrets (each command asks for the value):
   `uv run pywrangler secret put ANTHROPIC_API_KEY`, `... SESSION_SECRET`, `... ADMIN_TOKEN`,
   `... FAST_API_KEY`.
   For `SESSION_SECRET` and `ADMIN_TOKEN` use long random strings, e.g. `python3 -c "import secrets; print(secrets.token_hex(32))"`.
   Keep `ADMIN_TOKEN` somewhere safe for the exports.
5. Check the CPU limit of the Workers plan. The Free plan allows 10 ms of CPU per request; nobody
   has measured this Worker yet (FastAPI on Pyodide). After the first real calls, look at
   **Workers → hci-backend → Metrics → CPU time**; if requests fail with error 1102 (CPU limit),
   the Paid plan ($5/month) raises the limit.
6. Check the deployed Worker: `curl https://hci-backend.leon-grass.workers.dev/api/health`, then the
   live checks T-20 to T-26 in [docs/testing.md](docs/testing.md).

### After merging a PR with a new migration

Every new file in `migrations/` has to be applied to the real database once. Until then the
routes that need it answer 500 `internal_error` (no such table); everything else keeps working,
because migrations here only add tables and indexes.

| Migration | Needed by | Applied to `hci-grp19` |
|---|---|---|
| `0001_users_usage_events.sql` | session, ai, events, export | 16 Nov 2026 |
| `0002_graph_and_chats.sql` | `/sync`, `/state`, `/conversations/{id}/messages`, the export of the six new tables | 17 Nov 2026 |
| `0003_accounts.sql` | `/auth/signup`, `/auth/login`, `/me` | 20 Nov 2026 |

From `backend/`, with a Cloudflare login for the account that holds `hci-grp19`:

```bash
uv run pywrangler d1 migrations apply hci-grp19 --remote   # applies only the files not yet applied
```

Then run T-31 in [docs/testing.md](docs/testing.md) against the deployed Worker. Applying it before
the merge is also safe (the running code does not touch the new tables) and avoids the short window
of 500s.

### After merging the fast slot (`POST /api/ai/score`, 17 Nov 2026)

No migration (the tokens go into the existing `usage` table under task `score`). The two new vars
(`FAST_BASE_URL`, `MODEL_FAST`) come with `wrangler.toml`. One step by hand, best before the merge:
set the secret, with a Bedrock API key that may call `zai.glm-4.7` on bedrock-mantle in
eu-north-1:

```bash
uv run pywrangler secret put FAST_API_KEY   # or Workers → hci-backend → Settings → Variables and Secrets
```

Until it is set, only `/api/ai/score` answers 500 `server_misconfigured` (naming `FAST_API_KEY`);
every other route keeps working. Then run T-37 in [docs/testing.md](docs/testing.md).

**CORS:** `src/app.py` allows `localhost:5173` and `*.hci-2026-group-19.pages.dev`. Change the
regex there if the frontend moves to another domain.

## Possible follow-ups

- Refusal fallbacks: Claude Sonnet 5.5 supports a server-side `fallbacks` parameter (beta) that
  retries a declined request on another model inside the same call. Left out of this first version,
  which sends only request fields we have checked; today a refusal is a 502 `upstream_refusal`.
- Prompt caching (`cache_control`) for long chats, once real conversations show the token mix.

## AI declaration

This backend (code, tests and docs) was written with Claude Code (Anthropic) on 16 Nov 2026 and
extended on 17 Nov 2026, at Salomon's request. Review it like any other code before merging, and keep the course's AI
declaration in line with this.
