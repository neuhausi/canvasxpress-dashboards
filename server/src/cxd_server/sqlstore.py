"""SQL object-storage backend (``postgres://`` / ``postgresql://`` / ``sqlite://``).

Phase 5.3 of the dashboards storage program. Implements the same
:class:`~cxd_server.objectstore.ObjectStore` contract on a SQL database via
SQLAlchemy Core, so it joins the shared conformance suite unchanged and is
interchangeable with the ``file://`` and ``s3://`` backends. One row per
``(owner, id)`` in a table (default ``cxd_objects``; override with a ``?table=``
query param so datasets and dashboards can share one database):

    owner  TEXT · id TEXT · meta TEXT(JSON) · blob BYTEA/BLOB · updated_at TEXT
    PRIMARY KEY (owner, id)

Because the SQL is dialect-portable (SQLAlchemy handles the ``LargeBinary`` →
``BYTEA``/``BLOB`` mapping, and ``put`` is a portable delete-then-insert
overwrite), the exact code path proven here on SQLite runs unchanged on Postgres
— the "natural SQLite→Postgres upgrade" the plan calls for. SQLAlchemy is an
optional ``sql`` extra, imported lazily.
"""

from __future__ import annotations

import json
from typing import List, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from .objectstore import ObjectStore, Record, Summary

_DEFAULT_TABLE = "cxd_objects"
_engines = {}  # url -> Engine (cached; one pool per database URL)


class SqlObjectStore(ObjectStore):
    """Owner-isolated object store backed by a SQL table (one row per object)."""

    def __init__(self, url: str, table: str = _DEFAULT_TABLE, engine=None):
        sa = _sqlalchemy()
        self._sa = sa
        self._engine = engine or _get_engine(url)
        metadata = sa.MetaData()
        self._table = sa.Table(
            table,
            metadata,
            sa.Column("owner", sa.Text, primary_key=True),
            sa.Column("id", sa.Text, primary_key=True),
            sa.Column("meta", sa.Text, nullable=False),
            sa.Column("blob", sa.LargeBinary, nullable=False),
            sa.Column("updated_at", sa.Text),
        )
        metadata.create_all(self._engine)

    def put(self, owner: str, id: str, blob: bytes, meta: Optional[dict] = None) -> Record:
        if not owner:
            raise ValueError("owner is required")
        if not id:
            raise ValueError("id is required")
        if not isinstance(blob, (bytes, bytearray)):
            raise TypeError("blob must be bytes")
        meta = dict(meta or {})
        table = self._table
        # Portable overwrite: delete the existing row, then insert (a single
        # transaction, so a reader never sees the object missing).
        with self._engine.begin() as conn:
            conn.execute(table.delete().where(
                (table.c.owner == owner) & (table.c.id == id)
            ))
            conn.execute(table.insert().values(
                owner=owner, id=id, meta=json.dumps(meta),
                blob=bytes(blob), updated_at=meta.get("updated_at"),
            ))
        return Record(owner=owner, id=id, blob=bytes(blob), meta=meta)

    def get(self, owner: str, id: str) -> Optional[Record]:
        table = self._table
        with self._engine.connect() as conn:
            row = conn.execute(
                self._sa.select(table.c.meta, table.c.blob).where(
                    (table.c.owner == owner) & (table.c.id == id)
                )
            ).first()
        if row is None:
            return None
        return Record(owner=owner, id=id, blob=_as_bytes(row[1]), meta=json.loads(row[0]))

    def list(self, owner: str) -> List[Summary]:
        table = self._table
        with self._engine.connect() as conn:
            rows = conn.execute(
                self._sa.select(table.c.id, table.c.meta)
                .where(table.c.owner == owner)
                .order_by(table.c.updated_at.desc())
            ).all()
        return [Summary(id=r[0], meta=json.loads(r[1])) for r in rows]

    def delete(self, owner: str, id: str) -> None:
        table = self._table
        with self._engine.begin() as conn:
            conn.execute(table.delete().where(
                (table.c.owner == owner) & (table.c.id == id)
            ))

    def url_for(self, owner: str, id: str) -> Optional[str]:
        # A SQL backend serves objects through the app, not a direct URL.
        return None


def store_from_uri(uri: str) -> SqlObjectStore:
    """Build a :class:`SqlObjectStore` from a URI, honoring a ``?table=`` param."""
    clean_url, table = _split_table(uri)
    return SqlObjectStore(clean_url, table=table)


def _split_table(uri: str):
    """Return ``(db_url_without_table_param, table_name)``."""
    parsed = urlparse(uri)
    params = dict(parse_qsl(parsed.query))
    table = params.pop("table", _DEFAULT_TABLE)
    clean = urlunparse(parsed._replace(query=urlencode(params)))
    return clean, table


def _get_engine(url: str):
    if url not in _engines:
        _engines[url] = _sqlalchemy().create_engine(url, future=True)
    return _engines[url]


def _sqlalchemy():
    try:
        import sqlalchemy  # noqa: WPS433 — optional 'sql' extra, imported on demand
    except ImportError as exc:  # pragma: no cover - env-dependent
        raise RuntimeError(
            "the sql backend requires SQLAlchemy (install the 'sql' extra: pip "
            "install 'canvasxpress-dashboards-server[sql]')"
        ) from exc
    return sqlalchemy


def _as_bytes(value) -> bytes:
    """Normalize a driver blob value (memoryview/str/bytes) to bytes."""
    if isinstance(value, memoryview):
        return value.tobytes()
    if isinstance(value, str):
        return value.encode("utf-8")
    return bytes(value)
