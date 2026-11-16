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
| `test_llm.py` | upstream request body per task (model, `max_tokens`, effort, JSON schema format, never `temperature`/`thinking`/`tool_choice`), response parsing (thinking blocks ignored, refusal, truncation, bad JSON), error messages without the key, the SSE parser with events split at every possible byte (also inside UTF-8 characters), cumulative usage |
| `test_ai.py` | `/ai/complete` end to end: validation errors, 413, budget (429, resets per day, per user), usage written and summed, refusal, truncated, upstream errors (nothing recorded), streaming (happy path, chunk splits, upstream `error` event, missing `message_stop`, connection drop, refusal, truncation, client disconnect, CORS header) |
| `test_events.py` | storing, idempotency, duplicate ids in one batch, 1..200 limit, `clientTs` must carry a time zone |
| `test_admin.py` | CSV content and order for all three tables, 403 before 422, unknown table |
| `test_app.py` | health, error format for 404/405/422/500, `/api/docs`, CORS preflight with `Authorization`, the app imports without the Workers runtime |

## 2. Smoke test under the real Workers runtime

```bash
npm install          # once
bash tests/smoke.sh  # needs ports 8787 and 8790 free
```

The script applies the migrations to a separate local database (`.wrangler/smoke-state`), starts
`tests/fake_anthropic.py` on port 8790 and `uv run pywrangler dev` on port 8787 with the made-up
values from `tests/smoke.env` (your own `.dev.vars` is not used, so a real key in it is never
called), runs `tests/smoke.py` and stops both servers. The first run downloads the Python packages
and takes about a minute. Expected last line: `23 passed, 0 failed`. The Worker log is in
`.wrangler/smoke-dev.log`.

What it checks: health, session (also the same participant twice), 401, chat without streaming,
CORS preflight, chat streaming with `Origin: http://localhost:5173` (CORS header present, the text is
right, the deltas arrive spread over about 2.7 seconds, so nothing buffers them, ends with `done`),
an upstream `error` event mid-stream, analyze with a nested schema, upstream HTTP 500, refusal,
the budget (one call that reports 250 000 tokens, then 429), events twice (3 then 0), the CSV export
and its 403, and the 404 format.

The fake Claude API reacts to markers in the last user message: `[refuse]`, `[max-tokens]`,
`[upstream-500]`, `[stream-error]`, `[expensive]` (see the top of `tests/fake_anthropic.py`). Like
the real API it answers 400 to `temperature`, `top_p`, `top_k` and forced `tool_choice`.

## 3. Manual test checklist

Setup for T-01 to T-12 (fake Claude, no key needed), in two terminals (the `TOKEN=` line needs
`jq`; without it, copy the token from the response by hand):

```bash
uv run python tests/fake_anthropic.py --port 8790        # terminal 1
cp .dev.vars.example .dev.vars                            # then fill in made-up values and
                                                          # ANTHROPIC_BASE_URL=http://127.0.0.1:8790
uv run pywrangler d1 migrations apply arbor --local
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
| T-10 | Events | events `curl` from `docs/api.md` twice | `stored: 1`, then `stored: 0` |
| T-11 | Export | `curl -s 'localhost:8787/api/admin/export?table=events' -H 'x-admin-token: <ADMIN_TOKEN from .dev.vars>'`, then with a wrong token | CSV with header row and the event from T-10; wrong token 403 |
| T-12 | CORS from the frontend | run the frontend (`npm run dev` in `frontend/`), open the browser console on `localhost:5173`: `await (await fetch('http://localhost:8787/api/session', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).json()` | returns `userId` and `token`, no CORS error |

**Live Claude checks (need the group API key; nobody has run them yet).** Put the real key into
`.dev.vars` as `ANTHROPIC_API_KEY` and remove the `ANTHROPIC_BASE_URL` line, or run against the
deployed Worker. Each call costs a fraction of a cent.

| ID | Test | Steps | Expected |
|---|---|---|---|
| T-20 | Live chat | T-05 with a real question | a real answer, `usage` plausible (hundreds of tokens), no 400 |
| T-21 | Live chat stream | T-06 with a real question | text arrives word by word; `done` with usage |
| T-22 | Live analyze on Haiku | T-07 | `output` parses and matches the schema (proves JSON outputs work on `claude-haiku-5-5` with this API version) |
| T-23 | Live nested schema | `tree` or `quiz` task with the nested schema from `docs/api.md` | valid nested JSON; no `invalid_model_output` |
| T-24 | Deployed streaming | T-06 against `https://hci-backend.<account>.workers.dev` | deltas arrive spread out, not in one block at the end (only verified locally so far) |
| T-25 | Deployed CORS | T-12 from the Pages URL against the deployed Worker | no CORS error |
| T-26 | CPU time | after T-20 to T-25, Cloudflare dashboard: Workers, `hci-backend`, Metrics, CPU time | below the plan's limit (Free plan: 10 ms per request); no error 1102 "Worker exceeded CPU time limit" in the logs |

## 4. How we document tests

Every test run that matters (before a merge, before the pilot, after a deploy) gets one row per test
ID in the table below. Write what you actually saw, not what you expected.

| Date | Tester | Test ID | Commit | Expected | Actual | Pass/fail | Notes |
|---|---|---|---|---|---|---|---|
| 2026-11-16 | Claude (for Salomon) | smoke (`tests/smoke.sh`) | `e55729d` | `23 passed, 0 failed` | `23 passed, 0 failed`; 9 deltas at 0.32 s to 2.71 s | pass | local `pywrangler dev` (wrangler 4.162.0) with the fake Claude API; deployed Worker and live Claude not tested |

Rule: every PR that adds or changes an endpoint adds or updates its test ID in section 3 (and an
automatic test), and adds a row here with the result of its own run.
