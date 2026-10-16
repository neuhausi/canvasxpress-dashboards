"""Unity Catalog browser for the Data page (catalogs -> schemas -> tables).

Routes under ``/api/connectors/databricks/`` (session-guarded), installed next to
the connectors bridge. Enabled by ``CXD_DATABRICKS_HOST`` (e.g.
``dbc-1234.cloud.databricks.com``); unset, the section is hidden (``/config``
says ``enabled: false``) and every other route is a 404.

Who the calls run as is decided per request by an AUTH PROVIDER, so the feature
works on or off Posit Connect (``CXD_DATABRICKS_AUTH``):

``posit-connect``
    The viewer's own Databricks token, exchanged from the
    ``Posit-Connect-User-Session-Token`` header (``cx_connectors.databricks_oauth``).
    403 with no header, 502 when the exchange fails.
``token``
    One shared personal access token from ``CXD_DATABRICKS_TOKEN`` — for a
    deployment outside Connect. Every signed-in user then reads Databricks as
    that token's identity.
``auto`` (default)
    ``posit-connect`` when the request carries the Connect session header,
    otherwise ``token`` when ``CXD_DATABRICKS_TOKEN`` is set, otherwise 403.

The token is resolved first, per request; it is never logged, cached or returned
(error text is scrubbed of it), and nothing is shared between requests.

SQL is the catalog's ``information_schema`` on the chosen warehouse. Names that
become SQL identifiers are validated (:func:`valid_name`) and backtick-quoted;
filter values are bound parameters. The warehouse must be one the caller's token
lists, so a made-up id is rejected before any SQL runs.
"""

import json
import os
import re
import urllib.request
from typing import Any, Callable, List, Optional, Tuple

LIST_CAP = 1000
PREVIEW_ROWS = 50
_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_\-]{0,254}$")
_WAREHOUSE_ID = re.compile(r"^[A-Za-z0-9]{1,64}$")
_HOST = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.\-]*[A-Za-z0-9])?(:\d{1,5})?$")
_GONE_STATES = ("DELETED", "DELETING")
_PERMISSION = re.compile(r"permission[_ ]denied|insufficient[_ ]permissions|does not have|not authorized|"
                         r"unauthorized|forbidden|USE CATALOG|USE SCHEMA|SELECT on", re.I)
_MISSING = re.compile(r"not[_ ]found|does not exist|cannot be found|NO_SUCH", re.I)


class AuthError(Exception):
    """No usable Databricks identity for this request. ``status`` is the HTTP code."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def databricks_host(env: Optional[dict] = None) -> Optional[str]:
    """The configured workspace host (scheme and trailing slash dropped), or None
    when ``CXD_DATABRICKS_HOST`` is unset or not a plausible hostname."""
    env = os.environ if env is None else env
    raw = str(env.get("CXD_DATABRICKS_HOST", "")).strip()
    raw = re.sub(r"^https?://", "", raw, flags=re.I).rstrip("/")
    return raw if raw and _HOST.match(raw) else None


def valid_name(value: Any) -> bool:
    """Whether ``value`` is safe as a catalog / schema / table identifier."""
    return isinstance(value, str) and bool(_NAME.match(value))


def quote(name: str) -> str:
    """Backtick-quote an already-validated identifier."""
    return "`" + name + "`"


def table_sql(catalog: str, schema: str, table: str) -> str:
    """``SELECT * FROM `c`.`s`.`t``` for three validated names."""
    return "SELECT * FROM %s.%s.%s" % (quote(catalog), quote(schema), quote(table))


def source_url(host: str, warehouse_id: str, catalog: str, schema: str, viewer_oauth: bool) -> str:
    """The connectors URL for a table's schema: viewer-OAuth form (no credential)
    or, off Connect, a token form with a placeholder for the user to replace."""
    user = "posit-connect" if viewer_oauth else "token:REPLACE_WITH_TOKEN"
    return "databricks://%s@%s?http_path=/sql/1.0/warehouses/%s&catalog=%s&schema=%s" % (
        user, host, warehouse_id, catalog, schema)


# ---- auth providers: (headers) -> token, raising AuthError -------------------

def connect_token(headers: Any, client_factory: Optional[Callable[[], Any]] = None) -> str:
    """The viewer's Databricks token via Posit Connect."""
    from cx_connectors.databricks_oauth import (
        AUDIENCE_ENV,
        OAuthExchangeFailed,
        exchange_viewer_token,
        session_token_from_headers,
    )

    session = session_token_from_headers(headers)
    if not session:
        raise AuthError("Sign in through Posit Connect to browse Databricks as yourself "
                        "(no viewer session token on this request).", 403)
    try:
        return exchange_viewer_token(session, os.environ.get(AUDIENCE_ENV) or None, client_factory)
    except OAuthExchangeFailed as exc:
        raise AuthError(str(exc), 502)


def make_auth(mode: str, env: Optional[dict] = None,
              client_factory: Optional[Callable[[], Any]] = None) -> Tuple[Callable[[Any], str], Callable[[Any], bool]]:
    """``(token_for(headers), viewer_oauth(headers))`` for an auth mode.

    ``viewer_oauth`` says whether that request would use the Connect exchange
    (so saved sources get the credential-free URL form)."""
    env = os.environ if env is None else env
    shared = (env.get("CXD_DATABRICKS_TOKEN") or "").strip()

    def has_session(headers: Any) -> bool:
        from cx_connectors.databricks_oauth import session_token_from_headers
        try:
            return bool(session_token_from_headers(headers))
        except Exception:
            return False

    def uses_connect(headers: Any) -> bool:
        if mode == "posit-connect":
            return True
        if mode == "token":
            return False
        return has_session(headers) or not shared

    def token_for(headers: Any) -> str:
        if uses_connect(headers):
            return connect_token(headers, client_factory)
        if not shared:
            raise AuthError("CXD_DATABRICKS_AUTH=token needs CXD_DATABRICKS_TOKEN.", 403)
        return shared

    return token_for, uses_connect


# ---- Databricks calls (replaceable in tests) ---------------------------------

def rest_get(host: str, path: str, token: str) -> dict:
    """GET ``https://<host><path>`` with a bearer token; the parsed JSON."""
    req = urllib.request.Request("https://%s%s" % (host, path), headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=20) as resp:   # noqa: S310 (https, fixed host)
        return json.loads(resp.read().decode("utf-8"))


def run_queries(url: str, queries: List[Tuple[str, dict, int]]) -> List[Tuple[List[str], List[list], bool]]:
    """Run read-only ``(sql, params, cap)`` statements on one connection.

    :returns: per statement ``(columns, rows, truncated)``, at most ``cap`` rows.
    """
    from sqlalchemy import create_engine, text

    engine = create_engine(url, future=True)
    try:
        out = []
        with engine.connect() as conn:
            for sql, params, cap in queries:
                result = conn.execute(text(sql), params)
                columns = list(result.keys())
                rows = [list(r) for r in result.fetchmany(cap + 1)]
                out.append((columns, rows[:cap], len(rows) > cap))
        return out
    finally:
        engine.dispose()


def _plain(value: Any) -> Any:
    return value if value is None or isinstance(value, (str, int, float, bool)) else str(value)


def map_error(exc: Exception, what: str, token: str) -> Tuple[int, str]:
    """``(status, message)`` for a Databricks failure, scrubbed of the token."""
    text = str(exc).split("\n")[0]
    if token:
        text = text.replace(token, "***")
    if _PERMISSION.search(text):
        return 403, "You don't have access to %s." % what
    if _MISSING.search(text):
        return 404, "%s was not found." % what[:1].upper() + what[1:]
    return 502, "Databricks could not run the request: %s" % text[:300]


def install_databricks(app: Any, store: Any, env: Optional[dict] = None,
                       token_for: Optional[Callable[[Any], str]] = None,
                       viewer_oauth: Optional[Callable[[Any], bool]] = None,
                       rest: Optional[Callable[[str, str, str], dict]] = None,
                       run: Optional[Callable[..., list]] = None) -> None:
    """Add the browser routes to ``app``. The keyword hooks replace the token
    provider, the REST call and the SQL runner (tests); ``store`` is the
    connectors ``Store`` that "Save as source" writes to."""
    from fastapi import Request
    from fastapi.responses import JSONResponse

    env = os.environ if env is None else env
    host = databricks_host(env)
    mode = (env.get("CXD_DATABRICKS_AUTH") or "auto").strip().lower()
    if mode not in ("auto", "posit-connect", "token"):
        raise RuntimeError("CXD_DATABRICKS_AUTH must be auto, posit-connect or token")
    if token_for is None:
        token_for, default_oauth = make_auth(mode, env)
        viewer_oauth = viewer_oauth or default_oauth
    viewer_oauth = viewer_oauth or (lambda headers: True)
    rest = rest or rest_get
    run = run or run_queries

    def fail(status: int, detail: str):
        return JSONResponse({"detail": detail}, status_code=status)

    def begin(request: Request):
        """``(user, token, None)`` or ``(None, None, error response)``. The token is
        resolved before anything else can fail generically."""
        if host is None:
            return None, None, fail(404, "Databricks is not configured")
        user = request.session.get("user")
        if not user:
            return None, None, fail(401, "Not logged in")
        try:
            return user, token_for(request.headers), None
        except AuthError as exc:
            return None, None, fail(exc.status, str(exc))

    def warehouses_of(token: str) -> List[dict]:
        out = []
        for w in (rest(host, "/api/2.0/sql/warehouses", token) or {}).get("warehouses") or []:
            wid = str(w.get("id") or "")
            state = str(w.get("state") or "UNKNOWN")
            if _WAREHOUSE_ID.match(wid) and state not in _GONE_STATES:
                out.append({"id": wid, "name": w.get("name") or wid, "state": state,
                            "http_path": "/sql/1.0/warehouses/" + wid})
        return out

    def sql_url(token: str, wid: str) -> str:
        from urllib.parse import quote as urlquote
        return "databricks://token:%s@%s?http_path=/sql/1.0/warehouses/%s" % (urlquote(token, safe=""), host, wid)

    def names_ok(**names):
        bad = [k for k, v in names.items() if not valid_name(v)]
        return fail(400, "Invalid %s name." % ", ".join(bad)) if bad else None

    def query(request: Request, wid: str, queries: list, what: str, names: dict):
        """Validate, authenticate, check the warehouse, run ``queries``.
        Returns ``(results, None)`` or ``(None, error response)``."""
        user, token, error = begin(request)
        if error is not None:
            return None, error
        error = names_ok(**names)
        if error is not None:
            return None, error
        if not _WAREHOUSE_ID.match(wid or ""):
            return None, fail(400, "Invalid warehouse id.")
        try:
            if wid not in [w["id"] for w in warehouses_of(token)]:
                return None, fail(404, "No such warehouse for you.")
            return run(sql_url(token, wid), queries), None
        except Exception as exc:
            status, detail = map_error(exc, what, token)
            return None, fail(status, detail)

    def like(request: Request):
        q = (request.query_params.get("q") or "").strip().lower()[:100]
        esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return "%" + esc + "%"

    def config(request: Request):
        if not request.session.get("user"):
            return fail(401, "Not logged in")
        return {"enabled": host is not None, "host": host, "auth": mode,
                "viewer_oauth": bool(host and viewer_oauth(request.headers))}

    def warehouses(request: Request):
        user, token, error = begin(request)
        if error is not None:
            return error
        try:
            return {"warehouses": warehouses_of(token)}
        except Exception as exc:
            status, detail = map_error(exc, "your Databricks SQL warehouses", token)
            return fail(status, detail)

    def listing(sql: str, params: dict, label: str, key: str, names: dict, request: Request, extra=None):
        wid = request.query_params.get("warehouse", "")
        res, error = query(request, wid, [(sql, params, LIST_CAP)], label, names)
        if error is not None:
            return error
        _, rows, truncated = res[0]
        items = [extra(r) if extra else r[0] for r in rows]
        return {key: items, "count": len(items), "truncated": truncated}

    def catalogs(request: Request):
        q = like(request)
        return listing("SELECT catalog_name FROM system.information_schema.catalogs "
                       "WHERE lower(catalog_name) LIKE :q ORDER BY 1", {"q": q},
                       "the catalog list", "catalogs", {}, request)

    def schemas(request: Request):
        catalog = request.query_params.get("catalog", "")
        return listing("SELECT schema_name FROM %s.information_schema.schemata "
                       "WHERE lower(schema_name) LIKE :q ORDER BY 1" % quote(catalog) if valid_name(catalog)
                       else "", {"q": like(request)}, "catalog %s" % catalog, "schemas",
                       {"catalog": catalog}, request)

    def tables(request: Request):
        catalog = request.query_params.get("catalog", "")
        schema = request.query_params.get("schema", "")
        return listing("SELECT table_name, table_type FROM %s.information_schema.tables "
                       "WHERE table_schema = :schema AND lower(table_name) LIKE :q ORDER BY 1"
                       % quote(catalog) if valid_name(catalog) else "",
                       {"schema": schema, "q": like(request)}, "schema %s.%s" % (catalog, schema), "tables",
                       {"catalog": catalog, "schema": schema}, request,
                       extra=lambda r: {"name": r[0], "kind": "view" if "VIEW" in str(r[1] or "").upper() else "table"})

    def table(request: Request):
        qp = request.query_params
        catalog, schema, name = qp.get("catalog", ""), qp.get("schema", ""), qp.get("table", "")
        names = {"catalog": catalog, "schema": schema, "table": name}
        if all(valid_name(v) for v in names.values()):
            queries = [
                ("SELECT column_name, data_type FROM %s.information_schema.columns "
                 "WHERE table_schema = :schema AND table_name = :table ORDER BY ordinal_position" % quote(catalog),
                 {"schema": schema, "table": name}, LIST_CAP),
                (table_sql(catalog, schema, name) + " LIMIT %d" % PREVIEW_ROWS, {}, PREVIEW_ROWS)]
        else:
            queries = []
        res, error = query(request, qp.get("warehouse", ""), queries, "table %s.%s.%s" % (catalog, schema, name), names)
        if error is not None:
            return error
        (_, cols, cols_truncated), (header, rows, _) = res
        return {"catalog": catalog, "schema": schema, "table": name,
                "columns": [{"name": c[0], "type": c[1]} for c in cols], "columns_truncated": cols_truncated,
                "preview": {"columns": header, "rows": [[_plain(v) for v in r] for r in rows]}}

    async def save_source(request: Request):
        user, token, error = begin(request)
        if error is not None:
            return error
        body = await request.json()
        wid = str(body.get("warehouse") or "")
        catalog, schema, name = (str(body.get(k) or "") for k in ("catalog", "schema", "table"))
        error = names_ok(catalog=catalog, schema=schema, table=name)
        if error is not None:
            return error
        if not _WAREHOUSE_ID.match(wid):
            return fail(400, "Invalid warehouse id.")
        try:
            known = wid in [w["id"] for w in warehouses_of(token)]
        except Exception as exc:
            status, detail = map_error(exc, "your Databricks SQL warehouses", token)
            return fail(status, detail)
        if not known:
            return fail(404, "No such warehouse for you.")
        taken = set(store.list_sources(user))
        base = re.sub(r"[^A-Za-z0-9_\-]", "-", str(body.get("name") or name))[:60] or "databricks"
        source_name, n = base, 2
        while source_name in taken:     # never replace an existing source
            source_name, n = "%s-%d" % (base, n), n + 1
        url = source_url(host, wid, catalog, schema, viewer_oauth(request.headers))
        sql = table_sql(catalog, schema, name)
        store.save_source(user, source_name, url, sql)
        return {"name": source_name, "sql": sql, "viewer_oauth": url.startswith("databricks://posit-connect@")}

    base = "/api/connectors/databricks"
    before = list(app.router.routes)
    for path, fn, method in [("/config", config, "GET"), ("/warehouses", warehouses, "GET"),
                             ("/catalogs", catalogs, "GET"), ("/schemas", schemas, "GET"),
                             ("/tables", tables, "GET"), ("/table", table, "GET"),
                             ("/save-source", save_source, "POST")]:
        app.add_api_route(base + path, fn, methods=[method], include_in_schema=False)
    from .connectors import _before_root_mount
    _before_root_mount(app, [r for r in app.router.routes if r not in before])
    print("  [databricks] catalog browser %s" % ("enabled for " + host if host else "off (CXD_DATABRICKS_HOST unset)"))
