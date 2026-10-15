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


# The tool surface exposed to the model (name -> callable(data, **args)).
TOOLS = {
    "describe": lambda data, **a: describe(data),
    "filter": lambda data, field, op, value, **a: {"rows": filter_rows(data, field, op, value)},
    "aggregate": lambda data, group_by, measure, agg="sum", **a: {"groups": aggregate(data, group_by, measure, agg)},
    "top_n": lambda data, measure, n=5, ascending=False, **a: {"top": top_n(data, measure, n, ascending)},
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
