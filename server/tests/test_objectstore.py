"""Shared conformance suite for ObjectStore backends.

Every backend is parametrized through the same asserts (put/get/list/delete +
owner isolation), so backends are interchangeable and provably isolated. New
backends (S3, Postgres, Drive) join by adding a factory to ``BACKENDS``.
"""

import pytest

from cxd_server.gdrivestore import GDriveObjectStore
from cxd_server.objectstore import FileObjectStore, open_store
from cxd_server.s3store import S3ObjectStore
from cxd_server.sqlstore import SqlObjectStore
from fake_drive import FakeDrive, FakeDriveClient
from fake_s3 import FakeS3Client


def _file_backend(tmp_path):
    return FileObjectStore(str(tmp_path / "objs"))


def _s3_backend(tmp_path):
    return S3ObjectStore(bucket="cxd-test", prefix="datasets", client=FakeS3Client())


def _sql_backend(tmp_path):
    # SQLite proves the SQL path; Postgres runs the identical code (postgres://).
    return SqlObjectStore("sqlite:///" + str(tmp_path / "objs.db"))


def _gdrive_backend(tmp_path):
    # One shared fake Drive across owners → real per-owner folder isolation.
    drive = FakeDrive()
    return GDriveObjectStore("root-folder", client_factory=lambda owner: FakeDriveClient(drive))


# (id, factory) — every backend runs the identical asserts.
BACKENDS = [
    ("file", _file_backend), ("s3", _s3_backend), ("sql", _sql_backend), ("gdrive", _gdrive_backend),
]


@pytest.fixture(params=BACKENDS, ids=[b[0] for b in BACKENDS])
def store(request, tmp_path):
    return request.param[1](tmp_path)


def test_put_get_roundtrip(store):
    rec = store.put("alice", "a1", b"hello", {"title": "A"})
    assert rec.owner == "alice" and rec.id == "a1"
    got = store.get("alice", "a1")
    assert got.blob == b"hello"
    assert got.meta["title"] == "A"


def test_get_missing_is_none(store):
    assert store.get("alice", "ghost") is None


def test_overwrite_in_place(store):
    store.put("alice", "a1", b"one", {"v": 1})
    store.put("alice", "a1", b"two", {"v": 2})
    got = store.get("alice", "a1")
    assert got.blob == b"two" and got.meta["v"] == 2
    assert len(store.list("alice")) == 1


def test_list_returns_summaries_without_blob(store):
    store.put("alice", "a1", b"x", {"title": "First"})
    store.put("alice", "a2", b"y", {"title": "Second"})
    ids = sorted(s.id for s in store.list("alice"))
    assert ids == ["a1", "a2"]
    assert any(s.meta.get("title") == "First" for s in store.list("alice"))


def test_delete(store):
    store.put("alice", "a1", b"x", {})
    store.delete("alice", "a1")
    assert store.get("alice", "a1") is None
    store.delete("alice", "a1")  # no-op, no raise


def test_owner_isolation(store):
    store.put("alice", "a1", b"secret", {})
    assert store.get("bob", "a1") is None
    assert store.list("bob") == []
    # bob deleting the same id must not touch alice's object.
    store.delete("bob", "a1")
    assert store.get("alice", "a1").blob == b"secret"


def test_traversal_safe_ids(store):
    store.put("alice", "../../etc/passwd", b"x", {})
    assert store.get("alice", "../../etc/passwd").blob == b"x"
    assert store.get("alice", "etc/passwd") is None


def test_url_for_optional(store):
    store.put("alice", "a1", b"x", {})
    # file backend returns None; s3 returns a signed URL. Both satisfy the contract.
    assert isinstance(store.url_for("alice", "a1"), (str, type(None)))
    assert store.url_for("alice", "ghost") is None


def test_open_store_file_scheme(tmp_path):
    s = open_store("file://" + str(tmp_path / "d"))
    s.put("alice", "a1", b"x", {})
    assert s.get("alice", "a1").blob == b"x"


def test_open_store_s3_scheme_with_injected_client():
    s = open_store("s3://cxd-bucket/prefix", s3_client=FakeS3Client())
    s.put("alice", "a1", b"x", {})
    assert s.get("alice", "a1").blob == b"x"
    assert s.get("bob", "a1") is None
    assert s.url_for("alice", "a1").startswith("https://s3.fake/cxd-bucket/")


def test_open_store_s3_requires_bucket():
    with pytest.raises(ValueError):
        open_store("s3:///no-bucket", s3_client=FakeS3Client())


def test_open_store_rejects_unknown_scheme():
    with pytest.raises(ValueError):
        open_store("ftp://example.com/data")


def test_open_store_sql_scheme(tmp_path):
    s = open_store("sqlite:///" + str(tmp_path / "d.db") + "?table=cxd_datasets")
    s.put("alice", "a1", b"x", {})
    assert s.get("alice", "a1").blob == b"x"
    assert s.get("bob", "a1") is None


def test_open_store_gdrive_scheme_with_injected_factory():
    drive = FakeDrive()
    s = open_store("gdrive://my-folder", drive_client_factory=lambda owner: FakeDriveClient(drive))
    s.put("alice", "a1", b"x", {})
    assert s.get("alice", "a1").blob == b"x"
    assert s.get("bob", "a1") is None
    assert s.url_for("alice", "a1").startswith("https://drive.google.com/")


def test_open_store_gdrive_requires_folder_and_factory():
    with pytest.raises(ValueError):
        open_store("gdrive://", drive_client_factory=lambda owner: None)
    with pytest.raises(RuntimeError):
        open_store("gdrive://folder")  # no factory → cannot resolve OAuth creds
