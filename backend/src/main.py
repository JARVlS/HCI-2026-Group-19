from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from workers import asgi

app = FastAPI(title="Arbor API")

# The frontend lives on another origin (Cloudflare Pages), so the browser needs CORS.
# Allowed: local Vite dev server, the production Pages URL and its preview deployments
# (e.g. https://abc123.hci-2026-group-19.pages.dev).
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(http://localhost:5173|https://([a-z0-9-]+\.)?hci-2026-group-19\.pages\.dev)$",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health(request: Request):
    env = request.scope["env"]
    return {"ok": True, "environment": env.ENVIRONMENT}


@app.post("/api/echo")
async def echo(request: Request):
    """Placeholder: replace with real endpoints (e.g. /api/classify, /api/respond)."""
    return {"received": await request.json()}


Default = asgi.entrypoint(app)
