"""The HTTP call to the model API, through the Workers `fetch`.

Routes get an `Upstream` from the `get_upstream` dependency; tests override that dependency with
a fake, so this is the only module (besides main.py) that touches the Workers runtime.
"""

from collections.abc import AsyncIterator
from typing import Any, Protocol

from errors import ApiError


class UpstreamResponse(Protocol):
    status: int

    async def text(self) -> str: ...

    def iter_bytes(self) -> AsyncIterator[bytes]: ...


class Upstream(Protocol):
    async def post(self, url: str, headers: dict[str, str], body: str) -> UpstreamResponse: ...


class _WorkersResponse:
    def __init__(self, response: Any) -> None:
        self._response = response
        self.status: int = response.status

    async def text(self) -> str:
        return await self._response.text()

    async def iter_bytes(self) -> AsyncIterator[bytes]:
        # Read the JS ReadableStream directly so chunks are relayed as they arrive.
        async for chunk in self._response.js_response.body:
            yield chunk.to_bytes()


class WorkersUpstream:
    async def post(self, url: str, headers: dict[str, str], body: str) -> UpstreamResponse:
        from workers import fetch  # only exists inside the Workers runtime

        try:
            response = await fetch(url, method="POST", headers=headers, body=body)
        except Exception as exc:  # network failure; the message never contains the headers
            raise ApiError(502, "upstream_error", f"Could not reach the model API ({exc}).") from exc
        return _WorkersResponse(response)


def get_upstream() -> Upstream:
    return WorkersUpstream()
