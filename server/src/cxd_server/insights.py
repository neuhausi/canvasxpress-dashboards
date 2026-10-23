"""Proactive insights: a fixed set of deterministic checks run over a dashboard's data, each
reported as a caption that carries its figures.

Nothing here is free-form. The checks are the tools in :mod:`cxd_server.ask_tools` — Tukey outliers,
a Kruskal-Wallis group comparison corrected for multiple testing, and thresholds the dashboard
*declares* — and every caption is filled from a fixed template with numbers those tools computed.
No model is involved, so the same data always yields the same insights and nothing needs a login or
credits. Row/column security is applied by the caller before the data gets here.

A dashboard opts in with a top-level ``insights`` block::

    "insights": {
      "thresholds": [{"field": "q30", "op": "lt", "value": 85, "label": "Q30 below 85%"}],
      "sources": ["data"],     # optional: default is every source that is not a narrowed copy
      "max": 6                 # optional: the most insights to return
    }

A threshold is never invented: with none declared, only the data-derived checks run.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import ask_tools

ALPHA = 0.05            # a group difference needs a BH-adjusted p at or below this ...
MIN_EFFECT = 0.14       # ... and a "large" rank effect size (epsilon-squared) at or above this
MAX_RECORDS = 200_000   # a source with more records than this is skipped, not sampled
DEFAULT_MAX = 6
MAX_LEVELS = 6          # a grouping field may have at most this many levels
MIN_DISTINCT = 3        # a measure needs more than two distinct values to be "continuous"

_OP_WORDS = {"lt": "below", "le": "at or below", "gt": "above", "ge": "at or above"}


def _g(value: Any) -> str:
    """A number as it reads in a caption: whole numbers plain (thousands separated from 10,000 up),
    other numbers to 4 significant digits."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return str(value)
    if value == int(value) and abs(value) < 1e15:
        return format(int(value), ",") if abs(value) >= 10000 else str(int(value))
    if abs(value) >= 10000:
        return format(int(round(value)), ",")
    return "%.4g" % value


def _p(p: float) -> str:
    """A p-value comparison for a caption: "< 0.001" or "= 0.0123" (read after "p ")."""
    return "< 0.001" if p < 0.001 else "= %.3g" % p


def _names(ids: List[Any], limit: int = 3) -> str:
    shown = ", ".join(str(i) for i in ids[:limit])
    return shown + (", …" if len(ids) > limit else "")


def _measures_and_categories(data: Dict[str, Any], rows: List[Dict[str, Any]]) -> Dict[str, List[str]]:
    """The continuous measures and the few-level categories worth testing in one source."""
    fields = ask_tools.fields(data)
    measures = []
    for m in fields["measures"]:
        distinct = {v for v in (ask_tools._num(r.get(m)) for r in rows) if v is not None}
        if len(distinct) >= MIN_DISTINCT:
            measures.append(m)
    categories = []
    for c in fields["categories"]:
        if c == "id":
            continue
        levels = {str(r.get(c)) for r in rows if r.get(c) not in (None, "")}
        if 2 <= len(levels) <= MAX_LEVELS:
            categories.append(c)
    return {"measures": measures, "categories": categories}


def _threshold_insight(ref: str, spec: Dict[str, Any], result: Dict[str, Any]) -> Dict[str, Any]:
    label = spec.get("label")
    caption = "%d of %d records have %s %s %s" % (
        result["count"], result["n"], result["field"], _OP_WORDS[result["op"]], _g(result["value"]))
    if label:
        caption = "%s: %s" % (label, caption)
    ids = [d["id"] for d in result["ids"]]
    caption += " (%s)." % _names(ids) if ids else "."
    return {"id": "threshold:%s:%s:%s:%s" % (ref, result["field"], result["op"], _g(result["value"])),
            "kind": "threshold", "severity": "warn", "source": ref, "field": result["field"],
            "caption": caption, "figures": result, "ids": [str(i) for i in ids],
            "_score": 1000 + (result["share"] or 0)}


def _outlier_insight(ref: str, result: Dict[str, Any]) -> Dict[str, Any]:
    worst = result["outliers"][0]
    caption = "%d %s value%s outside the 1.5×IQR fences [%s, %s]" % (
        result["count"], result["measure"], "" if result["count"] == 1 else "s",
        _g(result["low_fence"]), _g(result["high_fence"]))
    if result["far_count"]:
        caption += ", %d of them far out (beyond 3×IQR)" % result["far_count"]
    ids = [d["id"] for d in result["outliers"]]
    caption += "; most extreme %s = %s (median %s, n = %d)." % (
        worst["id"], _g(worst["value"]), _g(result["median"]), result["n"])
    return {"id": "outliers:%s:%s" % (ref, result["measure"]), "kind": "outliers",
            "severity": "warn" if result["far_count"] else "info", "source": ref,
            "field": result["measure"], "caption": caption, "figures": result,
            "ids": [str(i) for i in ids],
            "_score": 100 + 10 * result["far_count"] + min(result["count"], 10)}


def _difference_insight(ref: str, result: Dict[str, Any], p_adj: float) -> Dict[str, Any]:
    top, bottom = result["groups"][0], result["groups"][-1]
    caption = ("%s differs by %s: %s has the highest median (%s, n = %d) and %s the lowest (%s, n = %d) "
               "— Kruskal-Wallis p %s (BH-adjusted p %s), ε² = %.2f, n = %d." % (
                   result["measure"], result["group_by"], top["group"], _g(top["median"]), top["n"],
                   bottom["group"], _g(bottom["median"]), bottom["n"], _p(result["p"]), _p(p_adj),
                   result["epsilon2"], result["n"]))
    figures = dict(result)
    figures["p_adjusted"] = p_adj
    return {"id": "difference:%s:%s:%s" % (ref, result["group_by"], result["measure"]),
            "kind": "group-difference", "severity": "info", "source": ref, "field": result["measure"],
            "group_by": result["group_by"], "caption": caption, "figures": figures, "ids": [],
            "_score": 500 + result["epsilon2"]}


def check_config(config: Any) -> Dict[str, Any]:
    """Validate and normalize an ``insights`` block.

    :param config: The spec's ``insights`` value (``True`` / ``{}`` mean "defaults").
    :returns: ``{thresholds, sources, max, problems}`` — a threshold that cannot be run is reported
        in ``problems`` and left out, never raised.
    """
    problems: List[str] = []
    if not isinstance(config, dict):
        config = {}
    thresholds = []
    for i, t in enumerate(config.get("thresholds") or []):
        ok = (isinstance(t, dict) and isinstance(t.get("field"), str) and t.get("field")
              and t.get("op") in ask_tools._THRESHOLD_OPS and ask_tools._num(t.get("value")) is not None)
        if ok:
            thresholds.append(t)
        else:
            problems.append("insights.thresholds[%d] needs a field, an op (%s) and a numeric value" % (
                i, ", ".join(ask_tools._THRESHOLD_OPS)))
    sources = config.get("sources")
    limit = config.get("max")
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0 else DEFAULT_MAX
    return {"thresholds": thresholds, "sources": sources if isinstance(sources, list) else None,
            "max": limit, "problems": problems}


def compute_insights(data_by_ref: Dict[str, Dict[str, Any]], config: Any = None,
                     narrowed: Optional[List[str]] = None) -> Dict[str, Any]:
    """Run the fixed checks over a dashboard's resolved sources.

    :param data_by_ref: Resolved CanvasXpress data per source ref (security already applied).
    :param config: The spec's ``insights`` block.
    :param narrowed: Source refs that are narrowed copies of another source (a pushdown, such as the
        case card's); they are skipped by default so one dataset is not reported twice.
    :returns: ``{insights, more, checked}``: the ranked insights (each ``{id, kind, severity, source,
        field, caption, figures, ids}``), how many further findings were cut by ``max``, and what was
        looked at (``sources``, ``tests``, ``skipped``, ``problems``).
    """
    cfg = check_config(config)
    skip = set(narrowed or [])
    refs = [r for r in (cfg["sources"] if cfg["sources"] is not None else list(data_by_ref))
            if r in data_by_ref and (cfg["sources"] is not None or r not in skip)]
    findings: List[Dict[str, Any]] = []
    checked = {"sources": [], "tests": 0, "skipped": [], "problems": list(cfg["problems"])}
    for ref in refs:
        data = data_by_ref[ref]
        rows = ask_tools.to_rows(data)
        if len(rows) > MAX_RECORDS:
            checked["skipped"].append({"source": ref, "reason": "more than %d records" % MAX_RECORDS})
            continue
        checked["sources"].append(ref)
        for t in cfg["thresholds"]:
            if t.get("source") not in (None, ref):
                continue
            if t["field"] not in ask_tools.fields(data)["measures"] + ask_tools.fields(data)["categories"]:
                continue
            result = ask_tools.threshold_check(data, t["field"], t["op"], t["value"], rows=rows)
            if result["count"]:
                findings.append(_threshold_insight(ref, t, result))
        picked = _measures_and_categories(data, rows)
        for m in picked["measures"]:
            result = ask_tools.outliers(data, m, rows=rows)
            if result and result["count"]:
                findings.append(_outlier_insight(ref, result))
        tests = []
        for c in picked["categories"]:
            for m in picked["measures"]:
                result = ask_tools.group_difference(data, c, m, rows=rows, max_groups=MAX_LEVELS)
                if result:
                    tests.append(result)
        checked["tests"] += len(tests)
        adjusted = ask_tools.benjamini_hochberg([t["p"] for t in tests])
        for result, p_adj in zip(tests, adjusted):
            if p_adj <= ALPHA and result["epsilon2"] >= MIN_EFFECT:
                findings.append(_difference_insight(ref, result, p_adj))
    findings.sort(key=lambda f: (-f["_score"], f["id"]))
    shown = findings[:cfg["max"]]
    for f in shown:
        f.pop("_score", None)
    return {"insights": shown, "more": max(0, len(findings) - len(shown)), "checked": checked}
