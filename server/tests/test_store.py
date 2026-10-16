import inspect
import sqlite3

import pytest

from cxd_server.sqldashboard import SqlDashboardStore
from cxd_server.store import DashboardStore


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


def test_lock_roundtrip_survives_resave(store):
    store.save_dashboard("alice", _spec(), "t1")
    assert not store.is_locked("alice", "d1")
    assert store.get_summary("alice", "d1")["locked"] is False
    assert store.set_locked("alice", "d1", True)["locked"] is True
    assert store.is_locked("alice", "d1")
    assert not store.is_locked("bob", "d1")
    # Re-saving must not silently unlock.
    store.save_dashboard("alice", _spec(title="Renamed"), "t2")
    assert store.list_dashboards("alice")[0]["locked"] is True
    assert store.set_locked("alice", "absent", True) is None
    assert not store.is_locked("alice", "absent")


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


# ---- comments, Ask history, purge: identical behaviour on every backend ----
def test_sql_store_has_every_public_method_of_the_sqlite_store():
    """The SQL store is a drop-in for DashboardStore; a method added to one must
    exist on the other (a missing one was a 500 on Postgres)."""
    def public(cls):
        return {n for n, _ in inspect.getmembers(cls, callable) if not n.startswith("_")}
    assert public(DashboardStore) - public(SqlDashboardStore) == set()
    for name in public(DashboardStore):
        mine = inspect.signature(getattr(DashboardStore, name))
        theirs = inspect.signature(getattr(SqlDashboardStore, name))
        assert list(mine.parameters) == list(theirs.parameters), name


def test_comments_roundtrip_threads_resolve_and_delete(store):
    c1 = store.add_comment("alice", "d1", "bob", "first", "2026-01-01T00:00:01", panel_id="p1",
                           mentions=["carol"])
    assert set(c1) == {"comment_id", "owner", "dashboard_id", "panel_id", "parent_id", "author", "body",
                       "mentions", "created_at", "resolved_at", "resolved_by", "resolved"}
    assert (c1["panel_id"], c1["mentions"], c1["resolved"], c1["created_at"]) == ("p1", ["carol"], False,
                                                                                  "2026-01-01T00:00:01")
    reply = store.add_comment("alice", "d1", "carol", "re", "2026-01-01T00:00:02", parent_id=c1["comment_id"])
    assert reply["mentions"] == [] and reply["parent_id"] == c1["comment_id"]
    other = store.add_comment("alice", "d2", "bob", "elsewhere", "2026-01-01T00:00:03")
    assert [c["body"] for c in store.list_comments("alice", "d1")] == ["first", "re"]   # oldest first, scoped
    assert store.get_comment("nope") is None and store.resolve_comment("nope", "x", "t") is None
    done = store.resolve_comment(c1["comment_id"], "alice", "2026-01-02T00:00:00")
    assert (done["resolved"], done["resolved_by"], done["resolved_at"]) == (True, "alice", "2026-01-02T00:00:00")
    reopened = store.resolve_comment(c1["comment_id"], "alice", "t", resolved=False)
    assert reopened["resolved"] is False and reopened["resolved_by"] is None
    assert store.delete_comment(c1["comment_id"]) is True       # takes its replies with it
    assert store.get_comment(reply["comment_id"]) is None
    assert store.delete_comment(c1["comment_id"]) is False
    store.delete_dashboard_comments("alice", "d2")
    assert store.get_comment(other["comment_id"]) is None


def test_asks_roundtrip_order_limit_and_delete(store):
    a1 = store.add_ask("alice", "d1", "bob", "q1", "a1", [{"tool": "aggregate"}], "2026-01-01T00:00:01")
    a2 = store.add_ask("alice", "d1", "bob", "q2", "a2", None, "2026-01-01T00:00:02")
    store.add_ask("alice", "d2", "bob", "q3", "a3", [], "2026-01-01T00:00:03")
    assert set(a1) == {"ask_id", "owner", "dashboard_id", "author", "question", "answer", "used", "created_at"}
    assert a1["used"] == [{"tool": "aggregate"}] and a2["used"] == []
    assert [a["question"] for a in store.list_asks("alice", "d1")] == ["q2", "q1"]   # newest first
    assert [a["question"] for a in store.list_asks("alice", "d1", limit=1)] == ["q2"]
    assert store.get_ask("nope") is None
    assert store.delete_ask(a1["ask_id"]) is True and store.delete_ask(a1["ask_id"]) is False
    store.delete_dashboard_asks("alice", "d1")
    assert store.list_asks("alice", "d1") == [] and len(store.list_asks("alice", "d2")) == 1


def test_purge_removes_the_dashboard_with_its_comments_and_asks(store):
    store.save_dashboard("alice", _spec("d1"), "2026-01-01T00:00:00")
    store.save_dashboard("alice", _spec("d2"), "2026-01-01T00:00:00")
    store.add_comment("alice", "d1", "bob", "x", "2026-01-01T00:00:01")
    store.add_comment("alice", "d2", "bob", "keep", "2026-01-01T00:00:01")
    store.add_ask("alice", "d1", "bob", "q", "a", None, "2026-01-01T00:00:01")
    store.purge_dashboard("alice", "d1")
    assert store.get_dashboard("alice", "d1") is None
    assert store.list_comments("alice", "d1") == [] and store.list_asks("alice", "d1") == []
    assert len(store.list_comments("alice", "d2")) == 1 and store.get_dashboard("alice", "d2") is not None
    store.purge_dashboard("alice", "d1")        # absent: a no-op
