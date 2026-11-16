"""The FastAPI app: CORS, routers, and one error format for every failure.

Every error response is `{"error": {"code": "<snake_case>", "message": "<text>"}}`.
"""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from errors import ApiError
from routes import admin, ai, events, health, session
from schemas import ErrorResponse

logger = logging.getLogger(__name__)

_HTTP_CODES = {401: "unauthorized", 403: "forbidden", 404: "not_found"}


def _error(status: int, code: str, message: str, headers: dict | None = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status, headers=headers)


async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
    return _error(exc.status, exc.code, exc.message)


async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    parts = []
    for err in exc.errors()[:5]:
        where = ".".join(str(p) for p in err["loc"] if p != "body")
        parts.append(f"{where}: {err['msg']}" if where else err["msg"])
    return _error(422, "invalid_request", "; ".join(parts))


async def _http_error(request: Request, exc: HTTPException) -> JSONResponse:
    code = _HTTP_CODES.get(exc.status_code, "invalid_request")
    return _error(exc.status_code, code, str(exc.detail), exc.headers)


async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled error", exc_info=exc)
    return _error(500, "internal_error", "Internal server error.")


def create_app() -> FastAPI:
    app = FastAPI(
        title="Arbor API",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
        responses={"4XX": {"model": ErrorResponse}, "5XX": {"model": ErrorResponse}},
    )
    # The frontend lives on another origin (Cloudflare Pages), so the browser needs CORS.
    # Allowed: local Vite dev server, the production Pages URL and its preview deployments
    # (e.g. https://abc123.hci-2026-group-19.pages.dev). allow_headers=["*"] includes
    # Authorization and X-Admin-Token.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(http://localhost:5173|https://([a-z0-9-]+\.)?hci-2026-group-19\.pages\.dev)$",
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for module in (health, session, ai, events, admin):
        app.include_router(module.router, prefix="/api")
    app.add_exception_handler(ApiError, _api_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(HTTPException, _http_error)
    app.add_exception_handler(Exception, _unhandled)
    return app


app = create_app()
