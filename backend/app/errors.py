"""Global FastAPI exception handlers.

CoreError → 422 with structured `{error, code, request_id}`.
Any other unhandled Exception → 500 with `{error, request_id}` only; the
full traceback is logged under that request_id for support lookups.
"""

from __future__ import annotations

import structlog
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .core.exceptions import CoreError

log = structlog.get_logger(__name__)


def install(app: FastAPI) -> None:
    @app.exception_handler(CoreError)
    async def _core(request: Request, exc: CoreError):
        rid = getattr(request.state, "request_id", "")
        log.warning(
            "core_error",
            code=type(exc).__name__,
            user_message=exc.user_message,
            tech_detail=exc.tech_detail,
            **exc.context,
        )
        return JSONResponse(
            status_code=422,
            content={
                "error": exc.user_message,
                "code": type(exc).__name__,
                "request_id": rid,
            },
        )

    @app.exception_handler(Exception)
    async def _fallback(request: Request, exc: Exception):
        rid = getattr(request.state, "request_id", "")
        log.exception("unhandled_exception", error_class=type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content={
                "error": "Internal error",
                "request_id": rid,
            },
        )
