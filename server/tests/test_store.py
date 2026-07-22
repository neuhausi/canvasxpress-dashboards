import sqlite3

import pytest

from cxd_server.store import DashboardStore


@pytest.fixture
def store(tmp_path):
    return DashboardStore(str(tmp_path / "dash.db"))


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
