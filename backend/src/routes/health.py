from fastapi import APIRouter

from config import Env

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(env: Env) -> dict:
    """Liveness check. No auth."""
    return {"ok": True, "environment": env.ENVIRONMENT}
