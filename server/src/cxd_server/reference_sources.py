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


def reference_sources_enabled(env=None) -> bool:
    """Whether ``CXD_REFERENCE_SOURCES`` turns the reference services on."""
    env = os.environ if env is None else env
    return str(env.get(REFERENCE_ENV, "")).strip().lower() in _TRUE


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
