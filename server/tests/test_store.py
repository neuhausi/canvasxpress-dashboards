import os
import sqlite3

import pytest

from cxd_server.sqldashboard import SqlDashboardStore
from cxd_server.store import DashboardStore

# Set CXD_TEST_PG_URL to also run the SqlDashboardStore asserts against a real
# Postgres (the durable-deployment proof); unset → the pg param is absent.
_PG_URL = os.getenv("CXD_TEST_PG_URL")


def _stdlib_store(tmp_path):
    return DashboardStore(str(tmp_path / "dash.db"))


def _sql_store(tmp_path):
    # SQLite proves the SQL dashboard store; Postgres runs the identical code.
    return SqlDashboardStore("sqlite:///" + str(tmp_path / "sql-dash.db"))


def _pg_store(tmp_path):
    # Real Postgres. The dashboard store uses fixed table names, so drop them
    # first for per-test isolation on the shared server DB; create_all rebuilds.
    import sqlalchemy as sa

    engine = sa.create_engine(_PG_URL, future=True)
    with engine.begin() as conn:
        for tbl in ("cxd_dashboards", "cxd_users"):
            conn.execute(sa.text("DROP TABLE IF EXISTS " + tbl))
    return SqlDashboardStore(_PG_URL, engine=engine)


# Both backends run through the same asserts → SQLite↔Postgres parity. The real-
# Postgres param joins only when CXD_TEST_PG_URL is set (else absent, never red).
_PARAMS = [(_stdlib_store, "stdlib"), (_sql_store, "sql")]
if _PG_URL:
    _PARAMS.append((_pg_store, "pg"))


@pytest.fixture(params=[p[0] for p in _PARAMS], ids=[p[1] for p in _PARAMS])
def store(request, tmp_path):
    return request.param(tmp_path)


def _spec(dashboard_id="d1", title="Sales"):
    return {"id": dashboard_id, "title": title, "layout": {"items": []}, "panels": {}}


def test_password_roundtrip_and_duplicate(store):
    assert store.create_user("alice", "secret1")
    assert store.check_user("alice", "secret1")
    assert not store.check_user("alice", "nope")
    assert not store.create_user("alice", "again")


def test_password_never_stored_plaintext(tmp_path):
    db = str(tmp_path / "dash.db")
    store = DashboardStore(db)
    store.create_user("bob", "hunter2secret")
    blob = sqlite3.connect(db).execute("SELECT pw_hash FROM users").fetchone()[0]
    assert b"hunter2secret" not in blob


def test_save_reload_roundtrip(store):
    store.create_user("alice", "secret1")
    spec = _spec()
    store.save_dashboard("alice", spec, "2026-07-22T00:00:00Z")
    assert store.get_dashboard("alice", "d1") == spec


def test_owner_isolation(store):
    store.save_dashboard("alice", _spec(), "2026-07-22T00:00:00Z")
    assert store.get_dashboard("bob", "d1") is None
    assert store.list_dashboards("bob") == []


def test_update_preserves_share_token(store):
    store.save_dashboard("alice", _spec(), "t1")
    shared = store.set_visibility("alice", "d1", "public")
    token = shared["share_token"]
    assert token
    # Re-saving must not silently unshare.
    store.save_dashboard("alice", _spec(title="Renamed"), "t2")
    summary = store.get_summary("alice", "d1")
    assert summary["visibility"] == "public"
    assert summary["share_token"] == token
    assert summary["title"] == "Renamed"


def test_share_token_resolves_and_private_clears(store):
    store.save_dashboard("alice", _spec(), "t1")
    shared = store.set_visibility("alice", "d1", "public")
    token = shared["share_token"]
    resolved = store.get_shared(token)
    assert resolved["spec"]["id"] == "d1"
    assert resolved["owner"] == "alice"
    assert resolved["visibility"] == "public"
    # Making it private clears the token.
    store.set_visibility("alice", "d1", "private")
    assert store.get_shared(token) is None
    assert store.get_summary("alice", "d1")["share_token"] is None


def test_set_visibility_missing_dashboard(store):
    assert store.set_visibility("alice", "ghost", "public") is None


def test_invalid_visibility_rejected(store):
    store.save_dashboard("alice", _spec(), "t1")
    with pytest.raises(ValueError):
        store.set_visibility("alice", "d1", "everyone")


def test_delete(store):
    store.save_dashboard("alice", _spec(), "t1")
    store.delete_dashboard("alice", "d1")
    assert store.get_dashboard("alice", "d1") is None


# ---- user management (admin) — parity across both dashboard stores ----
def test_list_users_sorted(store):
    store.create_user("bob", "secret1")
    store.create_user("alice", "secret1")
    assert store.list_users() == ["alice", "bob"]


def test_set_password(store):
    store.create_user("alice", "secret1")
    assert store.set_password("alice", "newpass1")
    assert store.check_user("alice", "newpass1")
    assert not store.check_user("alice", "secret1")
    assert not store.set_password("ghost", "whatever")


def test_delete_user_removes_dashboards(store):
    store.create_user("alice", "secret1")
    store.save_dashboard("alice", _spec(), "t1")
    assert store.delete_user("alice")
    assert store.list_users() == []
    assert store.list_dashboards("alice") == []
    assert not store.delete_user("alice")


def test_is_admin_flag(store):
    store.create_user("root", "secret1", is_admin=True)
    store.create_user("alice", "secret1")
    assert store.is_admin("root")
    assert not store.is_admin("alice")
    assert not store.is_admin("ghost")


def test_set_admin_grant_revoke(store):
    store.create_user("alice", "secret1")
    assert not store.is_admin("alice")
    assert store.set_admin("alice", True) and store.is_admin("alice")
    assert store.set_admin("alice", False) and not store.is_admin("alice")
    assert not store.set_admin("ghost", True)
