# Arbor API (Python Worker)

FastAPI running on Cloudflare Python Workers (Pyodide). Deployed separately from the
frontend (Cloudflare Pages); the frontend calls it with `api()` from `frontend/src/lib/api.ts`.

## Run locally

Needs uv ≥ 0.13.4 (`uv self update`) and Node 20+.

```bash
npm install            # wrangler, used by pywrangler under the hood
uv run pywrangler dev  # → http://localhost:8787/api/health
```

Run the frontend (`npm run dev` in `frontend/`) next to it; it reads the API URL from
`frontend/.env.development`. Local config values go in `.dev.vars` (gitignored).

## Endpoints

| Route | What |
|---|---|
| `GET /api/health` | liveness check, returns `{"ok": true, ...}` |
| `POST /api/echo` | placeholder, returns the JSON body; replace with real endpoints |

Add routes in `src/main.py`. Dependencies go in `pyproject.toml` (`uv add <pkg>`); only
pure-Python packages or ones Pyodide supports will work.

## Deployment (automatic)

Workers Builds deploys on every push to `main` that touches `backend/`. One-time setup in
Cloudflare: **Workers & Pages → Create → Worker → Import a repository**, then:

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Build command | `pip install uv && npm ci` |
| Deploy command | `uv run pywrangler deploy` |
| Build watch paths | `backend/*` |

Then set `VITE_API_URL` to the Worker's URL (`https://hci-backend.<account>.workers.dev`)
in the **Pages** project's environment variables and redeploy the frontend.

**CORS:** `src/main.py` allows `localhost:5173` and `*.hci-2026-group-19.pages.dev`. Change
the regex there if the frontend moves to another domain.

**Secrets** (e.g. an LLM API key): `uv run pywrangler secret put NAME` or the Worker's
settings in the dashboard, never in `wrangler.toml`. Read with `request.scope["env"].NAME`.
