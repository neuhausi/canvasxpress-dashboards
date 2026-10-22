"""Optional canvasxpress-connectors integration: per-user database sources.

Each signed-in user registers named database sources (a connection string plus
a read-only SQL query, or a Salesforce / ServiceNow account) in the
canvasxpress-connectors web app, mounted here at ``/connectors``, and charts
them live (``/connectors/api/data?source=<name>``) or refreshes stored datasets
from them on a schedule. Connection strings are stored ENCRYPTED and never sent
to the browser by the connectors app.

Enabled with ``CXD_CONNECTORS=on``. It needs the ``canvasxpress-connectors``
package (0.8+, the ``[connectors]`` extra) and ``ENCRYPTION_KEY``: the Fernet
key that encrypts every stored connection string. The key is never generated
here: it is the only way to read the stored connections back, so the operator
must own it (and back it up). Generate one with::

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

The session is BRIDGED: the dashboards front-end asks
``/api/connectors/credentials`` (guarded by the dashboards session) for a
derived per-user credential and signs into the connectors app with it, so the
user signs in once, to the dashboards app.
"""

# No `from __future__ import annotations` here: FastAPI resolves the route
# functions' `request: Request` annotation, and Request is imported inside
# install_connectors (fastapi is an optional extra), so it must stay a real class.
import hashlib
import hmac
import json
import os
import re
from typing import Any, Callable, Optional

# SaaS sources (Salesforce, ServiceNow, pins boards) keep a JSON document of settings AND
# credentials where a database source keeps its connection string.
SAAS_KINDS = ("salesforce", "servicenow", "pins")
_SECRET_FIELD = re.compile(r"pass|secret|token|(^|_)key$", re.IGNORECASE)
SECRET_MASK = "********"


def redact_secrets(value: Any) -> Any:
    """A copy of parsed JSON with every secret-looking string field masked.

    A field is secret when its name contains ``pass``, ``secret`` or ``token``, or ends in
    ``key`` (``password``, ``security_token``, ``client_secret``, ``api_key``, …). Everything
    else — usernames, domains, instance names, an ``oauth_app`` name — is kept so the owner can
    still see what a source points at. Empty values stay empty, so "not set" is distinguishable
    from "set".
    """
    if isinstance(value, dict):
        return {key: (SECRET_MASK if _SECRET_FIELD.search(str(key)) and isinstance(item, str) and item
                      else redact_secrets(item))
                for key, item in value.items()}
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    return value


def _connmask():
    """``cx_connectors.connmask`` when the installed canvasxpress-connectors can restore a masked
    secret on save, else ``None``. Masking a database URL is only safe with it: an older
    connectors would store the ``********`` as the password, so then the URL is shown as stored."""
    try:
        from cx_connectors import connmask
    except ImportError:
        return None
    return connmask


def _connector_type(kind: Optional[str], conn_url: Optional[str]) -> str:
    """``salesforce``, ``databricks``, ``postgresql`` … (see ``cx_connectors.kinds``); the plain
    ``kind`` when the installed connectors predates it."""
    try:
        from cx_connectors.kinds import connector_type
    except ImportError:
        return kind or "sql"
    return connector_type(kind, conn_url)


_TRUE = ("1", "on", "true", "yes")
_KEY_HINT = ('generate one with: python -c "from cryptography.fernet import Fernet; '
             'print(Fernet.generate_key().decode())"')


def connectors_enabled(env: Optional[dict] = None) -> bool:
    """Whether ``CXD_CONNECTORS`` turns the integration on (``on``/``1``/``true``/``yes``)."""
    env = os.environ if env is None else env
    return str(env.get("CXD_CONNECTORS", "")).strip().lower() in _TRUE


def default_db_path(env: Optional[dict] = None) -> str:
    """The connectors store path: ``CXD_CONNECTORS_DB``, else ``connectors.db``
    beside the dashboards database (``APP_DB_PATH``)."""
    env = os.environ if env is None else env
    if env.get("CXD_CONNECTORS_DB"):
        return env["CXD_CONNECTORS_DB"]
    db_path = env.get("APP_DB_PATH", "dashboards.db")
    return os.path.join(os.path.dirname(os.path.abspath(db_path)), "connectors.db")


def derive_bridge_password(key: str, user: str) -> str:
    """The bridged connectors password for a user: HMAC-SHA256 of
    ``cxc-bridge:<user>`` under ``key``, truncated to 32 hex characters (never
    stored anywhere)."""
    return hmac.new(key.encode(), ("cxc-bridge:" + user).encode(), hashlib.sha256).hexdigest()[:32]


def bridge_credential(store: Any, user: str, key: str, legacy_secret: Optional[str] = None) -> str:
    """Ensure ``user`` exists in the connectors store and return the password that
    signs them in.

    New users get the ENCRYPTION_KEY derivation. A user created by the earlier
    SESSION_SECRET derivation is recognised by that credential still verifying,
    which also proves the account is a bridged one, so an account made directly
    in the connectors app with its own password is never taken over. It is
    re-keyed to the new derivation, so a later SESSION_SECRET rotation cannot
    lock them out. On a store without ``set_password`` (an older
    canvasxpress-connectors) that user keeps the old credential instead.

    :param store: The connectors ``Store``.
    :param user: The signed-in dashboards username.
    :param key: ENCRYPTION_KEY.
    :param legacy_secret: SESSION_SECRET, to recognise users of the old derivation.
    :returns: The password to log into the connectors app with.
    """
    password = derive_bridge_password(key, user)
    if store.create_user(user, password) or store.check_user(user, password):
        return password
    if legacy_secret:
        legacy = derive_bridge_password(legacy_secret, user)
        if store.check_user(user, legacy):
            if hasattr(store, "set_password"):
                store.set_password(user, password)
                print("  [connectors] re-keyed bridged user %r to the ENCRYPTION_KEY derivation" % user)
                return password
            return legacy
    # Neither credential verifies (e.g. a user created under a SESSION_SECRET that
    # has since changed): nothing here can prove it is theirs, so leave it alone.
    return password


def refresh_fetcher(store: Any) -> Callable:
    """The ``origin_fetchers["connector"]`` for scheduled dataset refresh: read a
    user's database source with THEIR stored credentials, the way
    ``/connectors/api/data`` does.

    The fetcher takes ``(owner, name, params=None)``. SQL bind parameters take
    their values from ``params`` (a missing one is NULL, as before); a value for
    a name the query does not declare is an error. Salesforce / ServiceNow
    sources go through their reader. Matrix ("packed") sources need a gene list
    and cannot be refreshed on a schedule.
    """
    def fetch(owner: str, name: str, params: Optional[dict] = None) -> dict:
        from cx_connectors.reshape import rows_to_cx
        from cx_connectors.sources.sql import SqlSource, bind_param_names
        from cx_connectors.web.byo_app import _read_saas_source

        record = store.get_source(owner, name)
        if not record:
            raise ValueError("No database source named %r" % name)
        kind = record.get("kind")
        if kind == "packed":
            raise ValueError("Matrix sources need a gene list and cannot be refreshed on a schedule")
        given = dict(params or {})
        if kind in ("salesforce", "servicenow", "pins"):
            if given:
                raise ValueError("A %s source takes no parameters" % kind)
            try:
                from cx_connectors.web.byo_app import authorize_saas_source
            except ImportError:
                # an older canvasxpress-connectors: no Salesforce OAuth apps, nothing to authorize
                header, rows = _read_saas_source(record)
            else:
                # An OAuth-app source stores no credential; the operator's `users` list for
                # that app is the authorization, so re-check it on every scheduled run.
                authorize_saas_source(owner, record)
                header, rows = _read_saas_source(record, owner=owner)
        else:
            from cx_connectors.databricks_oauth import is_viewer_oauth_url

            # A viewer-OAuth source has no credential of its own — it borrows the
            # signed-in viewer's. A scheduled refresh runs with no viewer, so it
            # can never read one; fail clearly instead of connecting as nobody.
            if is_viewer_oauth_url(record.get("conn_url")):
                raise ValueError(
                    "Source %r signs in as the viewer through Posit Connect and has no "
                    "credential of its own, so it cannot be refreshed on a schedule "
                    "(there is no viewer). Use a source with its own token for scheduled "
                    "refresh." % name)
            sql = record["sql"]
            names = list(bind_param_names(sql))
            unknown = sorted(set(given) - set(names))
            if unknown:
                raise ValueError("Source %r has no parameter %s (it has: %s)"
                                 % (name, ", ".join(unknown), ", ".join(names) or "none"))
            header, rows = SqlSource(record["conn_url"], sql, {n: given.get(n) for n in names}).read()
        return rows_to_cx(header, rows)

    return fetch


_SCHEMA_MAX_TABLES = 1000


def _column_kind(sql_type: Any) -> str:
    """``number`` / ``text`` / ``other`` for a SQLAlchemy column type."""
    try:
        py = sql_type.python_type
    except Exception:  # NullType and dialect types without a python_type
        return "other"
    import decimal
    if py in (int, float, decimal.Decimal):   # (bool is its own python_type)
        return "number"
    return "text" if py is str else "other"


def describe_schema(conn_url: str, table: Optional[str] = None) -> dict:
    """What a database holds, for the "Dashboard from database" wizard: its
    tables and views (default schema), or one table's columns. Read-only — it
    only asks the database's catalog (SQLAlchemy ``inspect``), never the data.

    :param conn_url: A SQLAlchemy connection URL.
    :param table: A table or view name: list its columns instead.
    :returns: ``{"tables": [{name, kind: table|view}], "truncated": bool}``, or
        ``{"table": name, "columns": [{name, type, kind: number|text|other}]}``.
    :raises ValueError: When the table does not exist.
    """
    from sqlalchemy import create_engine, inspect

    engine = create_engine(conn_url, future=True)
    try:
        insp = inspect(engine)
        if table:
            known = set(insp.get_table_names()) | set(insp.get_view_names())
            if table not in known:
                raise ValueError("No table or view named %r" % table)
            columns = []
            for col in insp.get_columns(table):
                try:
                    type_name = str(col["type"])
                except Exception:  # a type that cannot compile without a dialect
                    type_name = ""
                columns.append({"name": col["name"], "type": type_name, "kind": _column_kind(col["type"])})
            return {"table": table, "columns": columns}
        names = [{"name": n, "kind": "table"} for n in sorted(insp.get_table_names())]
        names += [{"name": n, "kind": "view"} for n in sorted(insp.get_view_names())]
        return {"tables": names[:_SCHEMA_MAX_TABLES], "truncated": len(names) > _SCHEMA_MAX_TABLES}
    finally:
        engine.dispose()


def install_connectors(app: Any, db_path: str, encryption_key: Optional[str],
                       seed: Optional[Callable[[Any, str], None]] = None,
                       session_secret: Optional[str] = None,
                       https_only: Optional[bool] = None) -> Any:
    """Mount the connectors app at ``/connectors`` and wire it into this server:
    the scheduled-refresh origin ``"connector"`` and the session-bridge routes
    (``/api/connectors/credentials``, ``/sources-meta``, ``/source``, ``/schema``, ``/test``).

    :param app: The dashboards FastAPI app (with its session middleware).
    :param db_path: The connectors store. A bare filesystem path (SQLite, as
        before) or a database URL — ``sqlite://`` / ``postgresql://`` — so the
        store can live in the same database as the rest of the deployment
        (:func:`cx_connectors.sqlstore.open_store` dispatches on the scheme).
    :param encryption_key: ENCRYPTION_KEY (a Fernet key).
    :param seed: Optional ``seed(store, user)``, run when a user is bridged
        (e.g. to register demo sources).
    :param session_secret: Signs the connectors app's own session cookie;
        defaults to ``SESSION_SECRET`` (the launcher always sets it).
    :param https_only: Restrict the ``/connectors`` session cookie to HTTPS
        (``Secure`` flag); defaults to ``CXD_HTTPS_ONLY`` (off), matching the
        dashboards app's own session cookie.
    :returns: The connectors ``Store``.
    :raises RuntimeError: When the package is missing, the key is absent /
        invalid, or there is no session secret.
    """
    if not encryption_key:
        raise RuntimeError("CXD_CONNECTORS=on needs ENCRYPTION_KEY, the key that encrypts stored "
                           "connection strings (it is never generated for you; " + _KEY_HINT + ")")
    session_secret = session_secret or os.environ.get("SESSION_SECRET")
    if not session_secret:
        raise RuntimeError("the connectors app needs a session secret: set SESSION_SECRET "
                           "(python -m cxd_server sets one for you)")
    if https_only is None:
        https_only = os.getenv("CXD_HTTPS_ONLY", "0") == "1"
    try:
        from cx_connectors.sqlstore import open_store
        from cx_connectors.web.byo_app import create_byo_app
    except ImportError as exc:
        raise RuntimeError("CXD_CONNECTORS=on needs canvasxpress-connectors 0.8+ "
                           "(pip install 'canvasxpress-dashboards-server[connectors]'): %s" % exc)
    # Only a bare filesystem path gets its directory created; a database URL
    # (sqlite:// / postgresql://) addresses an existing server, never a local dir.
    if not _is_store_url(db_path):
        os.makedirs(os.path.dirname(os.path.abspath(db_path)) or ".", exist_ok=True)
    try:
        store = open_store(db_path, encryption_key)
    except ValueError as exc:
        raise RuntimeError("ENCRYPTION_KEY is not a valid Fernet key (%s); %s" % (exc, _KEY_HINT))

    from fastapi import Request
    from fastapi.responses import JSONResponse

    before = list(app.router.routes)
    app.mount("/connectors", create_byo_app(store=store, serve_static=False, session_secret=session_secret,
                                            encryption_key=encryption_key, https_only=https_only))
    app.state.origin_fetchers["connector"] = refresh_fetcher(store)
    app.state.connectors_store = store

    def credentials(request: Request):
        """Session bridge: hand the SIGNED-IN user a derived credential for the
        connectors app (same username; password = HMAC(ENCRYPTION_KEY, user), so
        it is stable, never stored, and only obtainable with a valid session).
        ENCRYPTION_KEY, not SESSION_SECRET, keys it: rotating the cookie secret
        must not lock bridged users out of their saved connections."""
        user = request.session.get("user")
        if not user:
            return JSONResponse({"detail": "Not logged in"}, status_code=401)
        password = bridge_credential(store, user, encryption_key, os.environ.get("SESSION_SECRET"))
        if seed is not None:
            seed(store, user)
        return {"username": user, "password": password}

    def sources_meta(request: Request):
        """The signed-in user's database sources with display metadata: last-saved
        timestamp and a CREDENTIAL-FREE location (dialect + host only)."""
        from urllib.parse import urlsplit

        user = request.session.get("user")
        if not user:
            return JSONResponse({"detail": "Not logged in"}, status_code=401)
        out = []
        for meta in store.list_sources_meta(user):
            record = store.get_source(user, meta["name"])
            location = ""
            ctype = ""
            if record:
                parts = urlsplit(record["conn_url"])
                location = (parts.scheme or "").split("+")[0]
                if parts.hostname:
                    location += "@" + parts.hostname
                ctype = _connector_type(record.get("kind"), record["conn_url"])
            out.append({"name": meta["name"], "updated_at": meta["updated_at"], "location": location,
                        "type": ctype})
        return {"sources": out}

    def source_detail(request: Request, name: str = ""):
        """Owner-only read-back of one source's connection URL + SQL, so the Data
        page can prefill its edit form. Guarded by the session; a user can only
        read their own sources.

        A stored password, token or client secret should be replaceable but never
        shown again (it would otherwise sit in the browser, its network tab and
        screenshots), so both kinds of source come back with every secret masked:

        * a SaaS source (Salesforce, ServiceNow, pins) stores a JSON document of
          settings and credentials; its secret fields read ``********``;
        * a database source's connection string keeps its host, database and options,
          with the password (and any secret query parameter) shown as ``********``.
          Saving the form with the mask still in it keeps the stored secret
          (``secret_from`` names the source it comes from).

        ``kind`` and ``type`` (``salesforce``, ``databricks``, ``postgresql`` …) let the
        page tell sources apart; ``masked`` says the URL's secrets were hidden. With a
        connectors package too old to restore a masked secret on save, a database URL is
        returned as stored (``masked`` false) rather than break the edit form."""
        user = request.session.get("user")
        if not user:
            return JSONResponse({"detail": "Not logged in"}, status_code=401)
        record = store.get_source(user, name)
        if not record:
            return JSONResponse({"detail": "No such source"}, status_code=404)
        kind = record.get("kind") or "sql"
        conn_url = record["conn_url"]
        masked = False
        if kind in SAAS_KINDS:
            masked = True
            try:
                conn_url = json.dumps(redact_secrets(json.loads(conn_url)), sort_keys=True)
            except ValueError:
                conn_url = ""          # not the JSON we expect: show nothing rather than risk a leak
        else:
            connmask = _connmask()
            if connmask is not None:
                masked = True
                conn_url = connmask.mask_conn_url(conn_url)
        return {"name": name, "kind": kind, "type": _connector_type(kind, record["conn_url"]),
                "masked": masked, "conn_url": conn_url, "sql": record["sql"]}

    def resolve_connection(user: str, body: dict):
        """The connection URL a wizard/editor request names: one of the user's own
        SQL sources (``source``: its stored connection), else ``conn_url``. Returns
        ``(url, None)`` or ``(None, error JSONResponse)``."""
        name = (body.get("source") or "").strip()
        if name:
            record = store.get_source(user, name)
            if not record:
                return None, JSONResponse({"detail": "No such source"}, status_code=404)
            if record.get("kind") not in (None, "", "sql"):
                return None, JSONResponse({"detail": "Only SQL sources have tables"}, status_code=400)
            return record["conn_url"], None
        conn_url = (body.get("conn_url") or "").strip()
        if not conn_url:
            return None, JSONResponse({"detail": "source or conn_url is required"}, status_code=400)
        connmask = _connmask()
        if connmask is not None and connmask.MASK in conn_url:
            # An edit form that still shows "********": take the real secret from the user's
            # own source it came from (``secret_from``), only while the server is unchanged.
            original = store.get_source(user, (body.get("secret_from") or "").strip())
            stored = original["conn_url"] if original and (original.get("kind") or "sql") == "sql" else None
            try:
                conn_url = connmask.unmask_conn_url(conn_url, stored)
            except ValueError as exc:
                return None, JSONResponse({"detail": str(exc)}, status_code=400)
        return conn_url, None

    def resolve_for_viewer(request: Request, conn_url: str):
        """Resolve a viewer-OAuth Databricks URL to a freshly-tokened one for this
        request (via cx_connectors), substituting the signed-in viewer's token.
        Normal sources pass through unchanged. Returns ``(url, None)`` or
        ``(None, error JSONResponse)`` — 403 with no viewer session token, 502 on
        a token-exchange failure (neither message contains a token)."""
        from cx_connectors.databricks_oauth import (
            OAuthExchangeFailed,
            ViewerSessionRequired,
            resolve_conn_url,
        )
        try:
            return resolve_conn_url(conn_url, request.headers), None
        except ViewerSessionRequired as exc:
            return None, JSONResponse({"detail": str(exc)}, status_code=403)
        except OAuthExchangeFailed as exc:
            return None, JSONResponse({"detail": str(exc)}, status_code=502)

    def db_error(exc: Exception):
        # (The owner's own connection; the message may name it, as /source returns it.)
        return JSONResponse({"detail": "Could not read the database: %s" % str(exc).split("\n")[0][:300]},
                            status_code=502)

    async def schema(request: Request):
        """The tables (or one table's columns) of a database, for the wizard and the
        database-source editor: either one of the signed-in user's SQL sources
        (``source``) or a connection URL (``conn_url``, in the body so it stays out
        of URLs and logs). Session-guarded; the URL is never echoed."""
        user = request.session.get("user")
        if not user:
            return JSONResponse({"detail": "Not logged in"}, status_code=401)
        body = await request.json()
        conn_url, error = resolve_connection(user, body)
        if error is not None:
            return error
        conn_url, error = resolve_for_viewer(request, conn_url)
        if error is not None:
            return error
        try:
            return describe_schema(conn_url, (body.get("table") or "").strip() or None)
        except ValueError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=404)
        except Exception as exc:
            return db_error(exc)

    async def test_sql(request: Request):
        """Run a SQL query BEFORE it is saved as a source (the editor's Test): the
        same read-only check as a saved source, ``:name`` parameters bound from
        ``params`` (never interpolated; a missing one is NULL), capped IN the
        database at ``limit`` rows (default 200, max 1000)."""
        from cx_connectors.pushdown import PushdownError, run_pushdown
        from cx_connectors.reshape import rows_to_cx
        from cx_connectors.sources.sql import ReadOnlyViolation, bind_param_names

        user = request.session.get("user")
        if not user:
            return JSONResponse({"detail": "Not logged in"}, status_code=401)
        body = await request.json()
        conn_url, error = resolve_connection(user, body)
        if error is not None:
            return error
        conn_url, error = resolve_for_viewer(request, conn_url)
        if error is not None:
            return error
        sql = (body.get("sql") or "").strip()
        if not sql:
            return JSONResponse({"detail": "sql is required"}, status_code=400)
        try:
            limit = max(1, min(int(body.get("limit") or 200), 1000))
        except (TypeError, ValueError):
            limit = 200
        given = body.get("params") or {}
        if not isinstance(given, dict):
            return JSONResponse({"detail": "params must be an object"}, status_code=400)
        try:
            params = {n: given.get(n) for n in bind_param_names(sql)}
            header, rows, truncated = run_pushdown(conn_url, sql, params, {"limit": limit}, limit)
        except (ReadOnlyViolation, PushdownError) as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        except Exception as exc:
            return db_error(exc)
        if not rows:
            return {"rows": 0, "truncated": False, "columns": header, "data": None}
        return {"rows": len(rows), "truncated": bool(truncated), "columns": header, "data": rows_to_cx(header, rows)}

    app.add_api_route("/api/connectors/credentials", credentials, methods=["GET"], include_in_schema=False)
    app.add_api_route("/api/connectors/sources-meta", sources_meta, methods=["GET"], include_in_schema=False)
    app.add_api_route("/api/connectors/source", source_detail, methods=["GET"], include_in_schema=False)
    app.add_api_route("/api/connectors/schema", schema, methods=["POST"], include_in_schema=False)
    app.add_api_route("/api/connectors/test", test_sql, methods=["POST"], include_in_schema=False)
    _before_root_mount(app, [r for r in app.router.routes if r not in before])
    from .databricks_browser import install_databricks
    install_databricks(app, store)
    print("  [connectors] database sources enabled at /connectors (store: %s)"
          % _store_location_label(db_path))
    return store


def _is_store_url(target: str) -> bool:
    """Whether ``target`` is a database URL (has a scheme) rather than a bare path."""
    from urllib.parse import urlsplit

    return bool(target) and bool(urlsplit(target).scheme)


def _store_location_label(target: str) -> str:
    """A credential-free label for the store, safe to log: a bare path as-is, a
    URL reduced to ``scheme@host`` (never its password)."""
    if not _is_store_url(target):
        return target
    from urllib.parse import urlsplit

    parts = urlsplit(target)
    scheme = (parts.scheme or "").split("+")[0]
    return scheme + ("@" + parts.hostname if parts.hostname else "")


def _before_root_mount(app: Any, routes: list) -> None:
    """Move ``routes`` ahead of a mount at ``/`` (the server's static app shell):
    routes match in order, so after a root mount they would never be reached.
    They only match their own paths, so moving them earlier changes nothing else.
    """
    table = app.router.routes
    for route in routes:
        table.remove(route)
    at = next((i for i, r in enumerate(table)
               if type(r).__name__ == "Mount" and getattr(r, "path", None) in ("", "/")), len(table))
    table[at:at] = routes


def install_from_env(app: Any) -> Optional[Any]:
    """Install the integration when ``CXD_CONNECTORS`` is on (the launcher's
    hook). Misconfiguration raises, so it surfaces at startup.

    With ``CXD_CONNECTORS_DEMO_SOURCES=on`` every bridged user is also seeded
    with the package's demo database sources (:mod:`cxd_server.demo_sources`), so
    a plain server-only deploy has something to chart from — the same seeding the
    examples' dev launcher uses. With ``CXD_REFERENCE_SOURCES=on`` the GTEx
    reference connector sources are seeded too (:mod:`cxd_server.reference_sources`),
    a no-op on a host without ``gtex.sqlite``.

    :returns: The connectors ``Store``, or None when not enabled.
    """
    if not connectors_enabled():
        return None
    # Per-bridged-user source seeders, applied in order. Each is a no-op when its
    # own precondition (demo flag on / the GTEx database present) is not met.
    seeders = []
    from . import demo_sources
    if demo_sources.demo_sources_enabled():
        seeders.append(demo_sources.seed_demo_sources)
    from . import reference_sources
    if reference_sources.reference_sources_enabled():
        seeders.append(reference_sources.seed_gtex_sources)

    def seed(store, user):
        for seeder in seeders:
            seeder(store, user)

    return install_connectors(app, default_db_path(), os.environ.get("ENCRYPTION_KEY"),
                              seed=seed if seeders else None)
