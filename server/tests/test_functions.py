"""Data functions: the reference runtime (Python + R) and its gated endpoint."""

import shutil

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.functions import FunctionError, FunctionsConfig, functions_status, run_function
from cxd_server.store import DashboardStore

CLIN = {"y": {"vars": ["Age"], "smps": ["c1", "c2", "c3", "c4"], "data": [[61, 55, 70, None]]},
        "x": {"Arm": ["drug", "placebo", "drug", "placebo"]}}
GENES = {"y": {"vars": ["TP53", "EGFR"], "smps": ["logFC", "P"], "data": [[1.5, 0.01], [-2, 0.2]]},
         "z": {"Chr": ["17", "7"]}}

LANGS = ["python"] + (["r"] if shutil.which("Rscript") else [])
AGGREGATE = {
    "python": "result = clin.groupby('Arm', as_index=False)['Age'].mean()",
    "r": "result <- aggregate(Age ~ Arm, data = clin, FUN = mean)",
}
DERIVE = {
    "python": "g = genes.copy(); g['absFC'] = g['logFC'].abs() * params['k']; result = g",
    "r": "g <- genes; g$absFC <- abs(g$logFC) * params$k; result <- g",
}


@pytest.fixture
def config():
    return FunctionsConfig(mode="users", timeout=10)


def _run(config, language, code, inputs=None, **extra):
    payload = {"language": language, "code": code,
               "inputs": inputs if inputs is not None else {"clin": {"data": CLIN}}}
    payload.update(extra)
    return run_function(payload, config)["data"]


@pytest.mark.parametrize("language", LANGS)
def test_round_trip_keeps_ids_numbers_and_annotations(config, language):
    code = "result = clin" if language == "python" else "result <- clin"
    out = _run(config, language, code)
    assert out["y"]["smps"] == ["c1", "c2", "c3", "c4"]
    assert out["y"]["vars"] == ["Age"]
    assert out["y"]["data"] == [[61, 55, 70, None]]
    assert out["x"] == {"Arm": ["drug", "placebo", "drug", "placebo"]}


@pytest.mark.parametrize("language", LANGS)
def test_grouped_result_takes_ids_from_the_first_column(config, language):
    out = _run(config, language, AGGREGATE[language])
    assert out == {"y": {"vars": ["Age"], "smps": ["drug", "placebo"], "data": [[65.5, 55]]}}


@pytest.mark.parametrize("language", LANGS)
def test_vars_axis_inputs_params_and_vars_axis_output(config, language):
    out = _run(config, language, DERIVE[language], {"genes": {"data": GENES, "axis": "vars"}},
               params={"k": 2}, axis="vars")
    # Output kept in the scatter orientation: genes are the variables again.
    assert out["y"]["vars"] == ["TP53", "EGFR"]
    assert out["y"]["smps"] == ["logFC", "P", "absFC"]
    assert out["y"]["data"] == [[1.5, 0.01, 3], [-2, 0.2, 4]]
    assert out["z"] == {"Chr": ["17", "7"]}


@pytest.mark.parametrize("language", LANGS)
def test_errors_are_reported(config, language):
    with pytest.raises(FunctionError) as err:
        _run(config, language, "result = 1/0" if language == "python" else "stop('boom')")
    assert err.value.status == 400
    assert ("ZeroDivisionError" if language == "python" else "boom") in str(err.value)
    with pytest.raises(FunctionError, match="must assign `result`"):
        _run(config, language, "x = 1" if language == "python" else "x <- 1")


def test_contract_validation_and_limits(config):
    with pytest.raises(FunctionError, match="language"):
        run_function({"language": "julia", "code": "x"}, config)
    with pytest.raises(FunctionError, match="valid identifier"):
        run_function({"language": "python", "code": "x", "inputs": {"a-b": {"data": CLIN}}}, config)
    with pytest.raises(FunctionError) as big:
        run_function({"language": "python", "code": "x", "inputs": {"clin": {"data": CLIN}}},
                     FunctionsConfig(mode="users", max_input=10))
    assert big.value.status == 413
    with pytest.raises(FunctionError) as slow:
        _run(FunctionsConfig(mode="users", timeout=1), "python", "while True: pass")
    assert slow.value.status == 504


def test_status_reports_languages_and_isolation(config):
    status = functions_status(config)
    assert status["enabled"] is True
    assert "python" in status["languages"]
    assert isinstance(status["networkIsolation"], str)
    assert functions_status(FunctionsConfig(mode="off"))["networkIsolation"] is None


def _app(tmp_path, mode):
    return create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s", serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "datasets"),
        functions=FunctionsConfig(mode=mode, timeout=10),
    )


def _login(client, username):
    r = client.post("/auth/signup", json={"username": username, "password": "secret1"})
    assert r.status_code == 200, r.text


BODY = {"language": "python", "code": "result = clin", "inputs": {"clin": {"data": CLIN}}}


def test_endpoint_is_off_by_default(tmp_path):
    client = TestClient(_app(tmp_path, "off"))
    assert client.post("/api/functions/run", json=BODY).status_code == 401
    _login(client, "alice")
    r = client.post("/api/functions/run", json=BODY)
    assert r.status_code == 403 and "disabled" in r.json()["detail"]
    assert client.get("/api/functions/status").json()["enabled"] is False


def test_admin_mode_limits_to_admins(tmp_path):
    app = _app(tmp_path, "admin")
    admin = TestClient(app)
    _login(admin, "first")          # the first signup bootstraps as admin
    other = TestClient(app)
    _login(other, "second")
    assert admin.post("/api/functions/run", json=BODY).status_code == 200
    assert other.post("/api/functions/run", json=BODY).status_code == 403


def test_users_mode_runs_and_reports_snippet_errors(tmp_path):
    client = TestClient(_app(tmp_path, "users"))
    _login(client, "alice")
    r = client.post("/api/functions/run", json=BODY)
    assert r.status_code == 200
    assert r.json()["data"]["y"]["smps"] == ["c1", "c2", "c3", "c4"]
    bad = client.post("/api/functions/run", json=dict(BODY, code="result = nope"))
    assert bad.status_code == 400 and "NameError" in bad.json()["detail"]
