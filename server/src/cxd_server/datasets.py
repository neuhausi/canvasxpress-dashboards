"""Dataset ingestion + storage for the dashboards service (Phase 5.1).

A *dataset* is uploaded tabular data (CSV or JSON) reshaped once into a
CanvasXpress data object ``{y:{vars,smps,data}, x?}`` and stored by id in a
pluggable :class:`~cxd_server.objectstore.ObjectStore`. Panels bind to it by id
(``{kind:"dataset", id:"sales-2026"}``) and fetch it at render time with the
viewer's own permissions — the spec stays path- and credential-free.

The CSV reshape mirrors the client ``csvToCx`` (and ``canvasxpress-connectors``):
the first column becomes sample ids (``y.smps``), fully-numeric columns become
variables (``y.vars`` + ``y.data``), and the rest become per-sample string
annotations (``x``).
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
               dataset_id: Optional[str] = None) -> dict:
        """Store a reshaped CanvasXpress data object; return its summary.

        :param owner: The owning user.
        :param data: A CanvasXpress data object (already reshaped).
        :param updated_at: ISO-8601 timestamp for the summary.
        :param title: Optional human title (seeds the generated id).
        :param dataset_id: Optional explicit id (overwrites in place); generated
            when absent.
        :returns: The stored summary ``{id, title, rows, cols, updated_at}``.
        """
        dataset_id = dataset_id or _new_id(title)
        meta = _summary_meta(dataset_id, title, data, updated_at)
        if self._store_name:
            meta["store"] = self._store_name
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
    numeric = [all(_is_numeric(_cell(r, c)) for r in body) for c in range(ncols)]

    smps = [str(_cell(r, 0)) for r in body]
    vars_: List[str] = []
    data: List[List[float]] = []
    x: Dict[str, List[str]] = {}
    for col in range(1, ncols):
        if numeric[col]:
            vars_.append(header[col])
            data.append([float(_cell(r, col)) for r in body])
        else:
            x[header[col]] = [_cell(r, col) for r in body]
    out: Dict = {"y": {"vars": vars_, "smps": smps, "data": data}}
    if x:
        out["x"] = x
    return out


def rows_to_cx(obj) -> dict:
    """Reshape a JSON array of row objects into a CanvasXpress data object.

    Column order follows the first row's keys; the first column becomes sample
    ids, fully-numeric columns become variables, the rest annotations.
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
def _summary_meta(dataset_id: str, title: Optional[str], data: dict, updated_at: str) -> dict:
    y = (data or {}).get("y") or {}
    return {
        "id": dataset_id,
        "title": title or dataset_id,
        "rows": len(y.get("smps") or []),
        "cols": len(y.get("vars") or []),
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
