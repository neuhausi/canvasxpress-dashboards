import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.sqldashboard import SqlDashboardStore
from cxd_server.store import DashboardStore
from cxd_server.stores import StoreRegistry
from fake_s3 import FakeS3Client


# ---- registry unit tests ----
def test_from_env_synthesizes_single_defaults(tmp_path):
    reg = StoreRegistry.from_env(environ={}, dataset_uri="file://" + str(tmp_path / "d"))
    names = reg.named("dataset")
    assert [s["name"] for s in names] == ["local"]
    assert names[0]["default"] is True
    assert reg.default_name("dataset") == "local"
    assert reg.default_name("dashboard") == "local"


def test_registry_named_hides_uris_and_marks_default(tmp_path):
    reg = StoreRegistry([
        {"name": "local", "capability": "dataset", "uri": "file://" + str(tmp_path / "a")},
        {"name": "s3-prod", "capability": "dataset", "uri": "s3://bucket/data", "default": True},
    ], s3_client=FakeS3Client())
    names = reg.named("dataset")
    for entry in names:
        assert set(entry.keys()) == {"name", "capability", "default"}  # no uri leaks
    default = [n["name"] for n in names if n["default"]]
    assert default == ["s3-prod"]


def test_registry_resolve_and_has(tmp_path):
    reg = StoreRegistry([
        {"name": "local", "capability": "dataset", "uri": "file://" + str(tmp_path / "a")},
        {"name": "s3-prod", "capability": "dataset", "uri": "s3://bucket/data"},
    ], s3_client=FakeS3Client())
    assert reg.has("dataset", "s3-prod")
    assert not reg.has("dataset", "ghost")
    reg.resolve("dataset", "s3-prod").put("alice", "a1", b"x", {})
    assert reg.resolve("dataset", "s3-prod").get("alice", "a1").blob == b"x"
    with pytest.raises(KeyError):
        reg.resolve("dataset", "ghost")


def test_registry_rejects_bad_config():
    with pytest.raises(ValueError):
        StoreRegistry([{"name": "x", "capability": "bogus", "uri": "file://y"}])


def test_from_env_loads_stores_json(tmp_path):
    import json
    path = tmp_path / "stores.json"
    path.write_text(json.dumps({"stores": [
        {"name": "local", "capability": "dataset", "uri": "file://" + str(tmp_path / "a"), "default": True},
        {"name": "s3", "capability": "dataset", "uri": "s3://bucket/data"},
        {"name": "local", "capability": "dashboard", "uri": "file://" + str(tmp_path / "b")},
    ]}))
    reg = StoreRegistry.from_env(stores_path=str(path), s3_client=FakeS3Client())
    assert [s["name"] for s in reg.named("dataset")] == ["local", "s3"]


# ---- app-level multi-store tests ----
@pytest.fixture
def multistore_app(tmp_path):
    reg = StoreRegistry([
        {"name": "local", "capability": "dataset", "uri": "file://" + str(tmp_path / "local"), "default": True},
        {"name": "s3-prod", "capability": "dataset", "uri": "s3://cxd/datasets"},
        {"name": "local", "capability": "dashboard", "uri": "file://" + str(tmp_path / "dash")},
    ], s3_client=FakeS3Client())
    store = DashboardStore(str(tmp_path / "dash.db"))
    return create_dashboards_app(store=store, session_secret="s", serve_static=False, registry=reg)


def _signup(client, user="alice"):
    assert client.post("/auth/signup", json={"username": user, "password": "secret1"}).status_code == 200


def test_list_stores_returns_names_only(multistore_app):
    client = TestClient(multistore_app)
    _signup(client)
    stores = client.get("/api/stores?capability=dataset").json()["stores"]
    assert {s["name"] for s in stores} == {"local", "s3-prod"}
    assert all("uri" not in s for s in stores)
    assert client.get("/api/stores").status_code == 200


def test_list_stores_requires_login(multistore_app):
    assert TestClient(multistore_app).get("/api/stores").status_code == 401


def test_dataset_targets_named_store_and_lists_across_stores(multistore_app):
    client = TestClient(multistore_app)
    _signup(client)
    local = client.post("/api/datasets", json={"format": "csv", "data": "id,v\nA,1\n"}).json()["dataset"]
    s3 = client.post("/api/datasets", json={"format": "csv", "data": "id,v\nB,2\n", "store": "s3-prod"}).json()["dataset"]
    assert local["store"] == "local"
    assert s3["store"] == "s3-prod"
    assert s3["url"] and s3["url"].startswith("https://s3.fake/")  # presigned
    assert local["url"] is None  # file backend: no direct URL

    # Aggregated listing spans both stores.
    listing = client.get("/api/datasets").json()["datasets"]
    assert {(d["id"], d["store"]) for d in listing} == {(local["id"], "local"), (s3["id"], "s3-prod")}

    # Fetch back from the s3 store by id + ?store.
    data = client.get("/api/datasets/%s?store=s3-prod" % s3["id"]).json()
    assert data["y"]["smps"] == ["B"]
    # Wrong store -> 404 (owner-scoped + store-scoped).
    assert client.get("/api/datasets/%s" % s3["id"]).status_code == 404


def test_unknown_store_is_404(multistore_app):
    client = TestClient(multistore_app)
    _signup(client)
    r = client.post("/api/datasets", json={"format": "csv", "data": "id,v\nA,1\n", "store": "ghost"})
    assert r.status_code == 404


# ---- dashboards on the SQL (Postgres-parity) store: 5.3 acceptance ----
def test_dashboards_roundtrip_and_share_on_sql_store(tmp_path):
    sql_store = SqlDashboardStore("sqlite:///" + str(tmp_path / "sql-dash.db"))
    app = create_dashboards_app(store=sql_store, session_secret="s", serve_static=False,
                                dataset_store_uri="file://" + str(tmp_path / "ds"))
    owner = TestClient(app)
    _signup(owner)
    spec = {"id": "d1", "title": "Sales", "layout": {"items": []}, "panels": {}}
    assert owner.post("/api/dashboards", json=spec).status_code == 200
    # Reloads identically.
    assert owner.get("/api/dashboards/d1").json() == spec
    # Share link resolves read-only for an anonymous viewer.
    token = owner.post("/api/dashboards/d1/share", json={"visibility": "public"}).json()["dashboard"]["share_token"]
    anon = TestClient(app)
    r = anon.get("/api/shared/%s" % token)
    assert r.status_code == 200 and r.json()["spec"]["id"] == "d1"
