import base64
import csv
import io
import json
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import JSONResponse

import db
from auth import require_admin
from config import Env
from errors import ApiError
from schemas import AdminEventsQuery, AdminEventsResponse, VisitsQuery, VisitsResponse

router = APIRouter(tags=["admin"])


@router.get(
    "/admin/export",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "CSV with a header row"}},
    dependencies=[Depends(require_admin)],
)
async def export(table: Literal[*db.EXPORTS], env: Env) -> Response:
    """One table as CSV, all users, ordered by time. Header `X-Admin-Token`."""
    columns, rows = await db.export_rows(env.DB, table)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(columns)
    writer.writerows([row[column] for column in columns] for row in rows)
    return Response(
        out.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="arbor-{table}.csv"'},
    )


# --- the logs page: visits and events as JSON, page by page ---------------------------------
# A cursor is the sort key of a page's last row as base64 JSON: opaque to the client, and stable
# under ties (a whole batch of events shares one server_ts) because the key ends in a unique part.
# As in routes/sync.py the rows go out as a JSONResponse; the response models are for the docs.

def _cursor(*key: str) -> str:
    return base64.urlsafe_b64encode(json.dumps(key).encode()).decode().rstrip("=")


def _key(cursor: str | None, name: str, size: int) -> tuple[str, ...] | None:
    """The sort key inside a cursor made by _cursor; a 422 for anything else."""
    if cursor is None:
        return None
    try:
        key = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except ValueError:
        key = None
    if not (isinstance(key, list) and len(key) == size and all(isinstance(part, str) for part in key)):
        raise ApiError(422, "invalid_request", f"query.{name}: not a cursor of this route (pass the `next` of the page before)")
    return tuple(key)


def _reject_constant(name: str) -> None:
    raise ValueError(f"{name} is not JSON")


def _payload(text: str) -> dict:
    """The stored payload. One that is not a JSON object (or holds NaN, which a strict JSON answer
    cannot carry) comes back as {"_raw": text}: visible, and the rest of the page still loads."""
    try:
        value = json.loads(text, parse_constant=_reject_constant)
    except ValueError:
        return {"_raw": text}
    return value if isinstance(value, dict) else {"_raw": text}


@router.get("/admin/visits", response_model=VisitsResponse, dependencies=[Depends(require_admin)])
async def visits(query: Annotated[VisitsQuery, Query()], env: Env) -> JSONResponse:
    """Visits (page loads), newest first by their last event's server time. Header `X-Admin-Token`."""
    rows = await db.visits(env.DB, query.limit, _key(query.before, "before", 3))
    page = rows[: query.limit]
    last = page[-1] if len(rows) > query.limit else None
    return JSONResponse({
        "visits": [{
            "visit": row["visit"] or None,
            "userId": row["user_id"],
            "participantId": row["participant_id"],
            "condition": row["condition"],
            "username": row["username"],
            "design": ",".join(sorted(row["designs"].split(","))) if row["designs"] else None,
            "first": row["first_ts"],
            "last": row["last_ts"],
            "lastServerTs": row["last_server_ts"],
            "events": row["events"],
            "turns": row["turns"],
        } for row in page],
        "next": _cursor(last["last_server_ts"], last["user_id"], last["visit"]) if last else None,
    })


@router.get("/admin/events", response_model=AdminEventsResponse, dependencies=[Depends(require_admin)])
async def events(query: Annotated[AdminEventsQuery, Query()], env: Env) -> JSONResponse:
    """Events ascending by server time, then id; filters `visit`, `userId`, `type` (AND). Header `X-Admin-Token`."""
    rows = await db.events_page(env.DB, visit=query.visit, user_id=query.user_id, type=query.type,
                                after=_key(query.after, "after", 2), limit=query.limit)
    page = rows[: query.limit]
    last = page[-1] if len(rows) > query.limit else None
    return JSONResponse({
        "events": [{
            "id": row["id"],
            "userId": row["user_id"],
            "condition": row["condition"],
            "type": row["type"],
            "payload": _payload(row["payload_json"]),
            "clientTs": row["client_ts"],
            "serverTs": row["server_ts"],
        } for row in page],
        "next": _cursor(last["server_ts"], last["id"]) if last else None,
    })
