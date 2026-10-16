"""Deleting a dashboard cleans up everything attached to it, on every store backend."""

import pytest
from dashstores import backend_params
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app


@pytest.fixture(**backend_params())
def app(request, tmp_path):
    store = request.param(tmp_path)
    app = create_dashboards_app(store=store, session_secret="s", serve_static=False,
                                dataset_store_uri="file://" + str(tmp_path / "ds"))
    app.state.store = store      # for the tests to reach the backend directly
    return app


def _spec():
    return {"id": "d1", "title": "Sales", "layout": {"items": []}, "panels": {}}


def _signup(client, name):
    assert client.post("/auth/signup", json={"username": name, "password": "secret1"}).status_code == 200


def _populated(app):
    """alice owns d1 with a comment, an ask and a view grant to bob."""
    alice, bob = TestClient(app), TestClient(app)
    _signup(alice, "alice")
    _signup(bob, "bob")
    alice.post("/api/dashboards", json=_spec())
    assert alice.post("/api/dashboards/d1/comments", json={"body": "hi"}).status_code == 200
    app.state.store.add_ask("alice", "d1", "alice", "q", "a", None, "2026-01-01T00:00:00")
    assert alice.post("/api/dashboards/d1/grants",
                      json={"principal": "user:bob", "level": "view"}).status_code == 200
    assert bob.get("/api/dashboards/d1", params={"owner": "alice"}).status_code == 200
    return alice, bob


def test_delete_removes_comments_asks_and_grants_so_a_recreated_id_starts_clean(app):
    alice, bob = _populated(app)
    assert alice.delete("/api/dashboards/d1").status_code == 200
    alice.post("/api/dashboards", json=_spec())
    assert alice.get("/api/dashboards/d1/comments").json()["comments"] == []
    assert alice.get("/api/dashboards/d1/asks").json()["asks"] == []
    # bob's old grant must not resurrect on the re-created id
    assert bob.get("/api/dashboards/d1", params={"owner": "alice"}).status_code == 404


def test_a_failed_grant_cleanup_deletes_nothing_and_a_retry_completes(app, monkeypatch):
    alice, bob = _populated(app)
    real = app.state.governance.forget_resource

    def boom(*a, **k):
        raise RuntimeError("db down")
    monkeypatch.setattr(app.state.governance, "forget_resource", boom)
    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.cookies.update(alice.cookies)
    assert quiet.delete("/api/dashboards/d1").status_code == 500
    # nothing was deleted: dashboard, comments and bob's access are all intact
    assert alice.get("/api/dashboards/d1").status_code == 200
    assert len(alice.get("/api/dashboards/d1/comments").json()["comments"]) == 1
    assert bob.get("/api/dashboards/d1", params={"owner": "alice"}).status_code == 200
    monkeypatch.setattr(app.state.governance, "forget_resource", real)
    assert alice.delete("/api/dashboards/d1").status_code == 200
    assert alice.get("/api/dashboards/d1").status_code == 404


def test_a_failed_purge_never_leaves_grants_behind_a_deleted_dashboard(app, monkeypatch):
    alice, bob = _populated(app)
    store = app.state.store
    real_purge = store.purge_dashboard
    monkeypatch.setattr(store, "purge_dashboard", lambda *a: (_ for _ in ()).throw(RuntimeError("boom")))
    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.cookies.update(alice.cookies)
    assert quiet.delete("/api/dashboards/d1").status_code == 500
    # the dashboard still exists (not deleted), with its comments; a retry finishes the job
    assert alice.get("/api/dashboards/d1").status_code == 200
    assert len(alice.get("/api/dashboards/d1/comments").json()["comments"]) == 1
    monkeypatch.setattr(store, "purge_dashboard", real_purge)
    assert alice.delete("/api/dashboards/d1").status_code == 200
    alice.post("/api/dashboards", json=_spec())
    assert bob.get("/api/dashboards/d1", params={"owner": "alice"}).status_code == 404


def test_deleting_a_user_removes_comments_and_asks_on_their_dashboards_only(app):
    alice, bob = _populated(app)             # alice's d1 has a comment + an ask
    bob.post("/api/dashboards", json=dict(_spec(), id="b1"))
    bob.post("/api/dashboards/d1/comments", params={"owner": "alice"}, json={"body": "bob on alice's board"})
    app.state.store.add_comment("bob", "b1", "alice", "alice on bob's board", "2026-01-01T00:00:00")
    # (alice signed up first, so she is the admin)
    assert alice.delete("/api/admin/users/bob").status_code == 200
    # bob's own dashboard is gone with its comments; his comment on alice's board stays
    assert app.state.store.list_comments("bob", "b1") == []
    assert [c["author"] for c in app.state.store.list_comments("alice", "d1")] == ["alice", "bob"]
    assert alice.delete("/api/admin/users/alice").status_code == 400      # still can't delete yourself
    _signup(TestClient(app), "bob")          # the name is re-registered...
    again = TestClient(app)
    again.post("/auth/login", json={"username": "bob", "password": "secret1"})
    again.post("/api/dashboards", json=dict(_spec(), id="b1"))
    assert again.get("/api/dashboards/b1/comments").json()["comments"] == []   # ...and inherits nothing


def test_a_failed_account_cleanup_deletes_nothing_and_a_retry_completes(app, monkeypatch):
    alice, bob = _populated(app)
    real = app.state.governance.forget_user
    monkeypatch.setattr(app.state.governance, "forget_user",
                        lambda *a: (_ for _ in ()).throw(RuntimeError("db down")))
    quiet = TestClient(app, raise_server_exceptions=False)
    quiet.cookies.update(alice.cookies)
    assert quiet.delete("/api/admin/users/bob").status_code == 500
    assert "bob" in app.state.store.list_users()
    monkeypatch.setattr(app.state.governance, "forget_user", real)
    assert alice.delete("/api/admin/users/bob").status_code == 200
    assert "bob" not in app.state.store.list_users()
    assert alice.delete("/api/admin/users/bob").status_code == 404
