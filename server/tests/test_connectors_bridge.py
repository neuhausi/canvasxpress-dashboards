"""The dashboards -> canvasxpress-connectors session bridge in examples/serve.py.

The bridged password is derived from ENCRYPTION_KEY, so rotating SESSION_SECRET
(which signs cookies) no longer locks users out of their saved connections; users
created by the earlier SESSION_SECRET derivation are re-keyed on their next visit.

Each test imports serve.py fresh against a temp data dir (CXD_DEMO_DATA_DIR), so a
running demo's databases are never touched, and restores the whole environment
afterwards (serve.py also loads the repo .env into os.environ).
"""

import importlib.util
import itertools
import os
import sqlite3

import pytest
from fastapi.testclient import TestClient

pytest.importorskip("cx_connectors")
from cx_connectors.store import Store, generate_key  # noqa: E402

SERVE = os.path.join(os.path.dirname(__file__), "..", "..", "examples", "serve.py")
_SET_BY_SERVE = ("APP_DB_PATH", "CXD_DATASET_STORE", "CXD_EXAMPLES_OWNER",
                 "CXD_DISPOSABLE_DASHBOARDS", "CXD_MCP_LOG")
_imports = itertools.count()


@pytest.fixture
def demo(tmp_path):
    """Env for an isolated demo server; yields a loader that (re-)imports serve.py."""
    saved = dict(os.environ)
    for name in _SET_BY_SERVE:          # serve.py setdefault()s these to its data dir
        os.environ.pop(name, None)
    os.environ.update({
        "CXD_DEMO_DATA_DIR": str(tmp_path / "demo"),
        "SESSION_SECRET": "session-secret-A",
        "ENCRYPTION_KEY": generate_key(),
        "ALLOW_SIGNUP": "1",
        "CXD_MOUNT_PREFIX": "",
    })

    def load():
        spec = importlib.util.spec_from_file_location("cxd_demo_serve_%d" % next(_imports), SERVE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if module._connectors_store is None:
            pytest.skip("connectors app not mounted in serve.py")
        return module

    try:
        yield load
    finally:
        os.environ.clear()
        os.environ.update(saved)


@pytest.fixture
def warehouse(tmp_path):
    """A small SQLite database for a user's registered source."""
    path = tmp_path / "warehouse.db"
    con = sqlite3.connect(str(path))
    con.execute("CREATE TABLE stock (item TEXT, qty INTEGER)")
    con.executemany("INSERT INTO stock VALUES (?, ?)", [("bolts", 40), ("nuts", 25)])
    con.commit()
    con.close()
    return "sqlite:///" + str(path)


def _sign_in(module, username="alice", password="secret1", signup=False):
    """A client signed in to the dashboards app and bridged into /connectors.

    :returns: ``(client, bridge_login_status)``.
    """
    client = TestClient(module.app)
    route = "/auth/signup" if signup else "/auth/login"
    assert client.post(route, json={"username": username, "password": password}).status_code == 200
    cred = client.get("/api/connectors/credentials")
    assert cred.status_code == 200, cred.text
    login = client.post("/connectors/auth/login", json=cred.json())
    return client, login.status_code


def test_a_saved_source_survives_a_session_secret_rotation(demo, warehouse):
    module = demo()
    client, status = _sign_in(module, signup=True)
    assert status == 200
    saved = client.post("/connectors/api/sources", json={
        "name": "mine", "conn_url": warehouse, "sql": "SELECT item, qty FROM stock ORDER BY item"})
    assert saved.status_code == 200, saved.text
    before = client.get("/connectors/api/data?source=mine")
    assert before.status_code == 200, before.text

    os.environ["SESSION_SECRET"] = "session-secret-B"      # rotate
    module = demo()                                         # re-import the app
    client, status = _sign_in(module)
    assert status == 200, "the bridged user must still sign in to the connectors app"
    after = client.get("/connectors/api/data?source=mine")
    assert after.status_code == 200, after.text
    assert after.json() == before.json()


def test_a_legacy_user_is_rekeyed_and_then_survives_a_rotation(demo, warehouse):
    module = demo()
    TestClient(module.app).post("/auth/signup", json={"username": "alice", "password": "secret1"})
    # Created by the earlier code: password keyed on SESSION_SECRET.
    legacy = module._derive_bridge_password(os.environ["SESSION_SECRET"], "alice")
    module._connectors_store.create_user("alice", legacy)
    module._connectors_store.save_source("alice", "mine", warehouse, "SELECT item, qty FROM stock")

    client, status = _sign_in(module)
    assert status == 200
    store = module._connectors_store
    assert store.check_user("alice", module._derive_bridge_password(os.environ["ENCRYPTION_KEY"], "alice"))
    assert not store.check_user("alice", legacy), "re-keyed to the ENCRYPTION_KEY derivation"

    os.environ["SESSION_SECRET"] = "session-secret-B"
    module = demo()
    client, status = _sign_in(module)
    assert status == 200
    assert client.get("/connectors/api/data?source=mine").status_code == 200


def test_a_legacy_user_keeps_the_old_credential_on_a_store_without_set_password(demo, monkeypatch):
    monkeypatch.delattr(Store, "set_password")             # an older canvasxpress-connectors
    module = demo()
    TestClient(module.app).post("/auth/signup", json={"username": "alice", "password": "secret1"})
    legacy = module._derive_bridge_password(os.environ["SESSION_SECRET"], "alice")
    module._connectors_store.create_user("alice", legacy)
    client, status = _sign_in(module)
    assert status == 200
    assert module._connectors_store.check_user("alice", legacy), "not re-keyed: no set_password"


def test_an_account_made_directly_in_the_connectors_app_is_not_taken_over(demo):
    module = demo()
    TestClient(module.app).post("/auth/signup", json={"username": "alice", "password": "secret1"})
    module._connectors_store.create_user("alice", "her-own-password")
    client, status = _sign_in(module)
    assert status == 401, "the bridge cannot prove the account is alice's"
    assert module._connectors_store.check_user("alice", "her-own-password")
