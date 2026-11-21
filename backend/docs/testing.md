# Testing the backend

Three layers: automatic tests (fast, no network), a smoke test against the real Workers runtime
with a fake Claude API, and a manual checklist (including the live Claude checks, which need the
group's API key). All commands run in `backend/`.

## 1. Automatic tests

```bash
uv run --group test pytest
```

They run on normal Python 3.13 in under two seconds and need no Cloudflare account and no API key.
`tests/fakes.py` replaces the Worker runtime: a fake `env` with all vars and secrets, a D1 stand-in
on sqlite3 (same calls as D1, built from the real migration files) and a fake upstream that records
every request sent to "Claude" and answers with prepared responses. The app gets the env exactly as
in the Worker (`request.scope["env"]`), so no production code has test-only branches.

| File | Covers |
|---|---|
| `test_session.py` | new session, same participant twice (same user, stored condition wins), bad fields, missing `SESSION_SECRET` |
| `test_auth.py` | token round trip, tampered/foreign/odd tokens, 401 cases, unknown user |
| `test_llm.py` | upstream request body per task (model, `max_tokens`, effort, effort `none` left out per slot, JSON schema format, never `temperature`/`thinking`/`tool_choice`), response parsing (thinking blocks ignored, refusal, truncation, bad JSON), error messages without the key, the SSE parser with events split at every possible byte (also inside UTF-8 characters), cumulative usage |
| `test_scoring.py` | the fast slot's OpenAI-format body (system message first or left out, `max_tokens` 1, `temperature` 0, `logprobs`, `top_logprobs` 20), URL and Bearer header, usage, scoring: whitespace tokens merged (`" 1"` counts for `"1"`), normalized in option order, unlisted option 0, case-sensitive, mass capped at 1, mass 0.5 enough, low mass names the likeliest token, six shapes of "no logprobs" |
| `test_ai.py` | `/ai/complete` end to end: validation errors, 413, budget (429, resets per day, per user), usage written and summed, effort `none` sends no effort, refusal, truncated, upstream errors (nothing recorded), streaming (happy path, chunk splits, upstream `error` event, missing `message_stop`, connection drop, refusal, truncation, client disconnect, CORS header). `/ai/score` end to end: happy path (request sent, probabilities, mass, usage under `score`), unlisted option 0, low mass and no logprobs (502, low mass still recorded), upstream error (502, key redacted, nothing recorded), missing `FAST_API_KEY` (500 on score, `/ai/complete` still works), missing `MODEL_FAST`/`FAST_BASE_URL`, 14 invalid bodies (422), 5 options of 8 characters, 401, 413, daily and total budget, score tokens count against the budget |
| `test_events.py` | storing, idempotency, duplicate ids in one batch, 1..200 limit, `clientTs` must carry a time zone |
| `test_sync.py` | `PUT /sync`, `GET /state`, `GET /conversations/:id/messages`: round trip of every entity (optional fields left out, nullable fields `null`, times in UTC), entity columns match the migrations, idempotency (same body twice leaves every row unchanged), last write wins on `updatedAt` (older ignored, newer and equal win), messages and attempts always replaced, edges insert or ignore, duplicate ids in one request, another user's rows neither readable (404) nor overwritable, soft delete and restore, message order, opaque message meta round trip with `streaming` dropped, NaN rejected, 401 on all three, unknown fields 422, bad values 422, the 500-row limit (413), the text and JSON size limits (422 naming the field) |
| `test_admin.py` | CSV content and order for events, usage, users, messages, conversations; every export has every column of its table; 403 before 422, unknown table |
| `test_admin_logs.py` | `/admin/visits` and `/admin/events` (the logs page): visits grouped by user and visit (no visit and `visit: ""` are one visit `null`), counts, turns, designs, username from accounts and never the password hash, newest first; events in `(server_ts, id)` order with each filter and their combinations, `visit=` for the events without one; paging through ties (one server time for a whole batch) gives every row exactly once; payloads that are not a JSON object (`{not json`, `[1, 2]`, `NaN`) come back as `_raw` and do not break the visits list; 422 for limits, bad or foreign cursors, unknown parameters; 403 before 422 |
| `test_app.py` | health, error format for 404/405/422/500, `/api/docs`, CORS preflight with `Authorization`, the app imports without the Workers runtime |

## 2. Smoke test under the real Workers runtime

```bash
npm install          # once
bash tests/smoke.sh  # needs ports 8787 and 8790 free
```

The script recreates a separate local database (`.wrangler/smoke-state`) and applies all
migrations to it, starts `tests/fake_anthropic.py` on port 8790 and `uv run pywrangler dev` on
port 8787 with the made-up values from `tests/smoke.env` (your own `.dev.vars` is not used, so a
real key in it is never called), runs `tests/smoke.py` and stops both servers. The first run
downloads the Python packages and takes about a minute, later runs about 20 seconds. Expected last
line: `49 passed, 0 failed`. The Worker log is in `.wrangler/smoke-dev.log`.

What it checks: health, session (also the same participant twice), 401, chat without streaming,
CORS preflight, chat streaming with `Origin: http://localhost:5173` (CORS header present, the text is
right, the deltas arrive spread over about 2.7 seconds, so nothing buffers them, ends with `done`),
an upstream `error` event mid-stream, analyze with a nested schema, the score route (probabilities
and mass from the fake's logprobs, then `[off-topic]`, `[no-logprobs]` and `[upstream-500]` as
502s), upstream HTTP 500, refusal, the budget (one call that reports 250 000 tokens, then 429),
accounts (sign up with a guest token keeps the guest, login ignores case and returns the same token,
wrong password 401, the same username again 409, `/api/me`; this is the only test of the WebCrypto
password hashing), events twice (3 then 0), the CSV export (the usage CSV has the session's `chat`, `analyze` and
`score` rows) and its 403, the logs page routes (a visit of 5 events sent in one batch with its
counts, its events in pages of 2 with each event once, a payload that is not JSON, written straight
into the database by `smoke.sh`, as visit `null` and `_raw`, a bad cursor 422, a wrong token 403),
and the 404 format. Then persistence on the local D1: `PUT /api/sync` with one row of
every entity and `GET /api/state` returns exactly that, messages come back in order with their
extra fields and without `streaming`, the same body twice changes nothing, an older `updatedAt` is
ignored, a soft-deleted concept disappears, a second user can neither read (404) nor overwrite the
first user's rows, 500 rows in one request work (one D1 batch), 501 rows are a 413, three messages
at every size limit (200 000 + 2 × 20 000 four-byte characters each, about 0.9 MB per row) are
stored and read back, and the messages CSV export.

Not covered by the local runtime: the local D1 does not enforce D1's 2 MB row limit (a 2.1 MB
`zeroblob` passes locally), so the size limits rest on Cloudflare's documented limits
(https://developers.cloudflare.com/d1/platform/limits/): 100 bound parameters per statement, 2 MB
per row, and a `db.batch()` counts as one query however many statements it holds. CPU time is not
measured locally either (T-26).

The fake Claude API reacts to markers in the last user message: `[refuse]`, `[max-tokens]`,
`[upstream-500]`, `[stream-error]`, `[expensive]` (see the top of `tests/fake_anthropic.py`). Like
the real API it answers 400 to `temperature`, `top_p`, `top_k` and forced `tool_choice`. The same
server plays the fast model at `/v1/chat/completions`: one token whose top logprobs are
`"1"` 0.6, `" 1"` 0.2, `"2"` 0.15, `"Sure"` 0.05, so options `["1", "2"]` score
`{"1": 0.842, "2": 0.158}` with mass 0.95; `[off-topic]` makes "Sure" the likely answer (mass 0.1),
`[no-logprobs]` leaves the logprobs out, `[upstream-500]` is an OpenAI-style 500.

## 3. Manual test checklist

Setup for T-01 to T-12 (fake Claude, no key needed), in two terminals (the `TOKEN=` line needs
`jq`; without it, copy the token from the response by hand):

```bash
uv run python tests/fake_anthropic.py --port 8790        # terminal 1
cp .dev.vars.example .dev.vars                            # then fill in made-up values and
                                                          # ANTHROPIC_BASE_URL=http://127.0.0.1:8790
uv run pywrangler d1 migrations apply hci-grp19 --local
uv run pywrangler dev                                     # terminal 2 -> http://localhost:8787
TOKEN=$(curl -s -X POST localhost:8787/api/session -H 'content-type: application/json' -d '{}' | jq -r .token)
```

| ID | Test | Steps | Expected |
|---|---|---|---|
| T-01 | Health | `curl -s localhost:8787/api/health` | `{"ok":true,"environment":...}` |
| T-02 | New session | `curl -s -X POST localhost:8787/api/session -H 'content-type: application/json' -d '{}'` | `userId` (UUID), `token` = `userId.` + 64 hex characters |
| T-03 | Same participant | run `-d '{"participantId":"T03","condition":"A"}'`, then the same with `"condition":"B"` | same `userId` both times, `condition` is `"A"` both times |
| T-04 | No or bad token | `curl -s -X POST localhost:8787/api/events -H 'content-type: application/json' -d '{"events":[]}'`, then with `-H "authorization: Bearer x.y"` | 401, `code` `unauthorized` |
| T-05 | Chat | chat `curl` from `docs/api.md` | `output` text, `usage`, `model` `claude-sonnet-5-5`, `truncated` false |
| T-06 | Chat stream | streaming `curl -sN` from `docs/api.md` | `delta` events appear one after the other (not all at once), then one `done` |
| T-07 | Analyze | analyze `curl` from `docs/api.md` | `output` is a JSON object that matches the schema, `model` `claude-haiku-5-5` |
| T-08 | Validation | chat request with a `"schema"`; analyze without one; `"model":"x"` added | 422 `invalid_request`, the message names the problem |
| T-09 | Budget | set `DAILY_TOKEN_BUDGET=1` in `.dev.vars`, restart dev, new token, two chat calls | first 200, second 429 `budget_exceeded` with the reset time |
| T-13 | Total budget | set `TOTAL_TOKEN_BUDGET=1` in `.dev.vars`, restart dev, new token, two chat calls | first 200, second 429 `total_budget_exceeded` |
| T-10 | Events | events `curl` from `docs/api.md` twice | `stored: 1`, then `stored: 0` |
| T-11 | Export | `curl -s 'localhost:8787/api/admin/export?table=events' -H 'x-admin-token: <ADMIN_TOKEN from .dev.vars>'`, then with a wrong token | CSV with header row and the event from T-10; wrong token 403 |
| T-12 | CORS from the frontend | run the frontend (`npm run dev` in `frontend/`), open the browser console on `localhost:5173`: `await (await fetch('http://localhost:8787/api/session', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).json()` | returns `userId` and `token`, no CORS error |

**Live Claude checks (need a real key).** Put the key into `.dev.vars` as `ANTHROPIC_API_KEY` and
remove the `ANTHROPIC_BASE_URL` line, or run against the deployed Worker. Each call costs a
fraction of a cent. T-20 to T-23 passed on 16 Nov 2026 through the Bedrock stopgap (Sonnet 5); with
an Anthropic key and the planned models they have to be run again.

| ID | Test | Steps | Expected |
|---|---|---|---|
| T-20 | Live chat | T-05 with a real question | a real answer, `usage` plausible (hundreds of tokens), no 400 |
| T-21 | Live chat stream | T-06 with a real question | text arrives word by word; `done` with usage |
| T-22 | Live analyze on Haiku | T-07 | `output` parses and matches the schema (proves JSON outputs work on `claude-haiku-5-5` with this API version) |
| T-23 | Live nested schema | `tree` or `quiz` task with the nested schema from `docs/api.md` | valid nested JSON; no `invalid_model_output` |
| T-24 | Deployed streaming | T-06 against `https://hci-backend.leon-grass.workers.dev` | deltas arrive spread out, not in one block at the end |
| T-25 | Deployed CORS | T-12 from the Pages URL against the deployed Worker | no CORS error |
| T-26 | CPU time | after T-20 to T-25, Cloudflare dashboard: Workers, `hci-backend`, Metrics, CPU time | below the plan's limit (Free plan: 10 ms per request); no error 1102 "Worker exceeded CPU time limit" in the logs |

**Persistence (M2).** Local setup as for T-01 (the `migrations apply --local` line creates the
new tables too). The `PUT` body is the `curl` example in `docs/api.md` ("`PUT /api/sync`"); replace
`6b0c...` with any prefix.

| ID | Test | Steps | Expected |
|---|---|---|---|
| T-27 | Sync round trip | `PUT /api/sync` with the example body, then `curl -s localhost:8787/api/state -H "authorization: Bearer $TOKEN"` | `{"ok":true,"serverTime":...}`; `/state` has the concept, the conversation and the attempt exactly as sent, `edges` and `trees` empty, no `messages` key |
| T-28 | Messages | `curl -s localhost:8787/api/conversations/<conversation id>/messages -H "authorization: Bearer $TOKEN"`, then with the id `nope` | the message with `conceptIds` and `analysis` flattened into it; `nope` is 404 `not_found` |
| T-29 | Idempotent, last write wins | send the T-27 body again, then once more with the conversation's `title` changed and an older `updatedAt` | `/state` unchanged both times |
| T-30 | Other user | new token (T-02), then T-28 with it, and T-27's body with it | 404 for the first user's conversation; the first user's `/state` unchanged; the second user's `/state` empty |
| T-31 | Deployed persistence | after `uv run pywrangler d1 migrations apply hci-grp19 --remote` and the deploy: T-27 to T-30 against `https://hci-backend.leon-grass.workers.dev`, then `GET /api/admin/export?table=messages` | as above; the CSV has the synced message with its `meta_json` |

**Fast slot and score route.** T-32 to T-34 use the fake: add `FAST_BASE_URL=http://127.0.0.1:8790/v1`
and any `FAST_API_KEY` to `.dev.vars` next to the T-01 setup. T-35 and T-36 need the real keys in
`.dev.vars` (and no `*_BASE_URL` lines pointing at the fake); each score call costs a few hundred
tokens.

| ID | Test | Steps | Expected |
|---|---|---|---|
| T-32 | Score (fake) | the score `curl` from `docs/api.md` | `probabilities` `{"1": 0.842..., "2": 0.157...}`, `mass` 0.95, `usage` 40 in / 1 out |
| T-33 | Score errors (fake) | the same with `[off-topic]`, then `[no-logprobs]` in the message; then `"options": ["1"]` and `"options": ["1", "a b"]` | 502 `invalid_model_output` (the message names the likeliest token "Sure"), 502 `invalid_model_output` ("no logprobs"); both option lists 422 |
| T-34 | Missing fast key | remove `FAST_API_KEY` from `.dev.vars`, restart dev, new token: score `curl`, then the chat `curl` | score 500 `server_misconfigured` naming `FAST_API_KEY`; chat 200 |
| T-35 | Live score | the score `curl` with a message that clearly thinks along, then with "Write me a summary of backpropagation for my exam."; time both (`curl -w '%{time_total}'`) | first `probabilities["1"]` above 0.9, second below 0.2, `mass` near 1, `model` `zai.glm-4.7-flash`, well under 1 s each |
| T-36 | Effort `none` on Haiku 4.5 | `.dev.vars`: `MODEL_ANALYZE=anthropic.claude-haiku-4-5`, `EFFORT_ANALYZE=low`, restart dev, analyze `curl`; then `EFFORT_ANALYZE=none`, restart, again | `low`: 502 `upstream_error` "HTTP 400 ... This model does not support the effort parameter"; `none`: 200 with JSON that matches the schema, `model` `anthropic.claude-haiku-4-5` |
| T-37 | Deployed score | after `FAST_API_KEY` is set on the Worker and the deploy: T-35 against `https://hci-backend.leon-grass.workers.dev` | as T-35 |
| T-38 | Accounts | new token (T-02), then the signup `curl` from `docs/api.md` with it; `POST /api/auth/login` with the username in capitals; again with a wrong password; the signup again; `GET /api/me` | signup 200 with the guest's `userId` and token; login 200, same token, username as stored; 401 `invalid_credentials`; 409 `username_taken`; `/me` names the account |
| T-39 | Deployed accounts | after `uv run pywrangler d1 migrations apply hci-grp19 --remote` (0003) and the deploy: T-38 against `https://hci-backend.leon-grass.workers.dev`; then T-26 for the signup and login requests | as T-38; CPU time of signup and login below the plan's limit (PBKDF2 runs in WebCrypto) |

**Logs page routes.** Local setup as for T-01, then T-10 with `"visit": "v1", "seq": 1` in the
payload, and once more with another event id and `"seq": 2`.

| ID | Test | Steps | Expected |
|---|---|---|---|
| T-40 | Visits and events | `curl -s 'localhost:8787/api/admin/visits?limit=5' -H 'x-admin-token: <ADMIN_TOKEN from .dev.vars>'`; then `curl -s 'localhost:8787/api/admin/events?visit=v1&userId=<userId>&limit=1' -H ...` and again with `&after=<next>`; both routes with a wrong token, and with `limit=0` | the visit `v1` with `events` 2; one event per page, the second page has the other event and `next` null; wrong token 403; `limit=0` 422 |
| T-41 | Deployed logs page | after the deploy of backend and frontend: open `https://hci-2026-group-19.pages.dev/logs`, enter the admin token, open a visit, download the events CSV | the live site's visits, newest first; the visit's timeline loads; the CSV downloads; a wrong token shows the 403 message |

## 4. How we document tests

Every test run that matters (before a merge, before the pilot, after a deploy) gets one row per test
ID in the table below. Write what you actually saw, not what you expected.

| Date | Tester | Test ID | Commit | Expected | Actual | Pass/fail | Notes |
|---|---|---|---|---|---|---|---|
| 2026-11-16 | Claude (for Salomon) | smoke (`tests/smoke.sh`) | `e55729d` | `23 passed, 0 failed` | `23 passed, 0 failed`; 9 deltas at 0.32 s to 2.71 s | pass | local `pywrangler dev` (wrangler 4.162.0) with the fake Claude API; deployed Worker and live Claude not tested |
| 2026-11-16 | Claude (for Salomon) | T-20, T-21, T-22, T-23 | `9b457cf` + total budget | real answers; stream in pieces; JSON matches the schemas | all four 200 on `anthropic.claude-sonnet-5`; stream: 53 deltas over 2.2 s, then `done`; flat and nested JSON valid | pass | local `pywrangler dev` against Claude in Amazon Bedrock (stopgap); not yet on the deployed Worker; not on the planned models |
| 2026-11-16 | Claude (for Salomon) | smoke (`tests/smoke.sh`) | `9b457cf` + total budget | `23 passed, 0 failed` | `23 passed, 0 failed` | pass | after adding `TOTAL_TOKEN_BUDGET`; 92 automatic tests pass |
| 2026-11-16 | Claude (for Salomon) | T-20 to T-25, T-10, T-11 on the deployed Worker | `3190591` | as in section 3 | all pass on `https://hci-backend.leon-grass.workers.dev`: chat 200; stream 59 deltas over 2.4 s with the CORS header for the Pages origin; flat and nested JSON valid; events `stored: 1`; CSV export 200, wrong admin token 403 | pass | model API: Bedrock stopgap, `anthropic.claude-sonnet-5`; no error 1102 in about 15 calls; T-26 (CPU time in the dashboard) not checked |
| 2026-11-16 | Claude (for Salomon) | browser, `?live=1`, classic and ASCII style | `16eab0f` (branch `live-chat`) | answer streams in, bar and squirrel react, tree gets leaves | as expected in both styles on the Pages preview against the deployed Worker; no console errors | pass | one prompt per style |
| 2026-11-17 | Claude (for Salomon) | automatic tests (`uv run --group test pytest -q`) | `43df729` | all pass | `128 passed` | pass | 92 before plus 36 new (`test_sync.py` 34, `test_admin.py` 2) |
| 2026-11-17 | Claude (for Salomon) | smoke (`tests/smoke.sh`) incl. the sync checks (T-27 to T-30 automated) | `43df729` | `33 passed, 0 failed` | `33 passed, 0 failed`; 500 attempts in one request stored; 3 messages of about 0.9 MB each stored and read back | pass | local `pywrangler dev` (wrangler 4.162.0), fresh local D1 with migrations 0001 + 0002; deployed Worker not tested (0002 is not applied remotely yet, T-31 open) |
| 2026-11-17 | Claude (for Salomon) | T-27 to T-30 by hand, with the `curl` example from `docs/api.md` | `43df729` | as in section 3 | as expected: `/state` returned the rows as sent (`independence` 1.0 comes back as `1`), messages with `conceptIds` and `analysis` flattened, `nope` 404, state unchanged after the repeat and after an older `updatedAt`, second user 404 and empty state; `/api/docs` 200 and all eight paths in `/api/openapi.json` | pass | local `pywrangler dev`; T-31 (deployed) open |
| 2026-11-17 | Claude (for Salomon) | automatic tests (`uv run --group test pytest -q`) | `915aa89` | all pass | `173 passed` | pass | 128 before plus 45 new: effort `none` 3, `test_scoring.py` 14, `/ai/score` 28 |
| 2026-11-17 | Claude (for Salomon) | smoke (`tests/smoke.sh`) incl. the score checks (T-32, T-33 automated) | `915aa89` | `38 passed, 0 failed` | `38 passed, 0 failed`; score `{"1": 0.842, "2": 0.158}`, mass 0.95; the three error markers 502; usage CSV has the `score` row | pass | local `pywrangler dev` (wrangler 4.162.0), fake fast model |
| 2026-11-17 | Claude (for Salomon) | T-35 live score: 14 judged messages (10 "thought along?", 4 "right or wrong?", prompts as in `docs/api.md`), 1 call with three options, 1 greeting prompt | `915aa89` | clear cases in their band, mass near 1, well under 1 s | 13 of 14 in band: "I think dropout works because ..." P("1") 0.999, "Write me a summary of backpropagation for my exam." 0.119, mass 1.00 on all 14; the one miss is a middle case, "Why does a smaller learning rate help? Is it because big steps overshoot?" at 0.881 (band 0.15 to 0.85). Three options on a hint request: "B" 0.9998, mass 0.99. Greeting prompt: 502 `invalid_model_output`, likeliest token 'Hello'. Latency through the local Worker: median 0.27 s, min 0.13 s, max 0.50 s (the first call), 15 calls; `/api/health` median 6 ms. 1 897 tokens for the 16 score calls | pass | local `pywrangler dev` against `zai.glm-4.7-flash` on Bedrock eu-north-1; deployed Worker not tested (T-37 open) |
| 2026-11-17 | Claude (for Salomon) | live upstream error on the score route | `915aa89` | 502 `upstream_error` with the provider's message | `MODEL_FAST=zai.no-such-model`: 502 `upstream_error` "The model API returned HTTP 404 (invalid_request_error: The model 'zai.no-such-model' does not exist)." | pass | Bedrock's error body has the OpenAI shape |
| 2026-11-17 | Claude (for Salomon) | T-36 | `915aa89` | `low` 400, `none` 200 | `low`: 502 `upstream_error` "HTTP 400 (invalid_request_error: This model does not support the effort parameter.)"; `none`: 200, `{"mode": "ai"}`, 187 in / 9 out tokens, 1.12 s | pass | local `pywrangler dev`, `anthropic.claude-haiku-4-5` on Bedrock |
| 2026-11-17 | Claude (for Leon) | automatic tests (`uv run --group test pytest -q`) | branch `accounts-backend` | all pass | `190 passed` | pass | 173 before plus 17 new in `test_accounts.py` |
| 2026-11-17 | Claude (for Leon) | smoke (`tests/smoke.sh`) incl. the account checks (T-38 automated) | branch `accounts-backend` | `43 passed, 0 failed` | `43 passed, 0 failed`; signup 0.06 s and login 0.06 s through the local Worker (PBKDF2 100 000 iterations in WebCrypto) | pass | local `pywrangler dev`, fresh local D1 with 0001 to 0003; deployed Worker not tested (T-39 open: 0003 is not applied remotely) |

Rule: every PR that adds or changes an endpoint adds or updates its test ID in section 3 (and an
automatic test), and adds a row here with the result of its own run.
