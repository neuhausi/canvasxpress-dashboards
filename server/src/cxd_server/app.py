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

from .datasets import DatasetStore, reshape_to_cx
from .sqldashboard import open_dashboard_store
from .store import DashboardStore
from .stores import StoreRegistry

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
    dataset_store: Optional[DatasetStore] = None,
    dataset_store_uri: Optional[str] = None,
    registry: Optional[StoreRegistry] = None,
    publish_base_url: Optional[str] = None,
    s3_client=None,
    drive_client_factory=None,
) -> FastAPI:
    """Build the dashboards FastAPI app.

    :param store: A DashboardStore; created from ``db_path`` if omitted.
    :param session_secret: Cookie-signing secret; falls back to ``SESSION_SECRET``.
    :param db_path: SQLite path; falls back to ``APP_DB_PATH`` or ``dashboards.db``.
    :param allow_signup: Enable ``/auth/signup``; falls back to ``ALLOW_SIGNUP`` (default on).
    :param https_only: Restrict the session cookie to HTTPS.
    :param serve_static: Mount the bundled viewer at ``/``.
    :param dataset_store: A single default DatasetStore (overrides the registry's
        default dataset store; kept for back-compat / tests).
    :param dataset_store_uri: Default dataset ObjectStore URI; falls back to
        ``CXD_DATASET_STORE`` (default local ``file://./cxd-datasets``).
    :param registry: A configured :class:`StoreRegistry`; built from env
        (``CXD_STORES`` / ``CXD_*_STORE``) if omitted.
    :param publish_base_url: Public base for share links; falls back to
        ``CXD_PUBLISH_BASE_URL`` (default: the request's own base URL).
    :param s3_client: Optional injected S3 client passed through to the registry.
    :param drive_client_factory: Optional ``owner -> DriveClient`` factory for
        ``gdrive://`` stores, passed through to the registry.
    :returns: The configured FastAPI application.
    """
    session_secret = session_secret or os.environ["SESSION_SECRET"]
    db_path = db_path or os.getenv("APP_DB_PATH", "dashboards.db")
    if allow_signup is None:
        allow_signup = os.getenv("ALLOW_SIGNUP", "1") == "1"
    # Dashboards: stdlib SQLite by default (zero-dep), or Postgres/SQLite via
    # SQLAlchemy when CXD_DASHBOARD_STORE names a postgres:// URL.
    store = store or open_dashboard_store(os.getenv("CXD_DASHBOARD_STORE"), db_path=db_path)
    if registry is None:
        registry = StoreRegistry.from_env(
            dataset_uri=dataset_store_uri, s3_client=s3_client,
            drive_client_factory=drive_client_factory,
        )
    publish_base_url = publish_base_url or os.getenv("CXD_PUBLISH_BASE_URL")

    def dataset_store_for(name: Optional[str]) -> DatasetStore:
        """Resolve the DatasetStore for a named dataset store (default when None)."""
        if dataset_store is not None and not name:
            return dataset_store
        resolved_name = name or registry.default_name("dataset")
        return DatasetStore(registry.resolve("dataset", resolved_name), store_name=resolved_name)

    def dataset_store_names() -> list:
        """All configured dataset store names (default first)."""
        return [s["name"] for s in registry.named("dataset")]

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
        summary["share_url"] = _share_url(request, summary["share_token"], publish_base_url)
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

    def resolve_dataset_store(name: Optional[str]) -> DatasetStore:
        """Resolve a (validated) named dataset store, 400/404 on a bad name."""
        if name and not registry.has("dataset", name):
            raise HTTPException(status_code=404, detail="No such dataset store '%s'" % name)
        try:
            return dataset_store_for(name)
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    # ---- stores (the picker sees names only; Phase 5.2) ----
    @app.get("/api/stores")
    def list_stores(request: Request, capability: Optional[str] = None):
        require_user(request)
        return {"stores": registry.named(capability)}

    # ---- datasets (owner-isolated; Phase 5.1/5.2) ----
    @app.get("/api/datasets")
    def list_datasets(request: Request):
        user = require_user(request)
        # Aggregate across every configured dataset store; each summary is tagged
        # with its store name so the client knows where to fetch it back from.
        datasets = []
        for name in dataset_store_names():
            datasets.extend(dataset_store_for(name).list(user))
        datasets.sort(key=lambda d: d.get("updated_at") or "", reverse=True)
        return {"datasets": datasets}

    @app.post("/api/datasets")
    async def create_dataset(request: Request):
        user = require_user(request)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object")
        fmt = body.get("format", "json")
        content = body.get("data")
        if content is None:
            raise HTTPException(status_code=400, detail="Body must include 'data'")
        target = resolve_dataset_store(body.get("store"))
        try:
            data = reshape_to_cx(fmt, content)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        summary = target.create(
            user, data, _now_iso(), title=body.get("title"), dataset_id=body.get("id")
        )
        summary["url"] = target.url_for(user, summary["id"])
        return {"dataset": summary}

    @app.get("/api/datasets/{dataset_id}")
    def get_dataset(request: Request, dataset_id: str, store: Optional[str] = None):
        user = require_user(request)
        data = resolve_dataset_store(store).get(user, dataset_id)
        if data is None:
            raise HTTPException(status_code=404, detail="No such dataset")
        return data

    @app.delete("/api/datasets/{dataset_id}")
    def delete_dataset(request: Request, dataset_id: str, store: Optional[str] = None):
        user = require_user(request)
        resolve_dataset_store(store).delete(user, dataset_id)
        datasets = []
        for name in dataset_store_names():
            datasets.extend(dataset_store_for(name).list(user))
        return {"datasets": datasets}

    if serve_static and os.path.isdir(_STATIC_DIR):
        app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="static")

    return app


def _has_body(request: Request) -> bool:
    """Best-effort check for a non-empty request body via Content-Length."""
    try:
        return int(request.headers.get("content-length", "0")) > 0
    except (TypeError, ValueError):
        return False


def _share_url(request: Request, token: Optional[str], publish_base_url: Optional[str] = None) -> Optional[str]:
    """Build an absolute share URL for a token.

    Uses ``publish_base_url`` (``CXD_PUBLISH_BASE_URL``) when configured so share
    links point at a stable public origin, else falls back to the request's own
    base URL.
    """
    if not token:
        return None
    base = (publish_base_url or str(request.base_url)).rstrip("/")
    return "%s/shared.html?token=%s" % (base, token)
