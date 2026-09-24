"""Electronic records: dashboard version history and electronic signatures.

Every save of a dashboard appends an immutable **version**: the spec as saved,
who saved it, when, and the SHA-256 of its canonical JSON. Versions are never
rewritten or deleted, not even when the dashboard is. Restoring an old version
saves it again as a new version, so the history only grows.

A **signature** binds a signer, a meaning ("Approved", …) and a time to one
version's hash. Signatures are hash-chained (each includes the previous one's
hash), so an edited, reordered or removed signature breaks the chain. The newest
one is the exception: removing it leaves a shorter but intact chain. Each signing
is also a ``dashboard.sign`` event in the audit log, which records it separately. A signature stays
tied to the exact content it was applied to: if a version's stored spec no
longer matches the hash it was signed with, the signature is reported invalid.

The tables live next to the dashboards (see :func:`cxd_server.governance.open_governance`).
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

GENESIS = "0" * 64

_SCHEMA = [
    "CREATE TABLE IF NOT EXISTS cxd_dashboard_versions ("
    " owner TEXT NOT NULL, dashboard TEXT NOT NULL, version INTEGER NOT NULL,"
    " saved_at TEXT NOT NULL, saved_by TEXT, title TEXT, spec TEXT NOT NULL,"
    " sha256 TEXT NOT NULL, note TEXT, PRIMARY KEY (owner, dashboard, version))",
    "CREATE TABLE IF NOT EXISTS cxd_signatures ("
    " seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, dashboard TEXT NOT NULL,"
    " version INTEGER NOT NULL, sha256 TEXT NOT NULL, signer TEXT NOT NULL,"
    " meaning TEXT NOT NULL, signed_at TEXT NOT NULL, method TEXT NOT NULL,"
    " prev_hash TEXT NOT NULL, hash TEXT NOT NULL)",
]


class RecordError(ValueError):
    """A request on records that cannot be honoured."""


def spec_sha256(spec: Dict[str, Any]) -> str:
    """The SHA-256 of a spec's canonical JSON (sorted keys, no spaces)."""
    text = json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def signature_hash(prev_hash: str, sig: Dict[str, Any]) -> str:
    payload = json.dumps({k: sig[k] for k in ("owner", "dashboard", "version", "sha256",
                                              "signer", "meaning", "signed_at", "method")},
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256((prev_hash + payload).encode("utf-8")).hexdigest()


class RecordStore:
    """Versions and signatures over the shared database adapter."""

    def __init__(self, db):
        self._db = db
        self._db.run([(sql, {}) for sql in _SCHEMA])

    # ---- versions ------------------------------------------------------------------
    def add_version(self, owner: str, spec: Dict[str, Any], saved_by: Optional[str],
                    saved_at: str, note: Optional[str] = None) -> Dict[str, Any]:
        """Append the spec as the dashboard's next version (skipped when the content
        is unchanged since the last one)."""
        digest = spec_sha256(spec)
        latest = self.latest(owner, spec["id"])
        if latest and latest["sha256"] == digest:
            return latest
        for _ in range(5):
            latest = self.latest(owner, spec["id"])
            version = (latest["version"] + 1) if latest else 1
            row = {"o": owner, "d": spec["id"], "v": version, "t": saved_at, "b": saved_by,
                   "ti": spec.get("title"), "s": json.dumps(spec, sort_keys=True), "h": digest,
                   "n": note}
            try:
                self._db.run([(
                    "INSERT INTO cxd_dashboard_versions (owner, dashboard, version, saved_at,"
                    " saved_by, title, spec, sha256, note)"
                    " VALUES (:o, :d, :v, :t, :b, :ti, :s, :h, :n)", row)])
                return self.version_info(owner, spec["id"], version)
            except Exception:  # noqa: BLE001 - a concurrent save took this number; retry
                continue
        raise RecordError("Could not record the version; try again")

    def latest(self, owner: str, dashboard: str) -> Optional[Dict[str, Any]]:
        rows = self._db.query(
            "SELECT version, saved_at, saved_by, title, sha256, note FROM cxd_dashboard_versions"
            " WHERE owner = :o AND dashboard = :d ORDER BY version DESC LIMIT 1",
            {"o": owner, "d": dashboard})
        return dict(rows[0]) if rows else None

    def versions(self, owner: str, dashboard: str) -> List[Dict[str, Any]]:
        rows = self._db.query(
            "SELECT version, saved_at, saved_by, title, sha256, note FROM cxd_dashboard_versions"
            " WHERE owner = :o AND dashboard = :d ORDER BY version DESC",
            {"o": owner, "d": dashboard})
        sigs = self.signatures(owner, dashboard)
        out = []
        for r in rows:
            item = dict(r)
            item["signatures"] = [s for s in sigs if s["version"] == r["version"]]
            out.append(item)
        return out

    def version_info(self, owner: str, dashboard: str, version: int) -> Optional[Dict[str, Any]]:
        rows = self._db.query(
            "SELECT version, saved_at, saved_by, title, sha256, note FROM cxd_dashboard_versions"
            " WHERE owner = :o AND dashboard = :d AND version = :v",
            {"o": owner, "d": dashboard, "v": int(version)})
        return dict(rows[0]) if rows else None

    def version_spec(self, owner: str, dashboard: str, version: int) -> Optional[Dict[str, Any]]:
        rows = self._db.query(
            "SELECT spec FROM cxd_dashboard_versions WHERE owner = :o AND dashboard = :d"
            " AND version = :v", {"o": owner, "d": dashboard, "v": int(version)})
        return json.loads(rows[0]["spec"]) if rows else None

    # ---- signatures ----------------------------------------------------------------
    def sign(self, owner: str, dashboard: str, version: int, signer: str, meaning: str,
             signed_at: str, method: str) -> Dict[str, Any]:
        info = self.version_info(owner, dashboard, version)
        if info is None:
            raise RecordError("No such version")
        for s in self.signatures(owner, dashboard):
            if s["version"] == version and s["signer"] == signer and s["meaning"] == meaning:
                raise RecordError("You already signed version %d as '%s'" % (version, meaning))
        sig = {"owner": owner, "dashboard": dashboard, "version": int(version),
               "sha256": info["sha256"], "signer": signer, "meaning": meaning,
               "signed_at": signed_at, "method": method}
        # One writer at a time keeps the chain linear (same approach as the audit log).
        for _ in range(5):
            last = self._db.query("SELECT seq, hash FROM cxd_signatures ORDER BY seq DESC LIMIT 1")
            seq = (last[0]["seq"] + 1) if last else 1
            prev = last[0]["hash"] if last else GENESIS
            row = dict(sig, seq=seq, prev_hash=prev, hash=signature_hash(prev, sig))
            try:
                self._db.run([(
                    "INSERT INTO cxd_signatures (seq, owner, dashboard, version, sha256, signer,"
                    " meaning, signed_at, method, prev_hash, hash) VALUES (:seq, :owner,"
                    " :dashboard, :version, :sha256, :signer, :meaning, :signed_at, :method,"
                    " :prev_hash, :hash)", row)])
                return row
            except Exception:  # noqa: BLE001 - another writer took this seq; retry
                continue
        raise RecordError("Could not record the signature; try again")

    def signatures(self, owner: str, dashboard: str) -> List[Dict[str, Any]]:
        rows = self._db.query(
            "SELECT * FROM cxd_signatures WHERE owner = :o AND dashboard = :d ORDER BY seq",
            {"o": owner, "d": dashboard})
        out = []
        for r in rows:
            item = dict(r)
            spec = self.version_spec(owner, dashboard, r["version"])
            item["valid"] = spec is not None and spec_sha256(spec) == r["sha256"]
            out.append(item)
        return out

    def verify_signatures(self) -> Dict[str, Any]:
        """Re-check the whole signature chain and every signed version's content."""
        prev, checked = GENESIS, 0
        for r in self._db.query("SELECT * FROM cxd_signatures ORDER BY seq"):
            if r["prev_hash"] != prev or signature_hash(prev, r) != r["hash"]:
                return {"ok": False, "checked": checked, "broken_at": r["seq"],
                        "reason": "the signature record was altered or removed"}
            spec = self.version_spec(r["owner"], r["dashboard"], r["version"])
            if spec is None or spec_sha256(spec) != r["sha256"]:
                return {"ok": False, "checked": checked, "broken_at": r["seq"],
                        "reason": "the signed version's content changed"}
            prev, checked = r["hash"], checked + 1
        return {"ok": True, "checked": checked, "broken_at": None}
