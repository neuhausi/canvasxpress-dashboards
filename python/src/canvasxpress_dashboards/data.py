"""Turn tabular data into the CanvasXpress data object a dashboard binds its panels to.

The numeric columns are the *measures* (``y``, one entry per column) and every other column an
*annotation* of the records (``x``). Rows are the records. That is the orientation the dashboard
templates expect (more rows than numeric columns).
"""

from __future__ import annotations

import datetime
import math
from typing import Any, Dict, List, Optional, Sequence


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    try:
        return isinstance(value, float) and math.isnan(value)
    except Exception:  # pragma: no cover - exotic scalar types
        return False


def _is_number(value: Any) -> bool:
    """A real number: ints and floats (and numpy scalars), not bool, not a string."""
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    return type(value).__module__ == "numpy" and type(value).__name__.startswith(("int", "uint", "float"))


def _plain(value: Any) -> Any:
    """A JSON-safe scalar: NaN/inf/None -> None, numpy numbers -> Python numbers."""
    if _is_missing(value):
        return None
    if hasattr(value, "item") and type(value).__module__ == "numpy":
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _text(value: Any) -> Optional[str]:
    if _is_missing(value):
        return None
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    return str(value)


def _columns_from(data: Any) -> "tuple[Dict[str, List[Any]], Optional[List[Any]]]":
    """Columns (name -> values) and, if the source has meaningful row labels, those labels."""
    # pandas DataFrame (duck-typed: no import needed)
    if hasattr(data, "columns") and hasattr(data, "index") and hasattr(data, "__getitem__"):
        names = [str(c) for c in data.columns]
        cols = {name: list(data[orig]) for name, orig in zip(names, data.columns)}
        index = list(data.index)
        default = index == list(range(len(index)))
        return cols, None if default else index
    if isinstance(data, dict):
        cols = {str(k): list(v) for k, v in data.items()}
        return cols, None
    if isinstance(data, (list, tuple)) and data and all(isinstance(r, dict) for r in data):
        records = [{str(k): v for k, v in r.items()} for r in data]
        names: List[str] = []
        for record in records:
            for key in record:
                if key not in names:
                    names.append(key)
        return {n: [r.get(n) for r in records] for n in names}, None
    raise TypeError("data must be a pandas DataFrame, a dict of columns, or a list of record dicts")


def cxd_data(data: Any, id: Optional[str] = None) -> Dict[str, Any]:
    """Build a CanvasXpress data object from a DataFrame, a dict of columns or a list of records.

    :param data: A pandas ``DataFrame``, a ``dict`` of equal-length columns, or a list of dicts.
    :param id: The column holding the record names (default: the index of a DataFrame, else 1..n).
        Record names must be unique; the column is not also used as an annotation.
    :returns: ``{"y": {"vars", "smps", "data"}, "x": {...}}`` (``x`` only with annotation columns). Missing
        values are ``None``.
    :raises ValueError: On no rows, no numeric column, or missing / duplicated record names.
    """
    cols, labels = _columns_from(data)
    if not cols:
        raise ValueError("data has no columns")
    n = len(next(iter(cols.values())))
    if any(len(v) != n for v in cols.values()):
        raise ValueError("all columns must have the same length")
    if n == 0:
        raise ValueError("data has no rows")
    if id is not None:
        if id not in cols:
            raise ValueError("`id` must name a column of the data")
        names = [_text(v) for v in cols.pop(id)]
    elif labels is not None:
        names = [_text(v) for v in labels]
    else:
        names = [str(i + 1) for i in range(n)]
    if any(v is None or v == "" for v in names):
        raise ValueError("record names must not be missing or empty")
    if len(set(names)) != len(names):
        dup = [v for v in dict.fromkeys(names) if names.count(v) > 1][:3]
        raise ValueError("record names must be unique (duplicated: %s)" % ", ".join(dup))

    def numeric(values: Sequence[Any]) -> bool:
        present = [v for v in values if not _is_missing(v)]
        return bool(present) and all(_is_number(v) for v in present)

    measures = [name for name, values in cols.items() if numeric(values)]
    if not measures:
        raise ValueError("data has no numeric columns to use as measures")
    out: Dict[str, Any] = {"y": {"vars": measures, "smps": names,
                                 "data": [[_plain(v) for v in cols[m]] for m in measures]}}
    notes = [name for name in cols if name not in measures]
    if notes:
        out["x"] = {name: [_text(v) for v in cols[name]] for name in notes}
    return out
