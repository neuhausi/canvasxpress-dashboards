"""Optional canvasxpress-connectors integration: per-user database sources.

Each signed-in user registers named database sources (a connection string plus
a read-only SQL query, or a Salesforce / ServiceNow account) in the
canvasxpress-connectors web app, mounted here at ``/connectors``, and charts
them live (``/connectors/api/data?source=<name>``) or refreshes stored datasets
from them on a schedule. Connection strings are stored ENCRYPTED and never sent
to the browser by the connectors app.

Enabled with ``CXD_CONNECTORS=on``. It needs the ``canvasxpress-connectors``
package (0.6+, the ``[connectors]`` extra) and ``ENCRYPTION_KEY``: the Fernet
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
import os
from typing import Any, Callable, Optional

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
        if kind in ("salesforce", "servicenow"):
            if given:
                raise ValueError("A %s source takes no parameters" % kind)
            header, rows = _read_saas_source(record)
        else:
            sql = record["sql"]
            names = list(bind_param_names(sql))
            unknown = sorted(set(given) - set(names))
            if unknown:
                raise ValueError("Source %r has no parameter %s (it has: %s)"
                                 % (name, ", ".join(unknown), ", ".join(names) or "none"))
            header, rows = SqlSource(record["conn_url"], sql, {n: given.get(n) for n in names}).read()
        return rows_to_cx(header, rows)

    return fetch


def install_connectors(app: Any, db_path: str, encryption_key: Optional[str],
                       seed: Optional[Callable[[Any, str], None]] = None,
                       session_secret: Optional[str] = None) -> Any:
    """Mount the connectors app at ``/connectors`` and wire it into this server:
    the scheduled-refresh origin ``"connector"`` and the session-bridge routes
    (``/api/connectors/credentials``, ``/sources-meta``, ``/source``).

    :param app: The dashboards FastAPI app (with its session middleware).
    :param db_path: The connectors store (SQLite) path.
    :param encryption_key: ENCRYPTION_KEY (a Fernet key).
    :param seed: Optional ``seed(store, user)``, run when a user is bridged
        (e.g. to register demo sources).
    :param session_secret: Signs the connectors app's own session cookie;
        defaults to ``SESSION_SECRET`` (the launcher always sets it).
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
    try:
        from cx_connectors.store import Store
        from cx_connectors.web.byo_app import create_byo_app
    except ImportError as exc:
        raise RuntimeError("CXD_CONNECTORS=on needs canvasxpress-connectors 0.6+ "
                           "(pip install 'canvasxpress-dashboards-server[connectors]'): %s" % exc)
    os.makedirs(os.path.dirname(os.path.abspath(db_path)) or ".", exist_ok=True)
    try:
        store = Store(db_path, encryption_key)
    except ValueError as exc:
        raise RuntimeError("ENCRYPTION_KEY is not a valid Fernet key (%s); %s" % (exc, _KEY_HINT))

    from fastapi import Request
    from fastapi.responses import JSONResponse

    before = list(app.router.routes)
    app.mount("/connectors", create_byo_app(store=store, serve_static=False, session_secret=session_secret,
                                            encryption_key=encryption_key))
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
            if record:
                parts = urlsplit(record["conn_url"])
                location = (parts.scheme or "").split("+")[0]
                if parts.hostname:
                    location += "@" + parts.hostname
            out.append({"name": meta["name"], "updated_at": meta["updated_at"], "location": location})
        return {"sources": out}

    def source_detail(request: Request, name: str = ""):
        """Owner-only read-back of one source's connection URL + SQL, so the Data
        page can prefill its edit form. Guarded by the session; a user can only
        read their own sources. NOTE: this returns the stored connection string,
        credentials included, to its owner's browser."""
        user = request.session.get("user")
        if not user:
            return JSONResponse({"detail": "Not logged in"}, status_code=401)
        record = store.get_source(user, name)
        if not record:
            return JSONResponse({"detail": "No such source"}, status_code=404)
        return {"name": name, "conn_url": record["conn_url"], "sql": record["sql"]}

    app.add_api_route("/api/connectors/credentials", credentials, methods=["GET"], include_in_schema=False)
    app.add_api_route("/api/connectors/sources-meta", sources_meta, methods=["GET"], include_in_schema=False)
    app.add_api_route("/api/connectors/source", source_detail, methods=["GET"], include_in_schema=False)
    _before_root_mount(app, [r for r in app.router.routes if r not in before])
    print("  [connectors] database sources enabled at /connectors (store: %s)" % db_path)
    return store


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

    :returns: The connectors ``Store``, or None when not enabled.
    """
    if not connectors_enabled():
        return None
    return install_connectors(app, default_db_path(), os.environ.get("ENCRYPTION_KEY"))
