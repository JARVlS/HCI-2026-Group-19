"""Request and response bodies. JSON field names are camelCase on the wire (ADR-2)."""

from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

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


# --- errors (for the OpenAPI docs) ---------------------------------------------------------

class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorBody
