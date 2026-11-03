"""Range headers for the existing DTO-backed access-log response."""

from litestar.datastructures import MutableScopeHeaders
from litestar.enums import ScopeType
from litestar.middleware import ASGIMiddleware
from litestar.types import ASGIApp, Message, Receive, Scope, Send

RANGE_HEADERS_STATE_KEY = "access_log_range_headers"


class AccessLogRangeHeaders(ASGIMiddleware):
    """Attach the resolved range headers after DTO serialization."""

    scopes = (ScopeType.HTTP,)

    async def handle(self, scope: Scope, receive: Receive, send: Send, next_app: ASGIApp) -> None:
        async def send_response(message: Message) -> None:
            if message["type"] == "http.response.start" and 200 <= message["status"] < 300:
                headers = MutableScopeHeaders.from_message(message)
                for name, value in scope.get("state", {}).get(RANGE_HEADERS_STATE_KEY, {}).items():
                    headers[name] = value
            await send(message)

        await next_app(scope, receive, send_response)
