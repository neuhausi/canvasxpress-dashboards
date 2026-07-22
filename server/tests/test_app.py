import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.store import DashboardStore


@pytest.fixture
def app(tmp_path):
    store = DashboardStore(str(tmp_path / "dash.db"))
    return create_dashboards_app(store=store, session_secret="test-secret", serve_static=False)


def _client(app):
    return TestClient(app)


def _spec(dashboard_id="d1", title="Sales"):
    return {"id": dashboard_id, "title": title, "layout": {"items": []}, "panels": {}}


def _signup(client, username="alice", password="secret1"):
    r = client.post("/auth/signup", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r


def test_requires_login(app):
    client = _client(app)
    assert client.get("/api/dashboards").status_code == 401
    assert client.post("/api/dashboards", json=_spec()).status_code == 401


def test_create_save_reload_matches(app):
    client = _client(app)
    _signup(client)
    spec = _spec()
    r = client.post("/api/dashboards", json=spec)
    assert r.status_code == 200
    assert r.json()["dashboard"]["id"] == "d1"

    # Reload by id -> identical spec.
    got = client.get("/api/dashboards/d1")
    assert got.status_code == 200
    assert got.json() == spec

    listing = client.get("/api/dashboards").json()["dashboards"]
    assert [d["id"] for d in listing] == ["d1"]


def test_owner_isolation_across_users(app):
    alice = _client(app)
    _signup(alice, "alice", "secret1")
    alice.post("/api/dashboards", json=_spec())

    bob = _client(app)
    _signup(bob, "bob", "secret1")
    assert bob.get("/api/dashboards").json()["dashboards"] == []
    assert bob.get("/api/dashboards/d1").status_code == 404


def test_public_share_is_readable_without_login(app):
    owner = _client(app)
    _signup(owner)
    owner.post("/api/dashboards", json=_spec())
    shared = owner.post("/api/dashboards/d1/share", json={"visibility": "public"})
    assert shared.status_code == 200
    token = shared.json()["dashboard"]["share_token"]
    assert token and "share_url" in shared.json()["dashboard"]

    # A brand-new, anonymous client can read the shared spec read-only.
    anon = _client(app)
    r = anon.get("/api/shared/%s" % token)
    assert r.status_code == 200
    assert r.json()["readOnly"] is True
    assert r.json()["spec"]["id"] == "d1"


def test_auth_gated_share_requires_login(app):
    owner = _client(app)
    _signup(owner)
    owner.post("/api/dashboards", json=_spec())
    token = owner.post("/api/dashboards/d1/share", json={"visibility": "auth"}).json()["dashboard"]["share_token"]

    anon = _client(app)
    assert anon.get("/api/shared/%s" % token).status_code == 401

    viewer = _client(app)
    _signup(viewer, "carol", "secret1")
    r = viewer.get("/api/shared/%s" % token)
    assert r.status_code == 200
    assert r.json()["spec"]["id"] == "d1"


def test_unshare_makes_link_dead(app):
    owner = _client(app)
    _signup(owner)
    owner.post("/api/dashboards", json=_spec())
    token = owner.post("/api/dashboards/d1/share", json={"visibility": "public"}).json()["dashboard"]["share_token"]
    owner.post("/api/dashboards/d1/share", json={"visibility": "private"})
    anon = _client(app)
    assert anon.get("/api/shared/%s" % token).status_code == 404


def test_share_missing_dashboard_404(app):
    client = _client(app)
    _signup(client)
    assert client.post("/api/dashboards/ghost/share", json={"visibility": "public"}).status_code == 404


def test_delete_dashboard(app):
    client = _client(app)
    _signup(client)
    client.post("/api/dashboards", json=_spec())
    r = client.delete("/api/dashboards/d1")
    assert r.status_code == 200
    assert client.get("/api/dashboards/d1").status_code == 404
