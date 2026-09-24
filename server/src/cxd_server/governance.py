"""Governance: roles, groups, sharing with users and groups, row- and column-level
security on stored datasets, and lineage.

Principals
    ``user:<name>``, ``group:<name>``, ``*`` (any signed-in user) and
    ``anonymous`` (a share-link viewer who is not signed in). A viewer's
    principals are their user, every group they belong to, and ``*``.

Roles
    A role is a named set of permissions (:data:`PERMISSIONS`). ``viewer`` and
    ``editor`` are built in; admins define more. A role is assigned to a user or
    a group, and a user's permissions are the union of the roles assigned to
    them and to their groups. When neither the user nor any of their groups has
    a role, the default role applies (``editor`` unless configured, which keeps
    the behaviour of a server without governance). Admins have every permission.

Grants
    ``view`` or ``edit`` access to one dashboard or one dataset, given to a
    principal. The owner and admins always have full access.

Policies (row- and column-level security)
    A per-dataset policy narrows what a viewer who is neither the owner nor an
    admin receives from the server::

        {"rows": [{"field": "site",
                   "allow": {"group:site-a": ["A"], "user:bob": ["A", "B"],
                             "group:leads": "*"}}],
         "columns": [{"hide": ["patient_name"], "except": ["group:clinicians"]}]}

    Each row rule keeps only the records whose ``field`` value is allowed for
    one of the viewer's principals (``"*"`` allows every value). It fails
    closed: a viewer no principal matches, or a field the data lacks, gets no
    records. Every row rule must pass. A column rule removes the named columns
    (variables or annotations) unless the viewer holds one of the ``except``
    principals. Only data held in the server's dataset stores is protected;
    data written inline into a spec travels with the spec.

The tables live next to the dashboards: in the same SQLite file, or in the same
database as a SQL dashboard store (see :func:`open_governance`).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections import OrderedDict
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

PERMISSIONS = OrderedDict([
    ("dashboard.create", "Create dashboards and edit their own"),
    ("dataset.create", "Upload datasets"),
    ("share.grant", "Share dashboards and datasets with users and groups"),
    ("share.public", "Publish share links"),
    ("function.run", "Run R/Python data functions (when the server allows it)"),
    ("llm.use", "Use the AI dashboard builder"),
    ("schedule.create", "Schedule dataset refreshes, alerts and email subscriptions"),
])

BUILTIN_ROLES = OrderedDict([
    ("viewer", {"description": "Opens what is shared with them; creates nothing",
                "permissions": []}),
    ("editor", {"description": "Builds, uploads and shares (the default)",
                "permissions": list(PERMISSIONS)}),
])

LEVELS = ("view", "edit")
RESOURCES = ("dashboard", "dataset")
ANONYMOUS = "anonymous"
EVERYONE = "*"

_SCHEMA = [
    "CREATE TABLE IF NOT EXISTS cxd_groups ("
    " name TEXT PRIMARY KEY, description TEXT, created_at TEXT)",
    "CREATE TABLE IF NOT EXISTS cxd_group_members ("
    " grp TEXT NOT NULL, username TEXT NOT NULL, PRIMARY KEY (grp, username))",
    "CREATE TABLE IF NOT EXISTS cxd_roles ("
    " name TEXT PRIMARY KEY, description TEXT, permissions TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS cxd_role_assignments ("
    " principal TEXT PRIMARY KEY, role TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS cxd_grants ("
    " resource TEXT NOT NULL, owner TEXT NOT NULL, store TEXT NOT NULL, rid TEXT NOT NULL,"
    " principal TEXT NOT NULL, level TEXT NOT NULL,"
    " PRIMARY KEY (resource, owner, store, rid, principal))",
    "CREATE TABLE IF NOT EXISTS cxd_policies ("
    " owner TEXT NOT NULL, store TEXT NOT NULL, rid TEXT NOT NULL, policy TEXT NOT NULL,"
    " updated_at TEXT, PRIMARY KEY (owner, store, rid))",
]


class GovernanceError(ValueError):
    """A request the governance model rejects (bad name, role, level, policy)."""


# ---- database adapters (one SQL dialect: named :params, ON CONFLICT upserts) ----
class _SqliteDb:
    def __init__(self, path: str):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")

    def run(self, statements: Sequence[Tuple[str, Dict[str, Any]]]) -> None:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                for sql, params in statements:
                    self._conn.execute(sql, params)
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    def query(self, sql: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, params or {}).fetchall()]

    def execute(self, sql: str, params: Optional[Dict[str, Any]] = None) -> int:
        """Run one write statement in its own transaction; returns the rowcount."""
        with self._lock:
            return self._conn.execute(sql, params or {}).rowcount


class _SqlDb:
    def __init__(self, engine):
        from .sqldashboard import _sqlalchemy
        self._sa = _sqlalchemy()
        self._engine = engine

    def run(self, statements: Sequence[Tuple[str, Dict[str, Any]]]) -> None:
        with self._engine.begin() as conn:
            for sql, params in statements:
                conn.execute(self._sa.text(sql), params)

    def query(self, sql: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        with self._engine.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(self._sa.text(sql), params or {})]

    def execute(self, sql: str, params: Optional[Dict[str, Any]] = None) -> int:
        """Run one write statement in its own transaction; returns the rowcount."""
        with self._engine.begin() as conn:
            return conn.execute(self._sa.text(sql), params or {}).rowcount


def _check_name(kind: str, name: Any) -> str:
    name = (name or "").strip() if isinstance(name, str) else ""
    if not (1 <= len(name) <= 64) or any(c in name for c in ":*/\\"):
        raise GovernanceError("%s names are 1-64 characters without : * / \\" % kind)
    return name


class Governance:
    """Roles, groups, grants and dataset policies over one database."""

    def __init__(self, db, default_role: str = "editor"):
        self._db = db
        self.default_role = default_role if default_role else "editor"
        self._db.run([(sql, {}) for sql in _SCHEMA])

    # ---- groups ----------------------------------------------------------
    def list_groups(self) -> List[Dict[str, Any]]:
        """Every group with its members and assigned role."""
        members: Dict[str, List[str]] = {}
        for row in self._db.query("SELECT grp, username FROM cxd_group_members ORDER BY username"):
            members.setdefault(row["grp"], []).append(row["username"])
        roles = self.assignments()
        return [{"name": g["name"], "description": g["description"] or "",
                 "members": members.get(g["name"], []),
                 "role": roles.get("group:" + g["name"])}
                for g in self._db.query("SELECT * FROM cxd_groups ORDER BY name")]

    def group_names(self) -> List[str]:
        return [r["name"] for r in self._db.query("SELECT name FROM cxd_groups ORDER BY name")]

    def save_group(self, name: str, description: str = "", members: Optional[Iterable[str]] = None,
                   created_at: Optional[str] = None) -> Dict[str, Any]:
        """Create or update a group; ``members`` (when given) replaces the member list."""
        name = _check_name("Group", name)
        statements = [(
            "INSERT INTO cxd_groups (name, description, created_at) VALUES (:n, :d, :c)"
            " ON CONFLICT (name) DO UPDATE SET description = excluded.description",
            {"n": name, "d": description or "", "c": created_at})]
        if members is not None:
            statements.append(("DELETE FROM cxd_group_members WHERE grp = :n", {"n": name}))
            for user in sorted({m.strip() for m in members if isinstance(m, str) and m.strip()}):
                statements.append((
                    "INSERT INTO cxd_group_members (grp, username) VALUES (:n, :u)",
                    {"n": name, "u": user}))
        self._db.run(statements)
        return next(g for g in self.list_groups() if g["name"] == name)

    def delete_group(self, name: str) -> bool:
        if name not in self.group_names():
            return False
        principal = "group:" + name
        self._db.run([
            ("DELETE FROM cxd_groups WHERE name = :n", {"n": name}),
            ("DELETE FROM cxd_group_members WHERE grp = :n", {"n": name}),
            ("DELETE FROM cxd_role_assignments WHERE principal = :p", {"p": principal}),
            ("DELETE FROM cxd_grants WHERE principal = :p", {"p": principal}),
        ])
        return True

    def groups_of(self, username: Optional[str]) -> List[str]:
        if not username:
            return []
        rows = self._db.query(
            "SELECT grp FROM cxd_group_members WHERE username = :u ORDER BY grp", {"u": username})
        return [r["grp"] for r in rows]

    def principals_for(self, username: Optional[str]) -> List[str]:
        """The principals a viewer holds (``["anonymous"]`` when not signed in)."""
        if not username:
            return [ANONYMOUS]
        return ["user:" + username] + ["group:" + g for g in self.groups_of(username)] + [EVERYONE]

    # ---- roles -----------------------------------------------------------
    def list_roles(self) -> List[Dict[str, Any]]:
        """Built-in roles first, then custom roles."""
        out = [dict(name=name, builtin=True, **role) for name, role in BUILTIN_ROLES.items()]
        for row in self._db.query("SELECT * FROM cxd_roles ORDER BY name"):
            out.append({"name": row["name"], "builtin": False,
                        "description": row["description"] or "",
                        "permissions": _json_list(row["permissions"])})
        return out

    def role_permissions(self, role: Optional[str]) -> Optional[Set[str]]:
        for r in self.list_roles():
            if r["name"] == role:
                return set(r["permissions"])
        return None

    def save_role(self, name: str, permissions: Iterable[str],
                  description: str = "") -> Dict[str, Any]:
        name = _check_name("Role", name)
        if name in BUILTIN_ROLES:
            raise GovernanceError("'%s' is a built-in role and cannot be changed" % name)
        perms = [p for p in PERMISSIONS if p in set(permissions or [])]
        unknown = set(permissions or []) - set(PERMISSIONS)
        if unknown:
            raise GovernanceError("Unknown permission(s): %s" % ", ".join(sorted(unknown)))
        self._db.run([(
            "INSERT INTO cxd_roles (name, description, permissions) VALUES (:n, :d, :p)"
            " ON CONFLICT (name) DO UPDATE SET description = excluded.description,"
            " permissions = excluded.permissions",
            {"n": name, "d": description or "", "p": json.dumps(perms)})])
        return next(r for r in self.list_roles() if r["name"] == name)

    def delete_role(self, name: str) -> bool:
        if name in BUILTIN_ROLES:
            raise GovernanceError("'%s' is a built-in role and cannot be deleted" % name)
        if not any(r["name"] == name for r in self.list_roles()):
            return False
        self._db.run([
            ("DELETE FROM cxd_roles WHERE name = :n", {"n": name}),
            ("DELETE FROM cxd_role_assignments WHERE role = :n", {"n": name}),
        ])
        return True

    def assignments(self) -> Dict[str, str]:
        """``principal -> role`` for every assignment."""
        return {r["principal"]: r["role"]
                for r in self._db.query("SELECT principal, role FROM cxd_role_assignments")}

    def assign_role(self, principal: str, role: Optional[str]) -> None:
        """Assign ``role`` to a ``user:``/``group:`` principal (None removes it)."""
        if not (principal.startswith("user:") or principal.startswith("group:")):
            raise GovernanceError("Roles are assigned to user:<name> or group:<name>")
        if role is None or role == "":
            self._db.run([("DELETE FROM cxd_role_assignments WHERE principal = :p",
                           {"p": principal})])
            return
        if self.role_permissions(role) is None:
            raise GovernanceError("No such role '%s'" % role)
        self._db.run([(
            "INSERT INTO cxd_role_assignments (principal, role) VALUES (:p, :r)"
            " ON CONFLICT (principal) DO UPDATE SET role = excluded.role",
            {"p": principal, "r": role})])

    def roles_of(self, username: str) -> List[str]:
        """The roles in effect for a user (their own, their groups', else the default)."""
        assigned = self.assignments()
        principals = ["user:" + username] + ["group:" + g for g in self.groups_of(username)]
        roles = [assigned[p] for p in principals if p in assigned]
        return sorted(set(roles)) if roles else [self.default_role]

    def permissions_for(self, username: Optional[str], is_admin: bool = False) -> Set[str]:
        if not username:
            return set()
        if is_admin:
            return set(PERMISSIONS)
        perms: Set[str] = set()
        for role in self.roles_of(username):
            perms |= self.role_permissions(role) or set()
        return perms

    # ---- grants ----------------------------------------------------------
    def set_grant(self, resource: str, owner: str, rid: str, principal: str,
                  level: Optional[str], store: str = "") -> None:
        """Grant ``level`` on one dashboard/dataset to a principal (None revokes)."""
        if resource not in RESOURCES:
            raise GovernanceError("Unknown resource '%s'" % resource)
        if not (principal == EVERYONE or principal.startswith("user:")
                or principal.startswith("group:")):
            raise GovernanceError("Share with user:<name>, group:<name> or * (everyone)")
        key = {"r": resource, "o": owner, "s": store or "", "i": rid, "p": principal}
        if level is None or level == "":
            self._db.run([(
                "DELETE FROM cxd_grants WHERE resource = :r AND owner = :o AND store = :s"
                " AND rid = :i AND principal = :p", key)])
            return
        if level not in LEVELS:
            raise GovernanceError("Level must be 'view' or 'edit'")
        self._db.run([(
            "INSERT INTO cxd_grants (resource, owner, store, rid, principal, level)"
            " VALUES (:r, :o, :s, :i, :p, :l)"
            " ON CONFLICT (resource, owner, store, rid, principal)"
            " DO UPDATE SET level = excluded.level", dict(key, l=level))])

    def grants_on(self, resource: str, owner: str, rid: str,
                  store: str = "") -> List[Dict[str, str]]:
        rows = self._db.query(
            "SELECT principal, level FROM cxd_grants WHERE resource = :r AND owner = :o"
            " AND store = :s AND rid = :i ORDER BY principal",
            {"r": resource, "o": owner, "s": store or "", "i": rid})
        return [{"principal": r["principal"], "level": r["level"]} for r in rows]

    def shared_with(self, username: str, resource: str) -> List[Dict[str, str]]:
        """Resources shared with a user (directly, through a group, or with
        everyone), with the highest level that applies; their own excluded."""
        principals = self.principals_for(username)
        params = {"r": resource, "u": username}
        marks = []
        for i, p in enumerate(principals):
            params["p%d" % i] = p
            marks.append(":p%d" % i)
        rows = self._db.query(
            "SELECT owner, store, rid, level FROM cxd_grants WHERE resource = :r"
            " AND owner <> :u AND principal IN (%s)" % ", ".join(marks), params)
        best: Dict[Tuple[str, str, str], str] = {}
        for r in rows:
            key = (r["owner"], r["store"], r["rid"])
            if best.get(key) != "edit":
                best[key] = r["level"]
        return [{"owner": o, "store": s, "id": i, "level": lvl}
                for (o, s, i), lvl in sorted(best.items())]

    def access_level(self, username: Optional[str], resource: str, owner: str, rid: str,
                     store: str = "") -> Optional[str]:
        """``edit``/``view`` from grants for a non-owner viewer, else None."""
        if not username:
            return None
        held = set(self.principals_for(username))
        level = None
        for g in self.grants_on(resource, owner, rid, store):
            if g["principal"] in held:
                if g["level"] == "edit":
                    return "edit"
                level = "view"
        return level

    # ---- policies --------------------------------------------------------
    def get_policy(self, owner: str, rid: str, store: str = "") -> Optional[Dict[str, Any]]:
        rows = self._db.query(
            "SELECT policy FROM cxd_policies WHERE owner = :o AND store = :s AND rid = :i",
            {"o": owner, "s": store or "", "i": rid})
        return json.loads(rows[0]["policy"]) if rows else None

    def set_policy(self, owner: str, rid: str, policy: Optional[Dict[str, Any]], store: str = "",
                   updated_at: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Store (or with None/empty, remove) a dataset's security policy."""
        key = {"o": owner, "s": store or "", "i": rid}
        policy = normalize_policy(policy)
        if not policy:
            self._db.run([("DELETE FROM cxd_policies WHERE owner = :o AND store = :s"
                           " AND rid = :i", key)])
            return None
        self._db.run([(
            "INSERT INTO cxd_policies (owner, store, rid, policy, updated_at)"
            " VALUES (:o, :s, :i, :p, :t) ON CONFLICT (owner, store, rid)"
            " DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at",
            dict(key, p=json.dumps(policy), t=updated_at))])
        return policy

    # ---- cleanup ---------------------------------------------------------
    def forget_resource(self, resource: str, owner: str, rid: str, store: str = "") -> None:
        key = {"r": resource, "o": owner, "s": store or "", "i": rid}
        statements = [("DELETE FROM cxd_grants WHERE resource = :r AND owner = :o"
                       " AND store = :s AND rid = :i", key)]
        if resource == "dataset":
            statements.append(("DELETE FROM cxd_policies WHERE owner = :o AND store = :s"
                               " AND rid = :i", key))
        self._db.run(statements)

    def forget_user(self, username: str) -> None:
        """Drop a deleted user's memberships, role, grants received and resources owned."""
        principal = "user:" + username
        self._db.run([
            ("DELETE FROM cxd_group_members WHERE username = :u", {"u": username}),
            ("DELETE FROM cxd_role_assignments WHERE principal = :p", {"p": principal}),
            ("DELETE FROM cxd_grants WHERE principal = :p OR owner = :u",
             {"p": principal, "u": username}),
            ("DELETE FROM cxd_policies WHERE owner = :u", {"u": username}),
        ])


# ---- policies: validation and enforcement ---------------------------------
def normalize_policy(policy: Any) -> Optional[Dict[str, Any]]:
    """Validate a policy and return it in canonical form (None when empty).

    :raises GovernanceError: On a malformed policy.
    """
    if policy is None or policy == {}:
        return None
    if not isinstance(policy, dict) or set(policy) - {"rows", "columns"}:
        raise GovernanceError("A policy is {rows: [...], columns: [...]}")
    rows, columns = [], []
    for rule in policy.get("rows") or []:
        field = rule.get("field") if isinstance(rule, dict) else None
        if not isinstance(field, str) or not field:
            raise GovernanceError("Each row rule needs a 'field'")
        allow = rule.get("allow")
        if not isinstance(allow, dict):
            raise GovernanceError("Row rule '%s' needs an 'allow' map" % rule["field"])
        clean = {}
        for principal, values in allow.items():
            if values == "*":
                clean[str(principal)] = "*"
            elif isinstance(values, list):
                clean[str(principal)] = [str(v) for v in values]
            else:
                raise GovernanceError("Allowed values are a list or \"*\"")
        rows.append({"field": rule["field"], "allow": clean})
    for rule in policy.get("columns") or []:
        hide = rule.get("hide") if isinstance(rule, dict) else None
        if not isinstance(hide, list) or not all(isinstance(h, str) for h in hide) or not hide:
            raise GovernanceError("Each column rule needs a non-empty 'hide' list")
        except_ = rule.get("except") or []
        if not isinstance(except_, list):
            raise GovernanceError("'except' is a list of principals")
        columns.append({"hide": hide, "except": [str(p) for p in except_]})
    if not rows and not columns:
        return None
    out: Dict[str, Any] = {}
    if rows:
        out["rows"] = rows
    if columns:
        out["columns"] = columns
    return out


def _allowed_values(rule: Dict[str, Any], principals: Sequence[str]) -> Optional[Set[str]]:
    """The values a viewer may see for one row rule (None = every value)."""
    allowed: Set[str] = set()
    for principal in principals:
        values = rule["allow"].get(principal)
        if values is None:
            continue
        if values == "*" or "*" in values:
            return None
        allowed.update(values)
    return allowed


def apply_policy(data: Any, policy: Optional[Dict[str, Any]], principals: Sequence[str]) -> Any:
    """Return ``data`` as the policy lets these principals see it.

    Handles both dataset shapes: a 2D table (header row + records) and a
    CanvasXpress object (records are samples; fields are sample annotations,
    and hidden columns may be variables or annotations). Any other shape is
    withheld entirely when a policy has row rules, since it cannot be filtered.
    """
    if not policy:
        return data
    held = set(principals)
    hidden: Set[str] = set()
    for rule in policy.get("columns") or []:
        if not held & set(rule.get("except") or []):
            hidden.update(rule["hide"])
    rules = [(r["field"], _allowed_values(r, principals)) for r in policy.get("rows") or []]
    if isinstance(data, list) and data and isinstance(data[0], list):
        return _apply_table(data, rules, hidden)
    if isinstance(data, dict) and isinstance(data.get("y"), dict):
        return _apply_cx(data, rules, hidden)
    return None if rules else data


def _apply_table(table: List[list], rules, hidden: Set[str]) -> List[list]:
    header = [str(h) for h in table[0]]
    body = table[1:]
    for field, allowed in rules:
        if allowed is None:
            continue
        if field not in header:
            body = []
            break
        col = header.index(field)
        body = [r for r in body if col < len(r) and str(r[col]) in allowed]
    keep = [i for i, h in enumerate(header) if h not in hidden]
    return [[table[0][i] for i in keep]] + [[r[i] if i < len(r) else None for i in keep]
                                             for r in body]


def _apply_cx(data: Dict[str, Any], rules, hidden: Set[str]) -> Dict[str, Any]:
    out = dict(data)
    y = dict(data["y"])
    smps = list(y.get("smps") or [])
    rows = [list(r) for r in (y.get("data") or [])]
    x = dict(data.get("x") or {})
    keep = list(range(len(smps)))
    for field, allowed in rules:
        if allowed is None:
            continue
        values = x.get(field)
        if not isinstance(values, list) or len(values) != len(smps):
            keep = []
            break
        keep = [i for i in keep if str(values[i]) in allowed]
    if len(keep) != len(smps):
        y["smps"] = [smps[i] for i in keep]
        rows = [[r[i] for i in keep if i < len(r)] for r in rows]
        x = {k: ([v[i] for i in keep] if isinstance(v, list) and len(v) == len(smps) else v)
             for k, v in x.items()}
    vars_ = list(y.get("vars") or [])
    if hidden & set(vars_):
        keep_v = [i for i, v in enumerate(vars_) if v not in hidden]
        y["vars"] = [vars_[i] for i in keep_v]
        rows = [rows[i] for i in keep_v if i < len(rows)]
        if isinstance(data.get("z"), dict):
            out["z"] = {k: ([v[i] for i in keep_v] if isinstance(v, list)
                            and len(v) == len(vars_) else v)
                        for k, v in data["z"].items() if k not in hidden}
    elif isinstance(data.get("z"), dict):
        out["z"] = {k: v for k, v in data["z"].items() if k not in hidden}
    y["data"] = rows
    out["y"] = y
    if "x" in data:
        out["x"] = {k: v for k, v in x.items() if k not in hidden}
    return out


# ---- lineage ----------------------------------------------------------------
def spec_sources(spec: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Describe a spec's data sources: kind, what they read, which panels use them."""
    data = spec.get("data") if isinstance(spec, dict) else None
    panels = spec.get("panels") if isinstance(spec, dict) else None
    used: Dict[str, List[str]] = {}
    for pid, panel in (panels or {}).items():
        if isinstance(panel, dict) and isinstance(panel.get("dataRef"), str):
            used.setdefault(panel["dataRef"], []).append(pid)
    out = []
    for ref, source in (data or {}).items():
        if isinstance(source, str):
            source = {"kind": "url", "url": source}
        if not isinstance(source, dict):
            continue
        kind = source.get("kind") or "inline"
        entry: Dict[str, Any] = {"ref": ref, "kind": kind, "panels": used.get(ref, [])}
        if kind == "dataset":
            entry.update(id=source.get("id"), store=source.get("store") or "",
                         owner=source.get("owner"))
        elif kind == "connector":
            entry["url"] = source.get("url")
        elif kind == "join":
            entry["inputs"] = [s for s in (source.get("left"), source.get("right")) if s]
            entry["how"] = source.get("how") or "inner"
        elif kind == "function":
            entry["inputs"] = [s for s in (source.get("inputs") or []) if isinstance(s, str)]
            entry["language"] = source.get("language")
        elif kind == "url":
            entry["url"] = source.get("url")
        out.append(entry)
    return out


def build_lineage(dashboards: Iterable[Tuple[str, Dict[str, Any]]],
                  dataset_owner: Optional[Callable[[str, str, str], str]] = None
                  ) -> Dict[str, Any]:
    """Dashboard → source lineage, plus the reverse index for stored datasets.

    :param dashboards: ``(owner, spec)`` pairs.
    :param dataset_owner: ``(dashboard_owner, store, id) -> owner`` for dataset
        sources that name no owner (defaults to the dashboard's owner).
    :returns: ``{"dashboards": [...], "datasets": [...], "connectors": [...]}``.
    """
    by_dataset: Dict[Tuple[str, str, str], List[Dict[str, str]]] = {}
    by_connector: Dict[str, List[Dict[str, str]]] = {}
    rows = []
    for owner, spec in dashboards:
        sources = spec_sources(spec)
        ref = {"owner": owner, "id": spec.get("id"), "title": spec.get("title") or spec.get("id")}
        for s in sources:
            if s["kind"] == "dataset" and s.get("id"):
                ds_owner = s.get("owner") or (dataset_owner(owner, s["store"], s["id"])
                                              if dataset_owner else owner)
                s["owner"] = ds_owner
                by_dataset.setdefault((ds_owner, s["store"], s["id"]), []).append(ref)
            elif s["kind"] == "connector" and s.get("url"):
                by_connector.setdefault(s["url"], []).append(ref)
        rows.append(dict(ref, sources=sources))
    return {
        "dashboards": rows,
        "datasets": [{"owner": o, "store": s, "id": i, "used_by": _by_ref(refs)}
                     for (o, s, i), refs in sorted(by_dataset.items())],
        "connectors": [{"url": u, "used_by": _by_ref(refs)}
                       for u, refs in sorted(by_connector.items())],
    }


def _by_ref(refs: List[Dict[str, str]]) -> List[Dict[str, str]]:
    return sorted(refs, key=lambda r: (r["owner"] or "", r["id"] or ""))


# ---- construction -------------------------------------------------------------
def open_governance(store, db_path: Optional[str] = None,
                    default_role: Optional[str] = None) -> Governance:
    """Governance next to the dashboard store: the same SQL engine, or the same
    SQLite file (``db_path`` when the store has none)."""
    engine = getattr(store, "_engine", None)
    if engine is not None:
        db = _SqlDb(engine)
    else:
        db = _SqliteDb(getattr(store, "db_path", None) or db_path or "dashboards.db")
    return Governance(db, default_role or "editor")


def _json_list(text: Optional[str]) -> List[str]:
    try:
        value = json.loads(text or "[]")
    except ValueError:
        return []
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []
