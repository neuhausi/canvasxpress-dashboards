"""Audit log: an append-only, tamper-evident record of who did what.

Every request the server treats as an auditable action — sign-ins, dashboard
and dataset changes, shares, share-link views, data-function runs, NL-builder
calls, admin actions, and reads of the audit log itself — is recorded as one
event::

    {seq, ts, actor, action, target, owner, outcome, status, ip, detail,
     prev_hash, hash}

* ``action`` is a semantic name (``dashboard.save``, ``function.run`` …),
  mapped from the route by :func:`action_for`; state-changing routes that are
  not mapped are still recorded under ``api.<METHOD> <route>``.
* ``outcome`` is ``ok`` (2xx/3xx), ``denied`` (401/403) or ``error`` (other).
* ``detail`` carries small, non-sensitive facts a handler adds (e.g. a
  function's language and a hash of its code). Passwords, dashboard specs,
  data and function code are never recorded.
* Rows are **hash-chained**: ``hash = sha256(prev_hash + canonical(row))``.
  Editing or deleting a row breaks the chain, which :meth:`verify` reports.

Storage lives next to the dashboards: a ``cxd_audit`` table in the same
SQLite file, or — when ``CXD_DASHBOARD_STORE`` is a SQL URL — the same
database via SQLAlchemy. ``CXD_AUDIT=off`` disables recording;
``CXD_AUDIT_RETENTION_DAYS`` (default: keep forever) prunes old rows, after
which :meth:`verify` checks the chain from the oldest remaining row.
"""

from __future__ import annotations

import csv
import datetime
import hashlib
import io
import json
import sqlite3
import threading
from typing import Any, Dict, Iterable, List, Optional, Tuple

GENESIS = "0" * 64
MAX_PAGE = 1000

# (method, route template) -> action. Reads that are not listed are not audited
# (listings, status probes, static files); every non-GET API route is.
_ACTIONS = {
    ("POST", "/auth/signup"): "auth.signup",
    ("POST", "/auth/login"): "auth.login",
    ("POST", "/auth/logout"): "auth.logout",
    ("GET", "/api/admin/users"): "admin.users.list",
    ("POST", "/api/admin/users"): "admin.user.create",
    ("POST", "/api/admin/users/{username}/password"): "admin.user.password",
    ("POST", "/api/admin/users/{username}/admin"): "admin.user.admin",
    ("DELETE", "/api/admin/users/{username}"): "admin.user.delete",
    ("POST", "/api/dashboards"): "dashboard.save",
    ("GET", "/api/dashboards/{dashboard_id}"): "dashboard.open",
    ("POST", "/api/dashboards/{dashboard_id}/lock"): "dashboard.lock",
    ("DELETE", "/api/dashboards/{dashboard_id}"): "dashboard.delete",
    ("POST", "/api/dashboards/{dashboard_id}/share"): "dashboard.share",
    ("GET", "/api/shared/{token}"): "shared.view",
    ("POST", "/api/datasets"): "dataset.create",
    ("GET", "/api/datasets/{dataset_id}"): "dataset.read",
    ("DELETE", "/api/datasets/{dataset_id}"): "dataset.delete",
    ("POST", "/api/datasets/{dataset_id}/lock"): "dataset.lock",
    ("POST", "/api/functions/run"): "function.run",
    ("POST", "/api/llm/dashboard"): "llm.dashboard",
    ("DELETE", "/api/llm/mcp-log"): "llm.mcplog.clear",
    ("GET", "/api/admin/audit"): "audit.view",
    ("GET", "/api/admin/audit/export"): "audit.export",
    ("GET", "/api/admin/audit/verify"): "audit.verify",
    ("POST", "/api/dashboards/{dashboard_id}/grants"): "dashboard.grant",
    ("POST", "/api/datasets/{dataset_id}/grants"): "dataset.grant",
    ("PUT", "/api/datasets/{dataset_id}/policy"): "dataset.policy",
    ("POST", "/api/admin/groups"): "admin.group.save",
    ("DELETE", "/api/admin/groups/{group_name}"): "admin.group.delete",
    ("POST", "/api/admin/roles"): "admin.role.save",
    ("DELETE", "/api/admin/roles/{role_name}"): "admin.role.delete",
    ("POST", "/api/admin/roles/assign"): "admin.role.assign",
    ("GET", "/api/admin/lineage"): "admin.lineage",
}

# Path parameters that name the event's target, in order of preference.
_TARGET_PARAMS = ("dashboard_id", "dataset_id", "username", "group_name", "role_name")

_FIELDS = ("seq", "ts", "actor", "action", "target", "owner", "outcome", "status", "ip",
           "detail", "prev_hash", "hash")


def action_for(method: str, route: Optional[str]) -> Optional[str]:
    """The audit action for a request, or None when it is not audited.

    :param method: HTTP method.
    :param route: The matched route template (e.g. ``/api/dashboards/{dashboard_id}``),
        or None when no route matched.
    """
    if not route:
        return None
    action = _ACTIONS.get((method.upper(), route))
    if action:
        return action
    writes = ("POST", "PUT", "PATCH", "DELETE")
    if method.upper() in writes and route.startswith(("/api/", "/auth/")):
        return "api.%s %s" % (method.upper(), route)
    return None


def target_from(path_params: Dict[str, Any]) -> Optional[str]:
    """The event target named by the route's path parameters (if any)."""
    for name in _TARGET_PARAMS:
        if path_params.get(name) is not None:
            return str(path_params[name])
    token = path_params.get("token")
    if token:
        # Share tokens are bearer secrets: keep a recognisable prefix only.
        return "share:" + str(token)[:6] + "…"
    return None


def outcome_for(status: int) -> str:
    """``ok`` for 2xx/3xx, ``denied`` for 401/403, else ``error``."""
    if status < 400:
        return "ok"
    if status in (401, 403):
        return "denied"
    return "error"


def now_iso() -> str:
    """UTC timestamp in ISO-8601 with milliseconds."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def event_hash(prev_hash: str, event: Dict[str, Any]) -> str:
    """The chained hash of one event (all fields except ``hash`` itself)."""
    body = {k: event.get(k) for k in _FIELDS if k not in ("hash", "prev_hash")}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256((prev_hash + canonical).encode("utf-8")).hexdigest()


class AuditLog:
    """Append-only, hash-chained audit events (backend-independent logic)."""

    enabled = True

    def __init__(self, retention_days: Optional[int] = None):
        self._lock = threading.Lock()
        self.retention_days = retention_days

    # --- backend hooks ----------------------------------------------------
    def _last(self, conn) -> Tuple[int, str]:  # pragma: no cover - abstract
        raise NotImplementedError

    def _insert(self, conn, row: Dict[str, Any]) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def _transaction(self):  # pragma: no cover - abstract
        raise NotImplementedError

    def _rows(self, where: str, params: List[Any], order: str,
              limit: Optional[int]) -> List[Dict[str, Any]]:  # pragma: no cover
        raise NotImplementedError

    def _prune(self, before_ts: str) -> int:  # pragma: no cover - abstract
        raise NotImplementedError

    # --- API --------------------------------------------------------------
    def record(self, action: str, actor: Optional[str] = None, target: Optional[str] = None,
               owner: Optional[str] = None, status: int = 200, ip: Optional[str] = None,
               detail: Optional[Dict[str, Any]] = None, ts: Optional[str] = None) -> Dict[str, Any]:
        """Append one event and return it (with ``seq`` and ``hash``)."""
        event = {
            "ts": ts or now_iso(), "actor": actor, "action": action, "target": target,
            "owner": owner, "outcome": outcome_for(status), "status": int(status), "ip": ip,
            "detail": json.dumps(detail, sort_keys=True, default=str) if detail else None,
        }
        with self._lock:
            with self._transaction() as conn:
                last_seq, last_hash = self._last(conn)
                event["seq"] = last_seq + 1
                event["prev_hash"] = last_hash
                event["hash"] = event_hash(last_hash, event)
                self._insert(conn, event)
        return self._public(event)

    def query(self, actor: Optional[str] = None, action: Optional[str] = None,
              target: Optional[str] = None, outcome: Optional[str] = None,
              since: Optional[str] = None, until: Optional[str] = None,
              before: Optional[int] = None, limit: int = 200) -> Dict[str, Any]:
        """Newest-first page of events matching the filters.

        ``action`` matches exactly or, when it ends in ``.``, as a prefix
        (``dashboard.`` = every dashboard action). ``before`` pages by ``seq``.

        :returns: ``{"events": [...], "next": <seq to pass as before, or None>}``.
        """
        where, params = self._filters(actor, action, target, outcome, since, until, before)
        limit = max(1, min(int(limit or 200), MAX_PAGE))
        rows = self._rows(where, params, "seq DESC", limit + 1)
        more = len(rows) > limit
        rows = rows[:limit]
        return {"events": [self._public(r) for r in rows],
                "next": rows[-1]["seq"] if more and rows else None}

    def export(self, fmt: str = "csv", **filters: Any) -> str:
        """All matching events, oldest first, as CSV or JSON lines."""
        where, params = self._filters(filters.get("actor"), filters.get("action"),
                                      filters.get("target"), filters.get("outcome"),
                                      filters.get("since"), filters.get("until"), None)
        rows = [self._public(r) for r in self._rows(where, params, "seq ASC", None)]
        if fmt == "jsonl":
            return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(_FIELDS))
        writer.writeheader()
        for r in rows:
            detail = json.dumps(r["detail"]) if r["detail"] is not None else ""
            writer.writerow(dict(r, detail=detail))
        return buf.getvalue()

    def verify(self) -> Dict[str, Any]:
        """Re-compute the hash chain.

        :returns: ``{"ok", "checked", "first_seq", "last_seq", "broken_at"}`` —
            ``broken_at`` is the first ``seq`` whose hash or link does not match.
        """
        rows = self._rows("", [], "seq ASC", None)
        prev = rows[0]["prev_hash"] if rows else GENESIS
        for row in rows:
            if row["prev_hash"] != prev or event_hash(prev, row) != row["hash"]:
                return {"ok": False, "checked": len(rows), "first_seq": rows[0]["seq"],
                        "last_seq": rows[-1]["seq"], "broken_at": row["seq"]}
            prev = row["hash"]
        return {"ok": True, "checked": len(rows), "first_seq": rows[0]["seq"] if rows else None,
                "last_seq": rows[-1]["seq"] if rows else None, "broken_at": None}

    def prune(self) -> int:
        """Delete events older than the retention window (if one is set)."""
        if not self.retention_days:
            return 0
        now = datetime.datetime.now(datetime.timezone.utc)
        cutoff = now - datetime.timedelta(days=self.retention_days)
        with self._lock:
            return self._prune(cutoff.isoformat(timespec="milliseconds"))

    # --- helpers ----------------------------------------------------------
    @staticmethod
    def _filters(actor, action, target, outcome, since, until, before) -> Tuple[str, List[Any]]:
        clauses, params = [], []
        if actor:
            clauses.append("actor = ?")
            params.append(actor)
        if action:
            if action.endswith("."):
                clauses.append("action LIKE ?")
                params.append(action.replace("%", "") + "%")
            else:
                clauses.append("action = ?")
                params.append(action)
        if target:
            clauses.append("target = ?")
            params.append(target)
        if outcome:
            clauses.append("outcome = ?")
            params.append(outcome)
        if since:
            clauses.append("ts >= ?")
            params.append(since)
        if until:
            clauses.append("ts <= ?")
            params.append(until)
        if before is not None:
            clauses.append("seq < ?")
            params.append(int(before))
        return (" WHERE " + " AND ".join(clauses)) if clauses else "", params

    @staticmethod
    def _public(row: Dict[str, Any]) -> Dict[str, Any]:
        out = {k: row.get(k) for k in _FIELDS}
        if isinstance(out["detail"], str):
            try:
                out["detail"] = json.loads(out["detail"])
            except ValueError:
                pass
        return out


class SqliteAuditLog(AuditLog):
    """The stdlib backend: a ``cxd_audit`` table in the dashboards' SQLite file."""

    def __init__(self, db_path: str, retention_days: Optional[int] = None):
        super().__init__(retention_days)
        self._conn = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS cxd_audit ("
            " seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,"
            " target TEXT, owner TEXT, outcome TEXT NOT NULL, status INTEGER NOT NULL,"
            " ip TEXT, detail TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)")
        self._conn.execute("CREATE INDEX IF NOT EXISTS cxd_audit_ts ON cxd_audit (ts)")
        self._conn.execute("CREATE INDEX IF NOT EXISTS cxd_audit_actor ON cxd_audit (actor)")

    def _transaction(self):
        conn = self._conn

        class _Tx:
            def __enter__(self_inner):
                conn.execute("BEGIN IMMEDIATE")   # serialize writers across processes
                return conn

            def __exit__(self_inner, exc_type, exc, tb):
                conn.execute("ROLLBACK" if exc_type else "COMMIT")
                return False
        return _Tx()

    def _last(self, conn) -> Tuple[int, str]:
        row = conn.execute("SELECT seq, hash FROM cxd_audit ORDER BY seq DESC LIMIT 1").fetchone()
        return (row["seq"], row["hash"]) if row else (0, GENESIS)

    def _insert(self, conn, row: Dict[str, Any]) -> None:
        sql = "INSERT INTO cxd_audit (%s) VALUES (%s)" % (
            ", ".join(_FIELDS), ", ".join("?" * len(_FIELDS)))
        conn.execute(sql, [row[k] for k in _FIELDS])

    def _rows(self, where, params, order, limit):
        sql = "SELECT * FROM cxd_audit%s ORDER BY %s" % (where, order)
        if limit:
            sql += " LIMIT %d" % int(limit)
        return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def _prune(self, before_ts: str) -> int:
        cur = self._conn.execute("DELETE FROM cxd_audit WHERE ts < ?", (before_ts,))
        return cur.rowcount


class SqlAuditLog(AuditLog):
    """The SQLAlchemy backend (Postgres in production): ``cxd_audit`` in the
    same database as the dashboards."""

    def __init__(self, url: str, retention_days: Optional[int] = None, engine=None):
        super().__init__(retention_days)
        from .sqldashboard import _sqlalchemy
        from .sqlstore import normalize_sql_url
        sa = _sqlalchemy()
        self._sa = sa
        self._engine = engine or sa.create_engine(normalize_sql_url(url), future=True)
        metadata = sa.MetaData()
        self._table = sa.Table(
            "cxd_audit", metadata,
            sa.Column("seq", sa.Integer, primary_key=True, autoincrement=False),
            sa.Column("ts", sa.Text, nullable=False, index=True),
            sa.Column("actor", sa.Text, index=True),
            sa.Column("action", sa.Text, nullable=False),
            sa.Column("target", sa.Text),
            sa.Column("owner", sa.Text),
            sa.Column("outcome", sa.Text, nullable=False),
            sa.Column("status", sa.Integer, nullable=False),
            sa.Column("ip", sa.Text),
            sa.Column("detail", sa.Text),
            sa.Column("prev_hash", sa.Text, nullable=False),
            sa.Column("hash", sa.Text, nullable=False),
        )
        metadata.create_all(self._engine)

    def _transaction(self):
        engine, sa = self._engine, self._sa

        class _Tx:
            def __enter__(self_inner):
                self_inner.ctx = engine.begin()
                conn = self_inner.ctx.__enter__()
                if engine.dialect.name == "postgresql":
                    # One writer at a time across processes keeps the chain linear.
                    conn.execute(sa.text("LOCK TABLE cxd_audit IN EXCLUSIVE MODE"))
                return conn

            def __exit__(self_inner, exc_type, exc, tb):
                return self_inner.ctx.__exit__(exc_type, exc, tb)
        return _Tx()

    def _last(self, conn) -> Tuple[int, str]:
        t = self._table
        latest = self._sa.select(t.c.seq, t.c.hash).order_by(t.c.seq.desc()).limit(1)
        row = conn.execute(latest).first()
        return (row.seq, row.hash) if row else (0, GENESIS)

    def _insert(self, conn, row: Dict[str, Any]) -> None:
        conn.execute(self._table.insert().values(**{k: row[k] for k in _FIELDS}))

    def _rows(self, where, params, order, limit):
        # Translate the shared "?"-placeholder filter into bound parameters.
        names = {}
        parts = where.split("?")
        sql = parts[0]
        for i, part in enumerate(parts[1:]):
            names["p%d" % i] = params[i]
            sql += ":p%d" % i + part
        text = "SELECT * FROM cxd_audit%s ORDER BY %s" % (sql, order)
        if limit:
            text += " LIMIT %d" % int(limit)
        with self._engine.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(self._sa.text(text), names)]

    def _prune(self, before_ts: str) -> int:
        with self._engine.begin() as conn:
            return conn.execute(self._table.delete().where(self._table.c.ts < before_ts)).rowcount


class NullAuditLog(AuditLog):
    """``CXD_AUDIT=off``: records nothing; queries return nothing."""

    enabled = False

    def record(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        return {}

    def _rows(self, where, params, order, limit):
        return []

    def prune(self) -> int:
        return 0


def open_audit_log(dashboard_store_uri: Optional[str], db_path: Optional[str],
                   mode: Optional[str] = None, retention_days: Optional[int] = None) -> AuditLog:
    """Resolve the audit log next to the dashboard store (see module doc).

    :param dashboard_store_uri: ``CXD_DASHBOARD_STORE`` (a SQL URL selects the
        SQLAlchemy backend), or None.
    :param db_path: The dashboards' SQLite file (stdlib backend).
    :param mode: ``CXD_AUDIT`` — ``off`` disables recording.
    :param retention_days: Prune events older than this (None keeps all).
    """
    if (mode or "on").strip().lower() in ("off", "0", "false", "no"):
        return NullAuditLog()
    from urllib.parse import urlparse
    scheme = urlparse(dashboard_store_uri).scheme if dashboard_store_uri else ""
    if scheme in ("postgres", "postgresql", "sqlite"):
        return SqlAuditLog(dashboard_store_uri, retention_days)
    path = db_path or "dashboards.db"
    if scheme == "file":
        path = urlparse(dashboard_store_uri).path or path
    elif dashboard_store_uri:
        path = dashboard_store_uri
    return SqliteAuditLog(path, retention_days)


def iter_actions() -> Iterable[str]:
    """Every mapped action name (for UIs offering an action filter)."""
    return sorted(set(_ACTIONS.values()))
