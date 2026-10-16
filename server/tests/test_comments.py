"""Collaboration: dashboard comments, threads, @mentions and permissions."""

import pytest
from dashstores import backend_params
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.mailer import MemoryMailer


@pytest.fixture(**backend_params())
def app(request, tmp_path):
    """The app on every dashboard-store backend (SQLite, SQL, + Postgres in CI)."""
    store = request.param(tmp_path)
    return create_dashboards_app(
        store=store,
        session_secret="test-secret",
        serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "datasets"),
    )


def _client(app):
    return TestClient(app)


def _spec(dashboard_id="d1", title="Sales"):
    return {"id": dashboard_id, "title": title, "layout": {"items": []}, "panels": {}}


def _signup(client, username="alice", password="secret1"):
    r = client.post("/auth/signup", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r


def _owner_with_d1(app):
    """A signed-in owner (admin, the first user) with dashboard d1 saved."""
    owner = _client(app)
    _signup(owner, "alice", "secret1")
    assert owner.post("/api/dashboards", json=_spec()).status_code == 200
    return owner


def test_comments_require_login(app):
    anon = _client(app)
    assert anon.get("/api/dashboards/d1/comments").status_code == 401
    assert anon.post("/api/dashboards/d1/comments", json={"body": "hi"}).status_code == 401


def test_owner_posts_and_lists(app):
    owner = _owner_with_d1(app)
    r = owner.post("/api/dashboards/d1/comments", json={"body": "Revenue looks off", "panelId": "p1"})
    assert r.status_code == 200, r.text
    c = r.json()["comment"]
    assert c["author"] == "alice" and c["body"] == "Revenue looks off"
    assert c["panel_id"] == "p1" and c["resolved"] is False and c["mentions"] == []

    listed = owner.get("/api/dashboards/d1/comments").json()["comments"]
    assert len(listed) == 1 and listed[0]["comment_id"] == c["comment_id"]
    assert listed[0]["replies"] == []


def test_empty_body_rejected(app):
    owner = _owner_with_d1(app)
    assert owner.post("/api/dashboards/d1/comments", json={"body": "   "}).status_code == 400


def test_reply_threads_under_parent(app):
    owner = _owner_with_d1(app)
    root = owner.post("/api/dashboards/d1/comments", json={"body": "Top"}).json()["comment"]
    reply = owner.post("/api/dashboards/d1/comments",
                       json={"body": "Agreed", "parentId": root["comment_id"]}).json()["comment"]
    threaded = owner.get("/api/dashboards/d1/comments").json()["comments"]
    assert len(threaded) == 1
    assert [r["comment_id"] for r in threaded[0]["replies"]] == [reply["comment_id"]]


def test_bad_parent_rejected(app):
    owner = _owner_with_d1(app)
    assert owner.post("/api/dashboards/d1/comments",
                      json={"body": "x", "parentId": "nope"}).status_code == 400


def test_resolve_and_reopen(app):
    owner = _owner_with_d1(app)
    cid = owner.post("/api/dashboards/d1/comments", json={"body": "q"}).json()["comment"]["comment_id"]
    done = owner.post("/api/dashboards/d1/comments/%s/resolve" % cid, json={}).json()["comment"]
    assert done["resolved"] is True and done["resolved_by"] == "alice"
    reopened = owner.post("/api/dashboards/d1/comments/%s/resolve" % cid,
                          json={"resolved": False}).json()["comment"]
    assert reopened["resolved"] is False and reopened["resolved_by"] is None


def test_delete_cascades_replies(app):
    owner = _owner_with_d1(app)
    root = owner.post("/api/dashboards/d1/comments", json={"body": "Top"}).json()["comment"]
    owner.post("/api/dashboards/d1/comments", json={"body": "r", "parentId": root["comment_id"]})
    left = owner.delete("/api/dashboards/d1/comments/%s" % root["comment_id"]).json()["comments"]
    assert left == []


def test_mentions_only_real_users(app):
    owner = _owner_with_d1(app)
    # Bob must exist for his mention to count; ghost never signs up.
    bob = _client(app)
    _signup(bob, "bob", "secret1")
    c = owner.post("/api/dashboards/d1/comments",
                   json={"body": "cc @bob and @ghost please"}).json()["comment"]
    assert c["mentions"] == ["bob"]


def test_stranger_cannot_comment(app):
    _owner_with_d1(app)  # alice owns d1
    bob = _client(app)
    _signup(bob, "bob", "secret1")
    assert bob.get("/api/dashboards/d1/comments", params={"owner": "alice"}).status_code == 404
    assert bob.post("/api/dashboards/d1/comments", params={"owner": "alice"},
                    json={"body": "sneak"}).status_code == 404


def test_shared_viewer_can_comment(app):
    owner = _owner_with_d1(app)  # alice is admin (first user) -> may grant
    bob = _client(app)
    _signup(bob, "bob", "secret1")
    g = owner.post("/api/dashboards/d1/grants", json={"principal": "user:bob", "level": "view"})
    assert g.status_code == 200, g.text
    r = bob.post("/api/dashboards/d1/comments", params={"owner": "alice"},
                 json={"body": "nice board"})
    assert r.status_code == 200, r.text
    assert r.json()["comment"]["author"] == "bob"
    # Bob (author) may delete his own; a non-author non-owner could not.
    cid = r.json()["comment"]["comment_id"]
    assert bob.delete("/api/dashboards/d1/comments/%s" % cid,
                      params={"owner": "alice"}).status_code == 200


@pytest.fixture(**backend_params())
def app_with_mail(request, tmp_path, monkeypatch):
    """App whose @mention emails go to an in-memory mailer; email verification off."""
    monkeypatch.setenv("CXD_EMAIL_VERIFY", "off")
    store = request.param(tmp_path)
    mailer = MemoryMailer()
    app = create_dashboards_app(
        store=store, session_secret="test-secret", serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "datasets"), mailer=mailer,
    )
    return app, mailer


def test_mention_emails_the_mentioned_user(app_with_mail):
    app, mailer = app_with_mail
    owner = _client(app)
    _signup(owner, "alice", "secret1")
    owner.post("/api/dashboards", json=_spec())
    bob = _client(app)
    _signup(bob, "bob", "secret1")
    assert bob.put("/api/me/profile", json={"email": "bob@example.test"}).status_code == 200

    r = owner.post("/api/dashboards/d1/comments", json={"body": "please review @bob (not @ghost)"})
    assert r.status_code == 200, r.text
    assert len(mailer.sent) == 1, "exactly one email (bob; ghost is not a user)"
    msg = mailer.sent[0]
    assert msg["To"] == "bob@example.test"
    assert "mentioned you" in msg["Subject"]


def test_no_email_for_self_mention_or_no_address(app_with_mail):
    app, mailer = app_with_mail
    owner = _client(app)
    _signup(owner, "alice", "secret1")
    owner.post("/api/dashboards", json=_spec())
    _signup(_client(app), "bob", "secret1")   # bob exists but set no email
    # alice mentions herself and bob (no address) -> no email goes out.
    owner.post("/api/dashboards/d1/comments", json={"body": "@alice and @bob"})
    assert mailer.sent == []


def test_deleting_dashboard_removes_its_comments(app):
    owner = _owner_with_d1(app)
    owner.post("/api/dashboards/d1/comments", json={"body": "keep me? no"})
    assert owner.delete("/api/dashboards/d1").status_code == 200
    # Re-create the same id: no stale comments leak in.
    owner.post("/api/dashboards", json=_spec())
    assert owner.get("/api/dashboards/d1/comments").json()["comments"] == []
