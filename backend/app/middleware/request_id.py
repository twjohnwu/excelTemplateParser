"""Inject a uuid4 request_id into every request's structlog context."""

from __future__ import annotations

import uuid

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


class RequestIdMiddleware(BaseHTTPMiddleware):
    HEADER = "X-Request-ID"

    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get(self.HEADER) or str(uuid.uuid4())
        request.state.request_id = request_id
        # Bind for structlog so every log line inside this request carries it.
        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.unbind_contextvars("request_id")
        response.headers[self.HEADER] = request_id
        return response
