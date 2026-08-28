"""Dataset ingestion + storage for the dashboards service.

A *dataset* is uploaded tabular data (CSV or JSON) reshaped once into a
CanvasXpress data object ``{y:{vars,smps,data}, x?}`` and stored by id in a
pluggable :class:`~cxd_server.objectstore.ObjectStore`. Panels bind to it by id
(``{kind:"dataset", id:"sales-2026"}``) and fetch it at render time with the
viewer's own permissions — the spec stays path- and credential-free.

The CSV reshape mirrors the client ``csvToCx`` (and ``canvasxpress-connectors``):
the first column becomes sample ids (``y.smps``); a column whose non-blank cells
are all numeric becomes a variable (``y.vars`` + ``y.data``), with any missing
cells emitted as ``null``; every other column becomes a per-sample string
annotation (``x``).
"""

from __future__ import annotations

import csv
import io
import json
import re
import secrets
from typing import Dict, List, Optional

from .objectstore import ObjectStore, Summary

_SLUG_RE = re.compile(r"[^a-z0-9]+")


class DatasetStore:
    """Owner-scoped dataset storage layered on an :class:`ObjectStore`.

    Datasets are stored as a JSON-encoded CanvasXpress data object; the summary
    metadata (title, rows/cols, updated_at) rides along in the record meta.
    """

    def __init__(self, store: ObjectStore, store_name: Optional[str] = None):
        self._store = store
        self._store_name = store_name

    def create(self, owner: str, data: dict, updated_at: str, title: Optional[str] = None,
               dataset_id: Optional[str] = None, config: Optional[dict] = None) -> dict:
        """Store a reshaped CanvasXpress data object; return its summary.

        :param owner: The owning user.
        :param data: A CanvasXpress data object (already reshaped).
        :param updated_at: ISO-8601 timestamp for the summary.
        :param title: Optional human title (seeds the generated id).
        :param dataset_id: Optional explicit id (overwrites in place); generated
            when absent.
        :param config: Optional CanvasXpress graph config associated with the
            dataset (e.g. from a dropped CanvasXpress JSON), carried in the
            summary so panels can adopt it as their initial state.
        :returns: The stored summary ``{id, title, rows, cols, updated_at, config?}``.
        """
        dataset_id = dataset_id or _new_id(title)
        meta = _summary_meta(dataset_id, title, data, updated_at)
        if self._store_name:
            meta["store"] = self._store_name
        if config:
            meta["config"] = config
        blob = json.dumps(data).encode("utf-8")
        self._store.put(owner, dataset_id, blob, meta)
        return dict(meta)

    def get(self, owner: str, dataset_id: str) -> Optional[dict]:
        """Return the owner's CanvasXpress data object for ``dataset_id``, or None."""
        record = self._store.get(owner, dataset_id)
        if record is None:
            return None
        return json.loads(record.blob.decode("utf-8"))

    def list(self, owner: str) -> List[dict]:
        """List the owner's dataset summaries (newest first)."""
        return [_summary_from(s, self._store_name) for s in self._store.list(owner)]

    def delete(self, owner: str, dataset_id: str) -> None:
        """Delete the owner's dataset (no-op if absent)."""
        self._store.delete(owner, dataset_id)

    def url_for(self, owner: str, dataset_id: str) -> Optional[str]:
        """A signed/public fetch URL when the backend supports one, else None."""
        return self._store.url_for(owner, dataset_id)


def reshape_to_cx(fmt: str, content) -> dict:
    """Reshape uploaded ``content`` into a CanvasXpress data object.

    :param fmt: ``"csv"``, ``"json"``, or ``"cx"`` (JSON already in CX shape).
    :param content: CSV/JSON text, or an already-parsed object for json/cx.
    :returns: A CanvasXpress data object ``{y:{vars,smps,data}, x?}``.
    :raises ValueError: On empty/malformed input.
    """
    if fmt == "csv":
        return csv_to_cx(content if isinstance(content, str) else str(content))
    if fmt in ("json", "cx"):
        obj = content if not isinstance(content, str) else _parse_json(content)
        if isinstance(obj, list) and obj and isinstance(obj[0], list):
            return obj                    # already a tabular 2D array
        if fmt == "cx" or _looks_like_cx(obj):
            if not isinstance(obj, dict) or "y" not in obj:
                raise ValueError("CanvasXpress data must be an object with a 'y' key")
            return obj
        return rows_to_cx(obj)
    raise ValueError("unknown dataset format '%s' (expected csv, json, or cx)" % fmt)


def csv_to_cx(text: str) -> dict:
    """Parse CSV text into a CanvasXpress data object (see module docstring)."""
    rows = [r for r in csv.reader(io.StringIO(text)) if any(cell != "" for cell in r)]
    if not rows:
        raise ValueError("CSV is empty")
    header = rows[0]
    body = rows[1:]
    if not body:
        raise ValueError("CSV has no data rows")
    ncols = len(header)

    # A column is a numeric measure if every NON-BLANK cell is numeric and at
    # least one is — blanks are missing values, emitted as null (CanvasXpress
    # renders those as gaps). A single non-numeric value makes it a string
    # annotation instead. This keeps real-world columns with the odd missing
    # value plottable rather than demoting the whole column to text.
    def _is_measure(col):
        saw_number = False
        for row in body:
            cell = _cell(row, col)
            if _is_blank(cell):
                continue
            if _is_numeric(cell):
                saw_number = True
            else:
                return False
        return saw_number

    # Tabular data stays a 2D ARRAY (header row + data rows): CanvasXpress
    # accepts array-of-arrays data directly and infers orientation itself, so a
    # scatter/bar/KM config works regardless of how a pre-shaped {y:{vars,smps}}
    # object would have been oriented. Numeric cells are coerced to numbers
    # (blank -> null) so measures plot as numbers, not strings.
    measure_cols = {col for col in range(ncols) if _is_measure(col)}
    out_rows: List[list] = [list(header)]
    for r in body:
        row_out = []
        for col in range(ncols):
            cell = _cell(r, col)
            if col in measure_cols:
                row_out.append(None if _is_blank(cell) else float(cell))
            else:
                row_out.append(cell)
        out_rows.append(row_out)
    return out_rows


def rows_to_cx(obj) -> dict:
    """Reshape a JSON array of row objects into a CanvasXpress data object.

    Column order follows the first row's keys; the first column becomes sample
    ids, columns whose non-blank values are all numeric become variables (with
    missing cells as null), and the rest become annotations.
    """
    if not isinstance(obj, list) or not obj or not isinstance(obj[0], dict):
        raise ValueError("JSON dataset must be a non-empty array of row objects")
    header = list(obj[0].keys())
    if not header:
        raise ValueError("JSON dataset rows have no columns")
    body = [[row.get(k, "") for k in header] for row in obj]
    text = io.StringIO()
    writer = csv.writer(text)
    writer.writerow(header)
    writer.writerows(body)
    return csv_to_cx(text.getvalue())


# ---- helpers ----
def _summary_meta(dataset_id: str, title: Optional[str], data, updated_at: str) -> dict:
    if isinstance(data, list):        # tabular 2D array: header + data rows
        rows = max(0, len(data) - 1)
        cols = len(data[0]) if data else 0
    else:
        y = (data or {}).get("y") or {}
        rows = len(y.get("smps") or [])
        cols = len(y.get("vars") or [])
    return {
        "id": dataset_id,
        "title": title or dataset_id,
        "rows": rows,
        "cols": cols,
        "updated_at": updated_at,
    }


def _summary_from(summary: Summary, store_name: Optional[str] = None) -> dict:
    meta = dict(summary.meta or {})
    meta.setdefault("id", summary.id)
    if store_name:
        meta.setdefault("store", store_name)
    return meta


def _new_id(title: Optional[str]) -> str:
    slug = _SLUG_RE.sub("-", (title or "").strip().lower()).strip("-")
    suffix = secrets.token_hex(3)
    return (slug + "-" + suffix) if slug else ("dataset-" + suffix)


def _parse_json(text: str):
    try:
        return json.loads(text)
    except ValueError as exc:
        raise ValueError("invalid JSON: %s" % exc)


def _looks_like_cx(obj) -> bool:
    return isinstance(obj, dict) and "y" in obj


def _cell(row, col):
    return row[col] if col < len(row) else ""


def _is_blank(value) -> bool:
    """True for a missing cell (None or empty/whitespace-only string)."""
    return value is None or str(value).strip() == ""


def _is_numeric(value) -> bool:
    if value is None:
        return False
    trimmed = str(value).strip()
    if trimmed == "":
        return False
    try:
        float(trimmed)
        return True
    except ValueError:
        return False


# Query params that address the dataset itself, not annotation filters.
_RESERVED_QUERY_KEYS = frozenset({"store"})


def filter_cx_data(data: dict, filters: dict) -> dict:
    """Filter a CanvasXpress data object by sample annotations, server-side.

    Each ``filters`` entry ``name -> value`` keeps only the samples (columns)
    whose ``x[name]`` equals ``value`` (string-compared, so query strings match
    numeric annotations). Names that are not sample annotations are ignored, so
    an unknown or injected key simply narrows nothing — there is no query
    language here, only an in-memory column mask. Non-``{y}`` shapes (network,
    genome) and tabular arrays are returned unchanged.

    :param data: A CanvasXpress data object (``{y:{vars,smps,data}, x?}``).
    :param filters: Annotation ``name -> value`` equality filters.
    :returns: A new data object with non-matching samples removed (or ``data``
        unchanged when there is nothing to filter).
    """
    active = {k: v for k, v in (filters or {}).items() if k not in _RESERVED_QUERY_KEYS}
    if not active or not isinstance(data, dict):
        return data
    y = data.get("y")
    x = data.get("x")
    if not isinstance(y, dict) or not isinstance(x, dict):
        return data
    smps = y.get("smps")
    rows = y.get("data")
    if not isinstance(smps, list) or not isinstance(rows, list):
        return data

    # Only filters that name an actual sample annotation participate.
    applicable = {k: v for k, v in active.items()
                  if isinstance(x.get(k), list) and len(x[k]) == len(smps)}
    if not applicable:
        return data

    keep = []
    for i in range(len(smps)):
        if all(str(x[name][i]) == str(value) for name, value in applicable.items()):
            keep.append(i)
    if len(keep) == len(smps):
        return data   # nothing removed

    out = dict(data)
    out_y = dict(y)
    out_y["smps"] = [smps[i] for i in keep]
    out_y["data"] = [[row[i] for i in keep if i < len(row)] for row in rows]
    out["y"] = out_y
    out_x = dict(x)
    for name, values in x.items():
        if isinstance(values, list) and len(values) == len(smps):
            out_x[name] = [values[i] for i in keep]
    out["x"] = out_x
    return out
