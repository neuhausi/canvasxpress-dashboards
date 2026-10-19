"""Server-side port of the dashboard ``kind:"join"`` data blend (``src/join.js``).

The browser joins two sources into one CanvasXpress data object before a panel
renders. View-time Q&A computes its answers on the server from the *spec's*
data, so it needs the same blend to answer a question that spans the joined
sources (e.g. MYC by stage when MYC and stage live in different sources).

Semantics mirror ``join.js`` (and R's ``merge()`` / SQL): ``how`` is inner /
left / right / outer, keys compare as strings, a missing key never matches, a
one-to-many match emits one row per pair, a key column named the same on both
sides is emitted once, and a clashing right column gets ``suffix`` appended.
"""
import json
from typing import Any, Dict, List, Optional

JOIN_TYPES = ("inner", "left", "right", "outer")
AXES = ("smps", "vars")


class _Table:
    """One side of a join, read as rows along an axis (smps or vars)."""

    def __init__(self, data: Any, name: str, axis: str):
        if axis not in AXES:
            raise ValueError('join axis must be "smps" or "vars" (got "%s")' % axis)
        y = data.get("y") if isinstance(data, dict) else None
        if not isinstance(y, dict) or not isinstance(y.get("smps"), list):
            raise ValueError('join input "%s" must be a CanvasXpress {y:{vars,smps,data}} object' % name)
        x = data.get("x") if isinstance(data.get("x"), dict) else {}
        z = data.get("z") if isinstance(data.get("z"), dict) else {}
        variables = y.get("vars") if isinstance(y.get("vars"), list) else []
        self.matrix = y.get("data") if isinstance(y.get("data"), list) else []
        self.axis = axis
        by_smps = axis == "smps"
        raw_ids = y["smps"] if by_smps else variables
        self.ids = [str(i) for i in raw_ids]
        self.cols = list(variables if by_smps else y["smps"])
        self.col_index = {c: i for i, c in enumerate(self.cols)}
        self.ann = x if by_smps else z
        self.ann_names = list(self.ann.keys())
        self.col_ann = z if by_smps else x
        self.by_smps = by_smps
        self.rows = len(raw_ids)

    def value(self, col: int, row: int) -> Any:
        # y.data is vars x smps: a smps-axis row is a column index, a vars-axis row a row index.
        try:
            if self.by_smps:
                return self.matrix[col][row]
            return self.matrix[row][col]
        except (IndexError, TypeError):
            return None

    def has_column(self, column: str) -> bool:
        return column == self.axis or column in self.col_index or column in self.ann

    def cell(self, column: str, row: int) -> Any:
        if column == self.axis:
            return self.ids[row]
        if column in self.col_index:
            return self.value(self.col_index[column], row)
        annotation = self.ann.get(column)
        if isinstance(annotation, list) and row < len(annotation):
            return annotation[row]
        return None


def _resolve_keys(on: Any, left: _Table, right: _Table, left_name: str, right_name: str) -> List[Dict[str, str]]:
    items = [{"left": left.axis, "right": right.axis}] if on is None else (on if isinstance(on, list) else [on])
    if not items:
        raise ValueError("join on must name at least one key")
    keys = []
    for item in items:
        if isinstance(item, str):
            keys.append({"left": item, "right": item})
        elif isinstance(item, dict) and isinstance(item.get("left"), str) and isinstance(item.get("right"), str):
            keys.append({"left": item["left"], "right": item["right"]})
        else:
            raise ValueError("join on entries must be a column name or {left, right}")
    for key in keys:
        if not left.has_column(key["left"]):
            raise ValueError('join key "%s" not found in "%s"' % (key["left"], left_name))
        if not right.has_column(key["right"]):
            raise ValueError('join key "%s" not found in "%s"' % (key["right"], right_name))
    return keys


def _row_key(table: _Table, columns: List[str], row: int) -> Optional[str]:
    parts = []
    for column in columns:
        value = table.cell(column, row)
        if value is None or value == "":
            return None
        parts.append(_js_str(value))
    return json.dumps(parts)


def _js_str(value: Any) -> str:
    """String(value) as JavaScript renders it, so 1 and 1.0 and "1" all match."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return str(value)


def _match_rows(left: _Table, right: _Table, keys: List[Dict[str, str]], how: str) -> List[Dict[str, Optional[int]]]:
    drive_right = how == "right"
    driver, other = (right, left) if drive_right else (left, right)
    driver_cols = [k["right"] if drive_right else k["left"] for k in keys]
    other_cols = [k["left"] if drive_right else k["right"] for k in keys]
    keep_driver = how != "inner"
    keep_other = how == "outer"
    index: Dict[str, List[int]] = {}
    for o in range(other.rows):
        key = _row_key(other, other_cols, o)
        if key is not None:
            index.setdefault(key, []).append(o)
    pairs: List[Dict[str, Optional[int]]] = []
    matched = set()
    for d in range(driver.rows):
        key = _row_key(driver, driver_cols, d)
        hits = index.get(key) if key is not None else None
        if hits:
            for h in hits:
                matched.add(h)
                pairs.append({"l": h, "r": d} if drive_right else {"l": d, "r": h})
        elif keep_driver:
            pairs.append({"l": None, "r": d} if drive_right else {"l": d, "r": None})
    if keep_other:
        for u in range(other.rows):
            if u not in matched:
                pairs.append({"l": None, "r": u})
    return pairs


def _plan_columns(left: _Table, right: _Table, keys: List[Dict[str, str]], suffix: str) -> Dict[str, list]:
    taken: set = set()
    cols: list = []
    ann: list = []
    coalesced = {k["right"] for k in keys
                 if k["left"] == k["right"] and k["left"] != left.axis and k["right"] != right.axis}
    for name in left.cols:
        taken.add(name)
        cols.append({"name": name, "side": "l", "source": name, "coalesce": name in coalesced})
    for name in left.ann_names:
        taken.add(name)
        ann.append({"name": name, "side": "l", "source": name, "coalesce": name in coalesced})

    def free_name(name: str) -> str:
        out = name
        while out in taken:
            out = out + suffix
        taken.add(out)
        return out

    for name in right.cols:
        if name not in coalesced:
            cols.append({"name": free_name(name), "side": "r", "source": name})
    for name in right.ann_names:
        if name not in coalesced:
            ann.append({"name": free_name(name), "side": "r", "source": name})
    return {"cols": cols, "ann": ann}


def _row_ids(pairs: list, left: _Table, right: _Table, keys: List[Dict[str, str]]) -> List[str]:
    right_key_as_id = keys[0]["right"] if len(keys) == 1 and keys[0]["left"] == left.axis else None
    bases = []
    for p in pairs:
        if p["l"] is not None:
            bases.append(left.ids[p["l"]])
        elif right_key_as_id is not None:
            bases.append(_js_str(right.cell(right_key_as_id, p["r"])))
        else:
            bases.append(right.ids[p["r"]])
    counts: Dict[str, int] = {}
    for b in bases:
        counts[b] = counts.get(b, 0) + 1
    seen: set = set()
    out = []
    for i, base in enumerate(bases):
        ident = base
        if counts[base] > 1 and pairs[i]["r"] is not None:
            ident = base + "|" + right.ids[pairs[i]["r"]]
        unique, n = ident, 2
        while unique in seen:
            unique = "%s#%d" % (ident, n)
            n += 1
        seen.add(unique)
        out.append(unique)
    return out


def _pair_value(column: dict, pair: dict, left: _Table, right: _Table) -> Any:
    if column["side"] == "l":
        value = None if pair["l"] is None else left.cell(column["source"], pair["l"])
        if value is None and column.get("coalesce") and pair["r"] is not None:
            value = right.cell(column["source"], pair["r"])
    else:
        value = None if pair["r"] is None else right.cell(column["source"], pair["r"])
    return value


def join_data(left_data: Any, right_data: Any, options: Optional[dict] = None) -> dict:
    """Join two CanvasXpress data objects; see the module docstring.

    :param options: ``on`` (key spec), ``how``, ``axis`` / ``leftAxis`` /
        ``rightAxis``, ``suffix``, ``leftName`` and ``rightName`` (for errors
        and the default suffix).
    :raises ValueError: On an unknown ``how`` / axis, a bad input, or a missing key.
    """
    options = options or {}
    left_name = options.get("leftName") or "left"
    right_name = options.get("rightName") or "right"
    how = options.get("how") or "inner"
    if how not in JOIN_TYPES:
        raise ValueError('join how must be one of %s (got "%s")' % (", ".join(JOIN_TYPES), how))
    suffix = str(options["suffix"]) if options.get("suffix") is not None else "." + right_name
    axis = options.get("axis") or "smps"
    left = _Table(left_data, left_name, options.get("leftAxis") or axis)
    right = _Table(right_data, right_name, options.get("rightAxis") or axis)
    keys = _resolve_keys(options.get("on"), left, right, left_name, right_name)
    pairs = _match_rows(left, right, keys, how)
    columns = _plan_columns(left, right, keys, suffix)
    ids = _row_ids(pairs, left, right, keys)

    col_names = [c["name"] for c in columns["cols"]]
    col_values = [[_pair_value(c, p, left, right) for p in pairs] for c in columns["cols"]]
    ann = None
    if columns["ann"]:
        ann = {c["name"]: [_pair_value(c, p, left, right) for p in pairs] for c in columns["ann"]}
    col_ann = None
    ann_keys = list(left.col_ann.keys()) + [k for k in right.col_ann.keys() if k not in left.col_ann]
    if ann_keys and columns["cols"]:
        col_ann = {}
        for name in ann_keys:
            values = []
            for c in columns["cols"]:
                table = left if c["side"] == "l" else right
                annotation = table.col_ann.get(name)
                idx = table.col_index.get(c["source"])
                value = annotation[idx] if isinstance(annotation, list) and idx is not None and idx < len(annotation) else None
                values.append(value)
            col_ann[name] = values

    if left.axis == "smps":
        out: Dict[str, Any] = {"y": {"vars": col_names, "smps": ids, "data": col_values}}
        if ann:
            out["x"] = ann
        if col_ann:
            out["z"] = col_ann
    else:
        out = {"y": {"vars": ids, "smps": col_names,
                     "data": [[values[row] for values in col_values] for row in range(len(ids))]}}
        if ann:
            out["z"] = ann
        if col_ann:
            out["x"] = col_ann
    return out
