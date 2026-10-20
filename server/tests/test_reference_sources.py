"""The packaged reference-database services (cxd_server.reference_sources /
reference_services): the ``/api/<db>`` route a plain ``python -m cxd_server``
server exposes with ``CXD_REFERENCE_SOURCES=on``, and the GTEx connector-source
seeding. Uses tiny synthetic SQLite files so it needs none of the real multi-GB
reference databases.
"""

import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from cxd_server import reference_services as rs
from cxd_server import reference_sources as rsrc


def _make_gencode(path):
    """A minimal gencode.sqlite: one TP53-like gene on chr17 plus an empty GWAS
    table — enough for the gene-search and biotype-aggregate paths."""
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE genome (geneName TEXT, geneId TEXT, transcriptId TEXT, "
                "geneType TEXT, chrom TEXT, strand TEXT, exonStarts TEXT, exonEnds TEXT, "
                "cdsStart INTEGER, cdsEnd INTEGER)")
    con.execute("INSERT INTO genome VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("TP53", "ENSG001", "ENST001", "protein_coding", "chr17", "-",
                 "7668402,7675994", "7669690,7676272", 7668402, 7676272))
    con.execute("CREATE TABLE gwas (pubmedid TEXT, diseaseTrait TEXT, chrom TEXT, start INTEGER, "
                "strongestSNPRiskAllele TEXT, pValue TEXT, ORorBeta TEXT)")
    con.commit()
    con.close()


def test_enable_flag():
    assert rsrc.reference_sources_enabled({"CXD_REFERENCE_SOURCES": "on"})
    assert rsrc.reference_sources_enabled({"CXD_REFERENCE_SOURCES": "1"})
    assert not rsrc.reference_sources_enabled({})
    assert not rsrc.reference_sources_enabled({"CXD_REFERENCE_SOURCES": "off"})


def test_db_path_override(monkeypatch, tmp_path):
    monkeypatch.setenv("GENCODE_SQLITE", str(tmp_path / "gc.sqlite"))
    assert rs.db_path("gencode") == str(tmp_path / "gc.sqlite")


def test_api_db_route_serves_gencode(monkeypatch, tmp_path):
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))
    _make_gencode(str(tmp_path / "gencode.sqlite"))
    app = FastAPI()
    rsrc.install_reference_services(app)
    client = TestClient(app)

    # gene search -> a Genome graph with Genes + GWAS tracks
    r = client.get("/api/gencode", params={"gene": "TP53"})
    assert r.status_code == 200
    names = [t["name"] for t in r.json()["tracks"]]
    assert names == ["Genes", "GWAS Catalog"]
    assert r.json()["tracks"][0]["data"][0]["geneName"] == "TP53"

    # aggregate biotype overview
    r = client.get("/api/gencode", params={"source": "biotypes"})
    assert r.status_code == 200 and r.json()["y"]["vars"] == ["Genes"]


def test_unknown_db_is_404(monkeypatch, tmp_path):
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))
    app = FastAPI()
    rsrc.install_reference_services(app)
    r = TestClient(app).get("/api/bogus")
    assert r.status_code == 404


def test_absent_data_is_503(monkeypatch, tmp_path):
    """A known db with no file installed is a clear 503, not a 500."""
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))  # empty dir
    app = FastAPI()
    rsrc.install_reference_services(app)
    r = TestClient(app).get("/api/gencode", params={"gene": "TP53"})
    assert r.status_code == 503
    assert "not installed" in r.json()["detail"]


class _FakeStore:
    """Minimal connectors store standing in for cx_connectors' store."""

    def __init__(self):
        self.sources = {}

    def list_sources(self, user):
        return list(self.sources.get(user, {}))

    def get_source(self, user, name):
        return self.sources.get(user, {}).get(name)

    def save_source(self, user, name, conn_url, sql):
        self.sources.setdefault(user, {})[name] = {"conn_url": conn_url, "sql": sql}


def test_seed_gtex_sources_noop_when_db_absent(monkeypatch, tmp_path):
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))  # no gtex.sqlite
    store = _FakeStore()
    rsrc.seed_gtex_sources(store, "ann")
    assert store.list_sources("ann") == []


def test_seed_gtex_sources_registers_when_present(monkeypatch, tmp_path):
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))
    (tmp_path / "gtex.sqlite").write_bytes(b"")  # presence is all the seeder checks
    store = _FakeStore()
    rsrc.seed_gtex_sources(store, "ann")
    assert sorted(store.list_sources("ann")) == ["gtex-expression", "gtex-genes"]
    rec = store.get_source("ann", "gtex-expression")
    assert rec["conn_url"].startswith("sqlite:///file:") and "gtex.sqlite" in rec["conn_url"]
    assert ":gene" in rec["sql"]
    # idempotent: a second seed with unchanged SQL does not duplicate/rewrite
    before = dict(store.sources["ann"])
    rsrc.seed_gtex_sources(store, "ann")
    assert store.sources["ann"] == before


def test_reference_data_server_flag():
    assert rsrc.reference_data_server_enabled({"CXD_REFERENCE_DATA_SERVE": "on"})
    assert not rsrc.reference_data_server_enabled({})


def test_reference_data_server_serves_db_and_sha(monkeypatch, tmp_path):
    import hashlib
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))
    _make_gencode(str(tmp_path / "gencode.sqlite"))
    raw = (tmp_path / "gencode.sqlite").read_bytes()
    app = FastAPI()
    rsrc.install_reference_data_server(app)
    client = TestClient(app)

    r = client.get("/reference-data/gencode.sqlite")
    assert r.status_code == 200 and r.content == raw
    assert r.headers["content-type"] == "application/octet-stream"

    r = client.get("/reference-data/gencode.sqlite.sha256")
    assert r.status_code == 200
    assert r.text.split()[0] == hashlib.sha256(raw).hexdigest()
    assert (tmp_path / "gencode.sqlite.sha256").is_file()  # cached beside the db

    # not installed / path-traversal / unknown are all a clean 404
    assert client.get("/reference-data/tcga.sqlite").status_code == 404
    assert client.get("/reference-data/bogus.sqlite").status_code == 404
    assert client.get("/reference-data/..%2f..%2fetc%2fpasswd").status_code == 404


def test_reference_data_server_excludes_noncleared_dbs(monkeypatch, tmp_path):
    """A present database that is NOT in the redistributable/publish set (TCGA)
    must not be downloadable, even though it exists on disk."""
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))
    monkeypatch.delenv("CXD_REFERENCE_DATA_PUBLISH", raising=False)
    _make_gencode(str(tmp_path / "gencode.sqlite"))      # redistributable
    (tmp_path / "tcga.sqlite").write_bytes(b"")          # present but controlled-tier
    app = FastAPI()
    rsrc.install_reference_data_server(app)
    client = TestClient(app)
    assert client.get("/reference-data/gencode.sqlite").status_code == 200
    assert client.get("/reference-data/tcga.sqlite").status_code == 404
    assert client.get("/reference-data/tcga.sqlite.sha256").status_code == 404


def test_reference_data_publish_override(monkeypatch, tmp_path):
    """CXD_REFERENCE_DATA_PUBLISH overrides the default set (operator cleared terms)."""
    monkeypatch.setattr(rs, "SQLITE_DIR", str(tmp_path))
    monkeypatch.setenv("CXD_REFERENCE_DATA_PUBLISH", "tcga")
    (tmp_path / "tcga.sqlite").write_bytes(b"x")
    _make_gencode(str(tmp_path / "gencode.sqlite"))
    app = FastAPI()
    rsrc.install_reference_data_server(app)
    client = TestClient(app)
    assert client.get("/reference-data/tcga.sqlite").status_code == 200       # now allowed
    assert client.get("/reference-data/gencode.sqlite").status_code == 404    # override replaces default
