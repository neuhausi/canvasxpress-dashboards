"""Dashboard persistence store (SQLite), mirroring the ``canvasxpress-connectors``
store patterns: PBKDF2-salted passwords (never stored in plaintext), per-owner
isolation, and a single-file SQLite backend that swaps cleanly for Postgres.

Two tables:

  users        -- who can log in (username + salted PBKDF2 hash)
  dashboards   -- each owner's saved specs, one row per (owner, dashboard id),
                  with a visibility flag and an unguessable share token.

Dashboard specs are **not secrets** (they describe layout + data *references*, not
credentials — those stay in connectors), so the spec body is stored as plain JSON
text; only the share token is a generated secret. This keeps the store
dependency-light (stdlib only).
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
from typing import List, Optional

_PBKDF2_ROUNDS = 200_000


def hash_password(password: str, salt: Optional[bytes] = None):
    """Return ``(salt, digest)`` for a password using PBKDF2-HMAC-SHA256."""
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)
    return salt, digest


def verify_password(password: str, salt: bytes, expected: bytes) -> bool:
    """Constant-time check of ``password`` against a stored ``(salt, expected)``."""
    _, digest = hash_password(password, salt)
    return secrets.compare_digest(digest, expected)


class DashboardStore:
    """Owner-isolated store for users and dashboard specs."""

    def __init__(self, db_path: str):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                username  TEXT PRIMARY KEY,
                salt      BLOB NOT NULL,
                pw_hash   BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS dashboards (
                owner       TEXT NOT NULL,
                id          TEXT NOT NULL,
                title       TEXT,
                spec        TEXT NOT NULL,
                visibility  TEXT NOT NULL DEFAULT 'private',
                share_token TEXT UNIQUE,
                updated_at  TEXT NOT NULL,
                PRIMARY KEY (owner, id)
            );
            """
        )
        self._conn.commit()

    # ---- users ----
    def create_user(self, username: str, password: str) -> bool:
        """Create a user; returns False if the username is already taken."""
        salt, digest = hash_password(password)
        try:
            with self._lock:
                self._conn.execute(
                    "INSERT INTO users (username, salt, pw_hash) VALUES (?, ?, ?)",
                    (username, salt, digest),
                )
                self._conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False

    def check_user(self, username: str, password: str) -> bool:
        """Return True when the username/password pair is valid."""
        with self._lock:
            row = self._conn.execute(
                "SELECT salt, pw_hash FROM users WHERE username = ?", (username,)
            ).fetchone()
        return bool(row) and verify_password(password, row[0], row[1])

    # ---- dashboards ----
    def save_dashboard(self, owner: str, spec: dict, updated_at: str) -> dict:
        """Insert or update a dashboard, keyed by ``(owner, spec['id'])``.

        A save preserves any existing visibility/share_token so re-saving a spec
        does not silently unshare it. Returns the stored summary row.
        """
        dashboard_id = spec.get("id")
        if not dashboard_id:
            raise ValueError("spec.id is required")
        title = spec.get("title")
        spec_json = json.dumps(spec)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO dashboards (owner, id, title, spec, visibility, share_token, updated_at)
                VALUES (?, ?, ?, ?, 'private', NULL, ?)
                ON CONFLICT(owner, id) DO UPDATE SET
                    title=excluded.title, spec=excluded.spec, updated_at=excluded.updated_at
                """,
                (owner, dashboard_id, title, spec_json, updated_at),
            )
            self._conn.commit()
        return self.get_summary(owner, dashboard_id)

    def list_dashboards(self, owner: str) -> List[dict]:
        """List an owner's dashboards (summaries, newest first)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, title, visibility, share_token, updated_at "
                "FROM dashboards WHERE owner = ? ORDER BY updated_at DESC",
                (owner,),
            ).fetchall()
        return [self._summary_row(r) for r in rows]

    def get_summary(self, owner: str, dashboard_id: str) -> Optional[dict]:
        """Return an owner's dashboard summary (no spec body), or None."""
        with self._lock:
            row = self._conn.execute(
                "SELECT id, title, visibility, share_token, updated_at "
                "FROM dashboards WHERE owner = ? AND id = ?",
                (owner, dashboard_id),
            ).fetchone()
        return self._summary_row(row) if row else None

    def get_dashboard(self, owner: str, dashboard_id: str) -> Optional[dict]:
        """Return an owner's full dashboard spec, or None (owner-scoped)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT spec FROM dashboards WHERE owner = ? AND id = ?",
                (owner, dashboard_id),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def delete_dashboard(self, owner: str, dashboard_id: str) -> None:
        """Delete an owner's dashboard (no-op if absent)."""
        with self._lock:
            self._conn.execute(
                "DELETE FROM dashboards WHERE owner = ? AND id = ?", (owner, dashboard_id)
            )
            self._conn.commit()

    # ---- sharing ----
    def set_visibility(self, owner: str, dashboard_id: str, visibility: str) -> Optional[dict]:
        """Set a dashboard's visibility and manage its share token.

        ``public`` / ``auth`` mint a share token if absent; ``private`` clears it.
        Returns the updated summary, or None if the dashboard doesn't exist.
        """
        if visibility not in ("private", "public", "auth"):
            raise ValueError("visibility must be 'private', 'public', or 'auth'")
        if self.get_summary(owner, dashboard_id) is None:
            return None
        with self._lock:
            if visibility == "private":
                self._conn.execute(
                    "UPDATE dashboards SET visibility='private', share_token=NULL "
                    "WHERE owner = ? AND id = ?",
                    (owner, dashboard_id),
                )
            else:
                token = self._ensure_token(owner, dashboard_id)
                self._conn.execute(
                    "UPDATE dashboards SET visibility=?, share_token=? WHERE owner = ? AND id = ?",
                    (visibility, token, owner, dashboard_id),
                )
            self._conn.commit()
        return self.get_summary(owner, dashboard_id)

    def get_shared(self, token: str) -> Optional[dict]:
        """Resolve a share token to ``{spec, visibility, owner}`` or None.

        Returns for both ``public`` and ``auth`` visibilities; the caller enforces
        whether the viewer must be logged in.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT spec, visibility, owner FROM dashboards WHERE share_token = ?",
                (token,),
            ).fetchone()
        if not row:
            return None
        return {"spec": json.loads(row[0]), "visibility": row[1], "owner": row[2]}

    # ---- helpers ----
    def _ensure_token(self, owner: str, dashboard_id: str) -> str:
        """Return the existing share token or a freshly generated one.

        Assumes the store lock is already held.
        """
        row = self._conn.execute(
            "SELECT share_token FROM dashboards WHERE owner = ? AND id = ?",
            (owner, dashboard_id),
        ).fetchone()
        if row and row[0]:
            return row[0]
        return secrets.token_urlsafe(24)

    @staticmethod
    def _summary_row(row) -> dict:
        """Map a summary SELECT row to a dict."""
        return {
            "id": row[0],
            "title": row[1],
            "visibility": row[2],
            "share_token": row[3],
            "updated_at": row[4],
        }
