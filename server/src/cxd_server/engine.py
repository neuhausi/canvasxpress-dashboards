"""Point every served HTML page at the configured CanvasXpress engine.

The app shell (``static/index.html``) gets its library tags injected at serve
time (see ``app._render_index``), but the other pages — the example boards,
``view.html``, ``shared.html``, the demo builder — load the engine from the
public CDN with a hardcoded ``<script>``. :class:`EngineMiddleware` rewrites
those tags in any ``text/html`` response so ``CXD_CANVASXPRESS_URL`` (and the
``CXD_CANVASXPRESS_LICENSE`` key, set as ``window.cX`` before the library)
applies to every page the server serves, e.g. to test a local engine build::

    CXD_CANVASXPRESS_URL=http://localhost:8080/dist

With the defaults (CDN, no license) the middleware is not installed at all.
"""

from __future__ import annotations

import html
import json
from typing import Optional

#: The public CDN base the static pages hardcode (and the default engine base).
DEFAULT_CANVASXPRESS_URL = "https://www.canvasxpress.org/dist"

_JS = "/canvasXpress.min.js"
_CSS = "/canvasXpress.css"


def engine_is_default(canvasxpress_url: str, canvasxpress_license: Optional[str]) -> bool:
    """True when the served pages need no rewriting (CDN engine, no license)."""
    return (canvasxpress_url.rstrip("/") == DEFAULT_CANVASXPRESS_URL
            and not canvasxpress_license)


def rewrite_engine_html(text: str, canvasxpress_url: str,
                        canvasxpress_license: Optional[str]) -> str:
    """Swap the CDN engine tags for the configured base and inject the license.

    Only the exact CDN ``canvasXpress.min.js`` / ``canvasXpress.css`` URLs are
    replaced; other canvasxpress.org links are left alone. The license
    (``window.cX``) is inserted just before the engine ``<script>`` — it must be
    set before the library loads — unless the page already sets it.

    :param text: The HTML page.
    :param canvasxpress_url: Engine base URL (no trailing file name).
    :param canvasxpress_license: License key, or None.
    :returns: The rewritten page (unchanged when it has no engine tag).
    """
    base = html.escape(canvasxpress_url.rstrip("/"), quote=True)
    text = text.replace(DEFAULT_CANVASXPRESS_URL + _JS, base + _JS)
    text = text.replace(DEFAULT_CANVASXPRESS_URL + _CSS, base + _CSS)
    if canvasxpress_license and "window.cX=" not in text:
        at = text.find(base + _JS)
        start = text.rfind("<script", 0, at) if at != -1 else -1
        if start != -1:
            # Escape "</" so the key can never close the inline script early.
            key = json.dumps(canvasxpress_license).replace("</", "<\\/")
            text = text[:start] + "<script>window.cX=%s;</script>\n  " % key + text[start:]
    return text


class EngineMiddleware:
    """ASGI middleware applying :func:`rewrite_engine_html` to HTML responses.

    Buffers only uncompressed ``200 text/html`` GET responses (pages are small);
    everything else streams through untouched. Validators (ETag/Last-Modified)
    are dropped from rewritten pages so a changed engine URL is never masked by
    a browser's 304 for the pre-rewrite file.
    """

    def __init__(self, app, canvasxpress_url: str, canvasxpress_license: Optional[str]):
        self.app = app
        self.canvasxpress_url = canvasxpress_url
        self.canvasxpress_license = canvasxpress_license

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "GET":
            await self.app(scope, receive, send)
            return

        state = {"start": None, "chunks": []}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = {k.lower(): v for k, v in message.get("headers", [])}
                is_html = headers.get(b"content-type", b"").startswith(b"text/html")
                if message.get("status") == 200 and is_html and b"content-encoding" not in headers:
                    state["start"] = message        # hold until the body is complete
                    return
                await send(message)
                return
            if message["type"] == "http.response.body" and state["start"] is not None:
                state["chunks"].append(message.get("body", b""))
                if message.get("more_body"):
                    return
                body = b"".join(state["chunks"])
                try:
                    body = rewrite_engine_html(body.decode("utf-8"), self.canvasxpress_url,
                                               self.canvasxpress_license).encode("utf-8")
                except UnicodeDecodeError:
                    pass                            # not UTF-8: pass through as-is
                drop = (b"content-length", b"etag", b"last-modified")
                start = dict(state["start"])
                start["headers"] = [(k, v) for k, v in start.get("headers", [])
                                    if k.lower() not in drop]
                start["headers"].append((b"content-length", str(len(body)).encode("latin-1")))
                await send(start)
                await send({"type": "http.response.body", "body": body})
                return
            await send(message)

        await self.app(scope, receive, send_wrapper)
