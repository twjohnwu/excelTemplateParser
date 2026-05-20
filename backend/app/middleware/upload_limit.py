"""Reject requests whose Content-Length exceeds the configured upload cap.

Multipart uploads carry total size in Content-Length; for streamed bodies
without that header we let it pass and rely on per-file `read()` in the
handler. Per-file limits could be enforced inside the route too if needed.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response


class UploadSizeLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, max_bytes: int) -> None:
        super().__init__(app)
        self.max_bytes = max_bytes

    async def dispatch(self, request: Request, call_next) -> Response:
        cl = request.headers.get("content-length")
        if cl is not None:
            try:
                if int(cl) > self.max_bytes:
                    return JSONResponse(
                        status_code=413,
                        content={
                            "error": f"上傳大小超過上限（{self.max_bytes // (1024 * 1024)} MB）",
                            "code": "PayloadTooLarge",
                        },
                    )
            except ValueError:
                pass
        return await call_next(request)
