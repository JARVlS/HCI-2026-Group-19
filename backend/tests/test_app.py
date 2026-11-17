"""Health, the common error format, docs, CORS preflight, and imports outside the Worker."""

import subprocess
import sys
from pathlib import Path

from fakes import FakeUpstream, build_client, make_env


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True, "environment": "test"}


def test_unknown_route_is_404_not_found(client):
    response = client.get("/api/nope")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "Not Found"}}


def test_echo_placeholder_is_gone(client):
    assert client.post("/api/echo", json={}).status_code == 404


def test_wrong_method_uses_the_error_format(client):
    response = client.get("/api/session")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "invalid_request"


def test_validation_error_format(client):
    response = client.post("/api/session", json={"participantId": 5})
    assert response.status_code == 422
    assert response.json() == {"error": {"code": "invalid_request",
                                         "message": "participantId: Input should be a valid string"}}


def test_invalid_json_body_is_422(client):
    response = client.post("/api/session", content=b"{not json", headers={"content-type": "application/json"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_unhandled_error_is_500_without_internals():
    env = make_env()
    env.DB = None  # any DB call now raises AttributeError deep inside a route
    with build_client(env, FakeUpstream()) as client:
        response = client.post("/api/session", json={})
    assert response.status_code == 500
    assert response.json() == {"error": {"code": "internal_error", "message": "Internal server error."}}


def test_docs_and_openapi(client):
    assert client.get("/api/docs").status_code == 200
    paths = client.get("/api/openapi.json").json()["paths"]
    assert set(paths) == {"/api/health", "/api/session", "/api/ai/complete", "/api/events", "/api/admin/export",
                          "/api/state", "/api/conversations/{conversation_id}/messages", "/api/sync"}


def test_cors_preflight_allows_authorization(client):
    response = client.options("/api/ai/complete", headers={
        "Origin": "https://abc123.hci-2026-group-19.pages.dev",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
    })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://abc123.hci-2026-group-19.pages.dev"
    assert "authorization" in response.headers["access-control-allow-headers"].lower()


def test_cors_rejects_other_origins(client):
    response = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in response.headers


def test_app_modules_import_without_the_workers_runtime():
    src = Path(__file__).parent.parent / "src"
    code = ("import sys; import app; "
            "bad = [m for m in ('workers', 'js', 'pyodide') if m in sys.modules]; "
            "assert not bad, bad")
    subprocess.run([sys.executable, "-c", code], cwd=src, check=True)
