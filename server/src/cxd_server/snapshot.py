"""PNG snapshots of a dashboard, rendered as a given user, for email subscriptions.

A headless Chromium (Playwright, an optional dependency: ``pip install playwright``
then ``playwright install chromium``) opens the server with a short-lived
session for the recipient. It renders the dashboard with the real CanvasXpress
engine and screenshots it. Because it renders *as the recipient*, every dataset
it reads passes through the same access checks and row/column security as
their own browser would.

Settings: ``CXD_INTERNAL_URL`` is how the server reaches itself (default
``http://127.0.0.1:<CXD_PORT or 8000>``), and ``CXD_SNAPSHOTS=off`` disables snapshots.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any, Dict, Optional

_ASSET_HOST = "https://cxd-snapshot.invalid"


class SnapshotUnavailable(RuntimeError):
    """Snapshots are off, or Playwright/Chromium is not installed."""


def session_cookie(session_secret: str, session: Dict[str, Any]) -> str:
    """The value Starlette's SessionMiddleware would set for ``session``."""
    import itsdangerous
    data = base64.b64encode(json.dumps(session).encode("utf-8"))
    return itsdangerous.TimestampSigner(str(session_secret)).sign(data).decode("utf-8")


class SnapshotRenderer:
    """Renders dashboards to PNG as a user (see module doc)."""

    def __init__(self, internal_url: str, session_secret: str, canvasxpress_url: str,
                 canvasxpress_license: Optional[str] = None, umd_path: Optional[str] = None,
                 cookie_name: str = "cxd_session", enabled: bool = True,
                 width: int = 1280, timeout_ms: int = 60000):
        self.internal_url = internal_url.rstrip("/")
        self.session_secret = session_secret
        self.canvasxpress_url = canvasxpress_url.rstrip("/")
        self.license = canvasxpress_license
        self.umd_path = umd_path or os.path.join(os.path.dirname(__file__), "static",
                                                 "canvasxpress-dashboards.umd.js")
        self.cookie_name = cookie_name
        self.enabled = enabled
        self.width = width
        self.timeout_ms = timeout_ms
        self._available: Optional[bool] = None

    def available(self) -> bool:
        """True when snapshots are on and Playwright can be imported."""
        if not self.enabled:
            return False
        if self._available is None:
            try:
                import playwright.sync_api  # noqa: F401
                self._available = os.path.isfile(self.umd_path)
            except ImportError:
                self._available = False
        return self._available

    def page_html(self, spec: Dict[str, Any]) -> str:
        spec_json = json.dumps(spec).replace("</", "<\\/")
        license_js = ("<script>window.cX = %s;</script>" % json.dumps(self.license)
                      if self.license else "")
        return (
            "<!doctype html><html><head><meta charset='utf-8'>" + license_js +
            "<link rel='stylesheet' href='%s/canvasXpress.css'>" % self.canvasxpress_url +
            "<script src='%s/canvasXpress.min.js'></script>" % self.canvasxpress_url +
            "<script src='%s/canvasxpress-dashboards.umd.js'></script>" % _ASSET_HOST +
            "<style>body{margin:0;background:#fff;font-family:system-ui,sans-serif}"
            "#cxd-title{font-size:20px;font-weight:600;padding:16px 16px 0}"
            "#dash{padding:12px}</style></head>"
            "<body style='width:%dpx'><div id='cxd-shot'><div id='cxd-title'></div>" % self.width +
            "<div id='dash'></div></div><script>"
            "var spec = " + spec_json + ";"
            "document.getElementById('cxd-title').textContent = spec.title || spec.id;"
            "CanvasXpressDashboards.renderDashboard(spec, 'dash', {baseUrl: %s})" % json.dumps(
                self.internal_url) +
            ".then(function (h) { return h.ready; })"
            ".then(function () { setTimeout(function () { window.cxdDone = true; }, 1500); },"
            " function (e) { window.cxdError = String(e && e.message || e);"
            " window.cxdDone = true; });"
            "</script></body></html>")

    def render(self, spec: Dict[str, Any], username: str) -> bytes:
        """Render ``spec`` as ``username`` and return PNG bytes.

        :raises SnapshotUnavailable: When snapshots are off or not installed.
        :raises RuntimeError: When the page fails to render.
        """
        if not self.available():
            raise SnapshotUnavailable("Snapshots need Playwright with Chromium on the server")
        from playwright.sync_api import sync_playwright

        with open(self.umd_path, "rb") as fh:
            umd = fh.read()
        cookie = session_cookie(self.session_secret, {"user": username})
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            try:
                context = browser.new_context(viewport={"width": self.width, "height": 900})
                context.add_cookies([{"name": self.cookie_name, "value": cookie,
                                      "url": self.internal_url}])
                page = context.new_page()
                page.route(_ASSET_HOST + "/**", lambda route: route.fulfill(
                    status=200, body=umd, content_type="text/javascript"))
                # Load a same-origin page first so the dashboard's API calls carry
                # the recipient's session cookie.
                page.goto(self.internal_url + "/auth/me", timeout=self.timeout_ms)
                page.set_content(self.page_html(spec), timeout=self.timeout_ms)
                page.wait_for_function("window.cxdDone === true", timeout=self.timeout_ms)
                error = page.evaluate("window.cxdError || null")
                if error:
                    raise RuntimeError("The dashboard did not render: %s" % error)
                return page.locator("#cxd-shot").screenshot(type="png")
            finally:
                browser.close()
