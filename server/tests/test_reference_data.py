"""The reference-data install/verify CLI (cxd_server.reference_data): status,
verify (well-formedness of a dropped file), and a checksum-verified fetch. Uses
synthetic SQLite files + a local ``file://`` base URL — no network, no real
multi-GB databases.
"""

import hashlib
import sqlite3

import pytest

from cxd_server import reference_data as rd
from cxd_server import reference_services as rs


def _make_db(path, tables):
    con = sqlite3.connect(path)
    for t in tables:
        con.execute("CREATE TABLE %s (x INTEGER)" % t)
    con.commit()
    con.close()


def test_verify_wellformed_missing_and_corrupt(monkeypatch, tmp_path):
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))
    # absent
    ok, detail = rd.verify("gencode")
    assert not ok and "not installed" in detail
    # well-formed (has the expected tables)
    _make_db(str(tmp_path / "gencode.sqlite"), rd.KNOWN_TABLES["gencode"])
    ok, detail = rd.verify("gencode")
    assert ok and detail.endswith("gencode.sqlite")
    # present but missing a table
    _make_db(str(tmp_path / "gtex.sqlite"), ("expression",))  # missing samples/json
    ok, detail = rd.verify("gtex")
    assert not ok and "missing expected tables" in detail and "samples" in detail
    # not a sqlite file at all
    (tmp_path / "wp.sqlite").write_bytes(b"this is not sqlite")
    ok, detail = rd.verify("wp")
    assert not ok and "not a valid SQLite database" in detail
    # unknown db
    ok, detail = rd.verify("nope")
    assert not ok and "unknown database" in detail


def test_status_lists_every_db(monkeypatch, tmp_path):
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))
    _make_db(str(tmp_path / "gencode.sqlite"), rd.KNOWN_TABLES["gencode"])
    rows = {r["db"]: r for r in rd.status()}
    assert set(rows) == set(rs.REFERENCE_DBS)
    assert rows["gencode"]["present"] and rows["gencode"]["ok"] and rows["gencode"]["bytes"] > 0
    assert not rows["gtex"]["present"] and rows["gtex"]["detail"] == "not installed"


def test_base_url_from_env():
    assert rd.base_url({}) is None
    assert rd.base_url({"CXD_REFERENCE_DATA_BASE_URL": "https://x/data/"}) == "https://x/data"


def test_fetch_roundtrip_with_checksum(monkeypatch, tmp_path):
    # A published artifact + its sha256 sidecar, served over file://
    published = tmp_path / "published"
    published.mkdir()
    _make_db(str(published / "gencode.sqlite"), rd.KNOWN_TABLES["gencode"])
    raw = (published / "gencode.sqlite").read_bytes()
    (published / "gencode.sqlite.sha256").write_text(
        hashlib.sha256(raw).hexdigest() + "  gencode.sqlite\n")

    dest = tmp_path / "data"
    monkeypatch.setattr(rs, "SQLITE_DIR", str(dest))
    base = published.as_uri()  # file:///.../published
    path = rd.fetch("gencode", url_base=base)
    assert path == str(dest / "gencode.sqlite")
    ok, _ = rd.verify("gencode")
    assert ok
    # no half-written leftovers
    assert not any(p.name.startswith(".gencode.") for p in dest.iterdir())


def test_fetch_detects_checksum_mismatch(monkeypatch, tmp_path):
    published = tmp_path / "published"
    published.mkdir()
    _make_db(str(published / "gencode.sqlite"), rd.KNOWN_TABLES["gencode"])
    (published / "gencode.sqlite.sha256").write_text("0" * 64 + "\n")  # wrong
    dest = tmp_path / "data"
    monkeypatch.setattr(rs, "SQLITE_DIR", str(dest))
    with pytest.raises(ValueError, match="checksum mismatch"):
        rd.fetch("gencode", url_base=published.as_uri())
    # the bad download was not left in place
    assert not (dest / "gencode.sqlite").exists()


def test_fetch_requires_base_url(monkeypatch, tmp_path):
    monkeypatch.delenv("CXD_REFERENCE_DATA_BASE_URL", raising=False)
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))
    with pytest.raises(ValueError, match="no artifact source"):
        rd.fetch("gencode")
