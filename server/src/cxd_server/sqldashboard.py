"""SQLAlchemy-backed dashboard store — the SQLite→Postgres upgrade (Phase 5.3).

A drop-in replacement for :class:`cxd_server.store.DashboardStore` with the exact
same public API and behavior, but running on any SQLAlchemy-supported database
(Postgres in production, SQLite in tests). This is what closes the 5.1/5.2
deviation: dashboards — users, specs, and *share tokens* — are relational and
queryable (``get_shared`` resolves a token across owners), so they belong in a
SQL store, not the blob-only :class:`ObjectStore`. Datasets stay pluggable
across file/S3/SQL; dashboards get first-class Postgres parity here.

The password helpers (`hash_password` / `verify_password`) are shared verbatim
with the stdlib store, so hashing behavior is identical across both backends.
SQLAlchemy is an optional ``sql`` extra, imported lazily.
"""

from __future__ import annotations

import json
import secrets
from typing import List, Optional

from .store import hash_password, verify_password


class SqlDashboardStore:
    """Owner-isolated users + dashboard specs on a SQL database (via SQLAlchemy)."""

    def __init__(self, url: str, engine=None):
        sa = _sqlalchemy()
        self._sa = sa
        self._engine = engine or sa.create_engine(url, future=True)
        metadata = sa.MetaData()
        self._users = sa.Table(
            "cxd_users",
            metadata,
            sa.Column("username", sa.Text, primary_key=True),
            sa.Column("salt", sa.LargeBinary, nullable=False),
            sa.Column("pw_hash", sa.LargeBinary, nullable=False),
        )
        self._dash = sa.Table(
            "cxd_dashboards",
            metadata,
            sa.Column("owner", sa.Text, primary_key=True),
            sa.Column("id", sa.Text, primary_key=True),
            sa.Column("title", sa.Text),
            sa.Column("spec", sa.Text, nullable=False),
            sa.Column("visibility", sa.Text, nullable=False, default="private"),
            sa.Column("share_token", sa.Text, unique=True),
            sa.Column("updated_at", sa.Text, nullable=False),
        )
        metadata.create_all(self._engine)

    # ---- users ----
    def create_user(self, username: str, password: str) -> bool:
        salt, digest = hash_password(password)
        users = self._users
        try:
            with self._engine.begin() as conn:
                conn.execute(users.insert().values(username=username, salt=salt, pw_hash=digest))
            return True
        except self._sa.exc.IntegrityError:
            return False

    def check_user(self, username: str, password: str) -> bool:
        users = self._users
        with self._engine.connect() as conn:
            row = conn.execute(
                self._sa.select(users.c.salt, users.c.pw_hash).where(users.c.username == username)
            ).first()
        return bool(row) and verify_password(password, _b(row[0]), _b(row[1]))

    # ---- dashboards ----
    def save_dashboard(self, owner: str, spec: dict, updated_at: str) -> dict:
        dashboard_id = spec.get("id")
        if not dashboard_id:
            raise ValueError("spec.id is required")
        title = spec.get("title")
        spec_json = json.dumps(spec)
        dash = self._dash
        with self._engine.begin() as conn:
            exists = conn.execute(
                self._sa.select(dash.c.id).where((dash.c.owner == owner) & (dash.c.id == dashboard_id))
            ).first()
            if exists:
                # Preserve visibility/share_token — a re-save never unshares.
                conn.execute(dash.update()
                             .where((dash.c.owner == owner) & (dash.c.id == dashboard_id))
                             .values(title=title, spec=spec_json, updated_at=updated_at))
            else:
                conn.execute(dash.insert().values(
                    owner=owner, id=dashboard_id, title=title, spec=spec_json,
                    visibility="private", share_token=None, updated_at=updated_at,
                ))
        return self.get_summary(owner, dashboard_id)

    def list_dashboards(self, owner: str) -> List[dict]:
        dash = self._dash
        with self._engine.connect() as conn:
            rows = conn.execute(
                self._sa.select(dash.c.id, dash.c.title, dash.c.visibility, dash.c.share_token, dash.c.updated_at)
                .where(dash.c.owner == owner)
                .order_by(dash.c.updated_at.desc())
            ).all()
        return [_summary_row(r) for r in rows]

    def get_summary(self, owner: str, dashboard_id: str) -> Optional[dict]:
        dash = self._dash
        with self._engine.connect() as conn:
            row = conn.execute(
                self._sa.select(dash.c.id, dash.c.title, dash.c.visibility, dash.c.share_token, dash.c.updated_at)
                .where((dash.c.owner == owner) & (dash.c.id == dashboard_id))
            ).first()
        return _summary_row(row) if row else None

    def get_dashboard(self, owner: str, dashboard_id: str) -> Optional[dict]:
        dash = self._dash
        with self._engine.connect() as conn:
            row = conn.execute(
                self._sa.select(dash.c.spec).where((dash.c.owner == owner) & (dash.c.id == dashboard_id))
            ).first()
        return json.loads(row[0]) if row else None

    def delete_dashboard(self, owner: str, dashboard_id: str) -> None:
        dash = self._dash
        with self._engine.begin() as conn:
            conn.execute(dash.delete().where((dash.c.owner == owner) & (dash.c.id == dashboard_id)))

    # ---- sharing ----
    def set_visibility(self, owner: str, dashboard_id: str, visibility: str) -> Optional[dict]:
        if visibility not in ("private", "public", "auth"):
            raise ValueError("visibility must be 'private', 'public', or 'auth'")
        if self.get_summary(owner, dashboard_id) is None:
            return None
        dash = self._dash
        with self._engine.begin() as conn:
            if visibility == "private":
                conn.execute(dash.update()
                             .where((dash.c.owner == owner) & (dash.c.id == dashboard_id))
                             .values(visibility="private", share_token=None))
            else:
                token = self._ensure_token(conn, owner, dashboard_id)
                conn.execute(dash.update()
                             .where((dash.c.owner == owner) & (dash.c.id == dashboard_id))
                             .values(visibility=visibility, share_token=token))
        return self.get_summary(owner, dashboard_id)

    def get_shared(self, token: str) -> Optional[dict]:
        dash = self._dash
        with self._engine.connect() as conn:
            row = conn.execute(
                self._sa.select(dash.c.spec, dash.c.visibility, dash.c.owner)
                .where(dash.c.share_token == token)
            ).first()
        if not row:
            return None
        return {"spec": json.loads(row[0]), "visibility": row[1], "owner": row[2]}

    # ---- helpers ----
    def _ensure_token(self, conn, owner: str, dashboard_id: str) -> str:
        dash = self._dash
        row = conn.execute(
            self._sa.select(dash.c.share_token).where((dash.c.owner == owner) & (dash.c.id == dashboard_id))
        ).first()
        if row and row[0]:
            return row[0]
        return secrets.token_urlsafe(24)


def _summary_row(row) -> dict:
    return {
        "id": row[0],
        "title": row[1],
        "visibility": row[2],
        "share_token": row[3],
        "updated_at": row[4],
    }


def _b(value) -> bytes:
    """Normalize a driver binary value (memoryview/bytes) to bytes."""
    return value.tobytes() if isinstance(value, memoryview) else bytes(value)


def _sqlalchemy():
    try:
        import sqlalchemy  # noqa: WPS433 — optional 'sql' extra, imported on demand
    except ImportError as exc:  # pragma: no cover - env-dependent
        raise RuntimeError(
            "the sql dashboard store requires SQLAlchemy (install the 'sql' extra: "
            "pip install 'canvasxpress-dashboards-server[sql]')"
        ) from exc
    return sqlalchemy


def open_dashboard_store(uri: Optional[str], db_path: Optional[str] = None):
    """Resolve a dashboard-store URI to a store, by scheme.

    ``postgres://`` / ``postgresql://`` / ``sqlite://`` → SQLAlchemy
    :class:`SqlDashboardStore`; anything else (a bare path, ``file://``, or no
    URI) → the stdlib :class:`~cxd_server.store.DashboardStore` (keeping the
    zero-dependency default). ``db_path`` is the fallback SQLite path.

    :param uri: A dashboard-store URI (e.g. ``CXD_DASHBOARD_STORE``), or None.
    :param db_path: Fallback SQLite file path for the stdlib store.
    :returns: A DashboardStore-compatible store.
    """
    from urllib.parse import urlparse
    scheme = urlparse(uri).scheme if uri else ""
    if scheme in ("postgres", "postgresql", "sqlite"):
        return SqlDashboardStore(uri)
    if scheme == "file":
        from .store import DashboardStore
        return DashboardStore(urlparse(uri).path or db_path or "dashboards.db")
    from .store import DashboardStore
    return DashboardStore(uri or db_path or "dashboards.db")
