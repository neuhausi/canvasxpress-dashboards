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

import contextlib
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
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.middleware.sessions import SessionMiddleware

from . import mcp_bridge
from .datasets import DatasetStore, reshape_to_cx, filter_cx_data
from .engine import DEFAULT_CANVASXPRESS_URL, EngineMiddleware, engine_is_default
from .audit import (AuditLog, NullAuditLog, SqlAuditLog, SqliteAuditLog, action_for, iter_actions,
                    open_audit_log, target_from)
from .functions import FunctionError, FunctionsConfig, functions_status, run_function
from .governance import (PERMISSIONS, Governance, GovernanceError, apply_policy, build_lineage,
                         open_governance, spec_sources)
from .jobs import Jobs
from .mailer import SmtpMailer
from .records import RecordError, RecordStore
from .oidc import (IdentityStore, OidcClient, OidcConfig, OidcError, groups_from, pkce_pair,
                   username_from)
from .scheduler import Cron, ScheduleError, ScheduleStore, Scheduler
from .snapshot import SnapshotRenderer
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
  "schemaVersion": "1.2", "id": "<kebab-case>", "title": "<Title>", "version": 1,
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
              or {"kind": "live", "url": "/connectors/api/stream/<name>?...",
                  "window"?: <samples kept, default 1000>,
                  "variables"?: ["<series>", ...]}
                  // a pushed (SSE) stream; only when the user asks for live /
                  // real-time data and a stream exists; bind Line/Area/Bar panels
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


def _record_request(audit, request: Request, actor_before, status: int, base: str = "") -> None:
    """Record one finished request in the audit log, if its route is audited.

    ``base`` is the request's ``root_path`` before routing (the app's own prefix, e.g.
    behind a reverse-proxy subpath); whatever routing added to it is the mount of a
    sub-app that served the request (``/connectors``).

    The actor is whoever is signed in after the handler (a sign-in) or before it
    (a sign-out). A failure to write is reported on stderr, never raised: the
    audit log must not take the app down.
    """
    route = request.scope.get("route")
    after = request.scope.get("root_path") or ""
    mount = after[len(base):] if base and after.startswith(base) else (after if not base else "")
    action = action_for(request.method, getattr(route, "path", None), mount)
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
    disposable_dashboards: Optional[list] = None,
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
    governance: Optional[Governance] = None,
    mailer=None,
    snapshots: Optional[SnapshotRenderer] = None,
    origin_fetchers: Optional[dict] = None,
    scheduler_enabled: Optional[bool] = None,
    oidc: Optional[OidcClient] = None,
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
    :param disposable_dashboards: ``(owner, id)`` pairs of scratch dashboards any
        signed-in user may view, save and **delete** (e.g. a demo sandbox the
        deployment recreates when missing); falls back to
        ``CXD_DISPOSABLE_DASHBOARDS`` (comma-separated ``owner/id``).
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
        served app and, via :class:`EngineMiddleware`, every other served HTML
        page); falls back to ``CXD_CANVASXPRESS_URL`` (default the CDN).
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
    :param governance: Roles, groups, sharing grants and dataset security
        policies; built next to the dashboard store if omitted.
        ``CXD_DEFAULT_ROLE`` names the role of users with none assigned
        (default ``editor``).
    :param mailer: Sends alert and subscription email; built from ``CXD_SMTP_*``
        if omitted (email is off without ``CXD_SMTP_HOST``).
    :param snapshots: Renders dashboard PNGs for subscriptions; built from
        ``CXD_INTERNAL_URL`` / ``CXD_SNAPSHOTS`` if omitted (needs Playwright).
    :param origin_fetchers: Extra dataset origins for scheduled refresh, as
        ``kind -> fetch(owner, source_name) -> data`` (e.g. ``"connector"``).
        Also reachable as ``app.state.origin_fetchers`` to register later.
    :param oidc: Single sign-on (OpenID Connect); built from ``CXD_OIDC_*`` if
        omitted (off without ``CXD_OIDC_ISSUER``).
    :param scheduler_enabled: Run due schedules in a background thread while
        the app runs; falls back to ``CXD_SCHEDULER`` (default on).
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
    if disposable_dashboards is None:
        disposable_dashboards = [tuple(pair.strip().split("/", 1))
                                 for pair in os.getenv("CXD_DISPOSABLE_DASHBOARDS", "").split(",")
                                 if pair.strip().count("/") == 1]
    disposable = {(str(o), str(i)) for o, i in disposable_dashboards}

    def is_disposable(owner: Optional[str], dashboard_id: Optional[str]) -> bool:
        """A scratch dashboard anyone signed in may view, save and delete."""
        return (owner, dashboard_id) in disposable
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
                        or DEFAULT_CANVASXPRESS_URL)
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
    # Governance: roles, groups, grants and row/column security, next to the store.
    if governance is None:
        governance = open_governance(store, db_path, os.getenv("CXD_DEFAULT_ROLE"))

    def dataset_store_for(name: Optional[str]) -> DatasetStore:
        """Resolve the DatasetStore for a named dataset store (default when None)."""
        if dataset_store is not None and not name:
            return dataset_store
        resolved_name = name or registry.default_name("dataset")
        return DatasetStore(registry.resolve("dataset", resolved_name), store_name=resolved_name)

    def dataset_store_names() -> list:
        """All configured dataset store names (default first)."""
        return [s["name"] for s in registry.named("dataset")]

    # Scheduling: refresh, alerts and subscriptions (see scheduler.py / jobs.py).
    verify_emails = os.getenv("CXD_EMAIL_VERIFY", "on").lower() not in ("off", "0", "false", "no")
    schedules = ScheduleStore(governance._db, verify_emails=verify_emails)
    try:
        email_cap = int(os.getenv("CXD_EMAIL_DAILY_CAP", "50") or 50)
    except ValueError:
        email_cap = 50
    if mailer is None:
        mailer = SmtpMailer.from_env()
    if snapshots is None:
        snapshots = SnapshotRenderer(
            os.getenv("CXD_INTERNAL_URL")
            or "http://127.0.0.1:%s" % (os.getenv("CXD_PORT") or 8000),
            session_secret, canvasxpress_url, canvasxpress_license,
            enabled=os.getenv("CXD_SNAPSHOTS", "on").lower() not in ("off", "0", "false", "no"))
    origin_fetchers = dict(origin_fetchers or {})
    if scheduler_enabled is None:
        scheduler_enabled = os.getenv("CXD_SCHEDULER", "on").lower() not in ("off", "0", "false",
                                                                           "no")
    dashboard_url = os.getenv("CXD_DASHBOARD_URL") or "{base}/view.html?id={id}&owner={owner}"
    jobs_holder = {}

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        if scheduler_enabled:
            jobs_holder["scheduler"].start()
        try:
            yield
        finally:
            jobs_holder["scheduler"].stop()

    app = FastAPI(title="canvasxpress-dashboards · persistence & sharing", lifespan=lifespan)
    app.state.audit = audit
    app.state.governance = governance
    app.state.schedules = schedules
    app.state.mailer = mailer
    app.state.origin_fetchers = origin_fetchers
    # Single sign-on (OpenID Connect): off unless configured.
    if oidc is None:
        oidc_config = OidcConfig.from_env()
        oidc = OidcClient(oidc_config) if oidc_config else None
    identities = IdentityStore(governance._db)
    # Electronic records: dashboard version history and e-signatures.
    records = RecordStore(governance._db)
    app.state.records = records
    signature_meanings = [m.strip() for m in (os.getenv("CXD_SIGNATURE_MEANINGS")
                                               or "Authored,Reviewed,Approved").split(",")
                          if m.strip()]
    try:
        reauth_seconds = int(os.getenv("CXD_SIGN_REAUTH_SECONDS", "300") or 300)
    except ValueError:
        reauth_seconds = 300
    app.state.oidc = oidc

    # Registered BEFORE the session middleware so it runs inside it: the session
    # (who is signed in) is readable before and after the handler.
    @app.middleware("http")
    async def audit_requests(request: Request, call_next):
        before = request.session.get("user") if "session" in request.scope else None
        base = request.scope.get("root_path") or ""   # before routing: the app's own prefix
        request.state.audit = {}
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            _record_request(audit, request, before, status, base)
    app.add_middleware(
        SessionMiddleware, secret_key=session_secret, same_site="lax", https_only=https_only,
        session_cookie="cxd_session",  # distinct name so co-hosted apps (e.g. connectors) don't clobber it
    )
    # Every other served page (examples, view.html, shared.html, the demo builder)
    # hardcodes the CDN engine: rewrite it to the configured engine + license.
    if not engine_is_default(canvasxpress_url, canvasxpress_license):
        app.add_middleware(EngineMiddleware, canvasxpress_url=canvasxpress_url,
                           canvasxpress_license=canvasxpress_license)
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

    def permissions_of(user: Optional[str]) -> set:
        return governance.permissions_for(user, user_is_admin(user))

    def require_permission(request: Request, permission: str) -> str:
        """The caller, if their role grants ``permission`` (403 otherwise)."""
        user = require_user(request)
        if permission not in permissions_of(user):
            raise HTTPException(status_code=403, detail="Your role does not allow this: %s"
                                % PERMISSIONS[permission].lower())
        return user

    def store_key(name: Optional[str]) -> str:
        """A dataset store name as grants and policies key it (default resolved)."""
        return name or registry.default_name("dataset") or ""

    def dataset_access(user: Optional[str], owner: str, store_name: Optional[str],
                       dataset_id: str) -> bool:
        """May ``user`` read dataset (owner, store, id)? The owner, admins, the
        shared examples, a dataset grant, or a dashboard shared with the user
        that reads this dataset."""
        if not user:
            return False
        if user == owner or user_is_admin(user) or (examples_owner and owner == examples_owner):
            return True
        key = store_key(store_name)
        if governance.access_level(user, "dataset", owner, dataset_id, key):
            return True
        for g in governance.shared_with(user, "dashboard"):
            if g["owner"] != owner:
                continue
            spec = store.get_dashboard(owner, g["id"]) or {}
            for s in spec_sources(spec):
                if (s["kind"] == "dataset" and s.get("id") == dataset_id
                        and store_key(s.get("store")) == key
                        and (s.get("owner") or owner) == owner):
                    return True
        return False

    def secured(data, viewer: Optional[str], owner: str, store_name: Optional[str],
                dataset_id: str):
        """Apply the dataset's row/column policy for a viewer who is neither the
        owner nor an admin (None when the policy withholds the whole dataset)."""
        if viewer and (viewer == owner or user_is_admin(viewer)):
            return data
        policy = governance.get_policy(owner, dataset_id, store_key(store_name))
        return apply_policy(data, policy, governance.principals_for(viewer))

    def check_principal(principal: str) -> str:
        """Validate a ``user:``/``group:``/``*`` principal against real users/groups."""
        if principal == "*":
            return principal
        if principal.startswith("user:") and principal[5:] in store.list_users():
            return principal
        if principal.startswith("group:") and principal[6:] in governance.group_names():
            return principal
        raise HTTPException(status_code=400, detail="No such user or group: %s" % principal)

    # ---- auth (mirrors canvasxpress-connectors) ----
    # ---- health (for load balancers / orchestrators; no sign-in, not audited) ----
    @app.get("/healthz")
    def healthz():
        """Liveness: the process answers (no database call)."""
        from . import __version__
        return {"status": "ok", "version": __version__}

    @app.get("/readyz")
    def readyz():
        """Readiness: the stores this process needs answer (503 names what failed)."""
        checks = {}

        def check(name, fn):
            try:
                fn()
                checks[name] = "ok"
            except Exception as exc:  # noqa: BLE001 - reported, never raised
                checks[name] = "failed: %s" % type(exc).__name__
        check("dashboards", store.list_users)
        check("governance", governance.group_names)
        check("schedules", lambda: schedules.due(datetime.datetime.now(datetime.timezone.utc)))
        check("audit", lambda: audit.query(limit=1))
        check("datasets", lambda: dataset_store_for(None).list("__readyz__"))
        if scheduler_enabled:
            checks["scheduler"] = "ok" if scheduler.running else "failed: not running"
        ready = all(v == "ok" for v in checks.values())
        return JSONResponse({"status": "ready" if ready else "not ready", "checks": checks},
                            status_code=200 if ready else 503)

    @app.get("/auth/config")
    def auth_config():
        """How users sign in here (the login page adapts to it)."""
        return {"password": not (oidc and oidc.config.only),
                "signup": bool(allow_signup) and not (oidc and oidc.config.only),
                "oidc": {"enabled": bool(oidc), "name": oidc.config.name if oidc else None}}

    @app.post("/auth/signup")
    async def signup(request: Request):
        if not allow_signup or (oidc and oidc.config.only):
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
        request.session["auth_at"] = int(time.time())
        return {"user": username}

    @app.post("/auth/login")
    async def login(request: Request):
        body = await request.json()
        username, password = body.get("username", ""), body.get("password", "")
        note(request, target=username)   # also recorded when the attempt fails
        # With single sign-on only, passwords are for the break-glass admins in CXD_ADMINS.
        if oidc and oidc.config.only and username not in admins:
            raise HTTPException(status_code=403, detail="Sign in with %s" % oidc.config.name)
        if identities.is_linked(username):
            raise HTTPException(status_code=401, detail="This account signs in with %s"
                                % (oidc.config.name if oidc else "single sign-on"))
        if not store.check_user(username, password):
            raise HTTPException(status_code=401, detail="Invalid username or password")
        request.session["user"] = username
        request.session["auth_at"] = int(time.time())
        return {"user": username}

    @app.post("/auth/logout")
    async def logout(request: Request):
        id_token = request.session.get("id_token")
        sso = request.session.get("sso")
        request.session.clear()
        logout_url = None
        if oidc and sso:
            try:
                logout_url = await run_in_threadpool(
                    oidc.logout_url, id_token, app_url(request))
            except OidcError:
                logout_url = None
        return {"user": None, "logout_url": logout_url}

    def app_url(request: Request) -> str:
        return (publish_base_url or str(request.base_url)).rstrip("/") + "/"

    def oidc_redirect_uri(request: Request) -> str:
        return oidc.config.redirect_url or app_url(request) + "auth/oidc/callback"

    def sso_error(message: str, status: int = 401) -> HTMLResponse:
        return HTMLResponse(
            "<!doctype html><meta charset='utf-8'><title>Sign-in failed</title>"
            "<body style='font-family:system-ui;max-width:560px;margin:10vh auto'>"
            "<h2>Sign-in failed</h2><p>%s</p><p><a href='%s'>Try again</a></p></body>"
            % (html.escape(message), html.escape(app_url_for_errors)), status_code=status)
    app_url_for_errors = (publish_base_url or "").rstrip("/") + "/"

    @app.get("/auth/oidc/login")
    def oidc_login(request: Request, prompt: Optional[str] = None):
        """Start single sign-on: send the browser to the identity provider."""
        if not oidc:
            raise HTTPException(status_code=404, detail="Single sign-on is not configured")
        verifier, challenge = pkce_pair()
        state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        request.session["oidc"] = {"state": state, "nonce": nonce, "verifier": verifier,
                                   "at": int(time.time())}
        try:
            url = oidc.authorize_url(oidc_redirect_uri(request), state, nonce, challenge, prompt)
        except OidcError as exc:
            return sso_error(str(exc), 502)
        return RedirectResponse(url, status_code=302)

    @app.get("/auth/oidc/callback")
    def oidc_callback(request: Request, code: str = "", state: str = "", error: str = "",
                      error_description: str = ""):
        """Finish single sign-on: verify the provider's answer and sign the user in."""
        if not oidc:
            raise HTTPException(status_code=404, detail="Single sign-on is not configured")
        pending = request.session.pop("oidc", None) or {}
        if error:
            note(request, error=error)
            return sso_error("The identity provider said: %s" % (error_description or error))
        if not code or not state or not pending or not secrets.compare_digest(
                state, pending.get("state", "")) or time.time() - pending.get("at", 0) > 600:
            note(request, error="state")
            return sso_error("This sign-in link expired or was not started here. Try again.")
        try:
            tokens = oidc.exchange(code, oidc_redirect_uri(request), pending["verifier"])
            claims = oidc.verify_id_token(tokens["id_token"], pending["nonce"])
            cfg = oidc.config
            info = claims
            wants_more = ("email" not in claims
                          or (cfg.groups_claim and cfg.groups_claim not in claims))
            if wants_more:
                extra = oidc.userinfo(tokens.get("access_token"))
                if extra.get("sub") == claims["sub"]:
                    info = dict(extra, **claims)
            if cfg.allowed_domains:
                domain = str(info.get("email") or "").rsplit("@", 1)[-1].lower()
                if domain not in cfg.allowed_domains or not info.get("email_verified", True):
                    raise OidcError("Accounts from this email domain cannot sign in here")
            issuer = claims["iss"]
            username = identities.username_for(issuer, claims["sub"])
            created = False
            if username is None:
                username = username_from(info, cfg.username_claim)
                if username in store.list_users():
                    if identities.is_linked(username) or not cfg.link_existing:
                        raise OidcError("An account named '%s' already exists here. Ask an "
                                        "administrator to link it." % username)
                else:
                    store.create_user(username, secrets.token_urlsafe(32))
                    created = True
            identities.link(issuer, claims["sub"], username, _now_iso())
        except OidcError as exc:
            note(request, error=str(exc)[:200])
            return sso_error(str(exc))
        groups = groups_from(info, cfg.groups_claim)
        if groups is not None:
            governance.sync_managed_groups(username, groups, "oidc", _now_iso())
        if cfg.admin_groups and username not in admins:
            store.set_admin(username, bool(set(groups or []) & set(cfg.admin_groups)))
        email = info.get("email")
        if isinstance(email, str) and email and info.get("email_verified") is True:
            try:
                if schedules.profile(username)["email"] != email:
                    schedules.set_email(username, email, verified=True)
            except ScheduleError:
                pass
        request.session.clear()   # a fresh session for the signed-in user
        request.session["user"] = username
        request.session["sso"] = issuer
        request.session["id_token"] = tokens["id_token"]
        request.session["auth_at"] = int(time.time())
        note(request, target=username, issuer=issuer, created=created or None,
             groups=len(groups) if groups is not None else None)
        return RedirectResponse(app_url(request), status_code=302)

    @app.get("/auth/me")
    def me(request: Request):
        user = request.session.get("user")
        return {"user": user, "is_admin": user_is_admin(user),
                "sso": bool(request.session.get("sso")),
                "permissions": sorted(permissions_of(user)),
                "groups": governance.groups_of(user),
                "roles": governance.roles_of(user) if user else []}

    # ---- admin: user management (gated by CXD_ADMINS) ----
    @app.get("/api/admin/users")
    def admin_list_users(request: Request):
        require_admin(request)
        assigned = governance.assignments()
        profiles = schedules.profiles()
        return {"users": [
            {"username": name, "is_admin": user_is_admin(name),
             "via_config": name in admins,
             "dashboards": len(store.list_dashboards(name)),
             "role": assigned.get("user:" + name),
             "email": (profiles.get(name) or {}).get("email"),
             "email_verified": bool((profiles.get(name) or {}).get("verified")),
             "roles": governance.roles_of(name),
             "groups": governance.groups_of(name)}
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
        governance.forget_user(username)
        schedules.forget_user(username)
        identities.forget_user(username)
        return {"users": store.list_users()}

    def resolve_write_owner(user: str, owner: Optional[str],
                            dashboard_id: Optional[str] = None) -> str:
        """The owner a write targets: the caller, unless ``?owner=`` names
        another owner. An admin may (to maintain the shared examples owned by
        ``examples_owner``); so may a user with an ``edit`` grant on that
        dashboard, unless it is locked. 403 otherwise."""
        if owner and owner != user:
            if user_is_admin(user) or is_disposable(owner, dashboard_id):
                return owner
            if dashboard_id and governance.access_level(
                    user, "dashboard", owner, dashboard_id) == "edit":
                if store.is_locked(owner, dashboard_id):
                    raise HTTPException(status_code=403, detail="Dashboard is locked")
                return owner
            raise HTTPException(status_code=403, detail="Admin access required")
        return user

    def foreign_dashboard_owner(user: str, dashboard_id: str) -> Optional[str]:
        """The owner of a dashboard with this id that ``user`` sees but does
        not own (a shipped example or one shared with them), else None."""
        if examples_owner and examples_owner != user \
                and store.get_summary(examples_owner, dashboard_id) is not None:
            return examples_owner
        for g in governance.shared_with(user, "dashboard"):
            if g["id"] == dashboard_id and g["owner"] != user:
                return g["owner"]
        return None

    # ---- dashboard CRUD (owner-isolated; examples read-merged) ----
    @app.get("/api/dashboards")
    def list_dashboards(request: Request):
        user = require_user(request)
        rows = []
        for d in store.list_dashboards(user):
            row = dict(d, owner=user)
            # Who the owner shared it with (for the list's share icon / tooltip).
            grants = governance.grants_on("dashboard", user, d["id"])
            if grants:
                row["sharedWith"] = grants
            rows.append(row)
        # Merge the shared example dashboards (read-only unless the viewer is admin).
        if examples_owner and examples_owner != user:
            own_ids = {d["id"] for d in rows}
            editable = user_is_admin(user)
            for d in store.list_dashboards(examples_owner):
                if d["id"] in own_ids:
                    continue
                rows.append(dict(d, owner=examples_owner, example=True, readOnly=not editable))
        # Dashboards shared with the user, a group of theirs, or everyone.
        seen = {(d["owner"], d["id"]) for d in rows}
        for g in governance.shared_with(user, "dashboard"):
            if (g["owner"], g["id"]) in seen:
                continue
            summary = store.get_summary(g["owner"], g["id"])
            if summary is not None:
                rows.append(dict(summary, owner=g["owner"], shared=True, access=g["level"],
                                 readOnly=g["level"] != "edit"))
        for row in rows:
            if is_disposable(row["owner"], row["id"]):
                row["disposable"] = True
        return {"dashboards": rows}

    @app.post("/api/dashboards")
    async def save_dashboard(request: Request, owner: Optional[str] = None, lock: Optional[int] = None):
        user = require_user(request)
        spec = await request.json()
        if not isinstance(spec, dict) or not spec.get("id"):
            raise HTTPException(status_code=400, detail="Body must be a dashboard spec with an id")
        target = resolve_write_owner(user, owner, spec["id"])
        # A NEW dashboard of yours may not take the id of one you can see but do
        # not own (a shipped example, one shared with you, a locked board): that
        # would silently fork it under the same name. Save it under another name
        # (or, with edit access, save back to its owner via ?owner=).
        if target == user and store.get_summary(user, spec["id"]) is None:
            taken_by = foreign_dashboard_owner(user, spec["id"])
            if taken_by:
                raise HTTPException(status_code=409, detail=(
                    'A dashboard named "%s" already exists (owner: %s). Save your '
                    "changes under another name." % (spec["id"], taken_by)))
        if target == user and "dashboard.create" not in permissions_of(user):
            raise HTTPException(status_code=403, detail="Your role does not allow this: "
                                + PERMISSIONS["dashboard.create"].lower())
        _unpin_dataset_owners(spec, target)
        note(request, target=spec["id"], owner=target,
             created=store.get_summary(target, spec["id"]) is None, lock=lock)
        saved = store.save_dashboard(target, spec, _now_iso())
        # Every save is also an immutable version (electronic record).
        version = records.add_version(target, spec, user, _now_iso())
        saved = dict(saved, version=version["version"])
        note(request, version=version["version"])
        # An admin may lock/unlock in the same call (e.g. saving a new example).
        if lock is not None and user_is_admin(user):
            store.set_locked(target, spec["id"], bool(lock))
            saved = store.get_summary(target, spec["id"])
        return {"dashboard": saved}

    @app.get("/api/dashboards/{dashboard_id}")
    def get_dashboard(request: Request, dashboard_id: str, owner: Optional[str] = None):
        user = require_user(request)
        spec, spec_owner = None, user
        if owner and owner != user:
            # Another owner's dashboard: admins, the examples, or a grant.
            spec_owner = owner
            if (user_is_admin(user) or owner == examples_owner or is_disposable(owner, dashboard_id)
                    or governance.access_level(user, "dashboard", owner, dashboard_id)):
                spec = store.get_dashboard(owner, dashboard_id)
        else:
            spec = store.get_dashboard(user, dashboard_id)
            # Fall back to the shared example owner so viewers can open examples,
            # then to dashboards shared with the user.
            if spec is None and examples_owner and examples_owner != user:
                spec = store.get_dashboard(examples_owner, dashboard_id)
                spec_owner = examples_owner
            if spec is None:
                for g in governance.shared_with(user, "dashboard"):
                    if g["id"] == dashboard_id:
                        spec = store.get_dashboard(g["owner"], dashboard_id)
                        spec_owner = g["owner"]
                        break
        if spec is None:
            raise HTTPException(status_code=404, detail="No such dashboard")
        if spec_owner != user:
            # Stored datasets resolve against the dashboard's owner, not the viewer.
            _pin_dataset_owners(spec, spec_owner)
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
            # A disposable scratch dashboard may be deleted by anyone signed in.
            if not (user_is_admin(user) or is_disposable(owner, dashboard_id)):
                raise HTTPException(status_code=403, detail="Admin access required")
            target = owner
        # Locked dashboards are protected; only an admin may delete them.
        note(request, owner=target)
        if (store.is_locked(target, dashboard_id) and not user_is_admin(user)
                and not is_disposable(target, dashboard_id)):
            raise HTTPException(status_code=403, detail="Dashboard is locked")
        store.delete_dashboard(target, dashboard_id)
        governance.forget_resource("dashboard", target, dashboard_id)
        return {"dashboards": store.list_dashboards(user)}

    # ---- sharing ----
    @app.post("/api/dashboards/{dashboard_id}/share")
    async def share_dashboard(request: Request, dashboard_id: str):
        user = require_user(request)
        body = await request.json() if _has_body(request) else {}
        visibility = (body or {}).get("visibility", "public")
        note(request, owner=user, visibility=visibility)
        if visibility != "private" and "share.public" not in permissions_of(user):
            raise HTTPException(status_code=403, detail="Your role does not allow this: "
                                + PERMISSIONS["share.public"].lower())
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
        # Row/column security applies with the viewer's principals (anonymous
        # when not signed in); a source pinned to another owner resolves only
        # if the sharing owner may read it.
        spec = shared["spec"]
        viewer = request.session.get("user")
        for ref, source in list((spec.get("data") or {}).items()):
            if not (isinstance(source, dict) and source.get("kind") == "dataset"):
                continue
            data_owner = source.get("owner") or shared["owner"]
            if data_owner != shared["owner"] and not dataset_access(
                    shared["owner"], data_owner, source.get("store"), source.get("id")):
                continue
            try:
                data = dataset_store_for(source.get("store")).get(data_owner, source.get("id"))
            except KeyError:
                data = None
            if data is not None:
                data = secured(data, viewer, data_owner, source.get("store"), source.get("id"))
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
        # Datasets shared with the user directly (dashboard grants reach the
        # data through the dashboard instead).
        listed = {(d["owner"], store_key(d.get("store")), d["id"]) for d in datasets}
        for g in governance.shared_with(user, "dataset"):
            if (g["owner"], g["store"], g["id"]) in listed:
                continue
            try:
                summaries = dataset_store_for(g["store"] or None).list(g["owner"])
            except KeyError:
                continue
            for d in summaries:
                if d["id"] == g["id"]:
                    datasets.append(dict(d, owner=g["owner"], shared=True, access=g["level"],
                                         readOnly=True))
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
        if "dataset.create" not in permissions_of(user):
            raise HTTPException(status_code=403, detail="Your role does not allow this: "
                                + PERMISSIONS["dataset.create"].lower())
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
    def get_dataset(request: Request, dataset_id: str, store: Optional[str] = None,
                    owner: Optional[str] = None):
        user = require_user(request)
        ds_store = resolve_dataset_store(store)
        data, data_owner = None, user
        if owner and owner != user:
            # Another owner's dataset (a source pinned by a shared dashboard, or a
            # dataset grant): only with access; 404 hides whether it exists.
            data_owner = owner
            if dataset_access(user, owner, store, dataset_id):
                data = ds_store.get(owner, dataset_id)
        else:
            data = ds_store.get(user, dataset_id)
            # Fall back to the shared example owner so viewers can read example data.
            if data is None and examples_owner and examples_owner != user:
                data = ds_store.get(examples_owner, dataset_id)
                data_owner = examples_owner
        if data is None:
            raise HTTPException(status_code=404, detail="No such dataset")
        note(request, owner=data_owner, store=store)
        data = secured(data, user, data_owner, store, dataset_id)
        if data is None:
            raise HTTPException(status_code=403, detail="Withheld by the dataset's security policy")
        # Any extra query params are sample-annotation filters (the parameterized
        # dataset path for live-data controls): keep only matching samples. Only
        # keys that name a real annotation participate, so nothing here executes
        # a query or trusts the key/value beyond an equality mask.
        filters = {k: v for k, v in request.query_params.items() if k not in ("store", "owner")}
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
        governance.forget_resource("dataset", target, dataset_id, store_key(store))
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

    # ---- governance: sharing with users/groups, dataset security, lineage ----
    def owned_resource(request: Request, resource: str, rid: str, owner: Optional[str],
                       store_name: Optional[str]) -> tuple:
        """``(user, owner)`` when the caller owns (or, as admin, may manage) an
        existing dashboard/dataset; 403/404 otherwise."""
        user = require_user(request)
        owner = owner or user
        if owner != user and not user_is_admin(user):
            raise HTTPException(status_code=403, detail="Only the owner can manage this")
        if resource == "dashboard":
            exists = store.get_summary(owner, rid) is not None
        else:
            exists = any(d["id"] == rid for d in resolve_dataset_store(store_name).list(owner))
        if not exists:
            raise HTTPException(status_code=404, detail="No such %s" % resource)
        return user, owner

    async def change_grant(request: Request, resource: str, rid: str, owner: Optional[str],
                           store_name: Optional[str]) -> dict:
        require_permission(request, "share.grant")
        _, owner = owned_resource(request, resource, rid, owner, store_name)
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("principal"), str):
            raise HTTPException(status_code=400, detail="Body must be {principal, level}")
        principal = body["principal"].strip()
        level = body.get("level") or None
        if level is not None:
            check_principal(principal)
        if principal == "user:" + owner:
            raise HTTPException(status_code=400, detail="The owner already has full access")
        key = store_key(store_name) if resource == "dataset" else ""
        note(request, owner=owner, principal=principal, level=level or "revoked")
        try:
            governance.set_grant(resource, owner, rid, principal, level, key)
        except GovernanceError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"grants": governance.grants_on(resource, owner, rid, key)}

    @app.get("/api/directory")
    def directory(request: Request):
        """Users and groups a dashboard/dataset can be shared with. Administrators
        are left out: they always have full access (view, change, delete)."""
        require_user(request)
        users = [u for u in store.list_users() if not user_is_admin(u)]
        return {"users": users, "groups": governance.group_names()}

    @app.get("/api/dashboards/{dashboard_id}/grants")
    def dashboard_grants(request: Request, dashboard_id: str, owner: Optional[str] = None):
        _, owner = owned_resource(request, "dashboard", dashboard_id, owner, None)
        return {"grants": governance.grants_on("dashboard", owner, dashboard_id)}

    @app.post("/api/dashboards/{dashboard_id}/grants")
    async def dashboard_grant(request: Request, dashboard_id: str, owner: Optional[str] = None):
        return await change_grant(request, "dashboard", dashboard_id, owner, None)

    @app.get("/api/datasets/{dataset_id}/grants")
    def dataset_grants(request: Request, dataset_id: str, store: Optional[str] = None,
                       owner: Optional[str] = None):
        _, owner = owned_resource(request, "dataset", dataset_id, owner, store)
        return {"grants": governance.grants_on("dataset", owner, dataset_id, store_key(store))}

    @app.post("/api/datasets/{dataset_id}/grants")
    async def dataset_grant(request: Request, dataset_id: str, store: Optional[str] = None,
                            owner: Optional[str] = None):
        return await change_grant(request, "dataset", dataset_id, owner, store)

    @app.get("/api/datasets/{dataset_id}/policy")
    def dataset_policy(request: Request, dataset_id: str, store: Optional[str] = None,
                       owner: Optional[str] = None):
        _, owner = owned_resource(request, "dataset", dataset_id, owner, store)
        return {"policy": governance.get_policy(owner, dataset_id, store_key(store))}

    @app.put("/api/datasets/{dataset_id}/policy")
    async def set_dataset_policy(request: Request, dataset_id: str, store: Optional[str] = None,
                                 owner: Optional[str] = None):
        """Set (or with ``{"policy": null}``, clear) a dataset's row/column security."""
        _, owner = owned_resource(request, "dataset", dataset_id, owner, store)
        body = await request.json()
        if not isinstance(body, dict) or "policy" not in body:
            raise HTTPException(status_code=400, detail="Body must be {policy}")
        try:
            policy = governance.set_policy(owner, dataset_id, body["policy"], store_key(store),
                                           _now_iso())
        except GovernanceError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        note(request, owner=owner, store=store,
             rows=len((policy or {}).get("rows") or []),
             columns=len((policy or {}).get("columns") or []))
        return {"policy": policy}

    def lineage_for(owners_and_ids) -> dict:
        def dataset_owner(dash_owner: str, store_name: str, dataset_id: str) -> str:
            # An unpinned source reads the dashboard owner's dataset, else the example.
            try:
                ds = dataset_store_for(store_name or None)
                if (examples_owner and dash_owner != examples_owner
                        and ds.get(dash_owner, dataset_id) is None
                        and ds.get(examples_owner, dataset_id) is not None):
                    return examples_owner
            except KeyError:
                pass
            return dash_owner
        specs = []
        for owner, dashboard_id in owners_and_ids:
            spec = store.get_dashboard(owner, dashboard_id)
            if spec is not None:
                specs.append((owner, spec))
        return build_lineage(specs, dataset_owner)

    @app.get("/api/lineage")
    def lineage(request: Request):
        """Where the data of the dashboards the user can open comes from."""
        user = require_user(request)
        pairs = [(user, d["id"]) for d in store.list_dashboards(user)]
        pairs += [(g["owner"], g["id"]) for g in governance.shared_with(user, "dashboard")]
        return lineage_for(pairs)

    @app.get("/api/admin/lineage")
    def admin_lineage(request: Request):
        """Lineage across every user's dashboards."""
        require_admin(request)
        owners = list(store.list_users())
        if examples_owner and examples_owner not in owners:
            owners.append(examples_owner)
        return lineage_for([(o, d["id"]) for o in owners for d in store.list_dashboards(o)])

    # ---- admin: roles and groups ----
    @app.get("/api/admin/governance")
    def admin_governance(request: Request):
        require_admin(request)
        return {"permissions": [{"name": k, "description": v} for k, v in PERMISSIONS.items()],
                "roles": governance.list_roles(), "groups": governance.list_groups(),
                "assignments": governance.assignments(),
                "default_role": governance.default_role}

    @app.post("/api/admin/groups")
    async def admin_save_group(request: Request):
        require_admin(request)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object")
        members = body.get("members")
        if members is not None:
            users = set(store.list_users())
            unknown = [m for m in members if m not in users] if isinstance(members, list) else [1]
            if unknown:
                raise HTTPException(status_code=400, detail="Unknown member(s): %s"
                                    % ", ".join(str(m) for m in unknown))
        note(request, target=body.get("name"), members=len(members or []) if members else None,
             role=body.get("role"))
        try:
            group = governance.save_group(body.get("name"), body.get("description") or "",
                                          members, _now_iso())
            if "role" in body:
                governance.assign_role("group:" + group["name"], body.get("role") or None)
        except GovernanceError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"groups": governance.list_groups()}

    @app.delete("/api/admin/groups/{group_name}")
    def admin_delete_group(request: Request, group_name: str):
        require_admin(request)
        if not governance.delete_group(group_name):
            raise HTTPException(status_code=404, detail="No such group")
        return {"groups": governance.list_groups()}

    @app.post("/api/admin/roles")
    async def admin_save_role(request: Request):
        require_admin(request)
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("permissions", []), list):
            raise HTTPException(status_code=400, detail="Body must be {name, permissions}")
        note(request, target=body.get("name"), permissions=body.get("permissions"))
        try:
            governance.save_role(body.get("name"), body.get("permissions") or [],
                                 body.get("description") or "")
        except GovernanceError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"roles": governance.list_roles()}

    @app.delete("/api/admin/roles/{role_name}")
    def admin_delete_role(request: Request, role_name: str):
        require_admin(request)
        try:
            if not governance.delete_role(role_name):
                raise HTTPException(status_code=404, detail="No such role")
        except GovernanceError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"roles": governance.list_roles()}

    @app.post("/api/admin/roles/assign")
    async def admin_assign_role(request: Request):
        """Assign a role to ``user:<name>`` / ``group:<name>`` (``role: null`` clears it)."""
        require_admin(request)
        body = await request.json()
        principal = (body or {}).get("principal") if isinstance(body, dict) else None
        if not isinstance(principal, str) or principal == "*":
            raise HTTPException(status_code=400, detail="Body must be {principal, role}")
        check_principal(principal)
        note(request, target=principal, role=body.get("role"))
        try:
            governance.assign_role(principal, body.get("role") or None)
        except GovernanceError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"assignments": governance.assignments()}

    # ---- electronic records: version history and e-signatures ----
    def record_access(request: Request, dashboard_id: str, owner: Optional[str],
                      edit: bool = False) -> tuple:
        """``(user, owner)`` for a dashboard the caller may open (``edit``: change)."""
        user = require_user(request)
        owner = owner or user
        if edit:
            allowed = owner == user or user_is_admin(user) or governance.access_level(
                user, "dashboard", owner, dashboard_id) == "edit"
        else:
            allowed = dashboard_access(user, owner, dashboard_id)
        if not allowed:
            raise HTTPException(status_code=404, detail="No such dashboard")
        note(request, owner=owner)
        return user, owner

    @app.get("/api/dashboards/{dashboard_id}/versions")
    def dashboard_versions(request: Request, dashboard_id: str, owner: Optional[str] = None):
        """The dashboard's saved versions (newest first) with their signatures."""
        user, owner = record_access(request, dashboard_id, owner)
        versions = records.versions(owner, dashboard_id)
        if not versions:
            current = store.get_dashboard(owner, dashboard_id)
            if current is None:
                raise HTTPException(status_code=404, detail="No such dashboard")
            # Saved before versions were kept: its current content becomes v1.
            records.add_version(owner, current, None, _now_iso(), note="baseline")
            versions = records.versions(owner, dashboard_id)
        return {"versions": versions, "meanings": signature_meanings,
                "can_sign": "dashboard.sign" in permissions_of(user),
                "reauth": "sso" if request.session.get("sso") else "password"}

    @app.get("/api/dashboards/{dashboard_id}/versions/{version}")
    def dashboard_version(request: Request, dashboard_id: str, version: int,
                          owner: Optional[str] = None):
        _, owner = record_access(request, dashboard_id, owner)
        spec = records.version_spec(owner, dashboard_id, version)
        if spec is None:
            raise HTTPException(status_code=404, detail="No such version")
        return {"version": records.version_info(owner, dashboard_id, version), "spec": spec}

    @app.post("/api/dashboards/{dashboard_id}/versions/{version}/restore")
    def restore_version(request: Request, dashboard_id: str, version: int,
                        owner: Optional[str] = None):
        """Make an old version current again (saved as a new version)."""
        user, owner = record_access(request, dashboard_id, owner, edit=True)
        if store.is_locked(owner, dashboard_id) and not user_is_admin(user):
            raise HTTPException(status_code=403, detail="Dashboard is locked")
        spec = records.version_spec(owner, dashboard_id, version)
        if spec is None:
            raise HTTPException(status_code=404, detail="No such version")
        store.save_dashboard(owner, spec, _now_iso())
        restored = records.add_version(owner, spec, user, _now_iso(),
                                       note="restored from version %d" % version)
        note(request, restored_from=version, version=restored["version"])
        return {"version": restored}

    @app.post("/api/dashboards/{dashboard_id}/sign")
    async def sign_dashboard(request: Request, dashboard_id: str, owner: Optional[str] = None):
        """Electronically sign a version: ``{version, meaning, password?}``.

        The signer re-authenticates: a password account enters its password; a
        single sign-on account must have signed in within the last few minutes.
        """
        user, owner = record_access(request, dashboard_id, owner)
        if "dashboard.sign" not in permissions_of(user):
            raise HTTPException(status_code=403, detail="Your role does not allow this: "
                                + PERMISSIONS["dashboard.sign"].lower())
        body = await request.json()
        body = body if isinstance(body, dict) else {}
        meaning = body.get("meaning")
        if meaning not in signature_meanings:
            raise HTTPException(status_code=400, detail="meaning must be one of: "
                                + ", ".join(signature_meanings))
        try:
            version = int(body.get("version"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Say which version to sign")
        if request.session.get("sso"):
            if time.time() - request.session.get("auth_at", 0) > reauth_seconds:
                note(request, meaning=meaning, version=version, reauth="required")
                raise HTTPException(status_code=401, detail="reauth: sign in again with "
                                    "single sign-on to sign")
            method = "sso"
        else:
            password = body.get("password") or ""
            if not await run_in_threadpool(store.check_user, user, password):
                note(request, meaning=meaning, version=version, reauth="failed")
                raise HTTPException(status_code=401, detail="The password is not correct")
            method = "password"
        try:
            signature = records.sign(owner, dashboard_id, version, user, meaning, _now_iso(),
                                     method)
        except RecordError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        note(request, meaning=meaning, version=version, sha256=signature["sha256"][:16],
             method=method)
        return {"signature": signature}

    @app.get("/api/admin/signatures/verify")
    def verify_signatures(request: Request):
        """Re-check the signature chain and every signed version's content."""
        require_admin(request)
        return records.verify_signatures()

    # ---- scheduling: dataset refresh, alerts, dashboard subscriptions ----
    def dashboard_access(user: Optional[str], owner: str, dashboard_id: str) -> bool:
        if not user:
            return False
        return (user == owner or user_is_admin(user) or (examples_owner and owner == examples_owner)
                or bool(governance.access_level(user, "dashboard", owner, dashboard_id)))

    def dashboard_link(owner: str, dashboard_id: str) -> Optional[str]:
        if not publish_base_url:
            return None
        from urllib.parse import quote
        return dashboard_url.format(base=publish_base_url.rstrip("/"), id=quote(dashboard_id),
                                    owner=quote(owner))

    class _JobContext:
        pass
    ctx = _JobContext()
    ctx.schedules, ctx.governance, ctx.dashboards, ctx.audit = schedules, governance, store, audit
    ctx.mailer, ctx.snapshots, ctx.origin_fetchers = mailer, snapshots, origin_fetchers
    ctx.dataset_store_for = lambda name: dataset_store_for(name or None)
    ctx.store_key, ctx.dataset_access, ctx.secured = store_key, dataset_access, secured
    ctx.dashboard_access, ctx.dashboard_link = dashboard_access, dashboard_link
    ctx.app_link = lambda: publish_base_url.rstrip("/") + "/" if publish_base_url else None
    ctx.list_users, ctx.now_iso = store.list_users, _now_iso
    ctx.allow_private = os.getenv("CXD_FETCH_ALLOW_PRIVATE", "0") == "1"
    ctx.email_cap = email_cap
    jobs = Jobs(ctx)
    try:
        tick = float(os.getenv("CXD_SCHEDULER_TICK", "30") or 30)
    except ValueError:
        tick = 30.0
    scheduler = Scheduler(schedules, jobs, tick=tick)
    jobs.run_related = scheduler.run_now
    jobs_holder["scheduler"] = scheduler
    app.state.scheduler = scheduler

    def own_schedule(request: Request, schedule_id: str) -> dict:
        user = require_user(request)
        found = schedules.get(schedule_id)
        if found is None or (found["owner"] != user and not user_is_admin(user)):
            raise HTTPException(status_code=404, detail="No such schedule")
        note(request, owner=found["owner"], kind=found["kind"])
        return found

    @app.get("/api/schedules/status")
    def schedules_status(request: Request):
        """What scheduling can do on this server (the UI adapts to it)."""
        user = require_user(request)
        return {"scheduler": scheduler.running if scheduler_enabled else False,
                "enabled": bool(scheduler_enabled),
                "email": mailer is not None,
                "snapshots": bool(snapshots and snapshots.available()),
                "links": bool(publish_base_url),
                "origins": ["url"] + sorted(k for k in origin_fetchers if k != "url"),
                "can_create": "schedule.create" in permissions_of(user),
                "email_address": schedules.profile(user)["email"],
                "email_verified": schedules.profile(user)["verified"] or not verify_emails,
                "email_daily_cap": email_cap}

    @app.get("/api/schedules")
    def list_schedules(request: Request, all: bool = False):
        """The user's schedules (``?all=1``: an admin sees everyone's)."""
        user = require_user(request)
        return {"schedules": schedules.list(None if all and user_is_admin(user) else user)}

    @app.post("/api/schedules")
    async def save_schedule(request: Request):
        """Create or update a schedule: ``{id?, kind, name, cron, tz, enabled, config}``."""
        user = require_permission(request, "schedule.create")
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object")
        schedule_id = body.get("id") or None
        if schedule_id:
            existing = schedules.get(schedule_id)
            if existing is None or existing["owner"] != user:
                raise HTTPException(status_code=404, detail="No such schedule")
        note(request, target=schedule_id, kind=body.get("kind"), cron=body.get("cron"))
        try:
            config = jobs.validate(user, body.get("kind"), body.get("config"))
            saved = schedules.save(user, body.get("kind"), body.get("name") or "",
                                   body.get("cron") or "", body.get("tz") or "UTC", config,
                                   enabled=body.get("enabled", True) is not False,
                                   schedule_id=schedule_id)
        except ScheduleError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        note(request, target=saved["id"])
        return {"schedule": saved}

    @app.delete("/api/schedules/{schedule_id}")
    def delete_schedule(request: Request, schedule_id: str):
        user = require_user(request)
        own_schedule(request, schedule_id)
        schedules.delete(schedule_id)
        return {"schedules": schedules.list(user)}

    @app.post("/api/schedules/{schedule_id}/run")
    async def run_schedule(request: Request, schedule_id: str):
        """Run a schedule now (its next scheduled run is unchanged)."""
        found = own_schedule(request, schedule_id)
        run = await run_in_threadpool(scheduler.run_now, found, "manual")
        note(request, status=run["status"])
        return {"run": run, "schedule": schedules.get(schedule_id)}

    @app.get("/api/schedules/{schedule_id}/runs")
    def schedule_runs(request: Request, schedule_id: str, limit: int = 20):
        own_schedule(request, schedule_id)
        return {"runs": schedules.runs(schedule_id, limit)}

    @app.get("/api/cron/preview")
    def cron_preview(request: Request, cron: str, tz: str = "UTC", count: int = 3):
        """Check a cron expression: its reading and the next few run times (UTC)."""
        require_user(request)
        try:
            parsed = Cron(cron)
            times, when = [], datetime.datetime.now(datetime.timezone.utc)
            for _ in range(max(1, min(count, 10))):
                when = parsed.next_after(when, tz)
                times.append(when.isoformat(timespec="seconds"))
        except ScheduleError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"description": parsed.describe(), "next": times}

    # ---- profile (the address alerts and subscriptions go to) ----
    # A new address must be confirmed (a link emailed to it) before anything else
    # is sent there, so nobody can point the server's email at someone else.
    def profile_body(user: str, sent: Optional[bool] = None) -> dict:
        p = schedules.profile(user)
        out = {"user": user, "email": p["email"], "verified": p["verified"] or not verify_emails}
        if sent is not None:
            out["confirmation_sent"] = sent
        return out

    def send_confirmation(request: Request, user: str) -> bool:
        if not verify_emails or mailer is None:
            return False
        token = schedules.confirmation_token(user, datetime.datetime.now(datetime.timezone.utc))
        email = schedules.profile(user)["email"]
        if not token or not email:
            return False
        from urllib.parse import quote
        base = (publish_base_url or str(request.base_url)).rstrip("/")
        link = "%s/api/me/verify-email?token=%s" % (base, quote(token))
        text = ("Confirm this address for CanvasXpress Dashboards (user %s):\n\n%s\n\n"
                "Alerts and emailed dashboards are sent here only after you confirm. If you did "
                "not ask for this, ignore this email." % (user, link))
        body = ("<p>Confirm this address for CanvasXpress Dashboards (user <b>%s</b>):</p>"
                "<p><a href='%s'>Confirm my email address</a></p><p style='color:#777;"
                "font-size:12px'>Alerts and emailed dashboards are sent here only after you "
                "confirm. If you did not ask for this, ignore this email.</p>"
                % (html.escape(user), html.escape(link)))
        mailer.send([(email, "Confirm your email address", text, body, [])])
        return True

    @app.get("/api/me/profile")
    def my_profile(request: Request):
        return profile_body(require_user(request))

    @app.put("/api/me/profile")
    async def set_my_profile(request: Request):
        user = require_user(request)
        body = await request.json()
        try:
            email = schedules.set_email(user, (body or {}).get("email"),
                                        verified=not verify_emails)
        except ScheduleError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        sent = False
        if email and not schedules.profile(user)["verified"]:
            try:
                sent = await run_in_threadpool(send_confirmation, request, user)
            except Exception as exc:  # noqa: BLE001 - report, keep the address
                raise HTTPException(status_code=502, detail="Could not send the confirmation "
                                    "email: %s" % exc)
        note(request, email_set=bool(email), confirmation_sent=sent or None)
        return profile_body(user, sent)

    @app.post("/api/me/profile/confirm")
    async def resend_confirmation(request: Request):
        """Send the confirmation link again (at most once every ten minutes)."""
        user = require_user(request)
        try:
            sent = await run_in_threadpool(send_confirmation, request, user)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail="Could not send the email: %s" % exc)
        return profile_body(user, sent)

    @app.get("/api/me/verify-email", response_class=HTMLResponse)
    def verify_email(request: Request, token: str = ""):
        """The link in the confirmation email (the token is the credential)."""
        user = schedules.verify_token(token)
        note(request, target=user, verified=bool(user))
        base = (publish_base_url or "").rstrip("/") + "/"
        message = ("Your email address is confirmed. Alerts and emailed dashboards will "
                   "reach it." if user else "This confirmation link is not valid (it was "
                   "already used, or the address changed since).")
        return HTMLResponse("<!doctype html><meta charset='utf-8'><title>Email address</title>"
                            "<body style='font-family:system-ui;max-width:560px;margin:10vh auto'>"
                            "<h2>%s</h2><p>%s</p><p><a href='%s'>Open CanvasXpress Dashboards</a>"
                            "</p></body>" % ("Confirmed" if user else "Link not valid", message,
                                             html.escape(base)),
                            status_code=200 if user else 400)

    @app.post("/api/admin/users/{username}/email")
    async def admin_set_email(request: Request, username: str):
        require_admin(request)
        if username not in store.list_users():
            raise HTTPException(status_code=404, detail="No such user")
        body = await request.json()
        try:
            # An address an admin sets is trusted (no confirmation email).
            email = schedules.set_email(username, (body or {}).get("email"), verified=True)
        except ScheduleError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"user": username, "email": email}

    # ---- data functions (kind:"function" sources) ----
    def can_author_functions(user: Optional[str]) -> bool:
        """May ``user`` run code of their own (write or edit data functions)?
        ``users`` mode: anyone whose role has ``function.run``; ``admin`` mode:
        administrators only."""
        if functions.mode == "off" or not user:
            return False
        if functions.mode == "admin" and not user_is_admin(user):
            return False
        return "function.run" in permissions_of(user)

    def approved_function(language, code) -> bool:
        """Is this exact function (language + code) saved in a dashboard owned by
        an administrator? Such code runs for any signed-in user, so everyone can
        view those charts while only authors may run code of their own. Checked
        on every call against the stored specs (the browser's copy is not trusted)."""
        if not isinstance(language, str) or not isinstance(code, str):
            return False
        owners = set(store.list_users()) | set(admins)
        for owner in owners:
            if not user_is_admin(owner):
                continue
            for summary in store.list_dashboards(owner):
                spec = store.get_dashboard(owner, summary["id"]) or {}
                for source in (spec.get("data") or {}).values():
                    if (isinstance(source, dict) and source.get("kind") == "function"
                            and source.get("language") == language
                            and source.get("code") == code):
                        return True
        return False

    @app.get("/api/functions/status")
    def function_status(request: Request):
        user = require_user(request)
        # canAuthor: may write / edit functions (the builder enables + Function
        # and the code editor's Apply only then); everyone else may still run
        # the functions of administrators' dashboards.
        return dict(functions_status(functions), canAuthor=can_author_functions(user))

    @app.post("/api/functions/run")
    async def function_run(request: Request):
        user = require_user(request)
        if functions.mode == "off":
            raise HTTPException(
                status_code=403,
                detail="Data functions are disabled on this server (set CXD_FUNCTIONS)")
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(status_code=400, detail="Request body must be JSON")
        # The code itself is not stored — a hash identifies which snippet ran.
        body = payload if isinstance(payload, dict) else {}
        code = body.get("code")
        if not can_author_functions(user) and not approved_function(body.get("language"), code):
            if functions.mode == "admin" and not user_is_admin(user):
                detail = ("Only administrators can write data functions; this code is not "
                          "part of an administrator's dashboard")
            else:
                detail = "Your role does not allow this: " + PERMISSIONS["function.run"].lower()
            raise HTTPException(status_code=403, detail=detail)
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
        user = require_permission(request, "llm.use")
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


def _pin_dataset_owners(spec: dict, owner: str) -> None:
    """Name the owner on a spec's stored-dataset sources (in place), so a viewer
    who is not the owner fetches the owner's data (``?owner=``, access-checked)."""
    for source in (spec.get("data") or {}).values():
        if isinstance(source, dict) and source.get("kind") == "dataset" and not source.get("owner"):
            source["owner"] = owner


def _unpin_dataset_owners(spec: dict, owner: str) -> None:
    """Drop owner pins that name the spec's own owner (they are the default)."""
    for source in (spec.get("data") or {}).values():
        if (isinstance(source, dict) and source.get("kind") == "dataset"
                and source.get("owner") == owner):
            del source["owner"]


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
