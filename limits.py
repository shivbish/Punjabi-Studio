"""Request-body size limits as a small ASGI middleware (no framework imports).

Checking the Content-Length header is not enough: a client can stream a body
with chunked transfer encoding and no length at all. This middleware also counts
the bytes as they arrive and stops reading as soon as the limit is passed.
"""
import json
from typing import Callable, Optional


class _BodyTooLarge(Exception):
    pass


async def _send_413(send, message: str) -> None:
    body = json.dumps({"detail": message}).encode("utf-8")
    await send({
        "type": "http.response.start",
        "status": 413,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode("ascii")),
        ],
    })
    await send({"type": "http.response.body", "body": body})


class BodyLimitMiddleware:
    """``limit_for(method, path)`` returns ``(max_bytes, message)`` or None for no limit."""

    def __init__(self, app, limit_for: Callable[[str, str], Optional[tuple[int, str]]]):
        self.app = app
        self.limit_for = limit_for

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        rule = self.limit_for(scope["method"], scope["path"])
        if rule is None:
            return await self.app(scope, receive, send)
        limit, message = rule

        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            return await _send_413(send, message)

        received = 0
        response_started = False

        async def counting_receive():
            nonlocal received
            event = await receive()
            if event["type"] == "http.request":
                received += len(event.get("body", b""))
                if received > limit:
                    raise _BodyTooLarge
            return event

        async def tracking_send(event):
            nonlocal response_started
            if event["type"] == "http.response.start":
                response_started = True
            await send(event)

        try:
            await self.app(scope, counting_receive, tracking_send)
        except _BodyTooLarge:
            if response_started:
                raise
            await _send_413(send, message)
