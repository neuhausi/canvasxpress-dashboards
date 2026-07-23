import pytest

from cxd_server.datasets import DatasetStore, csv_to_cx, reshape_to_cx, rows_to_cx
from cxd_server.objectstore import FileObjectStore


@pytest.fixture
def dstore(tmp_path):
    return DatasetStore(FileObjectStore(str(tmp_path / "datasets")))


def test_csv_to_cx_splits_numeric_and_annotation_columns():
    cx = csv_to_cx("id,region,sales\nA,East,10\nB,West,20\n")
    assert cx["y"]["smps"] == ["A", "B"]
    assert cx["y"]["vars"] == ["sales"]
    assert cx["y"]["data"] == [[10.0, 20.0]]
    assert cx["x"]["region"] == ["East", "West"]


def test_csv_empty_and_no_rows_raise():
    with pytest.raises(ValueError):
        csv_to_cx("")
    with pytest.raises(ValueError):
        csv_to_cx("id,sales\n")


def test_rows_to_cx():
    cx = rows_to_cx([{"id": "A", "sales": 10}, {"id": "B", "sales": 20}])
    assert cx["y"]["smps"] == ["A", "B"]
    assert cx["y"]["data"] == [[10.0, 20.0]]


def test_reshape_passes_through_cx_shape():
    src = {"y": {"vars": ["v"], "smps": ["s"], "data": [[1]]}}
    assert reshape_to_cx("json", src) == src
    assert reshape_to_cx("cx", src) == src


def test_reshape_rejects_bad_cx():
    with pytest.raises(ValueError):
        reshape_to_cx("cx", {"nope": 1})
    with pytest.raises(ValueError):
        reshape_to_cx("bogus", "x")


def test_store_create_get_list_delete(dstore):
    data = csv_to_cx("id,sales\nA,10\nB,20\n")
    summary = dstore.create("alice", data, "2026-07-23T00:00:00Z", title="Sales 2026")
    dataset_id = summary["id"]
    assert summary["rows"] == 2 and summary["cols"] == 1
    assert summary["title"] == "Sales 2026"
    assert dstore.get("alice", dataset_id) == data
    assert [s["id"] for s in dstore.list("alice")] == [dataset_id]
    dstore.delete("alice", dataset_id)
    assert dstore.get("alice", dataset_id) is None


def test_store_owner_isolation(dstore):
    data = csv_to_cx("id,sales\nA,10\n")
    summary = dstore.create("alice", data, "t", dataset_id="fixed")
    assert dstore.get("bob", summary["id"]) is None
    assert dstore.list("bob") == []


def test_explicit_id_overwrites(dstore):
    d1 = csv_to_cx("id,sales\nA,10\n")
    d2 = csv_to_cx("id,sales\nA,10\nB,20\n")
    dstore.create("alice", d1, "t1", dataset_id="fixed")
    dstore.create("alice", d2, "t2", dataset_id="fixed")
    assert len(dstore.list("alice")) == 1
    assert dstore.get("alice", "fixed") == d2
