"""Tests for the paste-R-canvasXpress-code → native panel spec path
(:mod:`cxd_server.cx_convert` + the ``/api/cx/*`` endpoints).

Gated on a working ``Rscript`` that has the ``canvasXpress`` package installed,
the same way the data-function R tests gate on ``Rscript``.
"""
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from cxd_server import create_dashboards_app
from cxd_server.store import DashboardStore
from cxd_server.functions import FunctionsConfig
from cxd_server import cx_convert


def _has_r_canvasxpress():
    if not shutil.which("Rscript"):
        return False
    try:
        proc = subprocess.run(
            ["Rscript", "-e", "suppressMessages(library(canvasXpress))"],
            capture_output=True, timeout=60)
        return proc.returncode == 0
    except Exception:
        return False


requires_r_cx = pytest.mark.skipif(
    not _has_r_canvasxpress(),
    reason="Rscript with the canvasXpress package not installed")


def _has_py_canvasxpress():
    try:
        import canvasxpress  # noqa: F401
        return True
    except Exception:
        return False


requires_py_cx = pytest.mark.skipif(
    not _has_py_canvasxpress(),
    reason="the Python canvasxpress package is not installed")


def _app(tmp_path, mode):
    return create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
        serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "datasets"),
        functions=FunctionsConfig(mode=mode, timeout=30),
    )


def _login(client, username):
    r = client.post("/auth/signup", json={"username": username, "password": "secret1"})
    assert r.status_code == 200, r.text


# A minimal, self-contained R canvasXpress chart assigned to `g`.
SNIPPET = (
    "y <- matrix(c(10,20,30,40,50,60), nrow=2, byrow=TRUE,\n"
    "            dimnames=list(c('A','B'), c('c1','c2','c3')))\n"
    "g <- canvasXpress(data=y, graphType='Bar')\n")

# The Python equivalent: a minimal CanvasXpress chart assigned to `g`.
PY_SNIPPET = (
    "from canvasxpress.canvas import CanvasXpress\n"
    "from canvasxpress.data.keypair import CXDictData\n"
    "g = CanvasXpress(\n"
    "    data=CXDictData({'y': {'vars': ['A', 'B'], 'smps': ['c1', 'c2', 'c3'],\n"
    "                           'data': [[10, 20, 30], [40, 50, 60]]}}),\n"
    "    config={'graphType': 'Bar'})\n")


# ---- unit-level (direct convert) ----

@requires_r_cx
def test_convert_extracts_native_spec():
    spec = cx_convert.convert(SNIPPET, FunctionsConfig(mode="users", timeout=30))
    assert isinstance(spec, dict)
    assert spec["config"]["graphType"] == "Bar"
    # A native CanvasXpress spec — NOT a ggplot (isGGPlot) spec.
    assert spec["config"].get("isGGPlot") is not True
    assert spec["data"]["y"]["vars"] == ["A", "B"]
    assert spec["data"]["y"]["smps"] == ["c1", "c2", "c3"]


@requires_r_cx
def test_convert_requires_g_assignment():
    # A valid chart, but assigned to the wrong name — must mention `g`.
    with pytest.raises(cx_convert.CxConvertError) as exc:
        cx_convert.convert(SNIPPET.replace("g <-", "h <-"),
                           FunctionsConfig(mode="users", timeout=30))
    assert "`g`" in str(exc.value)


@requires_r_cx
def test_convert_rejects_non_widget():
    with pytest.raises(cx_convert.CxConvertError) as exc:
        cx_convert.convert("g <- 42\n", FunctionsConfig(mode="users", timeout=30))
    assert "not a canvasXpress chart" in str(exc.value)


def test_convert_off_and_standalone_refuse():
    with pytest.raises(cx_convert.CxConvertError) as off:
        cx_convert.convert(SNIPPET, FunctionsConfig(mode="off"))
    assert off.value.status == 403
    with pytest.raises(cx_convert.CxConvertError) as remote:
        cx_convert.convert(SNIPPET,
                           FunctionsConfig(mode="users", runtime_url="http://x"))
    assert remote.value.status == 403


def test_convert_bad_input():
    with pytest.raises(cx_convert.CxConvertError):
        cx_convert.convert("   ", FunctionsConfig(mode="users"))
    with pytest.raises(cx_convert.CxConvertError) as lang:
        cx_convert.convert(SNIPPET, FunctionsConfig(mode="users"), language="python")
    assert lang.value.status == 400


# ---- endpoint-level ----

def test_endpoint_off_and_unauthenticated(tmp_path):
    client = TestClient(_app(tmp_path, "off"))
    # Unauthenticated → 401 before anything runs.
    assert client.post("/api/cx/convert", json={"code": SNIPPET}).status_code == 401
    _login(client, "alice")
    r = client.post("/api/cx/convert", json={"code": SNIPPET})
    assert r.status_code == 403 and "unavailable" in r.json()["detail"]
    status = client.get("/api/cx/status").json()
    assert status["available"] is False
    assert status["languages"] == []   # nothing offered when the runtime is off


@requires_r_cx
def test_endpoint_admin_gated_and_converts(tmp_path):
    app = _app(tmp_path, "admin")
    admin = TestClient(app)
    _login(admin, "first")          # first signup bootstraps as admin
    other = TestClient(app)
    _login(other, "second")
    assert admin.get("/api/cx/status").json()["canRun"] is True
    assert other.get("/api/cx/status").json()["canRun"] is False
    # Non-admin cannot run pasted code.
    assert other.post("/api/cx/convert", json={"code": SNIPPET}).status_code == 403
    # Admin converts and gets a native spec back.
    r = admin.post("/api/cx/convert", json={"code": SNIPPET})
    assert r.status_code == 200, r.text
    spec = r.json()["spec"]
    assert spec["config"]["graphType"] == "Bar"


# ---- Python path ----

@requires_py_cx
def test_python_convert_extracts_native_spec():
    spec = cx_convert.convert(PY_SNIPPET, FunctionsConfig(mode="users", timeout=30),
                              language="python")
    assert isinstance(spec, dict)
    assert spec["config"]["graphType"] == "Bar"
    assert spec["config"].get("isGGPlot") is not True
    assert spec["data"]["y"]["vars"] == ["A", "B"]
    assert spec["data"]["y"]["smps"] == ["c1", "c2", "c3"]


@requires_py_cx
def test_python_convert_requires_g_assignment():
    with pytest.raises(cx_convert.CxConvertError) as exc:
        cx_convert.convert(PY_SNIPPET.replace("g =", "h ="),
                           FunctionsConfig(mode="users", timeout=30), language="python")
    assert "`g`" in str(exc.value)


@requires_py_cx
def test_python_convert_rejects_non_chart():
    with pytest.raises(cx_convert.CxConvertError) as exc:
        cx_convert.convert("g = 42\n", FunctionsConfig(mode="users", timeout=30),
                           language="python")
    assert "not a CanvasXpress chart" in str(exc.value)


@requires_py_cx
def test_available_languages_includes_python():
    langs = cx_convert.available_languages(FunctionsConfig(mode="users"))
    assert "python" in langs


@requires_py_cx
def test_endpoint_converts_python(tmp_path):
    app = _app(tmp_path, "admin")
    admin = TestClient(app)
    _login(admin, "first")          # first signup bootstraps as admin
    r = admin.post("/api/cx/convert", json={"code": PY_SNIPPET, "language": "python"})
    assert r.status_code == 200, r.text
    assert r.json()["spec"]["config"]["graphType"] == "Bar"
