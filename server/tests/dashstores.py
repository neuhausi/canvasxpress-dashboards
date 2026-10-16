"""Dashboard-store backends shared by the store and API tests: the stdlib SQLite
store, the SQL store on SQLite, and (when CXD_TEST_PG_URL is set, as in CI) the SQL
store on a real Postgres."""
import os

import pytest

from cxd_server.sqldashboard import SqlDashboardStore
from cxd_server.store import DashboardStore

# Set CXD_TEST_PG_URL to also run the SqlDashboardStore asserts against a real
# Postgres (the durable-deployment proof); unset → the pg param is absent.
_PG_URL = os.getenv("CXD_TEST_PG_URL")


def _stdlib_store(tmp_path):
    return DashboardStore(str(tmp_path / "dash.db"))


def _sql_store(tmp_path):
    # SQLite proves the SQL dashboard store; Postgres runs the identical code.
    return SqlDashboardStore("sqlite:///" + str(tmp_path / "sql-dash.db"))


def _pg_store(tmp_path):
    # Real Postgres. The stores use fixed table names, and the app tests also create
    # governance/grants, identities and audit tables on the same engine, so drop EVERY
    # cxd_ table first (a throwaway test database) or state leaks between tests;
    # create_all rebuilds them.
    import sqlalchemy as sa

    engine = sa.create_engine(_PG_URL, future=True)
    with engine.begin() as conn:
        for tbl in sa.inspect(conn).get_table_names():
            if tbl.startswith("cxd_"):
                conn.execute(sa.text('DROP TABLE IF EXISTS "%s" CASCADE' % tbl))
    return SqlDashboardStore(_PG_URL, engine=engine)


# Both backends run through the same asserts → SQLite↔Postgres parity. The real-
# Postgres param joins only when CXD_TEST_PG_URL is set (else absent, never red).
_PARAMS = [(_stdlib_store, "stdlib"), (_sql_store, "sql")]
if _PG_URL:
    _PARAMS.append((_pg_store, "pg"))


def backend_params():
    """``pytest.fixture(params=...)`` kwargs for a fixture that takes ``tmp_path``
    and builds a store with ``request.param(tmp_path)``."""
    return {"params": [p[0] for p in _PARAMS], "ids": [p[1] for p in _PARAMS]}

