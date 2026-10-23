"""Read-only data tools for view-time dashboard Q&A ("ask this dashboard").

The whole point of asking a question of a dashboard is that the answer is
**computed from the actual data**, not hallucinated by a language model. So the
model is never given the raw numbers to reason over freely; it calls this small,
fixed set of deterministic tools, and only their *results* come back. There is
no ``eval`` and no free-form SQL — every tool is a plain function over the
CanvasXpress data object a panel is bound to.

A CanvasXpress data object looks like::

    { "y": { "vars": ["Revenue", "Units"],      # the measures (matrix rows)
             "smps": ["O1", "O2", ...],          # the records (matrix columns)
             "data": [[...revenue per smp...],    # data[var_index][smp_index]
                      [...units per smp...]] },
      "x": { "Region": [...per smp...], ... } }   # categorical annotations per record

So each **record** (a sample / ``smps`` entry) has a value for every measure
(``vars``) and every annotation (``x``). :func:`to_rows` flattens that into a
list of row dicts the tools work over.

This module is import-clean (stdlib only) and has no dependency on the web app,
so it is unit-tested directly.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional


def to_rows(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Flatten a CanvasXpress data object into one row dict per record.

    Each row carries ``id`` (the ``smps`` name), one key per measure (``vars``,
    the value from ``data[var][record]``), and one key per ``x`` annotation.

    :param data: A CanvasXpress data object.
    :returns: A list of row dicts, one per record.
    """
    y = (data or {}).get("y") or {}
    smps = y.get("smps") or []
    vars = y.get("vars") or []
    matrix = y.get("data") or []
    x = (data or {}).get("x") or {}
    rows = []
    for j, smp in enumerate(smps):
        row = {"id": smp}
        for i, var in enumerate(vars):
            try:
                row[var] = matrix[i][j]
            except (IndexError, TypeError):
                row[var] = None
        for ann, values in x.items():
            if isinstance(values, list) and j < len(values):
                row[ann] = values[j]
        rows.append(row)
    return rows


def fields(data: Dict[str, Any]) -> Dict[str, List[str]]:
    """The queryable fields of a data object: measures (numeric ``vars``) and
    annotations (categorical ``x`` keys, plus ``id``).

    :param data: A CanvasXpress data object.
    :returns: ``{"measures": [...], "categories": [...]}``.
    """
    y = (data or {}).get("y") or {}
    x = (data or {}).get("x") or {}
    return {"measures": list(y.get("vars") or []),
            "categories": ["id"] + list(x.keys())}


def _num(value: Any) -> Optional[float]:
    """Coerce a value to float, or None when it is not a finite number."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def describe(data: Dict[str, Any]) -> Dict[str, Any]:
    """Summarize a data object: record count, the measures (with min/max/mean)
    and the categories (with their distinct values, capped).

    :param data: A CanvasXpress data object.
    :returns: A summary dict safe to hand to the model as context.
    """
    rows = to_rows(data)
    meta = fields(data)
    measures = {}
    for m in meta["measures"]:
        nums = [n for n in (_num(r.get(m)) for r in rows) if n is not None]
        measures[m] = {
            "count": len(nums),
            "min": min(nums) if nums else None,
            "max": max(nums) if nums else None,
            "mean": round(sum(nums) / len(nums), 4) if nums else None,
        }
    categories = {}
    for c in meta["categories"]:
        seen = []
        for r in rows:
            v = r.get(c)
            if v is not None and v not in seen:
                seen.append(v)
            if len(seen) >= 50:
                break
        categories[c] = {"distinct": len(seen), "values": seen[:20]}
    return {"records": len(rows), "measures": measures, "categories": categories}


_OPS = {
    "eq": lambda a, b: a == b,
    "ne": lambda a, b: a != b,
    "gt": lambda a, b: a is not None and a > b,
    "lt": lambda a, b: a is not None and a < b,
    "ge": lambda a, b: a is not None and a >= b,
    "le": lambda a, b: a is not None and a <= b,
}


def _matches(row_value: Any, op: str, target: Any) -> bool:
    """Whether one row value satisfies ``op target``."""
    if op in ("eq", "ne"):
        # Compare as strings so "North" == "North" and 3 == "3".
        same = str(row_value) == str(target)
        return same if op == "eq" else not same
    if op == "contains":
        return row_value is not None and str(target).lower() in str(row_value).lower()
    rv, tv = _num(row_value), _num(target)
    if rv is None or tv is None:
        return False
    return _OPS[op](rv, tv)


def filter_rows(data: Dict[str, Any], field: str, op: str, value: Any) -> List[Dict[str, Any]]:
    """The rows whose ``field`` satisfies ``op value``.

    :param data: A CanvasXpress data object.
    :param field: A measure or category name (or ``id``).
    :param op: One of ``eq, ne, gt, lt, ge, le, contains``.
    :param value: The comparison value.
    :returns: The matching rows.
    :raises ValueError: On an unknown operator.
    """
    if op not in _OPS and op != "contains":
        raise ValueError("unknown op: %s" % op)
    return [r for r in to_rows(data) if _matches(r.get(field), op, value)]


_AGGS = {
    "sum": lambda ns: sum(ns),
    "avg": lambda ns: sum(ns) / len(ns) if ns else None,
    "mean": lambda ns: sum(ns) / len(ns) if ns else None,
    "min": lambda ns: min(ns) if ns else None,
    "max": lambda ns: max(ns) if ns else None,
    "count": lambda ns: len(ns),
}


def aggregate(data: Dict[str, Any], group_by: str, measure: str,
              agg: str = "sum", rows: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """Group records by ``group_by`` and aggregate ``measure`` within each group.

    :param data: A CanvasXpress data object.
    :param group_by: The category field to group on.
    :param measure: The measure to aggregate.
    :param agg: ``sum`` (default), ``avg``/``mean``, ``min``, ``max`` or ``count``.
    :param rows: Pre-filtered rows to aggregate instead of the whole object.
    :returns: ``[{group, value}, ...]`` sorted by value descending.
    :raises ValueError: On an unknown aggregation.
    """
    if agg not in _AGGS:
        raise ValueError("unknown agg: %s" % agg)
    source = rows if rows is not None else to_rows(data)
    groups: Dict[str, List[float]] = {}
    order: List[str] = []
    for r in source:
        key = str(r.get(group_by))
        if key not in groups:
            groups[key] = []
            order.append(key)
        if agg == "count":
            groups[key].append(1.0)
        else:
            n = _num(r.get(measure))
            if n is not None:
                groups[key].append(n)
    out = [{"group": k, "value": _round(_AGGS[agg](groups[k]))} for k in order]
    out.sort(key=lambda d: (d["value"] is None, -(d["value"] or 0)))
    return out


def top_n(data: Dict[str, Any], measure: str, n: int = 5, ascending: bool = False,
          rows: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """The ``n`` records with the highest (or lowest) ``measure``.

    :param data: A CanvasXpress data object.
    :param measure: The measure to rank by.
    :param n: How many records.
    :param ascending: Lowest-first when True.
    :param rows: Pre-filtered rows to rank instead of the whole object.
    :returns: ``[{id, value}, ...]``.
    """
    source = rows if rows is not None else to_rows(data)
    ranked = [(r.get("id"), _num(r.get(measure))) for r in source]
    ranked = [t for t in ranked if t[1] is not None]
    ranked.sort(key=lambda t: t[1], reverse=not ascending)
    return [{"id": rid, "value": _round(val)} for rid, val in ranked[:max(0, int(n))]]


def _round(value: Any) -> Any:
    """Round a float to 4 places; pass other values through."""
    return round(value, 4) if isinstance(value, float) else value


# ---------------------------------------------------------------------------
# Deterministic analysis checks (the "insights" layer)
#
# Fixed statistical checks over one data object. Like every tool here they are plain, stdlib-only
# functions: no eval, no model, and the same input always gives the same figures. Their numbers are
# validated against R (quantile type 7, kruskal.test, p.adjust "BH") in test_ask_tools.py.
# ---------------------------------------------------------------------------

def _quantile(sorted_values: List[float], p: float) -> float:
    """The ``p`` quantile of sorted values by linear interpolation (R's ``quantile`` type 7)."""
    h = (len(sorted_values) - 1) * p
    lo = int(math.floor(h))
    hi = int(math.ceil(h))
    return sorted_values[lo] + (h - lo) * (sorted_values[hi] - sorted_values[lo])


def _median(values: List[float]) -> float:
    return _quantile(sorted(values), 0.5)


def outliers(data: Dict[str, Any], measure: str, rows: Optional[List[Dict[str, Any]]] = None,
             k: float = 1.5, far: float = 3.0, min_n: int = 8, max_ids: int = 10) -> Optional[Dict[str, Any]]:
    """Values of ``measure`` outside Tukey's fences (``Q1 - k*IQR`` / ``Q3 + k*IQR``).

    :param data: A CanvasXpress data object.
    :param measure: A measure (numeric) field.
    :param rows: Pre-filtered rows to test instead of the whole object.
    :param k: The fence multiplier (1.5 is Tukey's convention).
    :param far: The multiplier beyond which a value is "far out" (3.0 is Tukey's convention).
    :param min_n: The fewest numeric values worth testing.
    :param max_ids: How many flagged records to list (most extreme first).
    :returns: ``None`` when there are too few values or no spread (IQR 0); otherwise
        ``{measure, n, median, q1, q3, iqr, low_fence, high_fence, count, far_count, outliers}``
        where ``outliers`` is ``[{id, value, side, beyond}]`` and ``beyond`` is how far past the
        nearest fence the value lies, in IQRs.
    """
    source = rows if rows is not None else to_rows(data)
    pairs = [(r.get("id"), _num(r.get(measure))) for r in source]
    pairs = [(i, v) for i, v in pairs if v is not None]
    if len(pairs) < min_n:
        return None
    values = sorted(v for _, v in pairs)
    q1, q3 = _quantile(values, 0.25), _quantile(values, 0.75)
    iqr = q3 - q1
    if iqr <= 0:
        return None
    low, high = q1 - k * iqr, q3 + k * iqr
    flagged = []
    for rid, v in pairs:
        if v < low:
            flagged.append({"id": rid, "value": _round(v), "side": "low", "beyond": _round((low - v) / iqr)})
        elif v > high:
            flagged.append({"id": rid, "value": _round(v), "side": "high", "beyond": _round((v - high) / iqr)})
    flagged.sort(key=lambda d: -d["beyond"])
    far_beyond = (far - k)
    return {
        "measure": measure, "n": len(pairs), "median": _round(_quantile(values, 0.5)),
        "q1": _round(q1), "q3": _round(q3), "iqr": _round(iqr),
        "low_fence": _round(low), "high_fence": _round(high),
        "count": len(flagged), "far_count": sum(1 for d in flagged if d["beyond"] > far_beyond),
        "outliers": flagged[:max(0, int(max_ids))],
    }


def _ranks(values: List[float]) -> List[float]:
    """1-based ranks, ties given the average of the ranks they span (R's ``rank``)."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        average = (i + j) / 2.0 + 1.0
        for t in range(i, j + 1):
            ranks[order[t]] = average
        i = j + 1
    return ranks


def _gamma_q(a: float, x: float) -> float:
    """The regularized upper incomplete gamma function ``Q(a, x)`` (series / continued fraction)."""
    if x <= 0:
        return 1.0
    log_front = -x + a * math.log(x) - math.lgamma(a)
    if x < a + 1.0:
        term = total = 1.0 / a
        ap = a
        for _ in range(2000):
            ap += 1.0
            term *= x / ap
            total += term
            if abs(term) < abs(total) * 1e-16:
                break
        return max(0.0, 1.0 - total * math.exp(log_front))
    tiny = 1e-300
    b = x + 1.0 - a
    c = 1.0 / tiny
    d = 1.0 / b
    h = d
    for i in range(1, 2000):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        d = tiny if abs(d) < tiny else d
        c = b + an / c
        c = tiny if abs(c) < tiny else c
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-16:
            break
    return min(1.0, math.exp(log_front) * h)


def _chi2_sf(x: float, df: int) -> float:
    """The chi-square survival function ``P(X > x)``."""
    return _gamma_q(df / 2.0, x / 2.0)


def kruskal_wallis(groups: List[List[float]]) -> Optional[Dict[str, float]]:
    """The Kruskal-Wallis rank-sum test across groups (tie-corrected, chi-square p; as R's
    ``kruskal.test``).

    :param groups: One list of numbers per group (at least two non-empty groups).
    :returns: ``{H, df, p, epsilon2}`` or ``None`` when every value is identical.
        ``epsilon2`` is the rank effect size ``H / (N - 1)``.
    """
    groups = [g for g in groups if g]
    if len(groups) < 2:
        return None
    pooled = [v for g in groups for v in g]
    n = len(pooled)
    ranks = _ranks(pooled)
    h = 0.0
    start = 0
    for g in groups:
        rank_sum = sum(ranks[start:start + len(g)])
        h += rank_sum * rank_sum / len(g)
        start += len(g)
    h = 12.0 / (n * (n + 1.0)) * h - 3.0 * (n + 1.0)
    ties: Dict[float, int] = {}
    for v in pooled:
        ties[v] = ties.get(v, 0) + 1
    correction = 1.0 - sum(t ** 3 - t for t in ties.values()) / float(n ** 3 - n)
    if correction <= 0:
        return None
    h /= correction
    df = len(groups) - 1
    return {"H": h, "df": df, "p": _chi2_sf(h, df), "epsilon2": h / (n - 1.0)}


def benjamini_hochberg(p_values: List[float]) -> List[float]:
    """Benjamini-Hochberg adjusted p-values, in the input order (R's ``p.adjust(p, "BH")``)."""
    n = len(p_values)
    order = sorted(range(n), key=lambda i: p_values[i], reverse=True)
    adjusted = [0.0] * n
    running = 1.0
    for position, idx in enumerate(order):
        rank = n - position
        running = min(running, p_values[idx] * n / rank)
        adjusted[idx] = min(1.0, running)
    return adjusted


def group_difference(data: Dict[str, Any], group_by: str, measure: str,
                     rows: Optional[List[Dict[str, Any]]] = None, min_group: int = 3,
                     max_groups: int = 6) -> Optional[Dict[str, Any]]:
    """Whether ``measure`` differs between the groups of ``group_by`` (Kruskal-Wallis).

    Groups with fewer than ``min_group`` values are left out; the test needs at least two groups
    left and no more than ``max_groups`` levels to begin with (a many-level field is an identifier,
    not a grouping).

    :param data: A CanvasXpress data object.
    :param group_by: A category field.
    :param measure: A measure (numeric) field.
    :param rows: Pre-filtered rows to test instead of the whole object.
    :param min_group: The fewest values a group needs to be compared.
    :param max_groups: The most levels a grouping field may have.
    :returns: ``None`` when the test cannot be run; otherwise ``{group_by, measure, n, groups, H,
        df, p, epsilon2, highest, lowest}`` with ``groups`` = ``[{group, n, median, mean}]``
        ordered by median, highest first.
    """
    source = rows if rows is not None else to_rows(data)
    buckets: Dict[str, List[float]] = {}
    for r in source:
        key, v = r.get(group_by), _num(r.get(measure))
        if key is None or key == "" or v is None:
            continue
        buckets.setdefault(str(key), []).append(v)
    if len(buckets) > max_groups:
        return None
    kept = {k: v for k, v in buckets.items() if len(v) >= min_group}
    if len(kept) < 2:
        return None
    test = kruskal_wallis(list(kept.values()))
    if test is None:
        return None
    groups = [{"group": k, "n": len(v), "median": _round(_median(v)), "mean": _round(sum(v) / len(v))}
              for k, v in kept.items()]
    groups.sort(key=lambda g: -g["median"])
    return {"group_by": group_by, "measure": measure, "n": sum(g["n"] for g in groups),
            "groups": groups, "H": test["H"], "df": test["df"], "p": test["p"],
            "epsilon2": test["epsilon2"], "highest": groups[0]["group"], "lowest": groups[-1]["group"]}


_THRESHOLD_OPS = ("lt", "le", "gt", "ge")


def threshold_check(data: Dict[str, Any], field: str, op: str, value: Any,
                    rows: Optional[List[Dict[str, Any]]] = None, max_ids: int = 10) -> Dict[str, Any]:
    """Records whose ``field`` violates a declared threshold (``field op value``).

    :param data: A CanvasXpress data object.
    :param field: A numeric measure or annotation.
    :param op: ``lt``, ``le``, ``gt`` or ``ge`` — the condition that counts as a failure.
    :param value: The threshold.
    :param rows: Pre-filtered rows to test instead of the whole object.
    :param max_ids: How many failing records to list (worst first).
    :returns: ``{field, op, value, n, count, share, ids}`` where ``ids`` is ``[{id, value}]``.
    :raises ValueError: On an unsupported operator or a non-numeric threshold.
    """
    if op not in _THRESHOLD_OPS:
        raise ValueError("threshold op must be one of: %s" % ", ".join(_THRESHOLD_OPS))
    limit = _num(value)
    if limit is None:
        raise ValueError("threshold value must be a number")
    source = rows if rows is not None else to_rows(data)
    numeric = [(r.get("id"), _num(r.get(field))) for r in source]
    numeric = [(i, v) for i, v in numeric if v is not None]
    failing = [(i, v) for i, v in numeric if _OPS[op](v, limit)]
    failing.sort(key=lambda t: t[1], reverse=op in ("gt", "ge"))
    return {"field": field, "op": op, "value": _round(limit), "n": len(numeric), "count": len(failing),
            "share": _round(len(failing) / len(numeric)) if numeric else None,
            "ids": [{"id": i, "value": _round(v)} for i, v in failing[:max(0, int(max_ids))]]}


# The tool surface exposed to the model (name -> callable(data, **args)).
TOOLS = {
    "describe": lambda data, **a: describe(data),
    "filter": lambda data, field, op, value, **a: {"rows": filter_rows(data, field, op, value)},
    "aggregate": lambda data, group_by, measure, agg="sum", **a: {"groups": aggregate(data, group_by, measure, agg)},
    "top_n": lambda data, measure, n=5, ascending=False, **a: {"top": top_n(data, measure, n, ascending)},
    "outliers": lambda data, measure, **a: {"outliers": outliers(data, measure)},
    "group_difference": lambda data, group_by, measure, **a: {"difference": group_difference(data, group_by, measure)},
    "threshold_check": lambda data, field, op, value, **a: {"check": threshold_check(data, field, op, value)},
}


def run_tool(data: Dict[str, Any], name: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Run one named read-only tool against a data object.

    :param data: A CanvasXpress data object.
    :param name: A key of :data:`TOOLS`.
    :param args: The tool's arguments.
    :returns: The tool's result.
    :raises ValueError: On an unknown tool.
    """
    if name not in TOOLS:
        raise ValueError("unknown tool: %s" % name)
    return TOOLS[name](data, **(args or {}))
