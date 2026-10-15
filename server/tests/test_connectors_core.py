"""The core canvasxpress-connectors integration (cxd_server.connectors): what the
`python -m cxd_server` launcher installs with CXD_CONNECTORS=on, and the
scheduled refresh from a database source with bound parameter values.

The end-to-end tests go through the real HTTP API: sign up, bridge into the
connectors app, register a SQLite source with a bind parameter, schedule a
refresh with ``params``, run it, and read the dataset back.
"""

import os
import sqlite3

import pytest

from cxd_server.connectors import (connectors_enabled, default_db_path, derive_bridge_password,
                                   install_connectors, install_from_env)


def test_enable_flag_and_default_store_path(tmp_path):
    assert connectors_enabled({"CXD_CONNECTORS": "on"}) and connectors_enabled({"CXD_CONNECTORS": "1"})
    assert not connectors_enabled({}) and not connectors_enabled({"CXD_CONNECTORS": "off"})
    db = str(tmp_path / "data" / "dashboards.db")
    assert default_db_path({"APP_DB_PATH": db}) == str(tmp_path / "data" / "connectors.db")
    assert default_db_path({"CXD_CONNECTORS_DB": "/x/c.db", "APP_DB_PATH": db}) == "/x/c.db"
    assert derive_bridge_password("k", "ann") == derive_bridge_password("k", "ann")
    assert derive_bridge_password("k", "ann") != derive_bridge_password("k2", "ann")


def test_the_key_is_required_and_never_generated(monkeypatch, tmp_path):
    with pytest.raises(RuntimeError, match="needs ENCRYPTION_KEY.*never generated"):
        install_connectors(object(), str(tmp_path / "c.db"), None)


def test_a_missing_package_is_a_clear_error(monkeypatch, tmp_path):
    """Without canvasxpress-connectors, turning the feature on names the extra to install."""
    import builtins
    real_import = builtins.__import__

    def no_connectors(name, *args, **kwargs):
        if name.startswith("cx_connectors"):
            raise ImportError("No module named 'cx_connectors'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_connectors)
    with pytest.raises(RuntimeError, match=r"needs canvasxpress-connectors 0\.8\+.*\[connectors\]"):
        install_connectors(object(), str(tmp_path / "c.db"), "any-key", session_secret="s")
    monkeypatch.setenv("CXD_CONNECTORS", "off")
    assert install_from_env(object()) is None, "off: nothing installed"


# ---- with the connectors package (each test skips without it) ---------------------------
from fastapi.testclient import TestClient  # noqa: E402

from cxd_server.app import create_dashboards_app  # noqa: E402
from cxd_server.store import DashboardStore  # noqa: E402


def generate_key():
    """A fresh Fernet key from canvasxpress-connectors (skips the test without it)."""
    return pytest.importorskip("cx_connectors.store").generate_key()


def test_an_invalid_key_or_no_session_secret_is_reported(monkeypatch, tmp_path):
    pytest.importorskip("cx_connectors.store")          # the Store is what rejects a bad key
    with pytest.raises(RuntimeError, match="not a valid Fernet key"):
        install_connectors(object(), str(tmp_path / "c.db"), "not-a-key", session_secret="s")
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="needs a session secret"):
        install_connectors(object(), str(tmp_path / "c.db"), generate_key())


@pytest.fixture
def warehouse(tmp_path):
    """A SQLite database with a few stock rows across regions."""
    path = tmp_path / "wh.sqlite"
    con = sqlite3.connect(str(path))
    con.execute("CREATE TABLE stock (item TEXT, region TEXT, qty REAL)")
    con.executemany("INSERT INTO stock VALUES (?, ?, ?)",
                    [("bolts", "EMEA", 40), ("nuts", "APAC", 10), ("gears", "EMEA", 7)])
    con.commit()
    con.close()
    return "sqlite:///" + str(path)


@pytest.fixture
def app(tmp_path):
    key = generate_key()
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s", serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "datasets"), scheduler_enabled=False)
    install_connectors(app, str(tmp_path / "sub" / "connectors.db"), key, session_secret="s")
    return app


def _bridged(app, user):
    """A client signed into the dashboards app AND, via the bridge, the connectors app."""
    client = TestClient(app)
    assert client.get("/api/connectors/credentials").status_code == 401, "needs a session"
    assert client.post("/auth/signup", json={"username": user, "password": "secret1"}).status_code == 200
    cred = client.get("/api/connectors/credentials").json()
    assert cred["username"] == user
    assert client.post("/connectors/auth/login", json=cred).status_code == 200
    return client


def test_install_mounts_the_app_and_registers_the_refresh_origin(app):
    assert "connector" in app.state.origin_fetchers
    client = _bridged(app, "ann")
    assert client.get("/connectors/api/sources").json() == {"sources": []}
    assert client.get("/api/connectors/sources-meta").json() == {"sources": []}


def test_scheduled_refresh_binds_parameter_values(app, warehouse):
    client = _bridged(app, "ann")
    sql = "SELECT item, qty FROM stock WHERE (:region IS NULL OR region = :region) ORDER BY item"
    assert client.post("/connectors/api/sources",
                       json={"name": "stock", "conn_url": warehouse, "sql": sql}).status_code == 200
    meta = client.get("/api/connectors/sources-meta").json()["sources"]
    assert meta[0]["name"] == "stock" and meta[0]["location"] == "sqlite"

    def schedule(origin):
        r = client.post("/api/schedules", json={"kind": "refresh", "name": "Stock", "cron": "@daily",
                                                "config": {"dataset": "stock", "origin": origin}})
        assert r.status_code == 200, r.text
        return r.json()["schedule"]

    def run(s):
        r = client.post("/api/schedules/%s/run" % s["id"])
        assert r.status_code == 200, r.text
        return r.json()["run"]

    # No params: :region is NULL, as before -> every row.
    s = schedule({"kind": "connector", "source": "stock"})
    assert run(s)["status"] == "ok"
    assert client.get("/api/datasets/stock").json()["y"]["smps"] == ["bolts", "gears", "nuts"]

    # A bound value narrows the refresh to that region.
    s = schedule({"kind": "connector", "source": "stock", "params": {"region": "EMEA"}})
    assert s["config"]["origin"]["params"] == {"region": "EMEA"}
    assert run(s)["status"] == "ok"
    assert client.get("/api/datasets/stock").json()["y"]["smps"] == ["bolts", "gears"]

    # A name the query does not declare fails the run with a clear message.
    s = schedule({"kind": "connector", "source": "stock", "params": {"country": "FR"}})
    failed = run(s)
    assert failed["status"] == "error" and "has no parameter country" in failed["message"]

    # Values must be scalars.
    r = client.post("/api/schedules", json={"kind": "refresh", "name": "Bad", "cron": "@daily",
                                            "config": {"dataset": "stock", "origin": {
                                                "kind": "connector", "source": "stock",
                                                "params": {"region": ["EMEA"]}}}})
    assert r.status_code == 400 and "origin params" in r.text


def test_the_launcher_hook_installs_from_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("CXD_CONNECTORS", "on")
    monkeypatch.setenv("CXD_CONNECTORS_DB", str(tmp_path / "c.db"))
    monkeypatch.delenv("ENCRYPTION_KEY", raising=False)
    monkeypatch.setenv("SESSION_SECRET", "s")        # the launcher always sets it
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
                                serve_static=False, dataset_store_uri="file://" + str(tmp_path / "ds"),
                                scheduler_enabled=False)
    with pytest.raises(RuntimeError, match="needs ENCRYPTION_KEY"):
        install_from_env(app)
    monkeypatch.setenv("ENCRYPTION_KEY", generate_key())
    assert install_from_env(app) is not None
    assert "connector" in app.state.origin_fetchers and os.path.exists(str(tmp_path / "c.db"))


def test_routes_are_reachable_when_the_app_shell_is_mounted_at_root(tmp_path):
    """With serve_static on (as the launcher runs it) the app shell is a mount at
    "/", which would swallow /connectors and /api/connectors/* if they came after it."""
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
                                dataset_store_uri="file://" + str(tmp_path / "ds"), scheduler_enabled=False)
    install_connectors(app, str(tmp_path / "c.db"), generate_key(), session_secret="s")
    client = TestClient(app)
    assert client.get("/api/connectors/credentials").status_code == 401    # our route, not the shell's 404
    assert client.post("/connectors/auth/login", json={"username": "x", "password": "y"}).status_code != 405
    assert client.get("/").status_code == 200                              # the shell still serves


# ---------------------------------------------------------------------------
# Databricks "sign in as the viewer" (Posit Connect OAuth)
# ---------------------------------------------------------------------------

# A credential-free Databricks source: it borrows the signed-in viewer's token.
_VIEWER_DBX = ("databricks://posit-connect@dbc-1234.cloud.databricks.com"
               "?http_path=/sql/1.0/warehouses/abc123&catalog=main&schema=default")


def test_viewer_oauth_source_cannot_be_scheduled(app):
    """A scheduled refresh runs with no viewer, so a viewer-OAuth source (no
    credential of its own) must fail clearly rather than connect as nobody."""
    client = _bridged(app, "ann")
    assert client.post("/connectors/api/sources",
                       json={"name": "dbx", "conn_url": _VIEWER_DBX,
                             "sql": "SELECT a, b FROM t"}).status_code == 200
    fetch = app.state.origin_fetchers["connector"]
    with pytest.raises(ValueError, match="cannot be refreshed on a schedule"):
        fetch("ann", "dbx")


def test_schema_route_403_without_a_viewer_session(app):
    """The wizard/editor schema route resolves a viewer-OAuth URL per request;
    with no Posit-Connect-User-Session-Token header it is a clear 403, not a 502."""
    client = _bridged(app, "ann")
    r = client.post("/api/connectors/schema", json={"conn_url": _VIEWER_DBX})
    assert r.status_code == 403
    assert "signed-in viewer" in r.json()["detail"]


# ---------------------------------------------------------------------------
# Store backend: bare path vs. database URL (cx_connectors.sqlstore.open_store)
# ---------------------------------------------------------------------------

def test_store_target_is_classified_and_logged_without_credentials():
    from cxd_server.connectors import _is_store_url, _store_location_label
    assert _is_store_url("sqlite:///x.db") and _is_store_url("postgresql://h/db")
    assert _is_store_url("postgresql+psycopg://h/db")
    assert not _is_store_url("/var/lib/connectors.db") and not _is_store_url("connectors.db")
    # A URL is logged as scheme@host only — never its password.
    assert _store_location_label("postgresql://user:s3cret@db.host:5432/app") == "postgresql@db.host"
    assert "s3cret" not in _store_location_label("postgresql://user:s3cret@db.host/app")
    assert _store_location_label("/var/lib/connectors.db") == "/var/lib/connectors.db"


def test_a_bare_path_store_creates_its_directory(tmp_path):
    """A bare path still gets its parent directory created (as before)."""
    pytest.importorskip("cx_connectors.sqlstore")
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
                                serve_static=False, dataset_store_uri="file://" + str(tmp_path / "ds"),
                                scheduler_enabled=False)
    install_connectors(app, str(tmp_path / "made" / "connectors.db"), generate_key(), session_secret="s")
    assert (tmp_path / "made").is_dir()


def test_schema_and_test_work_against_a_url_backed_store(tmp_path, warehouse):
    """With the store itself addressed by a sqlite:// URL (open_store dispatch),
    bridging and the wizard's schema / Test routes still work end-to-end."""
    pytest.importorskip("cx_connectors.sqlstore")
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
                                serve_static=False, dataset_store_uri="file://" + str(tmp_path / "ds"),
                                scheduler_enabled=False)
    store_url = "sqlite:///" + str(tmp_path / "store.sqlite")
    install_connectors(app, store_url, generate_key(), session_secret="s")
    client = _bridged(app, "ann")
    sql = "SELECT item, qty FROM stock ORDER BY item"
    assert client.post("/connectors/api/sources",
                       json={"name": "stock", "conn_url": warehouse, "sql": sql}).status_code == 200
    r = client.post("/api/connectors/schema", json={"conn_url": warehouse})
    assert r.status_code == 200 and any(t["name"] == "stock" for t in r.json()["tables"])
    r = client.post("/api/connectors/test", json={"conn_url": warehouse, "sql": sql})
    assert r.status_code == 200 and r.json()["rows"] == 3


# ---------------------------------------------------------------------------
# Packaged demo sources (cxd_server.demo_sources)
# ---------------------------------------------------------------------------

def test_demo_sources_enabled_flag():
    from cxd_server.demo_sources import demo_sources_enabled
    assert demo_sources_enabled({"CXD_CONNECTORS_DEMO_SOURCES": "on"})
    assert not demo_sources_enabled({}) and not demo_sources_enabled({"CXD_CONNECTORS_DEMO_SOURCES": "off"})


def test_demo_databases_are_available_and_read_only(tmp_path):
    from cxd_server.demo_sources import demo_db_url, ensure_demo_db
    for name in ("inventory.db", "sales.db"):
        path = ensure_demo_db(name)
        assert os.path.isfile(path)
        assert demo_db_url(name) == "sqlite:///file:" + path + "?mode=ro&uri=true"
    # The read-only copy rejects writes at the driver.
    inv = ensure_demo_db("inventory.db")
    conn = sqlite3.connect("file:" + inv + "?mode=ro", uri=True)
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("INSERT INTO product_inventory VALUES ('x', 'y', 'z', 1, 1.0)")
            conn.commit()
    finally:
        conn.close()


def test_seed_adds_once_updates_stale_and_leaves_user_sources_alone():
    sqlstore = pytest.importorskip("cx_connectors.sqlstore")
    from cxd_server.demo_sources import demo_db_url, seed_demo_sources
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        store = sqlstore.open_store(os.path.join(d, "c.db"), generate_key())
        # Added once.
        seed_demo_sources(store, "ann")
        assert set(store.list_sources("ann")) >= {"inventory", "furniture-only"}
        current = demo_db_url("inventory.db")
        assert store.get_source("ann", "inventory")["conn_url"] == current
        # Idempotent: a second pass adds no duplicates and changes nothing.
        before = sorted(store.list_sources("ann"))
        seed_demo_sources(store, "ann")
        assert sorted(store.list_sources("ann")) == before

        # A demo source whose stored path drifted (a different cxd-demo-data path,
        # e.g. a prior deploy) is re-saved to the current URL.
        stale = "sqlite:///file:/tmp/old/cxd-demo-data/inventory.db?mode=ro&uri=true"
        store.save_source("ann", "inventory", stale, "SELECT 1")
        seed_demo_sources(store, "ann")
        assert store.get_source("ann", "inventory")["conn_url"] == current

        # A source the USER created that happens to share a demo name (its URL is
        # not a demo-copy URL) is never modified.
        mine = "sqlite:///file:/home/ann/my.db?mode=ro&uri=true"
        store.save_source("ann", "furniture-only", mine, "SELECT 2")
        seed_demo_sources(store, "ann")
        kept = store.get_source("ann", "furniture-only")
        assert kept["conn_url"] == mine and kept["sql"] == "SELECT 2"


def test_ensure_demo_db_is_atomic_and_repairs_a_bad_size(monkeypatch, tmp_path):
    """A half-written copy (wrong size vs. the packaged db) is re-copied, and the
    copy is written atomically (temp + os.replace) so a racing worker never reads
    a partial file."""
    import cxd_server.demo_sources as ds
    monkeypatch.setattr(ds, "_demo_dir", lambda: str(tmp_path))
    good = ds.ensure_demo_db("inventory.db")
    full = os.path.getsize(good)
    assert full > 0
    # Simulate a half-written copy left by an older build.
    with open(good, "wb") as fh:
        fh.write(b"\x00" * 10)
    repaired = ds.ensure_demo_db("inventory.db")
    assert os.path.getsize(repaired) == full
    # No leftover temp files from the atomic write.
    assert not [n for n in os.listdir(tmp_path) if n.startswith(".tmp-") or ".build-" in n]


def test_connectors_cookie_gets_secure_flag_with_https_only(tmp_path):
    pytest.importorskip("cx_connectors.sqlstore")
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
                                serve_static=False, dataset_store_uri="file://" + str(tmp_path / "ds"),
                                scheduler_enabled=False)
    install_connectors(app, str(tmp_path / "c.db"), generate_key(), session_secret="s",
                       https_only=True)
    client = TestClient(app)
    client.post("/auth/signup", json={"username": "ann", "password": "secret1"})
    cred = client.get("/api/connectors/credentials").json()
    r = client.post("/connectors/auth/login", json=cred)
    assert r.status_code == 200
    assert "secure" in r.headers.get("set-cookie", "").lower()


def test_launcher_hook_seeds_demo_sources_when_enabled(monkeypatch, tmp_path):
    pytest.importorskip("cx_connectors.sqlstore")
    monkeypatch.setenv("CXD_CONNECTORS", "on")
    monkeypatch.setenv("CXD_CONNECTORS_DB", str(tmp_path / "c.db"))
    monkeypatch.setenv("CXD_CONNECTORS_DEMO_SOURCES", "on")
    monkeypatch.setenv("ENCRYPTION_KEY", generate_key())
    monkeypatch.setenv("SESSION_SECRET", "s")
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
                                serve_static=False, dataset_store_uri="file://" + str(tmp_path / "ds"),
                                scheduler_enabled=False)
    assert install_from_env(app) is not None
    client = _bridged(app, "ann")
    names = {s["name"] for s in client.get("/api/connectors/sources-meta").json()["sources"]}
    assert {"inventory", "furniture-only", "sales"} <= names


def test_sales_demo_source_returns_revenue_by_region(tmp_path):
    """The packaged `sales` demo source (backing the Sales Live example on any
    install) reads revenue-by-region live through the connectors data endpoint."""
    pytest.importorskip("cx_connectors.sqlstore")
    from cxd_server.demo_sources import seed_demo_sources
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
                                serve_static=False, dataset_store_uri="file://" + str(tmp_path / "ds"),
                                scheduler_enabled=False)
    install_connectors(app, str(tmp_path / "c.db"), generate_key(), session_secret="s",
                       seed=seed_demo_sources)
    client = _bridged(app, "ann")
    r = client.get("/connectors/api/data?source=sales")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["y"]["vars"] == ["Revenue"]
    assert set(body["y"]["smps"]) == {"North", "South", "East", "West", "Central"}
    assert all(v > 0 for v in body["y"]["data"][0])
