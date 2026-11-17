"""Request and response bodies. JSON field names are camelCase on the wire (ADR-2)."""

from typing import Annotated, Any, Literal

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

import db

Task = Literal["chat", "analyze", "tree", "quiz"]


class CamelModel(BaseModel):
    # Unknown fields are rejected, so a client that tries to send e.g. `model` or `maxTokens`
    # gets a clear 422 instead of being silently ignored.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


# --- /session -----------------------------------------------------------------------------

class SessionRequest(CamelModel):
    participant_id: str | None = Field(default=None, min_length=1, max_length=64)
    condition: str | None = Field(default=None, min_length=1, max_length=64)


class SessionResponse(CamelModel):
    user_id: str
    token: str
    participant_id: str | None
    condition: str | None


# --- /ai/complete -------------------------------------------------------------------------

class ChatMessage(CamelModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class CompleteRequest(CamelModel):
    task: Task
    system: str
    messages: list[ChatMessage] = Field(min_length=1)
    # JSON schema for analyze/tree/quiz. Named output_schema in Python because `schema`
    # shadows a BaseModel attribute; on the wire it is `schema`.
    output_schema: dict[str, Any] | None = Field(default=None, alias="schema")
    stream: bool = False

    @model_validator(mode="after")
    def _check_task_rules(self) -> "CompleteRequest":
        if self.messages[-1].role != "user":
            raise ValueError("the last message must have role 'user'")
        if self.task == "chat" and self.output_schema is not None:
            raise ValueError("task 'chat' does not take a schema")
        if self.task != "chat" and self.output_schema is None:
            raise ValueError(f"task '{self.task}' needs a schema")
        if self.stream and self.task != "chat":
            raise ValueError("only task 'chat' can stream")
        return self

    def input_chars(self) -> int:
        return len(self.system) + sum(len(m.content) for m in self.messages)


class Usage(CamelModel):
    input_tokens: int
    output_tokens: int

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens


class CompleteResponse(CamelModel):
    output: Any  # text for chat, the parsed JSON value for analyze/tree/quiz
    usage: Usage
    model: str
    truncated: bool  # chat only: true when the answer hit max_tokens


# --- /events ------------------------------------------------------------------------------

class StudyEvent(CamelModel):
    id: str = Field(min_length=1, max_length=100)  # client-generated, globally unique (UUID)
    type: str = Field(min_length=1, max_length=100)
    payload: dict[str, Any]
    client_ts: AwareDatetime
    conversation_id: str | None = Field(default=None, max_length=100)


class EventsRequest(CamelModel):
    events: list[StudyEvent] = Field(min_length=1, max_length=200)


class EventsResponse(CamelModel):
    ok: bool
    stored: int


# --- /sync, /state, /conversations/:id/messages ----------------------------------------------
# The entities mirror frontend/src/lib/domain.ts. Fields marked `?` there are optional here
# (missing and null mean the same) and are left out of responses when empty; fields typed
# `X | null` there are required here and always present in responses.

# Limits of PUT /api/sync (docs/api.md, "Limits"). D1 itself allows 100 bound parameters per
# statement (we bind at most 14, one statement per row) and 2 MB per row (the limits below keep
# a row under 1 MB even with 4-byte characters).
MAX_SYNC_ROWS = 500  # rows per request, all lists together; more is a 413 too_many_rows
MAX_MESSAGE_TEXT = 200_000  # characters of a message's `text`
MAX_FIELD_CHARS = 20_000  # any other text field, and every JSON field serialized
MAX_ID_CHARS = 100


def _json_size(value: Any, what: str = "") -> Any:
    size = len(db.to_json(value))
    if size > MAX_FIELD_CHARS:
        raise ValueError(f"{what}serializes to {size} characters, at most {MAX_FIELD_CHARS} are allowed")
    return value


Id = Annotated[str, Field(min_length=1, max_length=MAX_ID_CHARS)]
Text = Annotated[str, Field(max_length=MAX_FIELD_CHARS)]
# Any ISO time with a zone; stored and returned as UTC text (`2026-11-16T09:00:00.000Z`), so
# times compare correctly as strings (last write wins on updatedAt).
Timestamp = Annotated[AwareDatetime, AfterValidator(db.iso)]
Score = Annotated[float, Field(ge=0, le=1)]  # ADR-2: 0..1 everywhere, never 0..100
JsonSized = AfterValidator(_json_size)
Mode = Literal["own", "together", "ai"]


class Concept(CamelModel):
    id: Id
    label: Text
    slug: Text
    aliases: Annotated[list[str], JsonSized]
    kind: Literal["subject", "topic", "concept"]
    parent_id: Id | None
    description: Text | None = None
    created_by: Literal["seed", "llm", "user"]
    created_at: Timestamp
    updated_at: Timestamp
    deleted_at: Timestamp | None = None


class ConceptEdge(CamelModel):
    id: Id
    from_id: Id
    to_id: Id
    kind: Literal["prerequisite", "related"]
    created_at: Timestamp


class KnowledgeTree(CamelModel):
    id: Id
    root_concept_id: Id
    title: Text
    grove_id: Id | None
    split_from: Id | None = None
    created_at: Timestamp
    updated_at: Timestamp
    deleted_at: Timestamp | None = None


class Conversation(CamelModel):
    id: Id
    title: Text
    subject_id: Id | None
    study_mode: bool
    continued_from: Id | None = None
    carry_summary: Text | None = None
    created_at: Timestamp
    updated_at: Timestamp


class Message(CamelModel):
    """Only the core is validated. The frontend's Message keeps growing (conceptIds, veiled, guess,
    provider, model, analysis, ...), so every other field is accepted as it is, stored in
    meta_json and returned flattened. `streaming` is a UI state and is dropped."""

    model_config = ConfigDict(extra="allow")

    id: Id
    conversation_id: Id
    role: Literal["user", "assistant"]
    text: str = Field(max_length=MAX_MESSAGE_TEXT)
    classification: Annotated[dict[str, Any], JsonSized] | None = None
    created_at: Timestamp

    @model_validator(mode="after")
    def _meta(self) -> "Message":
        self.__pydantic_extra__.pop("streaming", None)
        _json_size(self.__pydantic_extra__, "the message's other fields (meta) ")
        return self


class ConceptAttempt(CamelModel):
    id: Id
    conversation_id: Id
    message_id: Id
    concept_id: Id
    mode: Mode
    independence: Score
    correctness: Score | None
    confidence: Score
    reasons: Annotated[list[str], JsonSized]
    # Evidence spans ({start, end, mode, reason}) are kept as they come: the shape is the frontend's.
    evidence: Annotated[list[dict[str, Any]], JsonSized]
    source: Literal["prompt", "reveal", "quiz", "override"]
    superseded_by: Id | None = None
    created_at: Timestamp


class SyncRequest(CamelModel):
    concepts: list[Concept] = []
    edges: list[ConceptEdge] = []
    trees: list[KnowledgeTree] = []
    conversations: list[Conversation] = []
    messages: list[Message] = []
    attempts: list[ConceptAttempt] = []


class SyncResponse(CamelModel):
    ok: bool
    server_time: str


class StateResponse(CamelModel):
    concepts: list[Concept]
    edges: list[ConceptEdge]
    trees: list[KnowledgeTree]
    conversations: list[Conversation]
    attempts: list[ConceptAttempt]


class MessagesResponse(CamelModel):
    messages: list[Message]


# --- errors (for the OpenAPI docs) ---------------------------------------------------------

class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorBody
