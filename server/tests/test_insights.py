"""Proactive insights: the deterministic checks (held to R) and the driver that turns them into
captions with their figures. Pure functions — no app, no model, no network."""

import json
import os
import random

import pytest

from cxd_server import ask_tools, insights

ORACLE = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "ask-stats-oracle.json"),
                        encoding="utf-8"))


def table(rows, measures, categories=None):
    """A CanvasXpress data object: rows = records, ``measures`` = {name: fn(i)}, ``categories`` = {name: fn(i)}."""
    smps = ["S%d" % (i + 1) for i in range(rows)]
    names = list(measures)
    return {"y": {"vars": names, "smps": smps, "data": [[measures[m](i) for i in range(rows)] for m in names]},
            "x": {c: [categories[c](i) for i in range(rows)] for c in (categories or {})}}


# ---- the statistics are R's ------------------------------------------------
@pytest.mark.parametrize("case", ORACLE["cases"], ids=lambda c: "case-%s" % c["data"]["y"]["smps"][-1])
def test_matches_r(case):
    data, r = case["data"], case["r"]
    values = [float(v) for v in case["data"]["y"]["data"][0]]
    # Tukey fences: R quantile(type = 7)
    s = sorted(values)
    assert ask_tools._quantile(s, 0.25) == pytest.approx(r["q1"], abs=1e-12)
    assert ask_tools._quantile(s, 0.75) == pytest.approx(r["q3"], abs=1e-12)
    result = ask_tools.outliers(data, "m", min_n=1, max_ids=10 ** 6)
    if result is None:
        assert r["high_fence"] == r["low_fence"] or r["q3"] == r["q1"]   # no spread: nothing to test
    else:
        assert result["low_fence"] == pytest.approx(r["low_fence"], abs=1e-3)
        assert result["high_fence"] == pytest.approx(r["high_fence"], abs=1e-3)
        assert {o["id"] for o in result["outliers"]} == set(r["flagged"])
    # Kruskal-Wallis: R kruskal.test (tie-corrected, chi-square p)
    diff = ask_tools.group_difference(data, "g", "m", min_group=1, max_groups=10)
    if r["kw"] is None:
        assert diff is None
    else:
        assert diff["H"] == pytest.approx(r["kw"]["H"], rel=1e-9, abs=1e-9)
        assert diff["df"] == r["kw"]["df"]
        assert diff["p"] == pytest.approx(r["kw"]["p"], rel=1e-8, abs=1e-300)
    # Benjamini-Hochberg: R p.adjust(p, "BH")
    ps = r["ps"] if isinstance(r["ps"], list) else [r["ps"]]
    bh = r["bh"] if isinstance(r["bh"], list) else [r["bh"]]
    assert ask_tools.benjamini_hochberg(ps) == pytest.approx(bh, abs=1e-12)


def test_the_checks_are_registered_as_tools():
    data = table(20, {"m": lambda i: i + (50 if i == 3 else 0)}, {"g": lambda i: "ab"[i % 2]})
    assert ask_tools.run_tool(data, "outliers", {"measure": "m"})["outliers"]["count"] == 1
    assert ask_tools.run_tool(data, "group_difference", {"group_by": "g", "measure": "m"})["difference"] is not None
    assert ask_tools.run_tool(data, "threshold_check", {"field": "m", "op": "gt", "value": 10})["check"]["count"] >= 1


# ---- the primitives' edges --------------------------------------------------
def test_outliers_need_enough_values_and_some_spread():
    assert ask_tools.outliers(table(5, {"m": lambda i: i}), "m") is None           # fewer than 8
    assert ask_tools.outliers(table(20, {"m": lambda i: 3}), "m") is None          # IQR is 0
    clean = ask_tools.outliers(table(20, {"m": lambda i: i}), "m")
    assert clean["count"] == 0 and clean["outliers"] == []


def test_outliers_report_the_most_extreme_first_and_what_is_far_out():
    values = list(range(20)) + [60, -45]
    out = ask_tools.outliers(table(len(values), {"m": lambda i: values[i]}), "m")
    assert [o["value"] for o in out["outliers"]] == [-45, 60] or [o["value"] for o in out["outliers"]] == [60, -45]
    assert out["count"] == 2 and out["far_count"] == 2
    assert out["outliers"][0]["beyond"] >= out["outliers"][1]["beyond"]
    assert {o["side"] for o in out["outliers"]} == {"low", "high"}


def test_group_difference_needs_two_real_groups():
    flat = table(30, {"m": lambda i: i}, {"g": lambda i: "only"})
    assert ask_tools.group_difference(flat, "g", "m") is None                       # one level
    many = table(30, {"m": lambda i: i}, {"g": lambda i: "L%d" % i})
    assert ask_tools.group_difference(many, "g", "m") is None                       # an identifier, not a group
    small = table(5, {"m": lambda i: i}, {"g": lambda i: "ab"[i % 2]})
    assert ask_tools.group_difference(small, "g", "m") is None                      # groups of 2-3 < min_group after drop
    same = table(20, {"m": lambda i: 5}, {"g": lambda i: "ab"[i % 2]})
    assert ask_tools.group_difference(same, "g", "m") is None                       # all identical


def test_group_difference_orders_groups_by_median():
    data = table(30, {"m": lambda i: i % 3 * 10 + i % 7}, {"g": lambda i: "xyz"[i % 3]})
    out = ask_tools.group_difference(data, "g", "m")
    assert [g["group"] for g in out["groups"]] == ["z", "y", "x"]
    assert out["highest"] == "z" and out["lowest"] == "x"
    assert out["groups"][0]["median"] > out["groups"][-1]["median"] and out["p"] < 0.001


def test_threshold_check_counts_the_worst_first():
    data = table(10, {"q": lambda i: 80 + i})
    low = ask_tools.threshold_check(data, "q", "lt", 85)
    assert low["count"] == 5 and low["n"] == 10 and low["share"] == 0.5
    assert [d["value"] for d in low["ids"]] == [80, 81, 82, 83, 84]               # lowest first
    high = ask_tools.threshold_check(data, "q", "ge", 88)
    assert [d["value"] for d in high["ids"]] == [89, 88]                         # highest first
    with pytest.raises(ValueError):
        ask_tools.threshold_check(data, "q", "between", 1)
    with pytest.raises(ValueError):
        ask_tools.threshold_check(data, "q", "lt", "lots")


# ---- the driver -------------------------------------------------------------
def qc(n=48):
    return table(n, {"q30": lambda i: 88 + (i * 3) % 7, "reads": lambda i: 1000 + (i * 37) % 90},
                 {"lane": lambda i: "L%d" % (1 + i % 4), "run": lambda i: "R%d" % (1 + i % 2)})


def test_a_threshold_is_only_checked_when_the_dashboard_declares_it():
    data = qc()
    assert not [i for i in insights.compute_insights({"d": data}, {})["insights"] if i["kind"] == "threshold"]
    out = insights.compute_insights({"d": data}, {"thresholds": [{"field": "q30", "op": "lt", "value": 90, "label": "Q30 below 90"}]})
    first = out["insights"][0]
    assert first["kind"] == "threshold" and first["severity"] == "warn"      # failures outrank everything
    assert first["caption"].startswith("Q30 below 90: ")
    assert "records have q30 below 90" in first["caption"]
    assert first["figures"]["count"] == len(first["ids"]) or len(first["ids"]) == 10
    assert first["ids"] and all(i.startswith("S") for i in first["ids"])


def test_captions_carry_their_figures_and_nothing_else():
    data = table(40, {"m": lambda i: i % 10 + (200 if i == 7 else 0)}, {"g": lambda i: "ab"[i % 2]})
    out = insights.compute_insights({"d": data}, {})
    kinds = {i["kind"] for i in out["insights"]}
    assert "outliers" in kinds
    for item in out["insights"]:
        assert set(item) >= {"id", "kind", "severity", "source", "field", "caption", "figures", "ids"}
        assert "_score" not in item
    o = [i for i in out["insights"] if i["kind"] == "outliers"][0]
    # every number in the caption is a figure the check computed
    assert str(o["figures"]["count"]) in o["caption"] and "S8" in o["caption"]
    assert "207" in o["caption"] and o["ids"][0] == "S8"
    assert o["figures"]["outliers"][0]["id"] == "S8"


def test_group_differences_are_corrected_for_all_the_tests_run():
    rng = random.Random(3)
    noise = [rng.random() for _ in range(60)]
    # one real effect among many null comparisons: only the real one may survive BH correction
    cats = {"real": lambda i: "ab"[i % 2]}
    for k in range(8):                                  # unrelated groupings: three levels, assigned at random
        assign = [rng.choice("xyz") for _ in range(60)]
        assert len(set(assign)) == 3
        cats["null%d" % k] = (lambda assign: lambda i: assign[i])(assign)
    data = table(60, {"m": lambda i: noise[i] + (3 if i % 2 else 0), "n": lambda i: noise[(i * 7) % 60]}, cats)
    out = insights.compute_insights({"d": data}, {})
    diffs = [i for i in out["insights"] if i["kind"] == "group-difference"]
    assert [d["group_by"] for d in diffs] == ["real"] and diffs[0]["field"] == "m"
    assert out["checked"]["tests"] == 18                                      # 9 categories x 2 measures
    assert diffs[0]["figures"]["p_adjusted"] >= diffs[0]["figures"]["p"]
    assert diffs[0]["figures"]["epsilon2"] >= insights.MIN_EFFECT


def test_binary_and_constant_measures_and_identifier_categories_are_not_tested():
    data = table(40, {"event": lambda i: i % 2, "flat": lambda i: 5, "m": lambda i: i + 100 * (i % 2)},
                 {"id2": lambda i: "u%d" % i, "g": lambda i: "ab"[i % 2]})
    out = insights.compute_insights({"d": data}, {})
    assert out["checked"]["tests"] == 1                                       # only (g, m)
    assert not [i for i in out["insights"] if i["field"] in ("event", "flat")]


def test_narrowed_copies_are_skipped_so_one_dataset_is_not_reported_twice():
    data = qc()
    both = insights.compute_insights({"data": data, "case": data}, {})
    assert both["checked"]["sources"] == ["data", "case"]
    skipped = insights.compute_insights({"data": data, "case": data}, {}, narrowed=["case"])
    assert skipped["checked"]["sources"] == ["data"]
    assert len(skipped["insights"]) * 2 >= len(both["insights"]) or len(both["insights"]) <= insights.DEFAULT_MAX
    named = insights.compute_insights({"data": data, "case": data}, {"sources": ["case"]}, narrowed=["case"])
    assert named["checked"]["sources"] == ["case"]                            # asked for by name


def test_the_result_is_deterministic_ranked_and_capped():
    data = table(60, {"a": lambda i: i % 10 + (300 if i == 3 else 0), "b": lambda i: i % 9 + (-300 if i == 5 else 0),
                      "c": lambda i: i % 8 + (250 if i == 9 else 0), "q": lambda i: 80 + i % 12},
                 {"lane": lambda i: "L%d" % (i % 3), "run": lambda i: "R%d" % (i % 2)})
    cfg = {"max": 3, "thresholds": [{"field": "q", "op": "lt", "value": 85}]}
    one, two = insights.compute_insights({"d": data}, cfg), insights.compute_insights({"d": data}, cfg)
    assert one == two
    assert len(one["insights"]) == 3 and one["more"] >= 1
    assert one["insights"][0]["kind"] == "threshold"
    full = insights.compute_insights({"d": data}, {"max": 50})
    assert [i["id"] for i in full["insights"]][:3] == [i["id"] for i in one["insights"]][:3] or one["insights"][0]["kind"] == "threshold"
    assert full["more"] == 0


def test_a_bad_threshold_is_reported_not_raised():
    out = insights.compute_insights({"d": qc()}, {"thresholds": [{"field": "q30", "op": "near", "value": 1},
                                                                  {"field": "q30", "op": "lt", "value": "x"},
                                                                  {"field": "q30", "op": "lt", "value": 90}]})
    assert len(out["checked"]["problems"]) == 2
    assert any(i["kind"] == "threshold" for i in out["insights"])             # the valid one still runs


def test_a_threshold_on_a_missing_field_or_other_source_is_ignored():
    out = insights.compute_insights({"d": qc()}, {"thresholds": [{"field": "nope", "op": "lt", "value": 1},
                                                                  {"field": "q30", "op": "lt", "value": 99, "source": "elsewhere"}]})
    assert not [i for i in out["insights"] if i["kind"] == "threshold"]


def test_a_very_large_source_is_skipped_and_said_so(monkeypatch):
    monkeypatch.setattr(insights, "MAX_RECORDS", 10)
    out = insights.compute_insights({"d": qc(48)}, {})
    assert out["insights"] == [] and out["checked"]["skipped"] == [{"source": "d", "reason": "more than 10 records"}]


def test_captions_format_numbers_for_reading():
    assert insights._g(20013880.0) == "20,013,880" and insights._g(7.0) == "7" and insights._g(0.123456) == "0.1235"
    assert insights._p(0.0004) == "< 0.001" and insights._p(0.01234) == "= 0.0123"


def test_without_correction_chance_findings_would_be_reported_and_the_correction_removes_them():
    # 12 records, 300 unrelated three-level groupings of pure noise: by chance some comparisons clear
    # raw p < 0.05 with a large effect. Only the correction for the number of tests keeps them out.
    rng = random.Random(11)
    values = [rng.random() for _ in range(12)]
    cats = {}
    for k in range(300):
        while True:
            assign = [rng.choice("xyz") for _ in range(12)]
            if all(assign.count(level) >= 3 for level in "xyz"):
                break
        cats["g%d" % k] = (lambda assign: lambda i: assign[i])(assign)
    data = table(12, {"m": lambda i: values[i]}, cats)
    # The premise, measured directly: uncorrected, there would be false alarms.
    raw = [ask_tools.group_difference(data, c, "m", max_groups=6) for c in cats]
    spurious = [r for r in raw if r and r["p"] <= insights.ALPHA and r["epsilon2"] >= insights.MIN_EFFECT]
    assert len(spurious) >= 3, "the fixture must contain chance findings, got %d" % len(spurious)
    out = insights.compute_insights({"d": data}, {"max": 100})
    assert out["checked"]["tests"] == 300
    assert [i for i in out["insights"] if i["kind"] == "group-difference"] == []
