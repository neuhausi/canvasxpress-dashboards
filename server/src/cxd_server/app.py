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
import hashlib
import html
import json
import os
import re
import secrets
import time
import warnings
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.middleware.sessions import SessionMiddleware

from . import mcp_bridge
from .datasets import DatasetStore, reshape_to_cx, filter_cx_data
from .audit import (AuditLog, NullAuditLog, SqlAuditLog, SqliteAuditLog, action_for, iter_actions,
                    open_audit_log, target_from)
from .functions import FunctionError, FunctionsConfig, functions_status, run_function
from .sqldashboard import open_dashboard_store
from .store import DashboardStore
from .stores import StoreRegistry
from .validate_spec import validate_bindings, validate_spec

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# ---- natural-language dashboard builder (POST /api/llm/dashboard) ----------
# The LLM's only job is authoring the declarative spec — it never touches the
# numbers. Datasets are appended per-request after this stable, cacheable text.
_LLM_SYSTEM = """You author dashboard specs for canvasxpress-dashboards.

Respond ONLY with a JSON object: {"reply": "<one or two sentences for the user>",
"spec": <a COMPLETE dashboard spec object, or null if no dashboard change is
needed (e.g. the user asked a question)>}. When revising, return the full
updated spec, preserving ids and anything the user didn't ask to change.

## Dashboard spec contract
{
  "schemaVersion": "1.1", "id": "<kebab-case>", "title": "<Title>", "version": 1,
  "layout": {"cols": 12, "rowHeight": 130, "gap": 12,
             "items": [{"panel": "<panel-id>", "x": 0-11, "y": 0+, "w": 1-12, "h": 1+}]},
  "data": {"<ref>": {"kind": "dataset", "id": "<dataset id>", "store": "<store>"}
           /* or {"kind": "inline", "value": {y:{vars,smps,data}, x?, z?}}
              or {"kind": "connector", "url": "...", "refresh"?: seconds,
                  "ttl"?: <ms cache lifetime, 0 = none>,
                  "headers"?: {"<header>": "<value>"},
                  "dependsOn"?: ["<param>", ...]  // params beyond those in query
                                                  // that should re-trigger a fetch
                 }
              or {"kind": "join", "left": "<ref>", "right": "<ref>",
                  "on"?: "smps" | "<column>" | {"left": "<col>", "right": "<col>"} | [...],
                  "how"?: "inner|left|right|outer", "suffix"?: "<str>"}
              or {"kind": "function", "language": "python|r", "code": "<assigns result>",
                  "inputs": ["<ref>", ...] | {"<var>": "<ref>"},
                  "args"?: {"<name>": "$param" | literal}}
              any source may add "axis": "smps" (default, one row per sample)
              | "vars" (one row per variable: scatter-oriented data) */},
  "relationships"?: [{"left": "<ref>", "right": "<ref>",
                      "on"?: <same forms as a join's on>}],
  "markingMode"?: "focus|highlight|ghost",
  "filterSchemes"?: {"<name>": [{"dataRef": "<ref>", "field": "<field>",
                     "values"?: [...] | "min"?: n, "max"?: n | "text"?: "..."}]},
  "panels": {"<panel-id>": {"title": "<Panel title>", "dataRef": "<ref>",
             "measures"?: ["<var>", ...],
             "transpose"?: true|false,  /* scatter/KaplanMeier of a table with one
               point per row: automatic when xAxis/yAxis name table columns */
             "config": { /* passed straight to new CanvasXpress() */ }}},
  "controls": [{"kind": "table", "dataRef": "<ref>", "title"?: "..."}],
  "params": {"<param-name>": {"value": "<default>", "type": "string|number|boolean"}},
  "theme"?: "light|dark|auto",   /* dashboard-level theme; default "auto" */
  "broadcastGroup"?: "<name>",   /* coordination domain; defaults to spec.id */
  "width"?: <px or CSS length>,  /* unset = fill parent */
  "height"?: <px or CSS length>, /* unset = content height */
  "maxWidth"?: <px or CSS length>, /* cap on wide screens; dashboard centres */
  "background"?: "<CSS color>",
  "backgroundImage"?: "<url or data: URI>",
  "canvasInset"?: <px>           /* margin left around each panel's graph */
}

## Panel variants
A panel's "type" is absent for a GRAPH panel, or one of "text", "control", "image":
- text  — {"type":"text","text":"<markdown/plain text>","align"?:"left|center|right","valign"?:"top|middle|bottom"}
- image — {"type":"image","src":"<url or data: URI>","alt"?:"...","fit"?:"contain|cover|fill|none|scale-down","href"?:"<link>"}
Text and image panels need NO dataRef and no data. Use them for titles, notes,
logos and banners — never refuse such a request.
- filters — {"type":"filters","dataRef":"<ref>",
             "fields"?:["<field>", {"field":"<f>","dataRef":"<ref>","kind":"values|range|search"}]}
  A Filters panel (like Spotfire's): checkbox lists for categories, min/max for
  numbers, search for many values; omit "fields" to list every annotation and
  numeric column. It filters its source and, via relationships/joins, related
  sources. Use it when the user asks for "a filter panel" or to filter by
  several fields; "filterSchemes" pre-defines named filter states.

## Cross-filtering by clicking a chart
A GRAPH panel can turn a click into a dashboard parameter:
  {"dataRef":"<ref>","clickParam":"<name in spec.params>","clickField"?:"<annotation>","config":{...}}
clickParam MUST name an entry in spec.params (declare it there); clickField
picks which annotation of the clicked mark supplies the value, defaulting to the
clicked sample name. Use this when the user asks that clicking one chart filter
or drive the others.

## Interactive controls (dropdowns, sliders, radios, buttons)
Controls are PANELS with "type": "control" — place them in layout.items like any
other panel. They are how the user gets dropdowns/sliders; the top-level
"controls" array above is only the filter/table widgets. Three modes:

- mode "filter" — filter the panels that share a dataRef by an annotation:
  {"type":"control","mode":"filter","dataRef":"<ref>","compartment":"x","annotation":"<annotation name>","style":"dropdown"}
  compartment "x" filters samples (rows) by an x annotation, "z" filters variables.
- mode "param" — set a declared parameter, e.g. to drive a connector query:
  {"type":"control","mode":"param","param":"<name in spec.params>","options":["A","B"],"style":"dropdown"}
  Every referenced param MUST be declared in spec.params. Instead of a literal
  options list you may use "optionsFrom": {"dataRef":"<ref>", ...}, or
  "style":"search" for free text.
- mode "config" — swap config fragments on a target panel:
  {"type":"control","mode":"config","target":"<panel-id>","style":"slider",
   "options":[{"label":"Bar","value":"bar","config":{"graphType":"Bar"}}, ...]}
  Requires a target panel id and a NON-EMPTY options array; each option needs a
  config fragment.

style: "auto"|"dropdown"|"radio"|"buttons"|"search"|"slider" (default "auto").
Extra control keys: "disabled": true renders it read-only; for style "search",
"placeholder" sets the box's hint text and "debounce" the ms to wait after the
last keystroke before applying (default 250).
Control panels need no dataRef when mode is "config", or when mode is "param"
with options/optionsFrom/style:"search".

## Rules
- Bind to the user's datasets (listed below) with kind "dataset" + their exact
  id and store. Only use "inline" for tiny data the user dictated in chat.
- config.graphType: Bar, Line, Area, Pie, Scatter2D, Scatter3D, Boxplot,
  Heatmap, Dotplot, Treemap, Sankey, KaplanMeier, etc. Common config keys:
  colorBy/groupingFactors (categorical annotation names), title:false (the
  panel chrome shows the title), showLegend, xAxis/yAxis (variable names),
  smpOverlays/varOverlays. For KaplanMeier: xAxis:["<time var>"],
  yAxis:["<event var>"], colorBy:"<group annotation>".
- Scatter2D / Scatter3D / KaplanMeier axes must be NUMERIC columns — never a
  category annotation. A category against a number is a Boxplot or Dotplot
  (groupingFactors: ["<category>"]), not a scatter.
- Datasets are tables: y.vars are columns/variables, y.smps are rows/samples;
  x holds per-smp annotations, z per-var annotations. measures picks numeric
  vars to plot. Categorical columns work as colorBy.
- Layout on a 12-column grid; typical panel is w:6 h:3; don't overlap items.
- Panels sharing a dataRef coordinate selections automatically (broadcast).
- To combine two datasets (e.g. samples + clinical annotations), declare both
  as sources and add a "join" source over them; bind panels to the join ref.
  "on" defaults to "smps" (the row/sample ids); name a shared column, or map
  {"left","right"} columns, when the ids differ. "how" defaults to "inner"; use
  "left" to keep every row of the primary table. Clashing right-hand column
  names get "suffix" (default ".<right ref>").
- A "function" source runs an R or Python snippet on the server (only when the
  "Data functions" note after the dataset list says AVAILABLE). Inputs are
  DataFrames / data.frames named after "inputs"; the code must assign `result`
  (a table: its first column or index/row names become row ids, numeric columns
  become variables). Use it for statistics or reshaping the other features
  can't express (models, custom scores, grouped summaries). Name the output
  columns explicitly in the code, and chart exactly those names: a grouped
  summary's group column becomes the row ids (not an annotation), so don't
  colour or group by it. "args" reach the code ONLY through the `params`
  mapping — Python params["name"], R params$name — never as bare variables.
- Totals per category (e.g. a pie or bar of revenue BY region) need the rows
  aggregated first: when data functions are AVAILABLE use a function source
  that sums per category; otherwise chart the rows as they are.
- To LINK sources without blending them (selecting rows in one chart marks the
  related rows in charts of another source, and a filter control on one source
  filters related panels), add a "relationships" entry with the same "left",
  "right", "on" as a join. Joins link their inputs automatically. Data whose
  rows are variables (scatter data: points are y.vars) needs "axis": "vars" on
  its source; then "vars" is its row-id key.
- 2-6 panels unless asked otherwise; add a table control when it helps.
- When the user asks to filter, choose, or switch something interactively,
  add a control PANEL (see Interactive controls) — never say controls are
  unsupported. Declare any param it needs in spec.params.
- Dashboard-wide look ("dark theme") is the TOP-LEVEL "theme" key, not a
  per-panel config.theme. To coordinate selections across panels set the
  top-level "broadcastGroup" (panels sharing a dataRef already coordinate).
"""

# How many times the model may be handed its own spec-validation errors and
# asked to fix them before we give up and report the errors instead.
_SPEC_REPAIR_ROUNDS = 2


# USD per million tokens for the orchestrator model; override per deployment.
# A cached read bills at a fraction of the input rate.
_PRICES = {
    "claude-opus-5": (5.0, 25.0), "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0), "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}
_CACHE_READ_RATIO = float(os.environ.get("CXD_CACHE_READ_RATIO", "0.1"))
_CACHE_WRITE_RATIO = float(os.environ.get("CXD_CACHE_WRITE_RATIO", "1.25"))


def _model_rates(model):
    """(input, output) USD per million tokens for `model`; (0,0) if unpriced."""
    pin, pout = _PRICES.get(model, (0.0, 0.0))
    try:
        pin = float(os.environ.get("CXD_PRICE_INPUT", pin))
        pout = float(os.environ.get("CXD_PRICE_OUTPUT", pout))
    except ValueError:
        pass
    return pin, pout


def _usage_cost(usage, model):
    """Estimated USD for one orchestrator call."""
    pin, pout = _model_rates(model)
    if not pin and not pout:
        return 0.0
    get = lambda k: getattr(usage, k, 0) or 0  # noqa: E731 - terse accessor
    return (get("input_tokens") * pin
            + get("output_tokens") * pout
            + get("cache_read_input_tokens") * pin * _CACHE_READ_RATIO
            + get("cache_creation_input_tokens") * pin * _CACHE_WRITE_RATIO) / 1e6


def _log_usage(response, model=None, tally=None):
    """Print token usage for one model call, including cache effectiveness.

    ``cache_read_input_tokens`` staying at 0 across repeated requests is the
    signal that something is silently invalidating the prefix — the only
    reliable way to tell whether the system-prompt split is actually working.

    When `tally` is given, the call's tokens and cost are accumulated into it so
    the whole dashboard request can be costed as one number.
    """
    try:
        usage = response.usage
        cost = _usage_cost(usage, model) if model else 0.0
        print("[llm] tokens in=%s out=%s cache_write=%s cache_read=%s cost=$%.5f" % (
            getattr(usage, "input_tokens", "?"),
            getattr(usage, "output_tokens", "?"),
            getattr(usage, "cache_creation_input_tokens", 0),
            getattr(usage, "cache_read_input_tokens", 0), cost), flush=True)
        if tally is not None:
            tally["calls"] += 1
            tally["cost_usd"] += cost
    except Exception:  # noqa: BLE001 - telemetry must never break a request
        pass

_LLM_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "spec": {"type": ["object", "null"]},
    },
    "required": ["reply", "spec"],
    "additionalProperties": False,
}


def note(request: Request, **fields) -> None:
    """Attach details to the request's audit event (``None`` values are skipped).

    ``target`` / ``owner`` override the event's target and owner; every other
    field goes into ``detail``. Safe to call when no audit middleware runs.
    """
    info = getattr(request.state, "audit", None)
    if info is None:
        info = {}
        request.state.audit = info
    for key, value in fields.items():
        if value is not None:
            info[key] = value


def _record_request(audit, request: Request, actor_before, status: int) -> None:
    """Record one finished request in the audit log, if its route is audited.

    The actor is whoever is signed in after the handler (a sign-in) or before it
    (a sign-out). A failure to write is reported on stderr, never raised: the
    audit log must not take the app down.
    """
    route = request.scope.get("route")
    action = action_for(request.method, getattr(route, "path", None))
    if not action or not audit.enabled:
        return
    info = dict(getattr(request.state, "audit", None) or {})
    session = request.scope.get("session") or {}
    actor = session.get("user") or actor_before
    target = info.pop("target", None) or target_from(request.scope.get("path_params") or {})
    owner = info.pop("owner", None)
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        info["forwarded_for"] = forwarded[:200]
    try:
        audit.record(action, actor=actor, target=target, owner=owner, status=status,
                     ip=request.client.host if request.client else None, detail=info or None)
    except Exception as exc:  # noqa: BLE001 - never fail the request over the log
        print("[audit] FAILED to record %s by %s: %s" % (action, actor, exc), flush=True)


def _default_audit_log(store, db_path: Optional[str]):
    """Build the audit log next to the dashboard store (see ``cxd_server.audit``)."""
    mode = os.getenv("CXD_AUDIT", "on")
    try:
        retention = int(os.getenv("CXD_AUDIT_RETENTION_DAYS", "") or 0) or None
    except ValueError:
        retention = None
    if mode.strip().lower() in ("off", "0", "false", "no"):
        return NullAuditLog()
    if getattr(store, "_engine", None) is not None:        # SQL dashboard store
        return SqlAuditLog(None, retention, engine=store._engine)
    if getattr(store, "db_path", None):                    # stdlib SQLite store
        return SqliteAuditLog(store.db_path, retention)
    return open_audit_log(os.getenv("CXD_DASHBOARD_STORE"), db_path, mode, retention)


def _now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def create_dashboards_app(
    store: Optional[DashboardStore] = None,
    session_secret: Optional[str] = None,
    db_path: Optional[str] = None,
    allow_signup: Optional[bool] = None,
    https_only: Optional[bool] = None,
    admins: Optional[set] = None,
    examples_owner: Optional[str] = None,
    serve_static: bool = True,
    dataset_store: Optional[DatasetStore] = None,
    dataset_store_uri: Optional[str] = None,
    registry: Optional[StoreRegistry] = None,
    publish_base_url: Optional[str] = None,
    s3_client=None,
    drive_client_factory=None,
    canvasxpress_url: Optional[str] = None,
    canvasxpress_license: Optional[str] = None,
    llm_api_key: Optional[str] = None,
    llm_model: Optional[str] = None,
    functions: Optional[FunctionsConfig] = None,
    audit: Optional[AuditLog] = None,
) -> FastAPI:
    """Build the dashboards FastAPI app.

    :param store: A DashboardStore; created from ``db_path`` if omitted.
    :param session_secret: Cookie-signing secret; falls back to ``SESSION_SECRET``.
    :param db_path: SQLite path; falls back to ``APP_DB_PATH`` or ``dashboards.db``.
    :param allow_signup: Enable ``/auth/signup``; falls back to ``ALLOW_SIGNUP`` (default on).
    :param https_only: Restrict the session cookie to HTTPS; falls back to
        ``CXD_HTTPS_ONLY`` (default off).
    :param admins: Usernames granted the user-management API; falls back to the
        comma-separated ``CXD_ADMINS`` env var (default none).
    :param examples_owner: Username whose datasets/dashboards are the shared,
        read-only "examples" merged into every user's lists; falls back to
        ``CXD_EXAMPLES_OWNER`` (default ``"app"``). Only an admin may edit/delete
        them; set to empty/None to disable the read-merge.
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
    :param canvasxpress_url: Base URL of the CanvasXpress library (loads
        ``<base>/canvasXpress.css`` + ``<base>/canvasXpress.min.js`` into the
        served app); falls back to ``CXD_CANVASXPRESS_URL`` (default the CDN).
    :param canvasxpress_license: CanvasXpress license key injected as
        ``window.cX`` before the library loads (hides the watermark); falls back
        to ``CXD_CANVASXPRESS_LICENSE``.
    :param llm_api_key: Secret API key for the (future) natural-language dashboard
        builder; falls back to ``CXD_LLM_API_KEY``. Kept server-side — never sent
        to the browser (the client only learns whether an LLM is configured).
    :param llm_model: LLM model id; falls back to ``CXD_LLM_MODEL``.
    :param functions: Data-function runtime settings; built from the
        ``CXD_FUNCTIONS*`` env vars if omitted (``CXD_FUNCTIONS`` defaults to
        ``off``; ``admin`` or ``users`` enables ``POST /api/functions/run``).
    :param audit: The audit log; built next to the dashboard store if omitted
        (the same SQLite file or SQL database). ``CXD_AUDIT=off`` disables it and
        ``CXD_AUDIT_RETENTION_DAYS`` prunes old events (default: keep all).
    :returns: The configured FastAPI application.
    """
    session_secret = session_secret or os.getenv("SESSION_SECRET")
    if not session_secret:
        # Never hard-crash on first run: fall back to an ephemeral secret so the
        # app boots, but warn loudly — sessions won't survive a restart until a
        # stable SESSION_SECRET is provided (the `python -m cxd_server` launcher
        # generates and persists one for you).
        session_secret = secrets.token_urlsafe(32)
        warnings.warn(
            "SESSION_SECRET is not set — using a random ephemeral secret. Logins "
            "will be lost on restart. Set SESSION_SECRET (or start via "
            "`python -m cxd_server`, which persists one).",
            RuntimeWarning,
            stacklevel=2,
        )
    db_path = db_path or os.getenv("APP_DB_PATH", "dashboards.db")
    if allow_signup is None:
        allow_signup = os.getenv("ALLOW_SIGNUP", "1") == "1"
    if https_only is None:
        https_only = os.getenv("CXD_HTTPS_ONLY", "0") == "1"
    # Admins (comma-separated usernames) get the user-management API. Config-only
    # so it needs no schema change and is identical across store backends.
    if admins is None:
        admins = {u.strip() for u in os.getenv("CXD_ADMINS", "").split(",") if u.strip()}
    else:
        admins = set(admins)
    # The "examples" account owns the shipped default datasets/dashboards. Its
    # artifacts are read-merged into every user's lists (read-only for non-admins)
    # so demo users see the examples without owning them, and only an admin can
    # edit or delete them. Config-only; falls back to CXD_EXAMPLES_OWNER ("app").
    if examples_owner is None:
        examples_owner = (os.getenv("CXD_EXAMPLES_OWNER", "app") or "").strip() or None
    # Dashboards: stdlib SQLite by default (zero-dep), or Postgres/SQLite via
    # SQLAlchemy when CXD_DASHBOARD_STORE names a postgres:// URL.
    store = store or open_dashboard_store(os.getenv("CXD_DASHBOARD_STORE"), db_path=db_path)
    if registry is None:
        registry = StoreRegistry.from_env(
            dataset_uri=dataset_store_uri, s3_client=s3_client,
            drive_client_factory=drive_client_factory,
        )
    publish_base_url = publish_base_url or os.getenv("CXD_PUBLISH_BASE_URL")
    # Served-app runtime config (injected into index.html at serve time).
    canvasxpress_url = (canvasxpress_url or os.getenv("CXD_CANVASXPRESS_URL")
                        or "https://www.canvasxpress.org/dist")
    canvasxpress_license = canvasxpress_license or os.getenv("CXD_CANVASXPRESS_LICENSE")
    # LLM config stays server-side (secret). The client only learns it's enabled.
    llm_api_key = llm_api_key or os.getenv("CXD_LLM_API_KEY")
    llm_model = llm_model or os.getenv("CXD_LLM_MODEL")
    # Data functions (R/Python snippets) run user code: off unless configured.
    functions = functions or FunctionsConfig.from_env()
    # Audit log: append-only, hash-chained, next to the dashboard store.
    if audit is None:
        audit = _default_audit_log(store, db_path)
    audit.prune()

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
    app.state.audit = audit

    # Registered BEFORE the session middleware so it runs inside it: the session
    # (who is signed in) is readable before and after the handler.
    @app.middleware("http")
    async def audit_requests(request: Request, call_next):
        before = request.session.get("user") if "session" in request.scope else None
        request.state.audit = {}
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            _record_request(audit, request, before, status)
    app.add_middleware(
        SessionMiddleware, secret_key=session_secret, same_site="lax", https_only=https_only,
        session_cookie="cxd_session",  # distinct name so co-hosted apps (e.g. connectors) don't clobber it
    )
    # LLM config lives on app.state for the (future) NL builder; the key never
    # leaves the server.
    app.state.llm = {"api_key": llm_api_key, "model": llm_model}

    def require_user(request: Request) -> str:
        user = request.session.get("user")
        if not user:
            raise HTTPException(status_code=401, detail="Not logged in")
        return user

    def user_is_admin(username: Optional[str]) -> bool:
        """Effective admin check: the ``CXD_ADMINS`` config OR the persisted flag
        (set for the first user to sign up)."""
        return bool(username) and (username in admins or store.is_admin(username))

    def require_admin(request: Request) -> str:
        user = require_user(request)
        if not user_is_admin(user):
            raise HTTPException(status_code=403, detail="Admin access required")
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
        # First user to sign up bootstraps as admin, so a fresh deployment has an
        # administrator without needing CXD_ADMINS preset.
        first_user = not store.list_users()
        note(request, target=username, first_admin=first_user or None)
        if not store.create_user(username, password, is_admin=first_user):
            raise HTTPException(status_code=409, detail="Username already taken")
        request.session["user"] = username
        return {"user": username}

    @app.post("/auth/login")
    async def login(request: Request):
        body = await request.json()
        username, password = body.get("username", ""), body.get("password", "")
        note(request, target=username)   # also recorded when the attempt fails
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
        user = request.session.get("user")
        return {"user": user, "is_admin": user_is_admin(user)}

    # ---- admin: user management (gated by CXD_ADMINS) ----
    @app.get("/api/admin/users")
    def admin_list_users(request: Request):
        require_admin(request)
        return {"users": [
            {"username": name, "is_admin": user_is_admin(name),
             "via_config": name in admins,
             "dashboards": len(store.list_dashboards(name))}
            for name in store.list_users()
        ]}

    @app.post("/api/admin/users")
    async def admin_create_user(request: Request):
        require_admin(request)
        body = await request.json()
        username, password = body.get("username", ""), body.get("password", "")
        if len(username) < 3 or len(password) < 6:
            raise HTTPException(status_code=400, detail="Username ≥3 and password ≥6 chars")
        if not store.create_user(username, password):
            raise HTTPException(status_code=409, detail="Username already taken")
        return {"user": username}

    @app.post("/api/admin/users/{username}/password")
    async def admin_set_password(request: Request, username: str):
        require_admin(request)
        body = await request.json()
        password = body.get("password", "")
        if len(password) < 6:
            raise HTTPException(status_code=400, detail="Password ≥6 chars")
        if not store.set_password(username, password):
            raise HTTPException(status_code=404, detail="No such user")
        return {"user": username}

    @app.post("/api/admin/users/{username}/admin")
    async def admin_set_admin(request: Request, username: str):
        admin = require_admin(request)
        body = await request.json()
        grant = bool(body.get("is_admin"))
        if username in admins:
            raise HTTPException(status_code=400,
                                detail="This user is an admin via CXD_ADMINS — change the config instead")
        if username == admin and not grant:
            raise HTTPException(status_code=400, detail="You cannot revoke your own admin rights")
        if not store.set_admin(username, grant):
            raise HTTPException(status_code=404, detail="No such user")
        return {"user": username, "is_admin": user_is_admin(username)}

    @app.delete("/api/admin/users/{username}")
    def admin_delete_user(request: Request, username: str):
        admin = require_admin(request)
        if username == admin:
            raise HTTPException(status_code=400, detail="You cannot delete your own account")
        if user_is_admin(username):
            raise HTTPException(status_code=400, detail="Cannot delete another admin (revoke their admin rights first)")
        if not store.delete_user(username):
            raise HTTPException(status_code=404, detail="No such user")
        return {"users": store.list_users()}

    def resolve_write_owner(user: str, owner: Optional[str]) -> str:
        """The owner a write targets: the caller, unless an admin names another
        owner via ``?owner=`` (403 for non-admins). Used to let an admin maintain
        the shared example artifacts owned by ``examples_owner``."""
        if owner and owner != user:
            if not user_is_admin(user):
                raise HTTPException(status_code=403, detail="Admin access required")
            return owner
        return user

    # ---- dashboard CRUD (owner-isolated; examples read-merged) ----
    @app.get("/api/dashboards")
    def list_dashboards(request: Request):
        user = require_user(request)
        rows = [dict(d, owner=user) for d in store.list_dashboards(user)]
        # Merge the shared example dashboards (read-only unless the viewer is admin).
        if examples_owner and examples_owner != user:
            own_ids = {d["id"] for d in rows}
            editable = user_is_admin(user)
            for d in store.list_dashboards(examples_owner):
                if d["id"] in own_ids:
                    continue
                rows.append(dict(d, owner=examples_owner, example=True, readOnly=not editable))
        return {"dashboards": rows}

    @app.post("/api/dashboards")
    async def save_dashboard(request: Request, owner: Optional[str] = None, lock: Optional[int] = None):
        user = require_user(request)
        spec = await request.json()
        if not isinstance(spec, dict) or not spec.get("id"):
            raise HTTPException(status_code=400, detail="Body must be a dashboard spec with an id")
        target = resolve_write_owner(user, owner)
        note(request, target=spec["id"], owner=target,
             created=store.get_summary(target, spec["id"]) is None, lock=lock)
        saved = store.save_dashboard(target, spec, _now_iso())
        # An admin may lock/unlock in the same call (e.g. saving a new example).
        if lock is not None and user_is_admin(user):
            store.set_locked(target, spec["id"], bool(lock))
            saved = store.get_summary(target, spec["id"])
        return {"dashboard": saved}

    @app.get("/api/dashboards/{dashboard_id}")
    def get_dashboard(request: Request, dashboard_id: str):
        user = require_user(request)
        spec = store.get_dashboard(user, dashboard_id)
        # Fall back to the shared example owner so viewers can open examples.
        spec_owner = user
        if spec is None and examples_owner and examples_owner != user:
            spec = store.get_dashboard(examples_owner, dashboard_id)
            spec_owner = examples_owner
        if spec is None:
            raise HTTPException(status_code=404, detail="No such dashboard")
        note(request, owner=spec_owner)
        return spec

    @app.post("/api/dashboards/{dashboard_id}/lock")
    async def lock_dashboard(request: Request, dashboard_id: str, owner: Optional[str] = None):
        """Lock/unlock a dashboard (admin only). Defaults to the examples owner."""
        admin = require_admin(request)
        target = owner or examples_owner or admin
        body = await request.json() if _has_body(request) else {}
        note(request, owner=target, locked=bool(body.get("locked", True)))
        summary = store.set_locked(target, dashboard_id, bool(body.get("locked", True)))
        if summary is None:
            raise HTTPException(status_code=404, detail="No such dashboard")
        return {"dashboard": summary}

    @app.delete("/api/dashboards/{dashboard_id}")
    def delete_dashboard(request: Request, dashboard_id: str, owner: Optional[str] = None):
        user = require_user(request)
        # Owner-only delete; an admin may target another user's dashboard via ?owner=.
        target = user
        if owner and owner != user:
            if not user_is_admin(user):
                raise HTTPException(status_code=403, detail="Admin access required")
            target = owner
        # Locked dashboards are protected; only an admin may delete them.
        note(request, owner=target)
        if store.is_locked(target, dashboard_id) and not user_is_admin(user):
            raise HTTPException(status_code=403, detail="Dashboard is locked")
        store.delete_dashboard(target, dashboard_id)
        return {"dashboards": store.list_dashboards(user)}

    # ---- sharing ----
    @app.post("/api/dashboards/{dashboard_id}/share")
    async def share_dashboard(request: Request, dashboard_id: str):
        user = require_user(request)
        body = await request.json() if _has_body(request) else {}
        visibility = (body or {}).get("visibility", "public")
        note(request, owner=user, visibility=visibility)
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
        note(request, target=(shared.get("spec") or {}).get("id") or target_from({"token": token}),
             owner=shared["owner"], visibility=shared["visibility"])
        # auth-gated shares require *any* logged-in viewer; public shares are open.
        if shared["visibility"] == "auth" and not request.session.get("user"):
            raise HTTPException(status_code=401, detail="Login required to view this dashboard")
        # Resolve kind:"dataset" sources into inline data using the OWNER's
        # datasets: the viewer has no session that could fetch /api/datasets/*,
        # and sharing means sharing the (read-only) data the spec binds to. The
        # snapshot is taken per request, so re-opening the link shows current data.
        spec = shared["spec"]
        for ref, source in list((spec.get("data") or {}).items()):
            if not (isinstance(source, dict) and source.get("kind") == "dataset"):
                continue
            try:
                data = dataset_store_for(source.get("store")).get(
                    shared["owner"], source.get("id"))
            except KeyError:
                data = None
            if data is not None:
                spec["data"][ref] = {"kind": "inline", "value": data}
        return {"spec": spec, "readOnly": True, "owner": shared["owner"]}

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
        seen = set()
        for name in dataset_store_names():
            for d in dataset_store_for(name).list(user):
                d["owner"] = user
                datasets.append(d)
                seen.add((d.get("store") or name, d["id"]))
        # Merge the shared example datasets (read-only unless the viewer is admin).
        if examples_owner and examples_owner != user:
            editable = user_is_admin(user)
            for name in dataset_store_names():
                for d in dataset_store_for(name).list(examples_owner):
                    if (d.get("store") or name, d["id"]) in seen:
                        continue
                    d["owner"] = examples_owner
                    d["example"] = True
                    d["readOnly"] = not editable
                    datasets.append(d)
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
        config = body.get("config")
        if config is not None and not isinstance(config, dict):
            raise HTTPException(status_code=400, detail="'config' must be an object")
        # An admin may create/overwrite a dataset under another owner (e.g. adding
        # a shared example under examples_owner) and mark it locked.
        owner = resolve_write_owner(user, body.get("owner"))
        locked = bool(body.get("locked")) and user_is_admin(user)
        summary = target.create(
            owner, data, _now_iso(), title=body.get("title"), dataset_id=body.get("id"),
            config=config, locked=locked,
        )
        summary["url"] = target.url_for(owner, summary["id"])
        note(request, target=summary["id"], owner=owner, store=body.get("store"),
             rows=summary.get("rows"), cols=summary.get("cols"), locked=locked or None)
        return {"dataset": summary}

    @app.get("/api/datasets/{dataset_id}")
    def get_dataset(request: Request, dataset_id: str, store: Optional[str] = None):
        user = require_user(request)
        ds_store = resolve_dataset_store(store)
        data = ds_store.get(user, dataset_id)
        data_owner = user
        # Fall back to the shared example owner so viewers can read example data.
        if data is None and examples_owner and examples_owner != user:
            data = ds_store.get(examples_owner, dataset_id)
            data_owner = examples_owner
        if data is None:
            raise HTTPException(status_code=404, detail="No such dataset")
        note(request, owner=data_owner, store=store)
        # Any extra query params are sample-annotation filters (the parameterized
        # dataset path for live-data controls): keep only matching samples. Only
        # keys that name a real annotation participate, so nothing here executes
        # a query or trusts the key/value beyond an equality mask.
        filters = {k: v for k, v in request.query_params.items() if k != "store"}
        if filters:
            data = filter_cx_data(data, filters)
        return data

    @app.delete("/api/datasets/{dataset_id}")
    def delete_dataset(request: Request, dataset_id: str, store: Optional[str] = None, owner: Optional[str] = None):
        user = require_user(request)
        # Owner-only delete; an admin may target another user's dataset via ?owner=.
        target = user
        if owner and owner != user:
            if not user_is_admin(user):
                raise HTTPException(status_code=403, detail="Admin access required")
            target = owner
        ds_store = resolve_dataset_store(store)
        note(request, owner=target, store=store)
        # Locked datasets are protected; only an admin may delete them.
        if ds_store.is_locked(target, dataset_id) and not user_is_admin(user):
            raise HTTPException(status_code=403, detail="Dataset is locked")
        ds_store.delete(target, dataset_id)
        datasets = []
        for name in dataset_store_names():
            datasets.extend(dataset_store_for(name).list(user))
        return {"datasets": datasets}

    @app.post("/api/datasets/{dataset_id}/lock")
    async def lock_dataset(request: Request, dataset_id: str, store: Optional[str] = None,
                           owner: Optional[str] = None):
        """Lock/unlock a dataset (admin only). Defaults to the examples owner."""
        admin = require_admin(request)
        target = owner or examples_owner or admin
        body = await request.json() if _has_body(request) else {}
        note(request, owner=target, store=store, locked=bool(body.get("locked", True)))
        summary = resolve_dataset_store(store).set_locked(target, dataset_id, bool(body.get("locked", True)))
        if summary is None:
            raise HTTPException(status_code=404, detail="No such dataset")
        return {"dataset": summary}

    # ---- data functions (kind:"function" sources) ----
    def require_function_user(request: Request) -> str:
        """The caller, if this server lets them run data functions."""
        user = require_user(request)
        if functions.mode == "off":
            raise HTTPException(
                status_code=403,
                detail="Data functions are disabled on this server (set CXD_FUNCTIONS)")
        if functions.mode == "admin" and not user_is_admin(user):
            raise HTTPException(status_code=403,
                                detail="Data functions are limited to administrators")
        return user

    @app.get("/api/functions/status")
    def function_status(request: Request):
        require_user(request)
        return functions_status(functions)

    @app.post("/api/functions/run")
    async def function_run(request: Request):
        user = require_function_user(request)
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(status_code=400, detail="Request body must be JSON")
        # The code itself is not stored — a hash identifies which snippet ran.
        body = payload if isinstance(payload, dict) else {}
        code = body.get("code")
        inputs = body.get("inputs")
        note(request, language=body.get("language"),
             code_sha256=(hashlib.sha256(code.encode("utf-8")).hexdigest()[:16]
                          if isinstance(code, str) else None),
             inputs=sorted(inputs.keys()) if isinstance(inputs, dict) else None)
        started = time.monotonic()
        try:
            result = await run_in_threadpool(run_function, payload, functions)
        except FunctionError as exc:
            elapsed = int((time.monotonic() - started) * 1000)
            note(request, duration_ms=elapsed, error=str(exc)[:200])
            raise HTTPException(status_code=exc.status, detail=str(exc))
        note(request, duration_ms=int((time.monotonic() - started) * 1000))
        print("[functions] user=%s language=%s ok" % (user, payload.get("language")), flush=True)
        return result

    # ---- audit log (admin only; reading it is itself audited) ----
    def audit_filters(request: Request) -> dict:
        q = request.query_params
        keys = ("actor", "action", "target", "outcome", "since", "until")
        filters = {k: q.get(k) for k in keys if q.get(k)}
        note(request, **filters)
        return filters

    @app.get("/api/admin/audit")
    def audit_view(request: Request, before: Optional[int] = None, limit: int = 200):
        require_admin(request)
        page = audit.query(before=before, limit=limit, **audit_filters(request))
        page["enabled"] = audit.enabled
        page["actions"] = list(iter_actions())
        return page

    @app.get("/api/admin/audit/export")
    def audit_export(request: Request, format: str = "csv"):
        require_admin(request)
        fmt = "jsonl" if format == "jsonl" else "csv"
        body = audit.export(fmt, **audit_filters(request))
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        disposition = 'attachment; filename="cxd-audit-%s.%s"' % (stamp, fmt)
        return Response(content=body,
                        media_type="application/x-ndjson" if fmt == "jsonl" else "text/csv",
                        headers={"Content-Disposition": disposition})

    @app.get("/api/admin/audit/verify")
    def audit_verify(request: Request):
        require_admin(request)
        result = audit.verify()
        note(request, ok=result["ok"], checked=result["checked"], broken_at=result["broken_at"])
        return result

    @app.get("/api/llm/status")
    def llm_status(request: Request):
        """Whether the NL dashboard builder is configured (no secret exposed)."""
        require_user(request)
        logs_panel = (os.getenv("CXD_LOGS_PANEL") or "1").strip().lower() not in ("0", "false", "no", "off")
        return {"enabled": bool(llm_api_key) or mcp_bridge.enabled(), "model": llm_model,
                "mcp": {"enabled": mcp_bridge.enabled(), "url": mcp_bridge.base_url()},
                "logsPanel": logs_panel and bool(mcp_bridge.log_path())}

    @app.get("/api/llm/mcp-log")
    def llm_mcp_log(request: Request, n: int = 50):
        """The last N canvasxpress-mcp bridge exchanges (request + response),
        for debugging generated graph configs. Enabled via CXD_MCP_LOG."""
        require_user(request)
        return {"log_path": mcp_bridge.log_path(),
                "entries": mcp_bridge.read_log(n)}

    @app.delete("/api/llm/mcp-log")
    def llm_mcp_log_clear(request: Request):
        """Delete all recorded canvasxpress-mcp bridge exchanges (clears the log
        file). Available to any logged-in user who can see the Logs panel."""
        require_user(request)
        return {"ok": mcp_bridge.clear_log()}

    @app.post("/api/llm/dashboard")
    async def llm_dashboard(request: Request):
        """Author or revise a dashboard spec from a natural-language request.

        Body: ``{message, history?, spec?}`` — ``history`` is a list of prior
        ``{role, content}`` chat turns, ``spec`` the current working spec.
        Returns ``{reply, spec}``; ``spec`` is None for purely conversational
        replies. The LLM only ever emits a declarative spec — it never touches
        the data (mirrors the "recipe" model: NL in, auditable JSON out).
        """
        user = require_user(request)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object")
        message = (body.get("message") or "").strip()
        if not message:
            raise HTTPException(status_code=400, detail="Body must include 'message'")
        current_spec = body.get("spec") if isinstance(body.get("spec"), dict) else None
        history = body.get("history") if isinstance(body.get("history"), list) else []
        # Optional client-side scoping: only these dataset ids are cataloged
        # (empty/absent = all of the user's datasets).
        wanted = body.get("datasets")
        wanted = set(wanted) if isinstance(wanted, list) and wanted else None

        # Catalog the user's datasets — id/store plus a schema sketch so the
        # model binds panels to real columns without ever seeing full data.
        catalog = []
        data_by_id = {}
        for name in dataset_store_names():
            ds = dataset_store_for(name)
            for meta in ds.list(user):
                if wanted is not None and meta.get("id") not in wanted:
                    continue
                entry = {"id": meta.get("id"), "title": meta.get("title"),
                         "store": meta.get("store")}
                data = ds.get(user, meta.get("id")) or {}
                data_by_id[meta.get("id")] = data
                if isinstance(data, list):   # tabular 2D array (CSV-derived)
                    headers = [str(c) for c in (data[0] if data else [])]
                    entry["columns"] = headers[:40]
                    entry["n_rows"] = max(0, len(data) - 1)
                else:
                    y = data.get("y") or {}
                    entry["vars"] = (y.get("vars") or [])[:40]
                    entry["n_vars"] = len(y.get("vars") or [])
                    entry["smps"] = (y.get("smps") or [])[:12]
                    entry["n_smps"] = len(y.get("smps") or [])
                    for annot in ("x", "z"):
                        keys = list((data.get(annot) or {}).keys())
                        if keys:
                            entry[annot + "_annotations"] = keys[:20]
                catalog.append(entry)

        # ---- Keyless fast path: single-chart creation via canvasxpress-mcp ----
        # With no LLM key configured, the chat can still build one chart: one
        # dataset in scope + empty canvas -> the MCP authors the validated
        # config and we wrap it in a one-panel spec. When an LLM key IS set,
        # the orchestrator below handles everything (its configs also come
        # from the MCP tools, and it can plan multi-panel dashboards).
        fresh = not ((current_spec or {}).get("panels"))
        if mcp_bridge.enabled() and fresh and len(catalog) == 1 and not llm_api_key:
            entry = catalog[0]
            headers, column_types = mcp_bridge.dataset_columns(data_by_id[entry["id"]])
            mcp = mcp_bridge.generate_config(message, headers, column_types)
            if mcp:
                config = mcp["config"]
                config.setdefault("title", False)
                graph = config.get("graphType") or "chart"
                spec_id = re.sub(r"[^a-z0-9]+", "-", (entry["title"] or entry["id"]).lower()).strip("-") or "dashboard"
                fast_spec = {
                    "id": spec_id, "title": entry["title"] or entry["id"], "version": 1,
                    "layout": {"cols": 12, "rowHeight": 130, "gap": 12,
                               "items": [{"panel": "p1", "x": 0, "y": 0, "w": 12, "h": 3}]},
                    "data": {entry["id"]: {"kind": "dataset", "id": entry["id"],
                                           "store": entry.get("store")}},
                    "panels": {"p1": {"title": "%s — %s" % (entry["title"] or entry["id"], graph),
                                      "dataRef": entry["id"], "config": config}},
                    "controls": [],
                }
                reply = "Built a %s from “%s” with the CanvasXpress engine (validated config)." \
                    % (graph, entry["title"] or entry["id"])
                warns = [w for w in (mcp.get("warnings") or []) if w]
                if warns:
                    reply += " Notes: " + "; ".join(str(w) for w in warns[:3])
                return {"reply": reply, "spec": fast_spec, "model": "canvasxpress-mcp"}

        # ---- LLM planner path (multi-panel dashboards, revisions) ----
        if not llm_api_key:
            raise HTTPException(status_code=503, detail=(
                "Natural-language builder is not configured. Set CXD_LLM_API_KEY "
                "(and optionally CXD_LLM_MODEL) on the server."))
        try:
            import anthropic
        except ImportError:
            raise HTTPException(status_code=503, detail=(
                "The 'anthropic' package is not installed on the server "
                "(pip install anthropic)."))

        # Phase 2: with the MCP bridge up, the planner becomes an ORCHESTRATOR —
        # it plans panels and layout but must fetch every panel's `config` from
        # the MCP tools (validated, hallucination-stripped). Without the bridge,
        # it writes configs itself as before.
        use_mcp_tools = mcp_bridge.enabled()
        system = _LLM_SYSTEM
        if use_mcp_tools:
            system += (
                "\n## Graph configs come from tools (MANDATORY)\n"
                "NEVER write a panel's `config` yourself. For each graph panel call "
                "generate_chart_config(description, dataset_id) — a rich plain-English "
                "description of the chart (type, axes, grouping, colors) — and use the "
                "returned config VERBATIM as that panel's `config` (you may only add "
                "title:false). To change an existing panel's graph, call "
                "modify_chart_config(config, instruction, dataset_id) with its current "
                "config. Table controls need no tool. EXCEPTION: the tools only know "
                "stored datasets, so for a panel bound to a \"join\" or \"function\" "
                "source write its config yourself from that source's OUTPUT columns (a "
                "join: both inputs' columns; a function: the columns your code creates) "
                "— never pass an input dataset's id for it. After all tool calls, "
                "respond with the final JSON object only.")

        # The dataset catalogue changes whenever the user adds/renames/removes a
        # dataset, so it must NOT sit inside the cached block: a prompt cache is
        # a prefix match, and appending it here would invalidate the whole
        # system prompt on every catalogue change. It goes in a second,
        # uncached block after the breakpoint instead.
        catalog_block = "## The user's datasets\n" + json.dumps(catalog)
        # Data functions depend on server config and the caller's role, so the
        # availability note rides in the uncached block too.
        can_run_functions = functions.mode == "users" or (
            functions.mode == "admin" and user_is_admin(user))
        if can_run_functions:
            catalog_block += ("\n\n## Data functions: AVAILABLE (languages: %s). You may use "
                              "kind \"function\" sources when the user asks for computation." %
                              ", ".join(functions_status(functions)["languages"]))
        else:
            catalog_block += ("\n\n## Data functions: NOT available on this server for this "
                              "user. Never emit kind \"function\" sources.")
        messages = []
        for turn in history[-12:]:
            if isinstance(turn, dict) and turn.get("role") in ("user", "assistant") \
                    and isinstance(turn.get("content"), str):
                messages.append({"role": turn["role"], "content": turn["content"]})
        prompt = message
        if current_spec is not None:
            prompt += "\n\n## Current dashboard spec\n" + json.dumps(current_spec)
        messages.append({"role": "user", "content": prompt})

        def run_mcp_tool(name: str, args: dict):
            """Execute one orchestrator tool via the MCP bridge.

            :returns: ``(payload, is_error)`` — the payload is JSON-encoded into
                the tool_result either way, so the model can react to failures
                (and fall back to writing the config itself).
            """
            dataset_id = (args or {}).get("dataset_id")
            print("[llm] tool call: %s(dataset_id=%s%s)" % (
                name, dataset_id,
                ", instruction=%r" % (args or {}).get("instruction")
                if name == "modify_chart_config" else ""), flush=True)
            data = data_by_id.get(dataset_id)
            if data is None:
                return {"error": "unknown dataset_id '%s' — use an id from the catalog" % dataset_id}, True
            headers, column_types = mcp_bridge.dataset_columns(data)
            if name == "generate_chart_config":
                res = mcp_bridge.generate_config(str((args or {}).get("description") or ""),
                                                 headers, column_types)
            elif name == "modify_chart_config":
                cfg = (args or {}).get("config")
                if not isinstance(cfg, dict):
                    return {"error": "config must be an object"}, True
                res = mcp_bridge.modify_config(cfg, str((args or {}).get("instruction") or ""),
                                               headers)
            else:
                return {"error": "unknown tool"}, True
            if not res:
                return {"error": "chart engine unavailable — write the config yourself, "
                                 "using only these columns: " + ", ".join(headers)}, True
            mcp_usage = res.get("usage") or {}
            if mcp_usage:
                cost_tally["mcp_calls"] += mcp_usage.get("calls", 1) or 1
                cost_tally["mcp_cost_usd"] += mcp_usage.get("cost_usd", 0.0) or 0.0
            return {"config": res["config"], "warnings": res.get("warnings") or []}, False

        _MCP_TOOLS = [
            {"name": "generate_chart_config",
             "description": "Generate a validated CanvasXpress graph config from a plain-English "
                            "chart description and the id of the dataset it will bind to.",
             "input_schema": {"type": "object", "properties": {
                 "description": {"type": "string"},
                 "dataset_id": {"type": "string"}},
                 "required": ["description", "dataset_id"]}},
            {"name": "modify_chart_config",
             "description": "Revise an existing CanvasXpress graph config with a plain-English "
                            "instruction; pass the panel's current config and its dataset id.",
             "input_schema": {"type": "object", "properties": {
                 "config": {"type": "object"},
                 "instruction": {"type": "string"},
                 "dataset_id": {"type": "string"}},
                 "required": ["config", "instruction", "dataset_id"]}},
        ]

        client = anthropic.Anthropic(api_key=llm_api_key)
        model = llm_model or "claude-opus-5"
        request_kwargs = dict(
            model=model,
            max_tokens=16000,
            # Stable prompt first with the single cache breakpoint (tools render
            # before system, so this one breakpoint covers tools + prompt), then
            # the volatile catalogue after it.
            system=[{"type": "text", "text": system,
                     "cache_control": {"type": "ephemeral"}},
                    {"type": "text", "text": catalog_block}],
        )
        if use_mcp_tools:
            request_kwargs["tools"] = _MCP_TOOLS
        # Real column names per dataset, so a spec that invents a measure or a
        # dataset id is caught server-side (the browser validator has no
        # catalogue and cannot check this).
        known_columns = {}
        for dataset_id, dataset in data_by_id.items():
            try:
                known_columns[dataset_id] = mcp_bridge.dataset_columns(dataset)[0]
            except Exception:  # noqa: BLE001 - a shape we cannot read just skips binding checks
                known_columns[dataset_id] = []

        def parse_reply(response):
            """Extract {reply, spec} from the model's final text block."""
            text = "".join(b.text for b in response.content if b.type == "text")
            try:
                parsed = json.loads(text)
            except ValueError:
                match = re.search(r"\{.*\}", text, re.DOTALL)
                try:
                    parsed = json.loads(match.group(0)) if match else {"reply": text}
                except ValueError:
                    parsed = {"reply": text}
            if not isinstance(parsed, dict):
                parsed = {"reply": text}
            return parsed, text

        def spec_errors(spec):
            """Structural + binding errors for a candidate spec."""
            if not isinstance(spec, dict) or not spec.get("id"):
                return ["spec must be an object with a non-empty string id"]
            structural = validate_spec(spec)
            bindings = validate_bindings(spec, known_columns)
            return structural["errors"] + bindings["errors"]

        def run_with_repair(run_turns):
            """Generate a spec, then let the model FIX its own validation errors.

            The spec was already being validated in the browser, but the errors
            were shown to the user and discarded — the model never saw them, so
            a malformed spec was a dead end. Here the errors go back as a normal
            user turn (the same shape tool failures already use), giving the
            model a bounded chance to repair before we answer.

            :param run_turns: callable driving one full tool-use loop.
            :returns: ``(spec, reply, validation)`` — spec is None for a purely
                conversational reply or when repair never converged.
            """
            attempts = []
            for attempt in range(_SPEC_REPAIR_ROUNDS + 1):
                response = run_turns()
                parsed, text = parse_reply(response)
                reply = parsed.get("reply") or ""
                spec = parsed.get("spec")

                if spec is None:
                    # A question or chit-chat: nothing to validate.
                    return None, reply, {"ok": True, "errors": [], "attempts": attempts}

                errors = spec_errors(spec)
                attempts.append({"attempt": attempt + 1, "errors": errors})
                if not errors:
                    return spec, reply, {"ok": True, "errors": [], "attempts": attempts}

                print("[llm] spec invalid (attempt %d/%d): %s" % (
                    attempt + 1, _SPEC_REPAIR_ROUNDS + 1, "; ".join(errors[:4])), flush=True)

                if attempt == _SPEC_REPAIR_ROUNDS:
                    # Out of repair budget — hand back the errors, not a broken
                    # dashboard, so the caller can say something useful.
                    return None, reply, {"ok": False, "errors": errors, "attempts": attempts}

                messages.append({"role": "assistant",
                                 "content": [b.model_dump() for b in response.content]})
                messages.append({"role": "user", "content": (
                    "The spec you returned failed validation:\n- "
                    + "\n- ".join(errors[:20])
                    + "\n\nReturn the SAME JSON object shape again with a corrected, "
                      "COMPLETE spec. Use only dataset ids and column names that exist "
                      "in the catalog above. Do not explain the fix.")})
            return None, "", {"ok": False, "errors": ["repair loop exhausted"], "attempts": attempts}

        # One dashboard = several orchestrator calls plus the MCP calls they
        # trigger. Both are accumulated here so the log can report what this
        # dashboard actually cost, end to end.
        cost_tally = {"calls": 0, "cost_usd": 0.0,
                      "mcp_calls": 0, "mcp_cost_usd": 0.0}

        def run_turns():
            """Drive the bounded tool-use loop until the model stops calling tools.

            :returns: the final assistant response (stop_reason != "tool_use").
            """
            for _round in range(8):   # tool-use loop (bounded)
                if use_mcp_tools:
                    response = client.messages.create(messages=messages, **request_kwargs)
                else:
                    try:
                        response = client.messages.create(
                            messages=messages,
                            output_config={"format": {
                                "type": "json_schema", "schema": _LLM_OUTPUT_SCHEMA}},
                            **request_kwargs)
                    except anthropic.BadRequestError:
                        # Structured outputs unavailable for this model/config —
                        # fall back to instructed JSON, parsed defensively below.
                        response = client.messages.create(messages=messages, **request_kwargs)
                _log_usage(response, model, cost_tally)
                if response.stop_reason != "tool_use":
                    break
                # Execute every tool call in this turn; echo the full assistant
                # content back (thinking blocks included) plus one user message
                # carrying ALL tool_result blocks.
                messages.append({"role": "assistant",
                                 "content": [b.model_dump() for b in response.content]})
                results = []
                for block in response.content:
                    if block.type != "tool_use":
                        continue
                    payload, is_error = run_mcp_tool(block.name, block.input)
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": json.dumps(payload), "is_error": is_error})
                messages.append({"role": "user", "content": results})
            return response

        try:
            spec, reply, validation = run_with_repair(run_turns)
        except anthropic.AuthenticationError:
            raise HTTPException(status_code=503, detail="LLM API key was rejected")
        except anthropic.RateLimitError:
            raise HTTPException(status_code=429, detail="LLM rate limit — try again shortly")
        except anthropic.APIStatusError as exc:
            raise HTTPException(status_code=502, detail="LLM error: %s" % exc.message)
        except anthropic.APIConnectionError:
            raise HTTPException(status_code=502, detail="Could not reach the LLM API")

        total = cost_tally["cost_usd"] + cost_tally["mcp_cost_usd"]
        note(request, model=model, cost_usd=round(total, 5), produced_spec=spec is not None)
        print("[llm] DASHBOARD cost=$%.4f (orchestrator $%.4f over %d calls + "
              "mcp $%.4f over %d calls)" % (
                  total, cost_tally["cost_usd"], cost_tally["calls"],
                  cost_tally["mcp_cost_usd"], cost_tally["mcp_calls"]), flush=True)
        return {"reply": reply, "spec": spec, "validation": validation,
                "model": model + ("+mcp" if use_mcp_tools else ""),
                "cost": {"total_usd": round(total, 5),
                         "orchestrator_usd": round(cost_tally["cost_usd"], 5),
                         "orchestrator_calls": cost_tally["calls"],
                         "mcp_usd": round(cost_tally["mcp_cost_usd"], 5),
                         "mcp_calls": cost_tally["mcp_calls"]}}

    if serve_static and os.path.isdir(_STATIC_DIR):
        # Inject runtime config (CanvasXpress license + library URL + client
        # flags) into the served app shell's head, replacing the generated
        # CXD_HEAD placeholder. The license MUST precede canvasXpress.min.js, so
        # this is done server-side rather than fetched by the page.
        index_html = _render_index(
            canvasxpress_url=canvasxpress_url,
            canvasxpress_license=canvasxpress_license,
            client_config={"llmEnabled": bool(llm_api_key)},
        )
        if index_html is not None:
            @app.get("/", response_class=HTMLResponse)
            def index():
                return HTMLResponse(index_html)

            @app.get("/index.html", response_class=HTMLResponse)
            def index_page():
                return HTMLResponse(index_html)

        # Everything else (bundle, shared.html, assets) stays plain static.
        app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="static")

    return app


def _render_index(canvasxpress_url: str, canvasxpress_license: Optional[str],
                  client_config: dict) -> Optional[str]:
    """Read the served app shell and inject runtime config into its head.

    Replaces the ``<!--CXD_HEAD_START-->…<!--CXD_HEAD_END-->`` block with the
    CanvasXpress license (``window.cX``, before the library), the configured
    library ``<link>``/``<script>``, and a ``window.__CXD_CONFIG__`` object for
    the client. Returns None if the shell isn't present (falls back to static).

    :param canvasxpress_url: Base URL for the CanvasXpress library assets.
    :param canvasxpress_license: License key, or None to keep the watermark.
    :param client_config: Non-secret config exposed to the browser.
    :returns: The HTML string, or None when there is no index.html to render.
    """
    index_path = os.path.join(_STATIC_DIR, "index.html")
    if not os.path.isfile(index_path):
        return None
    with open(index_path, encoding="utf-8") as handle:
        template = handle.read()

    base = canvasxpress_url.rstrip("/")
    css_url = html.escape(base + "/canvasXpress.css", quote=True)
    js_url = html.escape(base + "/canvasXpress.min.js", quote=True)
    parts = []
    if canvasxpress_license:
        # window.cX must be set before canvasXpress.min.js loads.
        parts.append("<script>window.cX=%s;</script>" % json.dumps(canvasxpress_license))
    parts.append('<link href="%s" rel="stylesheet" />' % css_url)
    parts.append('<script src="%s"></script>' % js_url)
    parts.append("<script>window.__CXD_CONFIG__=%s;</script>" % json.dumps(client_config))
    injected = "\n  ".join(parts)

    # Use a function replacement so backslashes in the config aren't treated as
    # regex backreferences.
    return re.sub(
        r"<!--CXD_HEAD_START-->.*?<!--CXD_HEAD_END-->",
        lambda _match: injected,
        template,
        flags=re.S,
    )


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
