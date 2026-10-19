"""Server-side join (port of src/join.js), used so view-time Q&A can span joined sources."""

import pytest

from cxd_server.join import join_data

EXPRESSION = {"y": {"vars": ["MYC"], "smps": ["S1", "S2", "S3"], "data": [[5.0, 7.0, 9.0]]},
              "x": {"patient_id": ["P1", "P2", "P9"]}}
CLINICAL = {"y": {"vars": ["age"], "smps": ["P1", "P2", "P3"], "data": [[50, 60, 70]]},
            "x": {"stage": ["I", "II", "III"]}}
ON = {"left": "patient_id", "right": "smps"}


def test_inner_join_carries_right_annotations_and_columns():
    out = join_data(EXPRESSION, CLINICAL, {"on": ON, "how": "inner"})
    assert out["y"]["smps"] == ["S1", "S2"]
    assert out["y"]["vars"] == ["MYC", "age"]
    assert out["y"]["data"] == [[5.0, 7.0], [50, 60]]
    assert out["x"]["stage"] == ["I", "II"]


def test_left_join_keeps_unmatched_left_rows_with_nulls():
    out = join_data(EXPRESSION, CLINICAL, {"on": ON, "how": "left"})
    assert out["y"]["smps"] == ["S1", "S2", "S3"]
    assert out["x"]["stage"] == ["I", "II", None]


def test_one_to_many_qualifies_the_row_id():
    right = {"y": {"vars": ["v"], "smps": ["a", "b"], "data": [[1, 2]]}, "x": {"k": ["P1", "P1"]}}
    out = join_data(EXPRESSION, right, {"on": {"left": "patient_id", "right": "k"}})
    assert out["y"]["smps"] == ["S1|a", "S1|b"]


def test_missing_key_is_an_error():
    with pytest.raises(ValueError):
        join_data(EXPRESSION, CLINICAL, {"on": {"left": "nope", "right": "smps"}})
