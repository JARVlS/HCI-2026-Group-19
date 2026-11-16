import csv
import io
from typing import Literal

from fastapi import APIRouter, Depends, Response

import db
from auth import require_admin
from config import Env

router = APIRouter(tags=["admin"])


@router.get(
    "/admin/export",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "CSV with a header row"}},
    dependencies=[Depends(require_admin)],
)
async def export(table: Literal["events", "usage", "users"], env: Env) -> Response:
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
