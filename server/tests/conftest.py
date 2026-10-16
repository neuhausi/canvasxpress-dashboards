import pytest
from dashstores import backend_params


@pytest.fixture(**backend_params())
def store(request, tmp_path):
    """A dashboard store on every backend (SQLite, SQL, + Postgres in CI)."""
    return request.param(tmp_path)
