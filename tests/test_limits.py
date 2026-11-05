"""Tests for the request-body limit middleware (no web framework needed)."""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from limits import BodyLimitMiddleware  # noqa: E402


def rule(method, path):
    if path.startswith("/limited"):
        return 10, "too big"
    return None


async def echo_app(scope, receive, send):
    """Reads the whole body and reports how many bytes arrived."""
    total = 0
    while True:
        event = await receive()
        total += len(event.get("body", b""))
        if not event.get("more_body", False):
            break
    body = json.dumps({"received": total}).encode()
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": body})


def call(path, chunks, content_length=None, method="PUT"):
    async def run():
        app = BodyLimitMiddleware(echo_app, rule)
        headers = []
        if content_length is not None:
            headers.append((b"content-length", str(content_length).encode()))
        scope = {"type": "http", "method": method, "path": path, "headers": headers}
        pending = list(chunks)

        async def receive():
            if pending:
                body = pending.pop(0)
                return {"type": "http.request", "body": body, "more_body": bool(pending)}
            return {"type": "http.disconnect"}

        sent = []

        async def send(event):
            sent.append(event)

        await app(scope, receive, send)
        return sent[0]["status"], json.loads(sent[1]["body"])

    return asyncio.run(run())


def test_small_body_passes():
    assert call("/limited", [b"12345678"], content_length=8) == (200, {"received": 8})


def test_declared_length_over_the_limit_is_rejected_before_reading():
    assert call("/limited", [b"x" * 50], content_length=50) == (413, {"detail": "too big"})


def test_chunked_body_without_content_length_is_stopped_while_streaming():
    assert call("/limited", [b"x" * 6, b"x" * 6]) == (413, {"detail": "too big"})


def test_unlimited_paths_are_untouched():
    assert call("/other", [b"x" * 500], content_length=500) == (200, {"received": 500})


def test_non_http_scopes_pass_through():
    async def run():
        seen = []

        async def app(scope, receive, send):
            seen.append(scope["type"])

        await BodyLimitMiddleware(app, rule)({"type": "lifespan"}, None, None)
        return seen

    assert asyncio.run(run()) == ["lifespan"]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("All checks passed")
