import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.gdrivestore import GDriveObjectStore, token_store_drive_factory
from cxd_server.store import DashboardStore
from cxd_server.stores import StoreRegistry
from fake_drive import FakeDrive, FakeDriveClient


def _store(drive=None):
    drive = drive or FakeDrive()
    return GDriveObjectStore("root", client_factory=lambda owner: FakeDriveClient(drive)), drive


def test_each_owner_gets_a_distinct_folder():
    store, drive = _store()
    store.put("alice", "a1", b"x", {})
    store.put("bob", "b1", b"y", {})
    folder_names = {f["name"] for f in drive._folders.values()}
    assert len(folder_names) == 2  # one per owner
    assert store.get("alice", "b1") is None  # cross-owner read blocked


def test_overwrite_reuses_same_file():
    store, drive = _store()
    store.put("alice", "a1", b"one", {"v": 1})
    store.put("alice", "a1", b"two", {"v": 2})
    files = [f for f in drive._files.values()]
    assert len(files) == 1  # updated in place, not duplicated
    assert store.get("alice", "a1").blob == b"two"


def test_url_for_returns_drive_link():
    store, _ = _store()
    store.put("alice", "a1", b"x", {})
    assert store.url_for("alice", "a1").startswith("https://drive.google.com/")
    assert store.url_for("alice", "ghost") is None


def test_list_only_after_folder_exists():
    store, _ = _store()
    assert store.list("nobody") == []  # no folder yet → empty, no crash


def test_token_store_factory_raises_without_connection():
    class EmptyTokens:
        def load(self, user_id):
            return None
    factory = token_store_drive_factory(EmptyTokens())
    with pytest.raises(PermissionError):
        factory("alice")


# ---- app-level: a dataset on a gdrive store renders + isolates ----
@pytest.fixture
def gdrive_app(tmp_path):
    drive = FakeDrive()
    reg = StoreRegistry(
        [{"name": "gdrive", "capability": "dataset", "uri": "gdrive://cxd-root", "default": True}],
        drive_client_factory=lambda owner: FakeDriveClient(drive),
    )
    store = DashboardStore(str(tmp_path / "dash.db"))
    return create_dashboards_app(store=store, session_secret="s", serve_static=False, registry=reg)


def _signup(client, user="alice"):
    assert client.post("/auth/signup", json={"username": user, "password": "secret1"}).status_code == 200


def test_dataset_roundtrip_on_gdrive(gdrive_app):
    client = TestClient(gdrive_app)
    _signup(client)
    summary = client.post("/api/datasets", json={"format": "csv", "data": "id,sales\nA,10\nB,20\n", "title": "Sales"}).json()["dataset"]
    assert summary["store"] == "gdrive"
    assert summary["url"].startswith("https://drive.google.com/")  # url_for = Drive link
    data = client.get("/api/datasets/%s" % summary["id"]).json()
    assert data["y"]["smps"] == ["A", "B"]


def test_gdrive_owner_isolation(gdrive_app):
    alice = TestClient(gdrive_app)
    _signup(alice, "alice")
    ds_id = alice.post("/api/datasets", json={"format": "csv", "data": "id,v\nA,1\n"}).json()["dataset"]["id"]
    bob = TestClient(gdrive_app)
    _signup(bob, "bob")
    assert bob.get("/api/datasets").json()["datasets"] == []
    assert bob.get("/api/datasets/%s" % ds_id).status_code == 404
