"""kind:"join" data sources in the server-side spec validator.

The JS/Python parity for these cases is also checked by
``tests/eval/run_js.mjs`` vs ``run_py.py`` over ``specs_corpus.json``.
"""

from cxd_server.validate_spec import join_cycle, validate_spec


def _spec(data, ref="j"):
    return {
        "id": "blend",
        "layout": {"cols": 12, "items": [{"panel": "bar", "x": 0, "y": 0, "w": 6, "h": 3}]},
        "data": data,
        "panels": {"bar": {"dataRef": ref, "config": {"graphType": "Bar"}}},
    }


_INLINE = {"kind": "inline", "value": {"y": {}}}


def test_accepts_a_join_over_declared_sources():
    spec = _spec({"a": _INLINE, "b": _INLINE,
                  "j": {"kind": "join", "left": "a", "right": "b",
                        "on": [{"left": "pid", "right": "smps"}, "visit"], "how": "outer"}})
    assert validate_spec(spec) == {"valid": True, "errors": []}


def test_flags_bad_join_fields():
    spec = _spec({"a": _INLINE,
                  "j": {"kind": "join", "left": "a", "right": "ghost", "how": "cross",
                        "on": [{"left": "id"}], "suffix": 1}})
    errors = validate_spec(spec)["errors"]
    assert 'spec.data["j"].right "ghost" has no matching entry in spec.data' in errors
    assert any(".how must be one of" in e for e in errors)
    assert any(".on must be" in e for e in errors)
    assert 'spec.data["j"].suffix must be a string' in errors


def test_flags_join_cycles():
    data = {"a": _INLINE,
            "j": {"kind": "join", "left": "a", "right": "k"},
            "k": {"kind": "join", "left": "j", "right": "a"}}
    errors = validate_spec(_spec(data))["errors"]
    assert 'spec.data["j"] join depends on itself (j -> k -> j)' in errors
    assert join_cycle("a", data) is None


def test_relationships_axis_and_marking_mode():
    ok = _spec({"a": _INLINE, "b": dict(_INLINE, axis="vars")}, ref="a")
    ok["relationships"] = [{"left": "a", "right": "b", "on": {"left": "Top", "right": "vars"}}]
    ok["markingMode"] = "ghost"
    assert validate_spec(ok) == {"valid": True, "errors": []}

    bad = _spec({"a": dict(_INLINE, axis="rows")}, ref="a")
    bad["relationships"] = [{"left": "a", "right": "ghost"}, "nope"]
    bad["markingMode"] = "blink"
    errors = validate_spec(bad)["errors"]
    assert 'spec.data["a"].axis must be "smps" or "vars"' in errors
    assert 'spec.relationships[0].right "ghost" has no matching entry in spec.data' in errors
    assert "spec.relationships[1] must be an object" in errors
    assert 'spec.markingMode must be "focus", "highlight", or "ghost"' in errors


def test_filters_panel_and_schemes():
    ok = _spec({"a": _INLINE, "b": _INLINE}, ref="a")
    ok["panels"]["f"] = {"type": "filters", "dataRef": "a",
                         "fields": ["Arm", {"field": "Age", "dataRef": "b", "kind": "range"}]}
    ok["filterSchemes"] = {"Drug": [{"dataRef": "a", "field": "Arm", "values": ["drug"]},
                                    {"dataRef": "b", "field": "Age", "min": 50}]}
    assert validate_spec(ok) == {"valid": True, "errors": []}

    bad = _spec({"a": _INLINE}, ref="a")
    bad["panels"]["f"] = {"type": "filters",
                          "fields": ["Arm", {"field": "X", "kind": "slider", "dataRef": "a"}]}
    bad["panels"]["g"] = {"type": "filters"}
    bad["filterSchemes"] = {"S": [{"dataRef": "ghost", "field": "Arm", "min": True}]}
    errors = validate_spec(bad)["errors"]
    assert 'spec.panels["f"].fields[0] needs the panel dataRef (or use {field, dataRef})' in errors
    assert 'spec.panels["f"].fields[1].kind must be "values", "range", or "search"' in errors
    assert 'spec.panels["g"] of type "filters" requires a dataRef or fields' in errors
    assert 'spec.filterSchemes["S"][0].dataRef has no matching entry in spec.data' in errors
    assert 'spec.filterSchemes["S"][0].min must be a number' in errors


def test_schema_version_rules():
    from cxd_server.validate_spec import spec_compatibility
    assert spec_compatibility({}) == ("older", "1.0")
    assert spec_compatibility({"schemaVersion": "1.1"}) == ("older", "1.1")
    assert spec_compatibility({"schemaVersion": "1.2"}) == ("older", "1.2")
    assert spec_compatibility({"schemaVersion": "1.3"}) == ("current", "1.3")
    assert spec_compatibility({"schemaVersion": "1.4"}) == ("newer-minor", "1.4")
    assert spec_compatibility({"schemaVersion": "3.0"}) == ("newer-major", "3.0")
    assert spec_compatibility({"schemaVersion": "1.1\n"})[0] == "invalid"
    newer = _spec({"a": _INLINE, "s": {"kind": "stream"}}, ref="a")
    newer["schemaVersion"] = "1.4"
    result = validate_spec(newer)
    assert result["valid"] is True and len(result["warnings"]) == 1
    newer["schemaVersion"] = "2.0"
    assert any("needs a newer" in e for e in validate_spec(newer)["errors"])


def test_calculated_fields_shape():
    """A source's calculatedFields: {name, target?, formula} or {name, target?, bin} (mirrors validateSpec.js)."""
    good = _spec({"a": dict(_INLINE, calculatedFields=[
        {"name": "PerUnit", "formula": "Revenue / Units"},
        {"name": "Tier", "target": "sampleAnnotation", "bin": {"field": "Revenue", "method": "quantile", "bins": 4}},
        {"name": "Cut", "target": "sampleAnnotation", "bin": {"field": "Revenue", "method": "custom", "breaks": [10, 20.5]}},
    ])}, ref="a")
    assert validate_spec(good)["errors"] == []

    bad = _spec({"a": dict(_INLINE, calculatedFields=[
        {"formula": "x"},                                     # no name
        {"name": "A", "formula": "x", "bin": {"field": "y"}},  # both
        {"name": "A", "formula": " "},                        # repeat + blank formula
        {"name": "B", "target": "column", "formula": "x"},    # bad target
        {"name": "C", "bin": {"method": "log", "bins": 0, "breaks": ["1"]}},
    ])}, ref="a")
    errors = validate_spec(bad)["errors"]
    for fragment in ("requires a name string", "needs exactly one of a formula string or a bin",
                     'repeats the name "A"', ".target must be", ".bin requires a field string",
                     ".bin.method must be", ".bin.bins must be a whole number", ".bin.breaks must be a list of numbers"):
        assert any(fragment in e for e in errors), (fragment, errors)

    live = _spec({"a": {"kind": "live", "url": "/s", "calculatedFields": [{"name": "X", "formula": "1"}]}}, ref="a")
    assert any("not supported on a live source" in e for e in validate_spec(live)["errors"])


def test_pushdown_runs_anywhere_but_live():
    """pushdown is allowed on any source but live: it runs in the browser when there is no database."""
    q = {"groupBy": ["region"], "measures": [{"fn": "count"}]}
    for src in (dict(_INLINE, pushdown=q), {"kind": "dataset", "id": "x", "pushdown": q},
                {"kind": "connector", "url": "/api/data", "pushdown": q}):
        assert validate_spec(_spec({"a": src}, ref="a"))["errors"] == [], src["kind"]
    live = _spec({"a": {"kind": "live", "url": "/s", "pushdown": q}}, ref="a")
    assert any("pushdown is not supported on a live source" in e for e in validate_spec(live)["errors"])
    boolean = _spec({"a": dict(_INLINE, pushdown=True)}, ref="a")
    assert any("pushdown must be an object" in e for e in validate_spec(boolean)["errors"])
