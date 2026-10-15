"""Read-only data tools for view-time Q&A — deterministic, no language model."""

from cxd_server import ask_tools


# Three records across two regions; Revenue + Units measures, Region annotation.
DATA = {
    "y": {"vars": ["Revenue", "Units"], "smps": ["O1", "O2", "O3"],
          "data": [[100, 250, 50], [10, 20, 5]]},
    "x": {"Region": ["North", "North", "South"]},
}


def test_to_rows_flattens_records():
    rows = ask_tools.to_rows(DATA)
    assert rows[0] == {"id": "O1", "Revenue": 100, "Units": 10, "Region": "North"}
    assert len(rows) == 3


def test_fields_split_measures_and_categories():
    f = ask_tools.fields(DATA)
    assert f["measures"] == ["Revenue", "Units"]
    assert f["categories"] == ["id", "Region"]


def test_describe_summarizes():
    d = ask_tools.describe(DATA)
    assert d["records"] == 3
    assert d["measures"]["Revenue"]["max"] == 250
    assert d["measures"]["Revenue"]["mean"] == round(400 / 3, 4)
    assert d["categories"]["Region"]["distinct"] == 2
    assert set(d["categories"]["Region"]["values"]) == {"North", "South"}


def test_filter_numeric_and_category():
    big = ask_tools.filter_rows(DATA, "Revenue", "gt", 80)
    assert sorted(r["id"] for r in big) == ["O1", "O2"]
    north = ask_tools.filter_rows(DATA, "Region", "eq", "North")
    assert sorted(r["id"] for r in north) == ["O1", "O2"]


def test_aggregate_groups_and_sorts():
    agg = ask_tools.aggregate(DATA, "Region", "Revenue", "sum")
    assert agg == [{"group": "North", "value": 350}, {"group": "South", "value": 50}]
    avg = ask_tools.aggregate(DATA, "Region", "Revenue", "avg")
    assert avg[0] == {"group": "North", "value": 175.0}
    cnt = ask_tools.aggregate(DATA, "Region", "Revenue", "count")
    assert {g["group"]: g["value"] for g in cnt} == {"North": 2, "South": 1}


def test_top_n_ranks():
    assert ask_tools.top_n(DATA, "Revenue", 2) == [{"id": "O2", "value": 250}, {"id": "O1", "value": 100}]
    assert ask_tools.top_n(DATA, "Revenue", 1, ascending=True) == [{"id": "O3", "value": 50}]


def test_aggregate_over_prefiltered_rows():
    north = ask_tools.filter_rows(DATA, "Region", "eq", "North")
    agg = ask_tools.aggregate(DATA, "Region", "Revenue", "sum", rows=north)
    assert agg == [{"group": "North", "value": 350}]


def test_run_tool_dispatch_and_errors():
    out = ask_tools.run_tool(DATA, "aggregate", {"group_by": "Region", "measure": "Revenue"})
    assert out["groups"][0]["group"] == "North"
    try:
        ask_tools.run_tool(DATA, "nope", {})
        assert False, "expected ValueError"
    except ValueError:
        pass
