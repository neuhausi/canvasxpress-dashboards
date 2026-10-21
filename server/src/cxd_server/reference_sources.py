"""Reference-database dashboards for a packaged (``python -m cxd_server``) deploy.

The science dashboards (GTEx tissue expression, the GENCODE genome browser, and
the CCLE / TCGA / WikiPathways overviews) read large read-only SQLite reference
databases. Those services used to live only in the examples' dev launcher
(``examples/serve.py`` + ``examples/dbservices.py``) — the host that
canvasxpress.org happens to run — so a plain ``pip install`` + ``python -m
cxd_server`` server could not serve them. This module brings the serving side
into the package so any install can, **off by default**:

    CXD_REFERENCE_SOURCES=on      # register the /api/<db> services (this module)
    CXD_SQLITE_DIR=/path/to/dbs   # where <db>.sqlite live (see reference_services)

Two serving paths, matching the dev launcher:

* **/api/<db>** (this module's :func:`install_reference_services`) — the GENCODE
  genome browser and the aggregate/explorer views, read straight from SQLite via
  :mod:`cxd_server.reference_services`. Needs only the data files; no connectors.
* **GTEx expression** — a ``cx_connectors`` ``SqlSource`` (``:gene`` parameter),
  seeded per bridged user by :func:`seed_gtex_sources` so the Builder lists it as
  a 🗄 database source. Needs ``CXD_CONNECTORS=on`` as well; a no-op when the
  GTEx database is absent.

Only the data files differ between a fresh install and canvasxpress.org — see the
reference-data distribution plan for how a (often offline) customer install gets
them (manual drop into ``CXD_SQLITE_DIR``, a fetch command, or a data-baked image).
"""

import os
from typing import Any

from . import reference_services

_TRUE = ("1", "on", "true", "yes")
REFERENCE_ENV = "CXD_REFERENCE_SOURCES"
SERVE_ENV = "CXD_REFERENCE_DATA_SERVE"


def reference_sources_enabled(env=None) -> bool:
    """Whether ``CXD_REFERENCE_SOURCES`` turns the reference services on."""
    env = os.environ if env is None else env
    return str(env.get(REFERENCE_ENV, "")).strip().lower() in _TRUE


def reference_data_server_enabled(env=None) -> bool:
    """Whether ``CXD_REFERENCE_DATA_SERVE`` makes this deployment PUBLISH its
    reference databases for download (so another install can ``fetch`` them).
    Off by default — only a deployment that chooses to be a distribution point
    turns it on, and only for the openly redistributable databases it holds."""
    env = os.environ if env is None else env
    return str(env.get(SERVE_ENV, "")).strip().lower() in _TRUE


# GTEx Gene Explorer database sources (read-only SQL into gtex.sqlite), so the
# Builder lists them as 🗄 database sources with their SQL and a live preview.
# `expression` stores each gene's ~17k sample TPMs as ONE ';'-joined string in
# sample order (the `samples` rowid order), so json_each splits it into rows
# that join their sample. char(59) is ';' — the connectors read-only check
# rejects a literal ';' anywhere in the statement.
GTEX_SOURCES = {
    "gtex-genes": (
        "SELECT DISTINCT geneName AS id, geneName AS gene"
        " FROM expression ORDER BY geneName"),
    "gtex-expression": (
        "SELECT s.sampleName AS sample, s.tissue AS tissue, CAST(e.value AS REAL) AS TPM"
        " FROM expression AS x, json_each('[' || replace(x.tpm, char(59), ',') || ']') AS e"
        " JOIN samples AS s ON s.rowid = e.key + 1"
        # No gene (the Data page preview / row count) → TP53, the dashboard's
        # default; an empty result is an error to the connectors app.
        " WHERE x.geneName = COALESCE(:gene, 'TP53')"),
}


def seed_gtex_sources(store: Any, user: str) -> None:
    """Register (or update, when the SQL changed) the GTEx connector sources for a
    bridged ``user`` in the connectors ``store``; a no-op when ``gtex.sqlite`` is
    not present on this host (so an install without the data is never broken).

    :param store: The ``cx_connectors`` store (from the connectors integration).
    :param user: The bridged username whose sources are being seeded.
    """
    path = reference_services.db_path("gtex")
    if not os.path.isfile(path):
        return
    url = "sqlite:///file:" + path + "?mode=ro&uri=true"
    have_sources = store.list_sources(user)
    for name, sql in GTEX_SOURCES.items():
        current = store.get_source(user, name) if name in have_sources else None
        if not current or current.get("sql") != sql or current.get("conn_url") != url:
            store.save_source(user, name, url, sql)


def seed_reference_dashboards(store: Any, owner: str, now: str = None) -> None:
    """Seed the GTEx / GENCODE reference explorer dashboards for ``owner`` so a
    packaged ``python -m cxd_server`` install with the data present shows them on
    the Dashboards page (they otherwise exist only in the examples dev launcher).

    Each shipped spec's ``../api/<db>`` connector URLs are rewritten root-relative
    (``api/<db>``) — the same rewrite the dev launcher does — so they resolve to
    the :func:`install_reference_services` routes under whatever mount prefix the
    app is served at. No connectors are needed: the dashboards read the
    ``/api/<db>`` services directly.

    A dashboard is seeded **only** when its data is actually available —
    ``CXD_REFERENCE_SOURCES`` is on *and* its ``<db>.sqlite`` is present — and only
    when it is not already stored (idempotent; never clobbers a later edit). When
    the data is **not** available, a copy seeded by an earlier run (with the flag
    on and the database present) is **removed**, so the Dashboards page never lists
    an explorer whose ``/api/<db>`` panels can only 503. Each seeded board is
    locked as a canonical example. Safe to call unconditionally.

    :param store: The dashboards ``DashboardStore`` (``save_dashboard`` /
        ``set_locked`` / ``get_summary`` / ``delete_dashboard``).
    :param owner: The examples owner the shipped dashboards are stored under.
    :param now: ISO-8601 timestamp for the save (defaults to current UTC).
    """
    import datetime
    import json

    if not store or not owner:
        return
    now = now or datetime.datetime.now(datetime.timezone.utc).isoformat()
    ddir = os.path.join(os.path.dirname(__file__), "reference_dashboards")
    enabled = reference_sources_enabled()
    for fname, db in (("gtex-explorer.spec.json", "gtex"),
                      ("gencode-explorer.spec.json", "gencode")):
        dashboard_id = fname[:-len(".spec.json")]   # "gtex-explorer" / "gencode-explorer"
        path = os.path.join(ddir, fname)
        available = enabled and os.path.isfile(path) and reference_services.db_present(db)
        if not available:
            # Drop a copy a previous run seeded when the flag/data were present, so
            # it does not linger as a broken (503) example.
            try:
                if store.get_summary(owner, dashboard_id) is not None:
                    store.delete_dashboard(owner, dashboard_id)
                    print("  [reference] removed dashboard: %s (owner %s) — %s data not available"
                          % (dashboard_id, owner, db), flush=True)
            except Exception as exc:  # noqa: BLE001 - never break startup over cleanup
                print("  [reference] NOTE: could not remove %s (%s)" % (dashboard_id, exc), flush=True)
            continue
        with open(path, encoding="utf-8") as handle:
            spec = json.load(handle)
        for source in spec.get("data", {}).values():
            url = source.get("url")
            if source.get("kind") == "connector" and isinstance(url, str) and url.startswith("../api/"):
                source["url"] = url[2:]
        try:
            if store.get_summary(owner, spec["id"]) is not None:
                continue
            store.save_dashboard(owner, spec, now)
            store.set_locked(owner, spec["id"], True)
            print("  [reference] seeded dashboard: %s (owner %s)" % (spec["id"], owner), flush=True)
        except Exception as exc:  # noqa: BLE001 - a seeding failure must not break startup
            print("  [reference] NOTE: could not seed %s (%s)" % (spec.get("id"), exc), flush=True)


def install_reference_services(app: Any) -> None:
    """Register ``GET /api/<db>`` on the dashboards ``app`` for the reference
    databases (ccle / tcga / gtex / gencode / wp), reading each from SQLite via
    :mod:`cxd_server.reference_services`. Mirrors the dev launcher's ``_db_service``
    route; registered ahead of the static ``/`` mount (via the connectors helper)
    so it is reachable, and after the specific ``/api/*`` routes so it never
    shadows them.

    :param app: The dashboards FastAPI app returned by ``create_dashboards_app``.
    """
    from fastapi import Request
    from fastapi.responses import JSONResponse
    from .connectors import _before_root_mount

    before = list(app.router.routes)

    def db_service(db: str, request: Request):
        """Live data service for one reference database: read the matching SQLite
        and return the CanvasXpress ``.data`` payload each panel consumes. Reached
        from the pages as the relative ``../api/<db>`` connector URL, so it
        resolves under whatever mount prefix the app is served at."""
        if db not in reference_services.REFERENCE_DBS:
            return JSONResponse({"detail": "unknown db '%s'" % db}, status_code=404)
        if not reference_services.db_present(db):
            return JSONResponse(
                {"detail": "reference database '%s' is not installed on this server "
                           "(set CXD_SQLITE_DIR and place %s.sqlite there)" % (db, db)},
                status_code=503)
        qs = {k: request.query_params.getlist(k) for k in request.query_params.keys()}
        try:
            payload = reference_services.handle(db, qs)
        except Exception as exc:  # noqa: BLE001 - surface DB/query errors to the client
            return JSONResponse({"detail": str(exc)}, status_code=500)
        if payload is None:
            return JSONResponse({"detail": "no data for these params"}, status_code=404)
        return JSONResponse(payload)

    app.add_api_route("/api/{db}", db_service, methods=["GET"], include_in_schema=False)
    _before_root_mount(app, [r for r in app.router.routes if r not in before])
    present = [db for db in reference_services.REFERENCE_DBS if reference_services.db_present(db)]
    print("  [reference] /api/<db> services enabled (CXD_SQLITE_DIR=%s; present: %s)"
          % (reference_services.SQLITE_DIR, ", ".join(present) or "none"), flush=True)


def install_reference_data_server(app: Any) -> None:
    """Publish this deployment's reference databases for download at
    ``GET /reference-data/<db>.sqlite`` (+ a ``.sha256`` sidecar), so another
    (often air-gapped-adjacent) install can ``cxd-reference-data fetch`` them with
    ``CXD_REFERENCE_DATA_BASE_URL`` pointing here. Unauthenticated, read-only, and
    restricted to the known database filenames (no path traversal). Registered
    ahead of the static ``/`` mount. Only wired when
    :func:`reference_data_server_enabled`.

    The ``.sha256`` is computed once and cached beside the database (so a 4 GB
    hash is not recomputed per request); when the data directory is read-only the
    digest is computed in memory instead.

    :param app: The dashboards FastAPI app returned by ``create_dashboards_app``.
    """
    import re

    from fastapi import Request
    from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
    from .connectors import _before_root_mount
    from . import reference_data

    _NAME = re.compile(r"^(?P<db>[a-z]+)\.sqlite(?P<sha>\.sha256)?$")
    before = list(app.router.routes)

    # Only openly-redistributable databases are published by default. TCGA/CCLE
    # have open vs controlled tiers (plan D4), so they are NOT exposed unless the
    # operator has cleared the terms and lists them in CXD_REFERENCE_DATA_PUBLISH
    # (comma-separated), which overrides the default set entirely.
    override = (os.environ.get("CXD_REFERENCE_DATA_PUBLISH") or "").strip()
    publishable = ({s.strip() for s in override.split(",") if s.strip()}
                   if override else set(reference_data.REDISTRIBUTABLE))

    def _resolve(fname):
        """(db, is_sha, path) for a valid, PUBLISHABLE artifact filename, else (None, …)."""
        m = _NAME.match(fname or "")
        if not m or m.group("db") not in reference_services.REFERENCE_DBS:
            return None, False, None
        db = m.group("db")
        if db not in publishable:                 # present on disk but not cleared to publish
            return None, False, None
        return db, bool(m.group("sha")), reference_services.db_path(db)

    def _sha256_cached(path):
        """The file's hex SHA-256, cached in a sibling ``.sha256`` when writable."""
        sidecar = path + ".sha256"
        try:
            if os.path.isfile(sidecar) and os.path.getmtime(sidecar) >= os.path.getmtime(path):
                with open(sidecar, encoding="utf-8") as handle:
                    token = handle.read().split()[0].strip()
                    if len(token) == 64:
                        return token
        except OSError:
            pass
        digest = reference_data.sha256_file(path)
        try:
            with open(sidecar, "w", encoding="utf-8") as handle:
                handle.write(digest + "  " + os.path.basename(path) + "\n")
        except OSError:
            pass  # read-only data dir: serve the computed digest without caching
        return digest

    def artifact(fname: str, request: Request):
        """Stream one reference database (or its checksum) for download."""
        db, is_sha, path = _resolve(fname)
        if db is None:
            return JSONResponse({"detail": "no such reference artifact '%s'" % fname}, status_code=404)
        if not path or not os.path.isfile(path):
            return JSONResponse({"detail": "reference database '%s' is not installed here" % db},
                                status_code=404)
        if is_sha:
            return PlainTextResponse(_sha256_cached(path) + "  " + db + ".sqlite\n")
        # FileResponse honours Range requests, so a multi-GB download is resumable.
        return FileResponse(path, media_type="application/octet-stream", filename=db + ".sqlite")

    app.add_api_route("/reference-data/{fname}", artifact, methods=["GET"], include_in_schema=False)
    _before_root_mount(app, [r for r in app.router.routes if r not in before])
    servable = [db for db in reference_services.REFERENCE_DBS
                if db in publishable and reference_services.db_present(db)]
    print("  [reference] /reference-data/<db>.sqlite downloads enabled "
          "(publishable: %s; serving: %s)"
          % (", ".join(sorted(publishable)), ", ".join(servable) or "none"), flush=True)
