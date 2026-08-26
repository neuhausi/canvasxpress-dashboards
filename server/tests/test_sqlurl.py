"""URL handling for the SQL stores, and the launcher's store banner.

Hermetic: no database is opened and no driver is required, so these run in the
same suite that has no Postgres available. The ``postgres://`` cases are the
regression guard — SQLAlchemy dropped that dialect alias in 1.4, so a URL in the
spelling the README and ``.env.example`` document used to raise
``NoSuchModuleError`` from ``create_engine``, and CI could not see it because the
fixtures use ``postgresql://``.
"""

import cxd_server.__main__ as launcher
from cxd_server.sqlstore import normalize_sql_url


# ---- postgres:// alias ----
def test_normalize_rewrites_postgres_alias():
    assert (normalize_sql_url("postgres://u:p@host:5432/db")
            == "postgresql://u:p@host:5432/db")


def test_normalize_preserves_query_params():
    assert (normalize_sql_url("postgres://u:p@host/db?table=cxd_objects")
            == "postgresql://u:p@host/db?table=cxd_objects")


def test_normalize_leaves_other_schemes_alone():
    for url in ("postgresql://u@host/db", "sqlite:///tmp/x.db",
                "file:///tmp/objs", "s3://bucket/prefix", "", "./bare-path.db"):
        assert normalize_sql_url(url) == url


def test_normalize_does_not_touch_postgres_inside_the_url():
    # Only the scheme is rewritten — a host or database called "postgres" stays.
    assert (normalize_sql_url("postgresql://u@postgres:5432/postgres")
            == "postgresql://u@postgres:5432/postgres")


# ---- launcher banner ----
def test_redact_url_masks_the_password():
    assert (launcher._redact_url("postgresql://cxd:s3cret@db:5432/cxd")
            == "postgresql://cxd:***@db:5432/cxd")


def test_redact_url_leaves_credential_free_values_alone():
    for url in ("postgresql://db:5432/cxd", "file:///data/objs", "dashboards.db"):
        assert launcher._redact_url(url) == url


def test_banner_reports_the_configured_store_not_sqlite(monkeypatch):
    # The bug this guards: the banner printed APP_DB_PATH unconditionally, so a
    # Postgres deployment (or a typo'd variable falling back to SQLite) looked
    # identical on startup.
    monkeypatch.setenv("CXD_DASHBOARD_STORE", "postgresql://cxd:s3cret@db:5432/cxd")
    monkeypatch.setenv("CXD_DATASET_STORE", "postgresql://cxd:s3cret@db:5432/cxd?table=cxd_objects")
    monkeypatch.setenv("APP_DB_PATH", "/data/dashboards.db")
    monkeypatch.delenv("CXD_STORES", raising=False)
    dashboard, dataset = launcher._effective_stores()
    assert dashboard == "postgresql://cxd:***@db:5432/cxd"
    assert dataset == "postgresql://cxd:***@db:5432/cxd?table=cxd_objects"
    assert "s3cret" not in dashboard + dataset


def test_banner_falls_back_to_sqlite_path_when_unset(monkeypatch):
    for var in ("CXD_DASHBOARD_STORE", "CXD_DATASET_STORE", "CXD_STORES"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("APP_DB_PATH", "/data/dashboards.db")
    dashboard, dataset = launcher._effective_stores()
    assert dashboard == "sqlite /data/dashboards.db"
    assert dataset.startswith("file://")
