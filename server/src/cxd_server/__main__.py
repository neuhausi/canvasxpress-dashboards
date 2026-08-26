"""Turnkey launcher for the dashboards server.

    python -m cxd_server            # or the `cxd-server` console script

Everything is configured through environment variables (see ``.env.example``),
so on-prem deployment is: install, edit a ``.env`` (or export vars), run this.
The only secret the server *must* have — ``SESSION_SECRET`` — is generated and
persisted on first run when unset, so logins survive restarts without any manual
key management. A ``.env`` file in the working directory is loaded automatically
when ``python-dotenv`` is available (it ships with the ``[web]`` extra).

Key variables (full list in ``.env.example``):

    SESSION_SECRET        cookie-signing key (auto-generated + persisted if unset)
    CXD_HOST / CXD_PORT   bind address (default 127.0.0.1:8000)
    APP_DB_PATH           SQLite dashboards DB (default ./dashboards.db)
    CXD_DASHBOARD_STORE   postgresql:// URL to use Postgres instead of SQLite
                          (postgres:// is accepted and normalized)
    CXD_DATASET_STORE     default dataset store URI (file:// / s3:// / postgresql://
                          / sqlite:// / gdrive://)
    CXD_STORES            JSON (or a path to stores.json) naming extra stores
    ALLOW_SIGNUP          "1" (default) to allow account creation, "0" to lock down
    CXD_PUBLISH_BASE_URL  public base for share links (default: the request origin)
"""

from __future__ import annotations

import argparse
import os
import secrets
import sys


def _load_dotenv() -> None:
    """Load a local ``.env`` into the environment when python-dotenv is present."""
    try:
        from dotenv import load_dotenv  # type: ignore
    except Exception:
        return
    load_dotenv()


def _resolve_session_secret() -> str:
    """Return a stable SESSION_SECRET, generating and persisting one if unset.

    Precedence: an existing ``SESSION_SECRET`` env var wins. Otherwise a secret
    is read from (or, on first run, written to) the file named by
    ``CXD_SECRET_FILE`` (default ``.session_secret`` beside the DB / CWD). This
    keeps sessions valid across restarts without the operator managing a key.
    """
    existing = os.getenv("SESSION_SECRET")
    if existing:
        return existing

    db_path = os.getenv("APP_DB_PATH", "dashboards.db")
    default_secret_file = os.path.join(os.path.dirname(os.path.abspath(db_path)), ".session_secret")
    secret_file = os.getenv("CXD_SECRET_FILE", default_secret_file)

    try:
        if os.path.exists(secret_file):
            with open(secret_file, "r", encoding="utf-8") as handle:
                saved = handle.read().strip()
            if saved:
                os.environ["SESSION_SECRET"] = saved
                return saved
        secret = secrets.token_urlsafe(32)
        os.makedirs(os.path.dirname(os.path.abspath(secret_file)) or ".", exist_ok=True)
        with open(secret_file, "w", encoding="utf-8") as handle:
            handle.write(secret)
        try:
            os.chmod(secret_file, 0o600)
        except OSError:
            pass
        os.environ["SESSION_SECRET"] = secret
        print("  Generated a SESSION_SECRET and saved it to %s" % secret_file)
        return secret
    except OSError:
        # Read-only filesystem (e.g. a container) — fall back to an ephemeral
        # secret. Logins won't survive a restart; the operator should set
        # SESSION_SECRET explicitly in that environment.
        secret = secrets.token_urlsafe(32)
        os.environ["SESSION_SECRET"] = secret
        print(
            "  WARNING: could not persist SESSION_SECRET (%s not writable) — "
            "using an ephemeral one. Set SESSION_SECRET to keep logins across "
            "restarts." % secret_file
        )
        return secret


def _redact_url(url: str) -> str:
    """Mask the password in a database/store URL so it is safe to print.

    ``postgresql://user:secret@host/db`` -> ``postgresql://user:***@host/db``.
    Non-URL values (a bare path) are returned unchanged.
    """
    if "://" not in url:
        return url
    scheme, rest = url.split("://", 1)
    if "@" not in rest:
        return url
    creds, host = rest.rsplit("@", 1)
    if ":" in creds:
        creds = creds.split(":", 1)[0] + ":***"
    return "%s://%s@%s" % (scheme, creds, host)


def _effective_stores() -> tuple:
    """Return ``(dashboard_store, dataset_store)`` as printable, redacted labels.

    The launcher used to print ``APP_DB_PATH`` unconditionally, which claimed
    SQLite even when ``CXD_DASHBOARD_STORE`` pointed at Postgres — so a typo in
    that variable silently fell back to SQLite and still looked healthy. Report
    what the app will actually open instead. Mirrors the resolution order in
    :func:`cxd_server.app.create_dashboards_app` and
    :meth:`cxd_server.stores.StoreRegistry.from_env`.
    """
    stores_path = os.getenv("CXD_STORES")
    if stores_path and os.path.isfile(stores_path):
        return ("see %s" % stores_path, "see %s" % stores_path)
    dashboard = os.getenv("CXD_DASHBOARD_STORE")
    dashboard = _redact_url(dashboard) if dashboard else (
        "sqlite %s" % os.getenv("APP_DB_PATH", "dashboards.db"))
    dataset = os.getenv("CXD_DATASET_STORE")
    dataset = _redact_url(dataset) if dataset else (
        "file://%s" % os.path.abspath("cxd-datasets"))
    return (dashboard, dataset)


def _int_env(name: str, default: int) -> int:
    """Read an integer env var, falling back to ``default`` when unset/invalid."""
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _parse_args(argv) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m cxd_server",
        description="Run the CanvasXpress Dashboards persistence & sharing server.",
    )
    parser.add_argument("--host", default=os.getenv("CXD_HOST", "127.0.0.1"),
                        help="bind address (env CXD_HOST, default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=_int_env("CXD_PORT", 8000),
                        help="bind port (env CXD_PORT, default 8000)")
    parser.add_argument("--reload", action="store_true",
                        help="auto-reload on code changes (development only)")
    parser.add_argument("--no-signup", action="store_true",
                        help="disable /auth/signup (same as ALLOW_SIGNUP=0)")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    """CLI entry point: resolve config, build the app, and serve it."""
    _load_dotenv()
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    if args.no_signup:
        os.environ["ALLOW_SIGNUP"] = "0"
    _resolve_session_secret()

    try:
        import uvicorn
    except ImportError:
        sys.stderr.write(
            "uvicorn is not installed. Install the web extra:\n"
            "    pip install 'canvasxpress-dashboards-server[web]'\n"
        )
        return 1

    from .app import create_dashboards_app

    # Build eagerly so misconfiguration surfaces here (not on first request);
    # --reload needs an import string, so hand uvicorn a factory in that mode.
    if args.reload:
        target = "cxd_server.__main__:_app_factory"
    else:
        target = create_dashboards_app()

    dashboard_store, dataset_store = _effective_stores()
    print("\n  CanvasXpress Dashboards server")
    print("    http://%s:%d/\n" % (args.host, args.port))
    print("    signup:     %s" % ("disabled" if os.getenv("ALLOW_SIGNUP") == "0" else "enabled"))
    print("    dashboards: %s" % dashboard_store)
    print("    datasets:   %s\n" % dataset_store)
    uvicorn.run(target, host=args.host, port=args.port, reload=args.reload,
                factory=args.reload)
    return 0


def _app_factory():
    """Import-string target used only under ``--reload``."""
    from .app import create_dashboards_app
    return create_dashboards_app()


if __name__ == "__main__":
    raise SystemExit(main())
