# Arbor (HCI 2026, group 19)

A tutor chat that shows who did the thinking: a thought linter while you type, a knowledge tree
per chat, live Claude answers through the group's backend.

- `frontend/`: React + Vite on Cloudflare Pages (`hci-2026-group-19.pages.dev`). Two designs
  (`src/designs/ascii` is the default, `classic` only has to compile). See `frontend/README.md`.
- `backend/`: FastAPI on Cloudflare Python Workers + D1 (`hci-backend.leon-grass.workers.dev`).
  See `backend/README.md`, `backend/docs/api.md`, `backend/docs/testing.md`.
- `IMPLEMENTATION_PLAN.md`: the binding ADRs (§3), the API contract (§4) and the milestones (§6).
  Read §2 to §4 before changing architecture; §8 has the coding conventions.

## Commands

```bash
cd frontend && npm ci && npm test && npm run build   # vitest + tsc + vite
cd frontend && npm run dev                            # http://localhost:5173
cd backend && uv run --group test pytest -q          # unit tests (CPython, fake D1)
cd backend && bash tests/smoke.sh                     # real Workers runtime, fake model API
cd frontend && npm run eval:linter                    # linter vs labelled prompts (offline; + fast model with VITE_API_URL)
```

Local dev talks to `VITE_API_URL` (`frontend/.env.development`: `http://localhost:8787`). To use
the deployed backend from `npm run dev`, put `VITE_API_URL=https://hci-backend.leon-grass.workers.dev`
(and `VITE_DEFAULT_PROVIDER=arbor` for the production default) in `frontend/.env.development.local`
(gitignored). CORS allows `http://localhost:5173`.

## How we work

- **Frontend changes are checked visually.** Run the dev server in the browser pane, take
  screenshots of the real UI (desktop width, and phone width when layout changes) before calling
  a UI change done; tests alone do not catch layout bugs. Example: a CSS class reused by another
  sheet once squeezed the chat prompt to two words while every test passed.
- **CSS classes are global within a design.** Before adding a class, grep the design's CSS for the
  name (`a-` prefix in ascii, `w-` for the welcome screen).
- **Backend and frontend go in separate branches and PRs** (`<topic>-backend`, `<topic>-frontend`),
  each with its tests and docs. Merging to `main` deploys: Pages for `frontend/`, Workers Builds
  for `backend/`.
- **A new D1 migration must be applied to `hci-grp19` by hand** (`uv run pywrangler d1 migrations
  apply hci-grp19 --remote`, needs the Cloudflare login) and recorded in the table in
  `backend/README.md`. Never run it without the account owner's go.
- **Decisions go into the plan in the same PR:** a new or amended ADR in §3, the API table in §4,
  milestone checkboxes in §6 with a dated note of what was actually built and what is still open.
  Update `frontend/README.md` / `backend/README.md` too, and add a row to the test log in
  `backend/docs/testing.md` for every endpoint change.
- UI copy in the ascii design is lowercase; every new action gets a `/command`.
- The linter must never move the layout (ADR-14): feedback lives in the fixed score line above the
  prompt and in hover pop-ups, never in a block under the prompt.
- Cost: every live answer spends the group's token budget (`TOTAL_TOKEN_BUDGET` in
  `backend/wrangler.toml`). Use `?demo=1` or the local fake model for UI work that does not need
  real answers.
- A change to how prompts are judged (rules, prompts, thresholds) comes with a fresh `npm run
  eval:linter` result in `frontend/eval/results/` (ADR-15). The labels there are a draft until the
  team has rated them; say so wherever the numbers are quoted.
- Accounts are optional (ADR-8 amended): guests are anonymous sessions; no email, no reset.
  Test accounts go in local databases only, never on the deployed backend.
