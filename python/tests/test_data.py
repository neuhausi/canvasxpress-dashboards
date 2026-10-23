import json
import math

import pytest

from canvasxpress_dashboards import cxd_data, read_spec

pd = pytest.importorskip("pandas")


def test_numeric_columns_are_measures_the_rest_annotations():
    df = pd.DataFrame({"id": ["P1", "P2", "P3"], "age": [40, 50, 60], "os": [3, 9, 5], "arm": ["Drug", "Placebo", "Drug"]})
    d = cxd_data(df, id="id")
    assert d["y"]["vars"] == ["age", "os"]
    assert d["y"]["smps"] == ["P1", "P2", "P3"]
    assert d["y"]["data"] == [[40, 50, 60], [3, 9, 5]]
    assert d["x"] == {"arm": ["Drug", "Placebo", "Drug"]}


def test_index_booleans_dates_and_categoricals():
    df = pd.DataFrame({"n": [1.5, 2.5], "flag": [True, False], "when": pd.to_datetime(["2026-01-01", "2026-02-01"]),
                       "cat": pd.Categorical(["a", "b"])}, index=["r1", "r2"])
    d = cxd_data(df)
    assert d["y"]["smps"] == ["r1", "r2"] and d["y"]["vars"] == ["n"]
    assert d["x"]["flag"] == ["True", "False"]                       # a bool is not a measure
    assert d["x"]["when"][0].startswith("2026-01-01")
    assert d["x"]["cat"] == ["a", "b"]
    assert cxd_data(pd.DataFrame({"n": [1, 2]}))["y"]["smps"] == ["1", "2"]    # a default index -> 1..n


def test_missing_values_become_none_and_the_result_is_strict_json():
    df = pd.DataFrame({"a": [1.0, float("nan"), 3.0], "b": [float("inf"), 2.0, 3.0], "g": ["x", None, "z"]})
    d = cxd_data(df)
    assert d["y"]["data"][0][1] is None
    assert d["y"]["data"][1][0] is None                              # inf is not JSON either
    assert d["x"]["g"] == ["x", None, "z"]
    json.dumps(d, allow_nan=False)                                    # raises if anything is NaN / inf


def test_dict_of_columns_and_list_of_records_need_no_pandas_semantics():
    cols = {"id": ["a", "b"], "n": [1, 2], "g": ["u", "v"]}
    assert cxd_data(cols, id="id") == {"y": {"vars": ["n"], "smps": ["a", "b"], "data": [[1, 2]]}, "x": {"g": ["u", "v"]}}
    records = [{"id": "a", "n": 1, "g": "u"}, {"id": "b", "n": None, "g": "v", "extra": 7}]
    d = cxd_data(records, id="id")
    assert d["y"]["vars"] == ["n", "extra"]                          # a column absent from a record is None
    assert d["y"]["data"] == [[1, None], [None, 7]]


def test_a_string_column_that_looks_numeric_stays_an_annotation():
    d = cxd_data({"n": [1, 2], "zip": ["02134", "10001"]})
    assert d["y"]["vars"] == ["n"] and d["x"]["zip"] == ["02134", "10001"]


def test_numpy_scalars_become_plain_numbers():
    np = pytest.importorskip("numpy")
    d = cxd_data({"n": list(np.array([1.5, 2.5])), "k": list(np.array([1, 2]))})
    assert all(type(v) in (int, float) for row in d["y"]["data"] for v in row)


def test_bad_input_is_refused_with_a_clear_message():
    with pytest.raises(TypeError, match="DataFrame"):
        cxd_data(42)
    with pytest.raises(ValueError, match="no rows"):
        cxd_data(pd.DataFrame({"a": []}))
    with pytest.raises(ValueError, match="no numeric columns"):
        cxd_data({"a": ["x", "y"]})
    with pytest.raises(ValueError, match="must be unique"):
        cxd_data({"id": ["a", "a"], "n": [1, 2]}, id="id")
    with pytest.raises(ValueError, match="missing or empty"):
        cxd_data({"id": ["a", None], "n": [1, 2]}, id="id")
    with pytest.raises(ValueError, match="must name a column"):
        cxd_data({"n": [1, 2]}, id="nope")
    with pytest.raises(ValueError, match="same length"):
        cxd_data({"a": [1, 2], "b": [1]})


def test_the_id_column_is_not_also_an_annotation():
    d = cxd_data({"id": ["a", "b"], "n": [1, 2], "g": ["u", "v"]}, id="id")
    assert list(d["x"]) == ["g"]


# ---- specs ----------------------------------------------------------------------------------------
def test_a_spec_can_be_a_dict_a_json_string_or_a_file(tmp_path):
    text = '{"id": "j", "layout": {"cols": 12, "items": []}, "data": {}, "panels": {}}'
    assert read_spec({"id": "d"})["id"] == "d"
    assert read_spec(text)["id"] == "j"
    path = tmp_path / "s.json"
    path.write_text(text)
    assert read_spec(str(path))["id"] == "j" and read_spec(path)["id"] == "j"


def test_bad_specs_are_refused():
    with pytest.raises(TypeError, match="dict, a JSON string or a file path"):
        read_spec(42)
    with pytest.raises(ValueError, match="no such file"):
        read_spec("not json and not a file")
    with pytest.raises(ValueError, match="not valid JSON"):
        read_spec("{broken")
    with pytest.raises(ValueError, match="JSON object"):
        read_spec("[1, 2]")
