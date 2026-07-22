"""FastAPI factory for the dashboards persistence + sharing service.

    from cxd_server.app import create_dashboards_app
    app = create_dashboards_app()        # reads SESSION_SECRET from env
    # uvicorn yourmodule:app

Each user logs in and saves their own dashboard specs (isolated by the session
cookie), can publish a per-dashboard **share link** (public or auth-gated), and
export/import specs as JSON. This mirrors the ``canvasxpress-connectors`` app
factory so the two can run side by side (or be mounted together) behind one
origin, sharing the same auth model.

Data still flows through connectors at *render* time with the viewer's own
permissions — this service only stores and serves the spec.
"""

from __future__ import annotations

import datetime
import os
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from .store import DashboardStore

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def _now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def create_dashboards_app(
    store: Optional[DashboardStore] = None,
    session_secret: Optional[str] = None,
    db_path: Optional[str] = None,
    allow_signup: Optional[bool] = None,
    https_only: bool = False,
    serve_static: bool = True,
) -> FastAPI:
    """Build the dashboards FastAPI app.

    :param store: A DashboardStore; created from ``db_path`` if omitted.
    :param session_secret: Cookie-signing secret; falls back to ``SESSION_SECRET``.
    :param db_path: SQLite path; falls back to ``APP_DB_PATH`` or ``dashboards.db``.
    :param allow_signup: Enable ``/auth/signup``; falls back to ``ALLOW_SIGNUP`` (default on).
    :param https_only: Restrict the session cookie to HTTPS.
    :param serve_static: Mount the bundled viewer at ``/``.
    :returns: The configured FastAPI application.
    """
    session_secret = session_secret or os.environ["SESSION_SECRET"]
    db_path = db_path or os.getenv("APP_DB_PATH", "dashboards.db")
    if allow_signup is None:
        allow_signup = os.getenv("ALLOW_SIGNUP", "1") == "1"
    store = store or DashboardStore(db_path)

    app = FastAPI(title="canvasxpress-dashboards · persistence & sharing")
    app.add_middleware(
        SessionMiddleware, secret_key=session_secret, same_site="lax", https_only=https_only
    )

    def require_user(request: Request) -> str:
        user = request.session.get("user")
        if not user:
            raise HTTPException(status_code=401, detail="Not logged in")
        return user

    # ---- auth (mirrors canvasxpress-connectors) ----
    @app.post("/auth/signup")
    async def signup(request: Request):
        if not allow_signup:
            raise HTTPException(status_code=403, detail="Signup disabled")
        body = await request.json()
        username, password = body.get("username", ""), body.get("password", "")
        if len(username) < 3 or len(password) < 6:
            raise HTTPException(status_code=400, detail="Username ≥3 and password ≥6 chars")
        if not store.create_user(username, password):
            raise HTTPException(status_code=409, detail="Username already taken")
        request.session["user"] = username
        return {"user": username}

    @app.post("/auth/login")
    async def login(request: Request):
        body = await request.json()
        username, password = body.get("username", ""), body.get("password", "")
        if not store.check_user(username, password):
            raise HTTPException(status_code=401, detail="Invalid username or password")
        request.session["user"] = username
        return {"user": username}

    @app.post("/auth/logout")
    async def logout(request: Request):
        request.session.clear()
        return {"user": None}

    @app.get("/auth/me")
    def me(request: Request):
        return {"user": request.session.get("user")}

    # ---- dashboard CRUD (owner-isolated) ----
    @app.get("/api/dashboards")
    def list_dashboards(request: Request):
        return {"dashboards": store.list_dashboards(require_user(request))}

    @app.post("/api/dashboards")
    async def save_dashboard(request: Request):
        user = require_user(request)
        spec = await request.json()
        if not isinstance(spec, dict) or not spec.get("id"):
            raise HTTPException(status_code=400, detail="Body must be a dashboard spec with an id")
        return {"dashboard": store.save_dashboard(user, spec, _now_iso())}

    @app.get("/api/dashboards/{dashboard_id}")
    def get_dashboard(request: Request, dashboard_id: str):
        user = require_user(request)
        spec = store.get_dashboard(user, dashboard_id)
        if spec is None:
            raise HTTPException(status_code=404, detail="No such dashboard")
        return spec

    @app.delete("/api/dashboards/{dashboard_id}")
    def delete_dashboard(request: Request, dashboard_id: str):
        user = require_user(request)
        store.delete_dashboard(user, dashboard_id)
        return {"dashboards": store.list_dashboards(user)}

    # ---- sharing ----
    @app.post("/api/dashboards/{dashboard_id}/share")
    async def share_dashboard(request: Request, dashboard_id: str):
        user = require_user(request)
        body = await request.json() if _has_body(request) else {}
        visibility = (body or {}).get("visibility", "public")
        try:
            summary = store.set_visibility(user, dashboard_id, visibility)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if summary is None:
            raise HTTPException(status_code=404, detail="No such dashboard")
        summary["share_url"] = _share_url(request, summary["share_token"])
        return {"dashboard": summary}

    @app.get("/api/shared/{token}")
    def get_shared(request: Request, token: str):
        shared = store.get_shared(token)
        if not shared:
            raise HTTPException(status_code=404, detail="Share link not found")
        # auth-gated shares require *any* logged-in viewer; public shares are open.
        if shared["visibility"] == "auth" and not request.session.get("user"):
            raise HTTPException(status_code=401, detail="Login required to view this dashboard")
        return {"spec": shared["spec"], "readOnly": True, "owner": shared["owner"]}

    if serve_static and os.path.isdir(_STATIC_DIR):
        app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="static")

    return app


def _has_body(request: Request) -> bool:
    """Best-effort check for a non-empty request body via Content-Length."""
    try:
        return int(request.headers.get("content-length", "0")) > 0
    except (TypeError, ValueError):
        return False


def _share_url(request: Request, token: Optional[str]) -> Optional[str]:
    """Build an absolute share URL for a token, from the request base URL."""
    if not token:
        return None
    base = str(request.base_url).rstrip("/")
    return "%s/shared.html?token=%s" % (base, token)
