"""The six synced entity tables: how a wire entity (schemas.py) maps to its D1 row and back, and
the SQL that writes and reads them (PUT /sync, GET /state, GET /conversations/:id/messages).

Columns follow mechanically from the Pydantic field names: `parent_id` stays parent_id, JSON
fields get a `_json` suffix (aliases -> aliases_json), booleans are stored as 0/1. A message's
fields beyond the validated core are stored together in meta_json and come back flattened.
`user_id` always comes from the session token, never from the body.
"""

import json
from typing import Any, Literal, NamedTuple

import db
from schemas import (
    CamelModel,
    Concept,
    ConceptAttempt,
    ConceptEdge,
    Conversation,
    KnowledgeTree,
    Message,
)

# How an incoming row meets a stored row with the same id:
#   newer   = last write wins: replace only if the incoming updatedAt >= the stored one
#   replace = the incoming row always wins (messages and attempts have no updatedAt)
#   keep    = insert or ignore (edges never change; also ignores a second edge with the same
#             from/to/kind under another id)
# Never across users: ids are global, and a stored row of another user is skipped, not replaced.
Conflict = Literal["newer", "replace", "keep"]


class Field(NamedTuple):
    name: str  # Python field name in schemas.py
    wire: str  # camelCase name on the wire
    column: str  # D1 column
    kind: Literal["plain", "json", "bool"]
    required: bool  # False: optional (`?` in domain.ts), left out of responses when empty


class Table:
    def __init__(self, name: str, key: str, model: type[CamelModel], conflict: Conflict,
                 json_fields: tuple[str, ...] = ()) -> None:
        self.name = name
        self.key = key  # list name in the sync body and in the /state response
        self.has_meta = model.model_config.get("extra") == "allow"  # messages: extra fields -> meta_json
        self.soft_delete = "deleted_at" in model.model_fields
        self.fields = [
            Field(name, info.alias, f"{name}_json" if name in json_fields else name,
                  "json" if name in json_fields else "bool" if info.annotation is bool else "plain",
                  info.is_required())
            for name, info in model.model_fields.items() if name != "id"
        ]
        self.columns = [field.column for field in self.fields] + (["meta_json"] if self.has_meta else [])

        insert_columns = ["id", "user_id", *self.columns]
        insert = (f"INSERT INTO {name} ({', '.join(insert_columns)})"
                  f" VALUES ({', '.join('?' * len(insert_columns))})")
        if conflict == "keep":
            self.upsert_sql = f"{insert} ON CONFLICT DO NOTHING"
        else:
            updates = ", ".join(f"{column} = excluded.{column}" for column in self.columns)
            where = f"{name}.user_id = excluded.user_id"
            if conflict == "newer":
                where += f" AND excluded.updated_at >= {name}.updated_at"
            self.upsert_sql = f"{insert} ON CONFLICT(id) DO UPDATE SET {updates} WHERE {where}"

    def select_sql(self, where: str) -> str:
        """Every row matching `where` (which must scope by user_id), oldest first."""
        return f"SELECT id, {', '.join(self.columns)} FROM {self.name} WHERE {where} ORDER BY created_at, id"

    def to_row(self, user_id: str, item: CamelModel) -> tuple:
        """Parameters for upsert_sql. Timestamps are already UTC text (schemas.Timestamp)."""
        values: list[Any] = [item.id, user_id]
        for field in self.fields:
            value = getattr(item, field.name)
            if value is not None and field.kind == "json":
                value = db.to_json(value)
            elif value is not None and field.kind == "bool":
                value = int(value)
            values.append(value)
        if self.has_meta:
            values.append(db.to_json(item.model_extra))
        return tuple(values)

    def to_wire(self, row: dict[str, Any]) -> dict[str, Any]:
        """A row from select_sql as the camelCase entity. Empty optional fields are left out."""
        out: dict[str, Any] = {"id": row["id"]}
        for field in self.fields:
            value = row[field.column]
            if value is None:
                if field.required:
                    out[field.wire] = None
                continue
            if field.kind == "json":
                value = json.loads(value)
            elif field.kind == "bool":
                value = bool(value)
            out[field.wire] = value
        if self.has_meta:
            # The validated core wins over a meta key of the same name.
            out.update((k, v) for k, v in json.loads(row["meta_json"]).items() if k not in out)
        return out


CONCEPTS = Table("concepts", "concepts", Concept, "newer", json_fields=("aliases",))
EDGES = Table("concept_edges", "edges", ConceptEdge, "keep")
TREES = Table("trees", "trees", KnowledgeTree, "newer")
CONVERSATIONS = Table("conversations", "conversations", Conversation, "newer")
MESSAGES = Table("messages", "messages", Message, "replace", json_fields=("classification",))
ATTEMPTS = Table("attempts", "attempts", ConceptAttempt, "replace", json_fields=("reasons", "evidence"))

SYNCED = (CONCEPTS, EDGES, TREES, CONVERSATIONS, MESSAGES, ATTEMPTS)  # PUT /sync, in this order
STATE = (CONCEPTS, EDGES, TREES, CONVERSATIONS, ATTEMPTS)  # GET /state (messages load per conversation)
