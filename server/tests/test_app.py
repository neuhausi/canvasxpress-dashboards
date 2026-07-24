import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.store import DashboardStore


@pytest.fixture
def app(tmp_path):
    store = DashboardStore(str(tmp_path / "dash.db"))
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


# ---- datasets (Phase 5.1) ----
def test_datasets_require_login(app):
    client = _client(app)
    assert client.get("/api/datasets").status_code == 401
    assert client.post("/api/datasets", json={"format": "csv", "data": "id,v\nA,1\n"}).status_code == 401


def test_dataset_upload_list_fetch_delete(app):
    client = _client(app)
    _signup(client)
    r = client.post("/api/datasets", json={"format": "csv", "data": "id,sales\nA,10\nB,20\n", "title": "Sales"})
    assert r.status_code == 200, r.text
    summary = r.json()["dataset"]
    dataset_id = summary["id"]
    assert summary["rows"] == 2 and summary["cols"] == 1
    assert "url" in summary

    listing = client.get("/api/datasets").json()["datasets"]
    assert [d["id"] for d in listing] == [dataset_id]

    data = client.get("/api/datasets/%s" % dataset_id).json()
    assert data["y"]["smps"] == ["A", "B"]
    assert data["y"]["data"] == [[10.0, 20.0]]

    client.delete("/api/datasets/%s" % dataset_id)
    assert client.get("/api/datasets/%s" % dataset_id).status_code == 404


def test_dataset_bad_input_is_400(app):
    client = _client(app)
    _signup(client)
    assert client.post("/api/datasets", json={"format": "csv"}).status_code == 400
    assert client.post("/api/datasets", json={"format": "csv", "data": ""}).status_code == 400


def test_dataset_owner_isolation(app):
    alice = _client(app)
    _signup(alice, "alice", "secret1")
    dataset_id = alice.post(
        "/api/datasets", json={"format": "csv", "data": "id,v\nA,1\n"}
    ).json()["dataset"]["id"]

    bob = _client(app)
    _signup(bob, "bob", "secret1")
    assert bob.get("/api/datasets").json()["datasets"] == []
    assert bob.get("/api/datasets/%s" % dataset_id).status_code == 404


# ---- admin: user management (CXD_ADMINS) ----
@pytest.fixture
def admin_app(tmp_path):
    store = DashboardStore(str(tmp_path / "dash.db"))
    store.create_user("root", "secret1")   # the admin, pre-created
    return create_dashboards_app(
        store=store,
        session_secret="test-secret",
        serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "datasets"),
        admins={"root"},
    )


def test_me_reports_admin_flag(admin_app):
    client = _client(admin_app)
    client.post("/auth/login", json={"username": "root", "password": "secret1"})
    assert client.get("/auth/me").json() == {"user": "root", "is_admin": True}


def test_non_admin_forbidden(admin_app):
    client = _client(admin_app)
    _signup(client, "alice", "secret1")   # a normal user
    assert client.get("/api/admin/users").status_code == 403
    assert client.post("/api/admin/users", json={"username": "x", "password": "yyyyyy"}).status_code == 403


def test_admin_requires_login(admin_app):
    assert _client(admin_app).get("/api/admin/users").status_code == 401


def test_admin_crud_users(admin_app):
    client = _client(admin_app)
    client.post("/auth/login", json={"username": "root", "password": "secret1"})

    # create
    assert client.post("/api/admin/users", json={"username": "alice", "password": "secret1"}).status_code == 200
    assert client.post("/api/admin/users", json={"username": "alice", "password": "secret1"}).status_code == 409
    assert client.post("/api/admin/users", json={"username": "ab", "password": "secret1"}).status_code == 400

    # list includes admin flag + dashboard count
    users = {u["username"]: u for u in client.get("/api/admin/users").json()["users"]}
    assert users["root"]["is_admin"] is True
    assert users["alice"]["is_admin"] is False and users["alice"]["dashboards"] == 0

    # reset password
    assert client.post("/api/admin/users/alice/password", json={"password": "newpass1"}).status_code == 200
    assert client.post("/api/admin/users/ghost/password", json={"password": "newpass1"}).status_code == 404

    # delete guards: cannot delete self or another admin
    assert client.delete("/api/admin/users/root").status_code == 400
    # delete a normal user
    assert client.delete("/api/admin/users/alice").status_code == 200
    assert client.delete("/api/admin/users/alice").status_code == 404


def test_first_signup_becomes_admin(app):
    client = _client(app)
    _signup(client, "first", "secret1")          # bootstraps as admin
    assert client.get("/auth/me").json()["is_admin"] is True
    # first user can reach the admin API and see the second (non-admin) user
    _signup(_client(app), "second", "secret1")    # separate session
    users = {u["username"]: u for u in client.get("/api/admin/users").json()["users"]}
    assert users["first"]["is_admin"] is True
    assert users["second"]["is_admin"] is False


def test_second_signup_not_admin(app):
    client = _client(app)
    _signup(_client(app), "first", "secret1")     # consumes the bootstrap slot
    _signup(client, "second", "secret1")
    assert client.get("/auth/me").json()["is_admin"] is False
    assert client.get("/api/admin/users").status_code == 403


def test_admin_grant_and_revoke(admin_app):
    client = _client(admin_app)
    client.post("/auth/login", json={"username": "root", "password": "secret1"})
    client.post("/api/admin/users", json={"username": "alice", "password": "secret1"})

    # grant alice admin; she can now reach the admin API
    r = client.post("/api/admin/users/alice/admin", json={"is_admin": True})
    assert r.status_code == 200 and r.json()["is_admin"] is True
    ac = _client(admin_app)
    ac.post("/auth/login", json={"username": "alice", "password": "secret1"})
    assert ac.get("/api/admin/users").status_code == 200

    # list marks root as via_config (CXD_ADMINS={"root"}), alice not
    users = {u["username"]: u for u in client.get("/api/admin/users").json()["users"]}
    assert users["root"]["via_config"] is True and users["alice"]["via_config"] is False

    # revoke alice; she loses access
    assert client.post("/api/admin/users/alice/admin", json={"is_admin": False}).status_code == 200
    assert ac.get("/api/admin/users").status_code == 403


def test_admin_toggle_guards(admin_app):
    client = _client(admin_app)
    client.post("/auth/login", json={"username": "root", "password": "secret1"})
    # cannot change a CXD_ADMINS user via the API
    assert client.post("/api/admin/users/root/admin", json={"is_admin": False}).status_code == 400
    # 404 for unknown user
    assert client.post("/api/admin/users/ghost/admin", json={"is_admin": True}).status_code == 404


def test_first_user_admin_can_revoke_via_flag(app):
    # No CXD_ADMINS here: first user is admin via the stored flag and CAN be
    # toggled by another admin (not via_config).
    client = _client(app)
    _signup(client, "first", "secret1")            # bootstrap admin (flag)
    client.post("/api/admin/users", json={"username": "second", "password": "secret1"})
    client.post("/api/admin/users/second/admin", json={"is_admin": True})
    # first cannot revoke self
    assert client.post("/api/admin/users/first/admin", json={"is_admin": False}).status_code == 400
    # but second (now admin) can revoke first
    sc = _client(app)
    sc.post("/auth/login", json={"username": "second", "password": "secret1"})
    assert sc.post("/api/admin/users/first/admin", json={"is_admin": False}).status_code == 200


# ---- served-app runtime config injection (license / library / LLM) ----
@pytest.fixture
def served_app(tmp_path):
    store = DashboardStore(str(tmp_path / "dash.db"))
    return create_dashboards_app(
        store=store, session_secret="test-secret", serve_static=True,
        dataset_store_uri="file://" + str(tmp_path / "datasets"),
        canvasxpress_url="https://cdn.example.com/cx",
        canvasxpress_license="LIC-123",
        llm_api_key="sk-secret", llm_model="claude-opus-4-8",
    )


def test_index_injects_license_before_library(served_app):
    body = _client(served_app).get("/").text
    assert 'window.cX="LIC-123"' in body
    # the license must appear BEFORE the CanvasXpress library script
    assert body.index("window.cX") < body.index("canvasXpress.min.js")


def test_index_uses_configured_library_url(served_app):
    body = _client(served_app).get("/").text
    assert "https://cdn.example.com/cx/canvasXpress.min.js" in body
    assert '"llmEnabled": true' in body


def test_index_never_leaks_llm_key(served_app):
    assert "sk-secret" not in _client(served_app).get("/").text


def test_llm_status_endpoint(served_app):
    client = _client(served_app)
    assert client.get("/api/llm/status").status_code == 401   # login-gated
    _signup(client)
    r = client.get("/api/llm/status").json()
    assert r == {"enabled": True, "model": "claude-opus-4-8"}


def test_index_defaults_without_config(tmp_path):
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
        serve_static=True, dataset_store_uri="file://" + str(tmp_path / "ds"),
    )
    body = _client(app).get("/").text
    assert "window.cX" not in body                            # watermark stays
    assert "www.canvasxpress.org/dist/canvasXpress.min.js" in body
    assert '"llmEnabled": false' in body


def test_dataset_config_round_trips(app):
    client = _client(app)
    _signup(client)
    r = client.post("/api/datasets", json={
        "format": "csv", "data": "id,sales\nA,10\n", "title": "S",
        "config": {"graphType": "Line"},
    })
    assert r.status_code == 200, r.text
    assert r.json()["dataset"]["config"] == {"graphType": "Line"}
    # listed summary carries the config too
    got = client.get("/api/datasets").json()["datasets"]
    assert got[0]["config"] == {"graphType": "Line"}
    # a bad config type is rejected
    bad = client.post("/api/datasets", json={"format": "csv", "data": "id,v\nA,1\n", "config": 5})
    assert bad.status_code == 400
