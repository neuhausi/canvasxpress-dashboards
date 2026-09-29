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
    with pytest.raises(RuntimeError, match=r"needs canvasxpress-connectors 0\.6\+.*\[connectors\]"):
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
