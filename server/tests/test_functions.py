"""Data functions: the reference runtime (Python + R) and its gated endpoint."""

import importlib.util
import shutil

import pytest
from fastapi.testclient import TestClient

# The Python reference runtime runs each input through a pandas DataFrame, so it
# is only offered when pandas is importable (mirrors functions_status, and the
# `functions`/`dev` extras that install it). Skip the Python path otherwise, the
# same way the R path is gated on a working Rscript.
HAS_PANDAS = importlib.util.find_spec("pandas") is not None
requires_pandas = pytest.mark.skipif(not HAS_PANDAS, reason="pandas not installed")

import os
import platform
import socket

from cxd_server.app import create_dashboards_app
from cxd_server.functions import (FunctionError, FunctionsConfig, functions_status,
                                  harden_process, run_function, self_check)
from cxd_server.store import DashboardStore

IS_LINUX = platform.system() == "Linux"

CLIN = {"y": {"vars": ["Age"], "smps": ["c1", "c2", "c3", "c4"], "data": [[61, 55, 70, None]]},
        "x": {"Arm": ["drug", "placebo", "drug", "placebo"]}}
GENES = {"y": {"vars": ["TP53", "EGFR"], "smps": ["logFC", "P"], "data": [[1.5, 0.01], [-2, 0.2]]},
         "z": {"Chr": ["17", "7"]}}

LANGS = (["python"] if HAS_PANDAS else []) + (["r"] if shutil.which("Rscript") else [])
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


@requires_pandas
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


@requires_pandas
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


@requires_pandas
def test_admin_mode_limits_to_admins(tmp_path):
    app = _app(tmp_path, "admin")
    admin = TestClient(app)
    _login(admin, "first")          # the first signup bootstraps as admin
    other = TestClient(app)
    _login(other, "second")
    assert admin.post("/api/functions/run", json=BODY).status_code == 200
    assert other.post("/api/functions/run", json=BODY).status_code == 403


@requires_pandas
def test_admin_mode_runs_admin_dashboard_code_for_everyone(tmp_path):
    app = _app(tmp_path, "admin")
    admin = TestClient(app)
    _login(admin, "first")          # admin
    other = TestClient(app)
    _login(other, "second")
    assert admin.get("/api/functions/status").json()["canAuthor"] is True
    assert other.get("/api/functions/status").json()["canAuthor"] is False

    # Not yet in an admin's dashboard: the non-admin cannot run it.
    r = other.post("/api/functions/run", json=BODY)
    assert r.status_code == 403 and "Only administrators" in r.json()["detail"]
    spec = {"id": "fn-board", "title": "F", "layout": {"cols": 12, "items": []}, "panels": {},
            "data": {"clin": {"kind": "inline", "value": CLIN},
                     "f": {"kind": "function", "language": "python", "code": BODY["code"],
                           "inputs": ["clin"]}}}
    assert admin.post("/api/dashboards", json=spec).status_code == 200
    # Saved by the admin: the same code now runs for anyone signed in ...
    assert other.post("/api/functions/run", json=BODY).status_code == 200
    # ... but only that exact code, and only in the saved language.
    edited = dict(BODY, code=BODY["code"] + "\nresult = result.head(1)")
    assert other.post("/api/functions/run", json=edited).status_code == 403
    assert other.post("/api/functions/run", json=dict(BODY, language="r")).status_code == 403
    # A non-admin's own dashboard does not approve code.
    mine = dict(spec, id="mine")
    mine["data"] = dict(spec["data"], f=dict(spec["data"]["f"], code=edited["code"]))
    assert other.post("/api/dashboards", json=mine).status_code == 200
    assert other.post("/api/functions/run", json=edited).status_code == 403


@requires_pandas
def test_users_mode_runs_and_reports_snippet_errors(tmp_path):
    client = TestClient(_app(tmp_path, "users"))
    _login(client, "alice")
    r = client.post("/api/functions/run", json=BODY)
    assert r.status_code == 200
    assert r.json()["data"]["y"]["smps"] == ["c1", "c2", "c3", "c4"]
    bad = client.post("/api/functions/run", json=dict(BODY, code="result = nope"))
    assert bad.status_code == 400 and "NameError" in bad.json()["detail"]


# ---- hardening: /proc/<pid>/environ unreadable to snippets (Linux only) ----

def test_harden_process_sets_non_dumpable_on_linux():
    result = harden_process()
    assert result["platform"] == platform.system()
    if IS_LINUX:
        assert result["applied"] is True
        # The kernel's dumpable flag is now 0, so same-user code cannot read our
        # /proc/<pid>/environ. (This makes the pytest process non-dumpable for the
        # rest of the run, which is harmless.)
        import ctypes
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        assert libc.prctl(3, 0, 0, 0, 0) == 0   # PR_GET_DUMPABLE -> 0
    else:
        assert result["applied"] is False
        assert "Linux" in result["reason"]


# ---- isolation self-check ----

@requires_pandas
def test_self_check_reports_shape_and_skips_unset_target(config):
    report = self_check(config)
    assert report["available"] is True
    assert isinstance(report["networkIsolation"], str)
    assert "python" in report["languages"]
    for name in ("serverEnviron", "parentEnviron", "otherEnviron", "network", "fileWrite"):
        assert name in report["checks"]
    # No probe target configured -> the network check is skipped, never guessed.
    assert report["checks"]["network"] == "skipped"


@requires_pandas
def test_self_check_network_blocked_and_allowed(config):
    # A live listener on loopback: the probe reaches it (unless an OS sandbox
    # denies the network) -> "allowed"; a closed port -> "blocked". Simulates both.
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    try:
        config.probe_target = "127.0.0.1:%d" % port
        allowed = self_check(config)["checks"]["network"]
    finally:
        listener.close()
    config.probe_target = "127.0.0.1:%d" % port   # now closed
    blocked = self_check(config)["checks"]["network"]
    # When no network isolation is in effect the open port is reachable; when a
    # wrapper denies the network both are "blocked". Either way the closed port
    # is never "allowed", and an isolation-free host distinguishes the two.
    if config.isolation() == "none":
        assert allowed == "allowed"
    assert blocked == "blocked"


@requires_pandas
def test_self_check_server_environ_blocked_after_hardening(config):
    # Only meaningful on Linux with /proc; the probe reads /proc/<server pid>/environ.
    if not IS_LINUX:
        assert self_check(config)["checks"]["serverEnviron"] == "unknown"
        return
    # Before hardening a child can read this (dumpable) process's environ ...
    before = self_check(config)["checks"]["serverEnviron"]
    harden_process()
    # ... after it, the kernel denies the same-user read.
    after = self_check(config)["checks"]["serverEnviron"]
    assert after == "blocked"
    assert before in ("allowed", "blocked")   # 'allowed' unless already hardened


# ---- server-wide default runtime URL ----

def test_from_env_reads_runtime_url_and_probe_target(monkeypatch):
    monkeypatch.setenv("CXD_FUNCTIONS", "users")
    monkeypatch.setenv("CXD_FUNCTIONS_RUNTIME_URL", "https://runtime.example/api/functions/run")
    monkeypatch.setenv("CXD_FUNCTIONS_PROBE_TARGET", "example.org:443")
    cfg = FunctionsConfig.from_env()
    assert cfg.runtime_url == "https://runtime.example/api/functions/run"
    assert cfg.probe_target == "example.org:443"
    # Blank values collapse to None (not an empty string).
    monkeypatch.setenv("CXD_FUNCTIONS_RUNTIME_URL", "")
    assert FunctionsConfig.from_env().runtime_url is None


# ---- admin-only self-check endpoint ----

@requires_pandas
def test_selfcheck_endpoint_is_admin_only(tmp_path):
    app = _app(tmp_path, "admin")
    admin = TestClient(app)
    _login(admin, "first")          # bootstraps as admin
    other = TestClient(app)
    _login(other, "second")
    assert admin.get("/api/functions/selfcheck").status_code == 200
    body = admin.get("/api/functions/selfcheck").json()
    assert "checks" in body and "networkIsolation" in body
    assert other.get("/api/functions/selfcheck").status_code == 403


# ---- standalone secret-free runtime app ----

from cxd_server.functions import RUNTIME_TOKEN_HEADER  # noqa: E402

RUNTIME_TOKEN = "shared-secret-123"


def _clear_forbidden(monkeypatch):
    from cxd_server.functions_app import _FORBIDDEN_ENV
    for name in _FORBIDDEN_ENV:
        monkeypatch.delenv(name, raising=False)


def test_standalone_runtime_refuses_to_start_without_the_token(monkeypatch):
    from cxd_server.functions_app import create_functions_app
    _clear_forbidden(monkeypatch)
    monkeypatch.delenv("CXD_FUNCTIONS_RUNTIME_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="shared secret"):
        create_functions_app()


def test_standalone_runtime_refuses_to_start_with_a_secret(monkeypatch):
    from cxd_server.functions_app import create_functions_app
    monkeypatch.setenv("CXD_FUNCTIONS_RUNTIME_TOKEN", RUNTIME_TOKEN)  # token present; secret is the problem
    monkeypatch.setenv("SESSION_SECRET", "nope")
    with pytest.raises(RuntimeError, match="SESSION_SECRET"):
        create_functions_app()


@requires_pandas
def test_standalone_runtime_runs_a_snippet_only_with_the_token(monkeypatch):
    from cxd_server.functions_app import create_functions_app
    _clear_forbidden(monkeypatch)
    monkeypatch.setenv("CXD_FUNCTIONS_RUNTIME_TOKEN", RUNTIME_TOKEN)
    monkeypatch.setenv("CXD_FUNCTIONS", "off")   # promoted to 'users' by the app
    app = create_functions_app()
    client = TestClient(app)
    # status is open (no token, no secrets, no code).
    assert client.get("/api/functions/status").json()["enabled"] is True
    # run and selfcheck reject a missing or wrong token with 401.
    assert client.post("/api/functions/run", json=BODY).status_code == 401
    assert client.post("/api/functions/run", json=BODY,
                       headers={RUNTIME_TOKEN_HEADER: "wrong"}).status_code == 401
    assert client.get("/api/functions/selfcheck").status_code == 401
    # with the right token it runs the snippet.
    r = client.post("/api/functions/run", json=BODY, headers={RUNTIME_TOKEN_HEADER: RUNTIME_TOKEN})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["y"]["smps"] == ["c1", "c2", "c3", "c4"]


# ---- the main app forwards to a standalone runtime (and stays the only authorizer) ----

RUNTIME_URL = "https://runtime.example/api/functions/run"


def _forwarding_app(tmp_path, mode):
    """A main app pointed at a standalone runtime (so runs are forwarded, not local)."""
    return create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s", serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "datasets"),
        functions=FunctionsConfig(mode=mode, timeout=10, runtime_url=RUNTIME_URL,
                                  runtime_token=RUNTIME_TOKEN),
    )


def _no_local(monkeypatch):
    """Make the embedded runtime blow up if it is ever reached while forwarding."""
    import cxd_server.app as appmod

    def boom(*a, **k):
        raise AssertionError("snippet executed locally while a runtime URL is set")
    monkeypatch.setattr(appmod, "run_function", boom)


def test_run_is_forwarded_and_never_executed_locally(tmp_path, monkeypatch):
    import cxd_server.app as appmod
    _no_local(monkeypatch)
    seen = {}

    async def fake_forward_run(payload, config):
        seen["payload"] = payload
        seen["url"] = config.runtime_url
        seen["token"] = config.runtime_token
        return {"data": {"y": {"vars": ["Age"], "smps": ["c1"], "data": [[1]]}}}
    monkeypatch.setattr(appmod, "forward_run", fake_forward_run)

    app = _forwarding_app(tmp_path, "users")
    client = TestClient(app)
    _login(client, "ann")
    r = client.post("/api/functions/run", json=BODY)
    assert r.status_code == 200, r.text
    assert seen["payload"]["code"] == BODY["code"]
    assert seen["url"] == RUNTIME_URL and seen["token"] == RUNTIME_TOKEN


def test_authorization_happens_before_forwarding(tmp_path, monkeypatch):
    import cxd_server.app as appmod
    _no_local(monkeypatch)
    called = {"forward": False}

    async def fake_forward_run(payload, config):
        called["forward"] = True
        return {"data": {}}
    monkeypatch.setattr(appmod, "forward_run", fake_forward_run)

    app = _forwarding_app(tmp_path, "admin")
    admin = TestClient(app)
    _login(admin, "first")           # admin
    other = TestClient(app)
    _login(other, "second")
    # A non-author in admin mode is rejected BEFORE any forwarding.
    r = other.post("/api/functions/run", json=BODY)
    assert r.status_code == 403 and called["forward"] is False
    # Approved admin-dashboard code is forwarded.
    spec = {"id": "fn", "title": "F", "layout": {"cols": 12, "items": []}, "panels": {},
            "data": {"clin": {"kind": "inline", "value": CLIN},
                     "f": {"kind": "function", "language": "python", "code": BODY["code"],
                           "inputs": ["clin"]}}}
    assert admin.post("/api/dashboards", json=spec).status_code == 200
    assert other.post("/api/functions/run", json=BODY).status_code == 200
    assert called["forward"] is True


def test_busy_429_from_runtime_flows_through(tmp_path, monkeypatch):
    import cxd_server.app as appmod
    from cxd_server.functions import FunctionError
    _no_local(monkeypatch)

    async def busy(payload, config):
        raise FunctionError("Data-function runtime is busy; try again shortly", 429)
    monkeypatch.setattr(appmod, "forward_run", busy)

    app = _forwarding_app(tmp_path, "users")
    client = TestClient(app)
    _login(client, "ann")
    assert client.post("/api/functions/run", json=BODY).status_code == 429


def test_selfcheck_is_forwarded_when_a_runtime_is_configured(tmp_path, monkeypatch):
    import cxd_server.app as appmod
    seen = {}

    async def fake_forward_self_check(config):
        seen["url"] = config.runtime_url
        return {"available": True, "networkIsolation": "unshare -rn",
                "checks": {"serverEnviron": "blocked"}}
    monkeypatch.setattr(appmod, "forward_self_check", fake_forward_self_check)

    app = _forwarding_app(tmp_path, "admin")
    admin = TestClient(app)
    _login(admin, "first")
    body = admin.get("/api/functions/selfcheck").json()
    assert body["runtime"] == "remote" and body["runtimeUrl"] == RUNTIME_URL
    assert body["checks"]["serverEnviron"] == "blocked"
    # The shared token is never exposed in the admin report.
    assert RUNTIME_TOKEN not in str(body)


def test_browser_config_no_longer_carries_a_default_runtime(tmp_path):
    # With serve_static, the server injects client config into index.html's head.
    # It must NOT advertise the runtime URL to the browser any more.
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
        dataset_store_uri="file://" + str(tmp_path / "datasets"),
        functions=FunctionsConfig(mode="users", runtime_url=RUNTIME_URL, runtime_token=RUNTIME_TOKEN),
        serve_static=True,
    )
    client = TestClient(app)
    html = client.get("/").text
    # The page's own JS still reads __CXD_CONFIG__.functionsRuntime (a harmless
    # fallback for non-cxd_server hosts); what must NOT appear is the injected
    # runtime URL — the server no longer advertises it to the browser.
    assert RUNTIME_URL not in html


def test_forward_helpers_map_errors(monkeypatch):
    """forward_run/forward_self_check surface the runtime's status + detail."""
    import httpx

    from cxd_server import functions as fn

    cfg = FunctionsConfig(mode="users", timeout=2, runtime_url=RUNTIME_URL, runtime_token=RUNTIME_TOKEN)

    def handler(request):
        assert request.headers.get(RUNTIME_TOKEN_HEADER) == RUNTIME_TOKEN
        if request.url.path.endswith("/selfcheck"):
            return httpx.Response(200, json={"checks": {}, "networkIsolation": "none"})
        return httpx.Response(429, json={"detail": "busy"})

    class FakeClient:
        def __init__(self, *a, **k):
            self._c = httpx.Client(transport=httpx.MockTransport(handler))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            self._c.close()

        async def request(self, method, url, json=None, headers=None):
            return self._c.request(method, url, json=json, headers=headers)

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    import asyncio
    with pytest.raises(fn.FunctionError) as ei:
        asyncio.run(fn.forward_run(BODY, cfg))
    assert ei.value.status == 429 and "busy" in str(ei.value)
    report = asyncio.run(fn.forward_self_check(cfg))
    assert report["networkIsolation"] == "none"


def test_forward_sends_connect_api_key_when_configured(monkeypatch):
    """With a Posit Connect API key configured, forwarded requests carry
    `Authorization: Key <key>` so Connect lets them through to the runtime."""
    import httpx

    from cxd_server import functions as fn

    cfg = FunctionsConfig(mode="users", timeout=2, runtime_url=RUNTIME_URL,
                          runtime_token=RUNTIME_TOKEN, runtime_connect_key="connect-key-xyz")
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("Authorization")
        seen["token"] = request.headers.get(RUNTIME_TOKEN_HEADER)
        return httpx.Response(200, json={"data": {"y": {"vars": [], "smps": [], "data": []}}})

    class FakeClient:
        def __init__(self, *a, **k):
            self._c = httpx.Client(transport=httpx.MockTransport(handler))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            self._c.close()

        async def request(self, method, url, json=None, headers=None):
            return self._c.request(method, url, json=json, headers=headers)

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    import asyncio
    asyncio.run(fn.forward_run(BODY, cfg))
    assert seen["auth"] == "Key connect-key-xyz"
    assert seen["token"] == RUNTIME_TOKEN


def test_sandbox_env_pins_blas_and_openmp_threads():
    """The snippet environment caps BLAS/OpenMP thread pools to 1, so numpy's
    OpenBLAS doesn't over-reserve per-core buffers and blow the memory cap."""
    from cxd_server.functions import _sandbox_env
    env = _sandbox_env("/tmp/wd")
    for var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
                "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        assert env[var] == "1"


@requires_pandas
def test_self_check_blocks_file_write_when_sandboxed():
    """Where an OS sandbox is in effect, a snippet cannot write outside its temp
    dir (into the server's working directory) — self-check reports it blocked."""
    config = FunctionsConfig(mode="users", timeout=10)
    if config.isolation() == "none":
        pytest.skip("no OS sandbox available on this host")
    assert self_check(config)["checks"]["fileWrite"] == "blocked"


def test_startup_warns_when_runtime_url_set_without_token(tmp_path, capsys):
    """A runtime URL with no token would get a confusing 401; warn at startup."""
    create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s", serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "ds"),
        functions=FunctionsConfig(mode="users", runtime_url=RUNTIME_URL))
    out = capsys.readouterr().out
    assert "CXD_FUNCTIONS_RUNTIME_URL is set without" in out
    assert "CXD_FUNCTIONS_RUNTIME_TOKEN" in out
