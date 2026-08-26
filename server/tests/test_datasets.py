import pytest

from cxd_server.datasets import DatasetStore, csv_to_cx, reshape_to_cx, rows_to_cx
from cxd_server.objectstore import FileObjectStore


@pytest.fixture
def dstore(tmp_path):
    return DatasetStore(FileObjectStore(str(tmp_path / "datasets")))


def test_csv_to_cx_splits_numeric_and_annotation_columns():
    # Tabular data stays a 2D array (header row + data rows). Numeric columns are
    # coerced to numbers; string columns stay text — CanvasXpress infers orientation.
    cx = csv_to_cx("id,region,sales\nA,East,10\nB,West,20\n")
    assert cx == [["id", "region", "sales"], ["A", "East", 10.0], ["B", "West", 20.0]]


def test_csv_numeric_column_with_blanks_stays_measure_as_null():
    # A blank cell is a missing value, not a demotion to text: the column stays
    # a numeric measure and the gap becomes null (CanvasXpress handles nulls).
    cx = csv_to_cx("id,score\nA,10\nB,\nC,30\n")
    assert cx == [["id", "score"], ["A", 10.0], ["B", None], ["C", 30.0]]


def test_csv_one_nonnumeric_value_makes_column_annotation():
    # One non-numeric value makes the whole column a string annotation (values
    # stay as text, not coerced).
    cx = csv_to_cx("id,val\nA,10\nB,oops\nC,30\n")
    assert cx == [["id", "val"], ["A", "10"], ["B", "oops"], ["C", "30"]]


def test_csv_all_blank_column_is_annotation_not_measure():
    # An all-blank column is not a measure (no numeric value seen); it stays text.
    cx = csv_to_cx("id,empty\nA,\nB,\n")
    assert cx == [["id", "empty"], ["A", ""], ["B", ""]]


def test_rows_to_cx_preserves_null():
    cx = rows_to_cx([{"id": "A", "v": 1}, {"id": "B", "v": None}, {"id": "C", "v": 3}])
    assert cx == [["id", "v"], ["A", 1.0], ["B", None], ["C", 3.0]]


def test_csv_empty_and_no_rows_raise():
    with pytest.raises(ValueError):
        csv_to_cx("")
    with pytest.raises(ValueError):
        csv_to_cx("id,sales\n")


def test_rows_to_cx():
    cx = rows_to_cx([{"id": "A", "sales": 10}, {"id": "B", "sales": 20}])
    assert cx == [["id", "sales"], ["A", 10.0], ["B", 20.0]]


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
    # cols counts every column of the 2D array (id + sales), not just measures.
    assert summary["rows"] == 2 and summary["cols"] == 2
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


def test_store_associates_config(dstore):
    data = csv_to_cx("id,sales\nA,10\n")
    cfg = {"graphType": "Scatter", "colorBy": "region"}
    summary = dstore.create("alice", data, "2026-07-23T00:00:00Z", title="S", config=cfg)
    assert summary["config"] == cfg
    listed = dstore.list("alice")[0]
    assert listed["config"] == cfg
    # no config → no config key
    plain = dstore.create("alice", data, "2026-07-23T00:00:00Z", title="P", dataset_id="p")
    assert "config" not in plain
