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
    # cols counts every column of the 2D array (id + sales), not just measures.
    assert summary["rows"] == 2 and summary["cols"] == 2
    assert "url" in summary

    listing = client.get("/api/datasets").json()["datasets"]
    assert [d["id"] for d in listing] == [dataset_id]

    data = client.get("/api/datasets/%s" % dataset_id).json()
    assert data == [["id", "sales"], ["A", 10.0], ["B", 20.0]]  # 2D array round-trips

    client.delete("/api/datasets/%s" % dataset_id)
    assert client.get("/api/datasets/%s" % dataset_id).status_code == 404


def test_dataset_fetch_filters_by_sample_annotation(app):
    # The parameterized dataset path for live-data controls: extra query params
    # filter the CanvasXpress object server-side by matching sample annotations.
    client = _client(app)
    _signup(client)
    cx = {
        "y": {"vars": ["sales"], "smps": ["s1", "s2", "s3"], "data": [[10, 20, 30]]},
        "x": {"region": ["EMEA", "APAC", "EMEA"]},
    }
    r = client.post("/api/datasets", json={"format": "cx", "data": cx, "title": "Regional"})
    assert r.status_code == 200, r.text
    dataset_id = r.json()["dataset"]["id"]

    full = client.get("/api/datasets/%s" % dataset_id).json()
    assert full["y"]["smps"] == ["s1", "s2", "s3"]

    filtered = client.get("/api/datasets/%s?region=EMEA" % dataset_id).json()
    assert filtered["y"]["smps"] == ["s1", "s3"]
    assert filtered["y"]["data"] == [[10, 30]]
    assert filtered["x"]["region"] == ["EMEA", "EMEA"]

    # An unknown filter key narrows nothing (no query language, just a mask).
    unchanged = client.get("/api/datasets/%s?bogus=x" % dataset_id).json()
    assert unchanged["y"]["smps"] == ["s1", "s2", "s3"]


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
    me = client.get("/auth/me").json()
    assert (me["user"], me["is_admin"]) == ("root", True)
    assert "share.grant" in me["permissions"]      # admins hold every permission


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
    # Status now also reports the MCP bridge and whether the Logs panel is on.
    # Derive the mcp block from the bridge so a dev machine's CXD_MCP_* env can't
    # make this brittle; logsPanel is off with no CXD_MCP_LOG configured.
    from cxd_server import mcp_bridge
    assert r == {
        "enabled": True,
        "model": "claude-opus-4-8",
        "mcp": {"enabled": mcp_bridge.enabled(), "url": mcp_bridge.base_url()},
        "logsPanel": False,
    }


def test_index_defaults_without_config(tmp_path):
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
        serve_static=True, dataset_store_uri="file://" + str(tmp_path / "ds"),
    )
    body = _client(app).get("/").text
    assert "window.cX" not in body                            # watermark stays
    assert "www.canvasxpress.org/dist/canvasXpress.min.js" in body
    assert '"llmEnabled": false' in body
    assert "cxd-banner" not in body


def test_index_shows_the_configured_banner(tmp_path, monkeypatch):
    monkeypatch.setenv("CXD_BANNER", "Nothing is kept yet </script><b>x</b>")
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
        serve_static=True, dataset_store_uri="file://" + str(tmp_path / "ds"),
    )
    body = _client(app).get("/").text
    assert "b.textContent=\"Nothing is kept yet \\u003c/script>\\u003cb>x\\u003c/b>\"" in body
    assert "</script><b>" not in body          # the text cannot break out of its script


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


def test_health_and_readiness(tmp_path):
    from cxd_server.app import create_dashboards_app
    from cxd_server.store import DashboardStore
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
                                serve_static=False, scheduler_enabled=True,
                                dataset_store_uri="file://" + str(tmp_path / "ds"))
    client = TestClient(app)
    assert client.get("/healthz").json()["status"] == "ok"
    # Outside the app's lifespan the scheduler thread is not running: not ready.
    down = client.get("/readyz")
    assert down.status_code == 503 and down.json()["checks"]["scheduler"].startswith("failed")
    with TestClient(app) as running:
        up = running.get("/readyz")
        assert up.status_code == 200, up.json()
        assert set(up.json()["checks"]) == {"dashboards", "governance", "schedules", "audit",
                                            "datasets", "scheduler"}
    # A store that fails makes it not ready, and says which.
    app.state.governance.group_names = None
    assert "failed" in TestClient(app).get("/readyz").json()["checks"]["governance"]


# ---- engine URL/license applied to every served page (EngineMiddleware) ----
def test_static_pages_use_configured_engine(served_app):
    client = _client(served_app)
    for page in ("/view.html", "/shared.html"):
        r = client.get(page)
        assert r.status_code == 200
        assert "https://cdn.example.com/cx/canvasXpress.min.js" in r.text
        assert "www.canvasxpress.org/dist/canvasXpress.min.js" not in r.text
        # license injected once, before the engine script
        assert r.text.count("window.cX=") == 1
        assert r.text.index("window.cX") < r.text.index("canvasXpress.min.js")
        assert int(r.headers["content-length"]) == len(r.content)
        assert "etag" not in r.headers


def test_index_not_double_injected(served_app):
    assert _client(served_app).get("/").text.count("window.cX=") == 1


def test_static_pages_untouched_by_default(tmp_path):
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
        serve_static=True, dataset_store_uri="file://" + str(tmp_path / "ds"),
    )
    body = _client(app).get("/view.html").text
    assert "https://www.canvasxpress.org/dist/canvasXpress.min.js" in body
    assert "window.cX" not in body


def test_rewrite_engine_html_escapes_license():
    from cxd_server.engine import rewrite_engine_html
    page = ('<link href="https://www.canvasxpress.org/dist/canvasXpress.css" rel="stylesheet" />\n'
            '  <script src="https://www.canvasxpress.org/dist/canvasXpress.min.js"></script>')
    out = rewrite_engine_html(page, "http://localhost:8080/dist/", "a</script>b")
    assert 'href="http://localhost:8080/dist/canvasXpress.css"' in out
    assert 'src="http://localhost:8080/dist/canvasXpress.min.js"' in out
    assert "a</script>b" not in out and 'window.cX="a<\\/script>b"' in out


# ---- disposable scratch dashboards + sharedWith in the list ----
def test_disposable_dashboard_anyone_can_edit_and_delete(tmp_path):
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s", serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "ds"),
        disposable_dashboards=[("owner1", "sandbox")],
    )
    owner = _client(app)
    _signup(owner, "owner1")
    assert owner.post("/api/dashboards", json=_spec("sandbox", "Sandbox")).status_code == 200
    assert owner.post("/api/dashboards", json=_spec("private", "Private")).status_code == 200
    other = _client(app)
    _signup(other, "bob")
    # Anyone may open and save it back to its owner ...
    assert other.get("/api/dashboards/sandbox?owner=owner1").status_code == 200
    r = other.post("/api/dashboards?owner=owner1", json=_spec("sandbox", "Bob was here"))
    assert r.status_code == 200
    assert owner.get("/api/dashboards/sandbox").json()["title"] == "Bob was here"
    # ... and delete it; a normal dashboard of the same owner stays protected.
    assert other.delete("/api/dashboards/private?owner=owner1").status_code == 403
    assert other.delete("/api/dashboards/sandbox?owner=owner1").status_code == 200
    assert owner.get("/api/dashboards/sandbox").status_code == 404


def test_list_reports_disposable_and_own_grants(tmp_path):
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s", serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "ds"),
        disposable_dashboards=[("owner1", "sandbox")],
    )
    owner = _client(app)
    _signup(owner, "owner1")
    owner.post("/api/dashboards", json=_spec("sandbox", "Sandbox"))
    owner.post("/api/dashboards", json=_spec("board", "Board"))
    r = owner.post("/api/dashboards/board/grants", json={"principal": "*", "level": "view"})
    assert r.status_code == 200, r.text
    rows = {d["id"]: d for d in owner.get("/api/dashboards").json()["dashboards"]}
    assert rows["board"]["sharedWith"] == [{"principal": "*", "level": "view"}]
    assert "sharedWith" not in rows["sandbox"] and rows["sandbox"]["disposable"] is True
    assert "disposable" not in rows["board"]


def test_new_dashboard_cannot_take_a_visible_foreign_id(tmp_path):
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s", serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "ds"),
    )
    owner = _client(app)
    _signup(owner, "owner1")
    owner.post("/api/dashboards", json=_spec("board", "Board"))
    owner.post("/api/dashboards/board/grants", json={"principal": "*", "level": "view"})
    other = _client(app)
    _signup(other, "bob")
    # Same id as a board shared with bob: refused, nothing forked.
    r = other.post("/api/dashboards", json=_spec("board", "Board"))
    assert r.status_code == 409 and "owner: owner1" in r.json()["detail"]
    assert [d for d in other.get("/api/dashboards").json()["dashboards"] if d["owner"] == "bob"] == []
    # Another name is fine, and so is re-saving a dashboard bob already owns.
    assert other.post("/api/dashboards", json=_spec("board-copy", "Board (copy)")).status_code == 200
    assert other.post("/api/dashboards", json=_spec("board-copy", "Board (copy) v2")).status_code == 200
    # The owner keeps saving their own board normally.
    assert owner.post("/api/dashboards", json=_spec("board", "Board v2")).status_code == 200


def test_directory_omits_admins_who_always_have_full_access(admin_app):
    root = _client(admin_app)
    assert root.post("/auth/login", json={"username": "root", "password": "secret1"}).status_code == 200
    alice = _client(admin_app)
    _signup(alice, "alice")
    alice.post("/api/dashboards", json=_spec("private-board", "Private"))
    users = alice.get("/api/directory").json()["users"]
    assert "root" not in users and "alice" in users
    # The admin can view, change and delete a user's private dashboard anyway.
    assert root.get("/api/dashboards/private-board?owner=alice").status_code == 200
    assert root.post("/api/dashboards?owner=alice", json=_spec("private-board", "Edited")).status_code == 200
    assert alice.get("/api/dashboards/private-board").json()["title"] == "Edited"
    assert root.delete("/api/dashboards/private-board?owner=alice").status_code == 200
    assert alice.get("/api/dashboards/private-board").status_code == 404
