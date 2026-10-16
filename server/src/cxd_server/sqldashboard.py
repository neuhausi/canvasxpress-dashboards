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

from .sqlstore import normalize_sql_url
from .store import hash_password, verify_password


class SqlDashboardStore:
    """Owner-isolated users + dashboard specs on a SQL database (via SQLAlchemy)."""

    def __init__(self, url: str, engine=None):
        sa = _sqlalchemy()
        self._sa = sa
        # postgres:// -> postgresql:// (SQLAlchemy dropped the alias in 1.4).
        self._engine = engine or sa.create_engine(normalize_sql_url(url), future=True)
        metadata = sa.MetaData()
        self._users = sa.Table(
            "cxd_users",
            metadata,
            sa.Column("username", sa.Text, primary_key=True),
            sa.Column("salt", sa.LargeBinary, nullable=False),
            sa.Column("pw_hash", sa.LargeBinary, nullable=False),
            sa.Column("is_admin", sa.Integer, nullable=False, server_default=sa.text("0")),
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
            sa.Column("locked", sa.Integer, nullable=False, server_default=sa.text("0")),
            sa.Column("updated_at", sa.Text, nullable=False),
        )
        # Collaboration: viewer comment threads, and the per-dashboard Ask history.
        # Same columns, ids and ISO timestamps as the SQLite store's tables.
        self._comments = sa.Table(
            "cxd_comments",
            metadata,
            sa.Column("comment_id", sa.Text, primary_key=True),
            sa.Column("owner", sa.Text, nullable=False),
            sa.Column("dashboard_id", sa.Text, nullable=False),
            sa.Column("panel_id", sa.Text),
            sa.Column("parent_id", sa.Text),
            sa.Column("author", sa.Text, nullable=False),
            sa.Column("body", sa.Text, nullable=False),
            sa.Column("mentions", sa.Text),
            sa.Column("created_at", sa.Text, nullable=False),
            sa.Column("resolved_at", sa.Text),
            sa.Column("resolved_by", sa.Text),
        )
        sa.Index("cxd_comments_board", self._comments.c.owner, self._comments.c.dashboard_id,
                 self._comments.c.created_at)
        self._asks = sa.Table(
            "cxd_asks",
            metadata,
            sa.Column("ask_id", sa.Text, primary_key=True),
            sa.Column("owner", sa.Text, nullable=False),
            sa.Column("dashboard_id", sa.Text, nullable=False),
            sa.Column("author", sa.Text, nullable=False),
            sa.Column("question", sa.Text, nullable=False),
            sa.Column("answer", sa.Text),
            sa.Column("used", sa.Text),
            sa.Column("created_at", sa.Text, nullable=False),
        )
        sa.Index("cxd_asks_board", self._asks.c.owner, self._asks.c.dashboard_id, self._asks.c.created_at)
        metadata.create_all(self._engine)
        # Migrate tables created before is_admin / locked existed (no-op if present).
        for ddl in ("ALTER TABLE cxd_users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
                    "ALTER TABLE cxd_dashboards ADD COLUMN locked INTEGER NOT NULL DEFAULT 0"):
            try:
                with self._engine.begin() as conn:
                    conn.execute(sa.text(ddl))
            except sa.exc.SQLAlchemyError:
                pass

    # ---- users ----
    def create_user(self, username: str, password: str, is_admin: bool = False) -> bool:
        """Create a user; False if taken. ``is_admin`` persists the admin flag."""
        salt, digest = hash_password(password)
        users = self._users
        try:
            with self._engine.begin() as conn:
                conn.execute(users.insert().values(
                    username=username, salt=salt, pw_hash=digest, is_admin=1 if is_admin else 0,
                ))
            return True
        except self._sa.exc.IntegrityError:
            return False

    def is_admin(self, username: str) -> bool:
        """Return True if the user is persisted as an admin (the is_admin flag)."""
        users = self._users
        with self._engine.connect() as conn:
            row = conn.execute(
                self._sa.select(users.c.is_admin).where(users.c.username == username)
            ).first()
        return bool(row) and bool(row[0])

    def check_user(self, username: str, password: str) -> bool:
        users = self._users
        with self._engine.connect() as conn:
            row = conn.execute(
                self._sa.select(users.c.salt, users.c.pw_hash).where(users.c.username == username)
            ).first()
        return bool(row) and verify_password(password, _b(row[0]), _b(row[1]))

    def list_users(self) -> List[str]:
        """Return all usernames (sorted). Admin use — no secrets are exposed."""
        users = self._users
        with self._engine.connect() as conn:
            rows = conn.execute(
                self._sa.select(users.c.username).order_by(users.c.username)
            ).all()
        return [r[0] for r in rows]

    def set_password(self, username: str, password: str) -> bool:
        """Reset a user's password. Returns False if the user doesn't exist."""
        salt, digest = hash_password(password)
        users = self._users
        with self._engine.begin() as conn:
            result = conn.execute(
                users.update().where(users.c.username == username).values(salt=salt, pw_hash=digest)
            )
        return result.rowcount > 0

    def set_admin(self, username: str, is_admin: bool) -> bool:
        """Grant or revoke a user's admin flag. False if the user doesn't exist."""
        users = self._users
        with self._engine.begin() as conn:
            result = conn.execute(
                users.update().where(users.c.username == username).values(is_admin=1 if is_admin else 0)
            )
        return result.rowcount > 0

    def delete_user(self, username: str) -> bool:
        """Delete a user, their dashboards, and the comments and Ask history on
        those dashboards, in one transaction. False if user is absent. (Comments
        they wrote on OTHER people's dashboards stay: they are part of those
        discussions.)"""
        users, dash = self._users, self._dash
        with self._engine.begin() as conn:
            result = conn.execute(users.delete().where(users.c.username == username))
            for table in (dash, self._comments, self._asks):
                conn.execute(table.delete().where(table.c.owner == username))
        return result.rowcount > 0

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
                self._sa.select(dash.c.id, dash.c.title, dash.c.visibility, dash.c.share_token,
                               dash.c.locked, dash.c.updated_at)
                .where(dash.c.owner == owner)
                .order_by(dash.c.updated_at.desc())
            ).all()
        return [_summary_row(r) for r in rows]

    def get_summary(self, owner: str, dashboard_id: str) -> Optional[dict]:
        dash = self._dash
        with self._engine.connect() as conn:
            row = conn.execute(
                self._sa.select(dash.c.id, dash.c.title, dash.c.visibility, dash.c.share_token,
                               dash.c.locked, dash.c.updated_at)
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

    def is_locked(self, owner: str, dashboard_id: str) -> bool:
        """Return True if the dashboard is locked (protected from deletion)."""
        dash = self._dash
        with self._engine.connect() as conn:
            row = conn.execute(
                self._sa.select(dash.c.locked).where((dash.c.owner == owner) & (dash.c.id == dashboard_id))
            ).first()
        return bool(row) and bool(row[0])

    def set_locked(self, owner: str, dashboard_id: str, locked: bool) -> Optional[dict]:
        """Mark a dashboard locked/unlocked. Returns the updated summary, or None."""
        if self.get_summary(owner, dashboard_id) is None:
            return None
        dash = self._dash
        with self._engine.begin() as conn:
            conn.execute(dash.update()
                         .where((dash.c.owner == owner) & (dash.c.id == dashboard_id))
                         .values(locked=1 if locked else 0))
        return self.get_summary(owner, dashboard_id)

    def delete_dashboard(self, owner: str, dashboard_id: str) -> None:
        """Delete unconditionally; lock enforcement lives in the API layer."""
        dash = self._dash
        with self._engine.begin() as conn:
            conn.execute(dash.delete().where((dash.c.owner == owner) & (dash.c.id == dashboard_id)))

    def purge_dashboard(self, owner: str, dashboard_id: str) -> None:
        """Delete a dashboard together with its comments and Ask history in ONE
        transaction: all gone or none (no stale comments to leak into a dashboard
        later re-created under the same id)."""
        dash, comments, asks = self._dash, self._comments, self._asks
        with self._engine.begin() as conn:
            conn.execute(dash.delete().where((dash.c.owner == owner) & (dash.c.id == dashboard_id)))
            conn.execute(comments.delete().where(
                (comments.c.owner == owner) & (comments.c.dashboard_id == dashboard_id)))
            conn.execute(asks.delete().where((asks.c.owner == owner) & (asks.c.dashboard_id == dashboard_id)))

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

    # ---- comments (collaboration: viewer threads + @mentions) ----
    _COMMENT_COLS = ("comment_id", "owner", "dashboard_id", "panel_id", "parent_id",
                     "author", "body", "mentions", "created_at", "resolved_at", "resolved_by")

    @classmethod
    def _comment_row(cls, row) -> dict:
        """Map a comments row (``_COMMENT_COLS`` order) to a dict, parsing the JSON
        ``mentions`` list and the resolved flag."""
        d = dict(zip(cls._COMMENT_COLS, row))
        d["mentions"] = json.loads(d["mentions"]) if d["mentions"] else []
        d["resolved"] = d["resolved_at"] is not None
        return d

    def _comment_select(self):
        return self._sa.select(*[self._comments.c[name] for name in self._COMMENT_COLS])

    def add_comment(self, owner: str, dashboard_id: str, author: str, body: str,
                    created_at: str, panel_id: Optional[str] = None,
                    parent_id: Optional[str] = None,
                    mentions: Optional[List[str]] = None) -> dict:
        """Insert a comment (or threaded reply) on a dashboard and return it."""
        comment_id = secrets.token_urlsafe(12)
        with self._engine.begin() as conn:
            conn.execute(self._comments.insert().values(
                comment_id=comment_id, owner=owner, dashboard_id=dashboard_id, panel_id=panel_id,
                parent_id=parent_id, author=author, body=body,
                mentions=json.dumps(list(mentions)) if mentions else None, created_at=created_at))
        return self.get_comment(comment_id)

    def list_comments(self, owner: str, dashboard_id: str) -> List[dict]:
        """Every comment on a dashboard, oldest first (the API threads them)."""
        c = self._comments
        with self._engine.connect() as conn:
            rows = conn.execute(self._comment_select()
                                .where((c.c.owner == owner) & (c.c.dashboard_id == dashboard_id))
                                .order_by(c.c.created_at.asc(), c.c.comment_id.asc())).all()
        return [self._comment_row(r) for r in rows]

    def get_comment(self, comment_id: str) -> Optional[dict]:
        """One comment by id, or None."""
        with self._engine.connect() as conn:
            row = conn.execute(self._comment_select().where(self._comments.c.comment_id == comment_id)).first()
        return self._comment_row(row) if row else None

    def resolve_comment(self, comment_id: str, resolved_by: str, when: str,
                        resolved: bool = True) -> Optional[dict]:
        """Mark a comment resolved (or reopen it). Returns the updated comment, or
        None if it does not exist."""
        if self.get_comment(comment_id) is None:
            return None
        values = {"resolved_at": when, "resolved_by": resolved_by} if resolved \
            else {"resolved_at": None, "resolved_by": None}
        with self._engine.begin() as conn:
            conn.execute(self._comments.update().where(self._comments.c.comment_id == comment_id).values(**values))
        return self.get_comment(comment_id)

    def delete_comment(self, comment_id: str) -> bool:
        """Delete a comment and any replies that point at it. True if it existed."""
        c = self._comments
        with self._engine.begin() as conn:
            result = conn.execute(c.delete().where((c.c.comment_id == comment_id) | (c.c.parent_id == comment_id)))
        return result.rowcount > 0

    def delete_dashboard_comments(self, owner: str, dashboard_id: str) -> None:
        """Drop every comment on a dashboard (called when the dashboard is deleted)."""
        c = self._comments
        with self._engine.begin() as conn:
            conn.execute(c.delete().where((c.c.owner == owner) & (c.c.dashboard_id == dashboard_id)))

    # ---- view-time Q&A history (asks persist per dashboard) ----
    _ASK_COLS = ("ask_id", "owner", "dashboard_id", "author", "question",
                 "answer", "used", "created_at")

    @classmethod
    def _ask_row(cls, row) -> dict:
        """Map an asks row (``_ASK_COLS`` order) to a dict, parsing ``used``."""
        d = dict(zip(cls._ASK_COLS, row))
        d["used"] = json.loads(d["used"]) if d["used"] else []
        return d

    def _ask_select(self):
        return self._sa.select(*[self._asks.c[name] for name in self._ASK_COLS])

    def add_ask(self, owner: str, dashboard_id: str, author: str, question: str,
                answer: str, used, created_at: str) -> dict:
        """Record an answered question on a dashboard and return it."""
        ask_id = secrets.token_urlsafe(12)
        with self._engine.begin() as conn:
            conn.execute(self._asks.insert().values(
                ask_id=ask_id, owner=owner, dashboard_id=dashboard_id, author=author,
                question=question, answer=answer, used=json.dumps(used) if used else None,
                created_at=created_at))
        return self.get_ask(ask_id)

    def get_ask(self, ask_id: str) -> Optional[dict]:
        """One ask by id, or None."""
        with self._engine.connect() as conn:
            row = conn.execute(self._ask_select().where(self._asks.c.ask_id == ask_id)).first()
        return self._ask_row(row) if row else None

    def list_asks(self, owner: str, dashboard_id: str, limit: int = 50) -> List[dict]:
        """The most recent asks on a dashboard, newest first."""
        a = self._asks
        with self._engine.connect() as conn:
            rows = conn.execute(self._ask_select()
                                .where((a.c.owner == owner) & (a.c.dashboard_id == dashboard_id))
                                .order_by(a.c.created_at.desc(), a.c.ask_id.desc())
                                .limit(int(limit))).all()
        return [self._ask_row(r) for r in rows]

    def delete_ask(self, ask_id: str) -> bool:
        """Delete one ask. True if it existed."""
        with self._engine.begin() as conn:
            result = conn.execute(self._asks.delete().where(self._asks.c.ask_id == ask_id))
        return result.rowcount > 0

    def delete_dashboard_asks(self, owner: str, dashboard_id: str) -> None:
        """Drop every ask on a dashboard (called when the dashboard is deleted)."""
        a = self._asks
        with self._engine.begin() as conn:
            conn.execute(a.delete().where((a.c.owner == owner) & (a.c.dashboard_id == dashboard_id)))

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
        "locked": bool(row[4]),
        "updated_at": row[5],
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
