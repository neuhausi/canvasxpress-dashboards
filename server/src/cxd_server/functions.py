"""Data functions: run a short R or Python snippet over a dashboard's tables.

A dashboard ``kind:"function"`` source sends its input tables and code to a
*runtime* — any HTTP endpoint implementing the contract below. This module is
the reference runtime ``cxd_server`` ships behind ``POST /api/functions/run``.
It is **off by default**; enable it with ``CXD_FUNCTIONS=admin`` (admins only)
or ``CXD_FUNCTIONS=users`` (any logged-in user).

Contract (JSON in, JSON out)::

    POST <runtime>
    {"language": "python" | "r",
     "code": "<snippet that assigns `result`>",
     "inputs": {"<name>": {"data": <CanvasXpress data object>, "axis": "smps" | "vars"}},
     "params": {"<name>": <value>},
     "axis": "smps" | "vars"}          # orientation of the result (default smps)

    200 {"data": <CanvasXpress data object>}
    4xx/5xx {"detail": "<message>"}

Inside the snippet every input is a table — a pandas ``DataFrame`` (Python) or
a ``data.frame`` (R) — indexed by its row ids, with the numeric columns and the
row annotations as columns; ``params`` holds the resolved parameters. The code
assigns ``result``: a DataFrame / data.frame (row ids from its index / row
names, or from its first column when those are the defaults; numeric columns
become variables, the rest annotations) or a CanvasXpress data object. A table
result is emitted with one sample per row, or — with ``"axis": "vars"`` — one
variable per row (the scatter orientation); a returned data object is kept as is.

Isolation: each run is a fresh subprocess in an empty temporary directory with
a minimal environment, a wall-clock timeout, CPU / file-size / memory limits
(memory where the OS enforces ``RLIMIT_AS``), a concurrency cap, and input /
output size caps. Network isolation needs an OS sandbox: ``auto`` uses
``sandbox-exec`` on macOS and ``unshare -rn`` on Linux when they work, else
none — :func:`functions_status` reports what is actually in effect, and
``CXD_FUNCTIONS_WRAPPER`` can name any wrapper (e.g. ``firejail --net=none``).
Run it inside a container or VM for real multi-tenant use.

Three further hardening seams: :func:`harden_process` makes the server's
``/proc/<pid>/environ`` unreadable to same-user snippets (Linux); :func:`self_check`
runs one probe through the real launch path and reports what it could/couldn't do
(``blocked``/``allowed``); and ``CXD_FUNCTIONS_RUNTIME_URL`` names a server-wide
default runtime so snippets can run in a separate, secret-free app
(:mod:`cxd_server.functions_app`) instead of this process.
"""

from __future__ import annotations

import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
from typing import Any, Dict, List, Optional

LANGUAGES = ("python", "r")
MODES = ("off", "admin", "users")

# The main app forwards each authorized run to a standalone runtime
# (CXD_FUNCTIONS_RUNTIME_URL), proving itself with this shared secret in this
# header. Defined here so both the forwarder (below) and the runtime app
# (functions_app) share one definition. The token is never logged.
RUNTIME_TOKEN_HEADER = "X-Cxd-Runtime-Token"
RUNTIME_TOKEN_ENV = "CXD_FUNCTIONS_RUNTIME_TOKEN"
# Added to the runtime's own timeout when the main app forwards, so the HTTP wait
# always outlasts the runtime's wall-clock limit (which returns 504 first).
FORWARD_TIMEOUT_MARGIN = 5.0


class FunctionError(Exception):
    """A data function failed; ``status`` is the HTTP status to report."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class FunctionsConfig:
    """Runtime settings, read from the environment by :meth:`from_env`."""

    def __init__(self, mode: str = "off", timeout: float = 20.0, memory_mb: int = 1024,
                 max_input: int = 20_000_000, max_output: int = 20_000_000,
                 max_concurrent: int = 2, python: Optional[str] = None,
                 rscript: Optional[str] = None, wrapper: str = "auto",
                 runtime_url: Optional[str] = None, probe_target: Optional[str] = None,
                 runtime_token: Optional[str] = None):
        self.mode = mode if mode in MODES else "off"
        self.timeout = timeout
        self.memory_mb = memory_mb
        self.max_input = max_input
        self.max_output = max_output
        self.python = python or sys.executable
        self.rscript = rscript or shutil.which("Rscript") or "Rscript"
        self.wrapper_setting = wrapper
        # Server-wide default runtime for function sources that carry no
        # ``runtime`` of their own (a per-spec ``runtime`` still wins). Injected
        # into the served app's client config; see app.py.
        self.runtime_url = (runtime_url or "").strip() or None
        # Shared secret sent to that runtime (header ``X-Cxd-Runtime-Token``) to
        # prove the request came from this authorizing app. Never logged.
        self.runtime_token = (runtime_token or "").strip() or None
        # ``host:port`` the isolation self-check tries to reach (skipped unset).
        self.probe_target = (probe_target or "").strip() or None
        self._slots = threading.BoundedSemaphore(max(1, max_concurrent))
        self._wrapper: Optional[List[str]] = None
        self._isolation: Optional[str] = None
        self._languages: Optional[List[str]] = None

    @classmethod
    def from_env(cls, mode: Optional[str] = None) -> "FunctionsConfig":
        """Build from ``CXD_FUNCTIONS*`` environment variables."""
        def num(name: str, default: float) -> float:
            try:
                return float(os.getenv(name, default))
            except ValueError:
                return default
        return cls(
            mode=(mode or os.getenv("CXD_FUNCTIONS", "off")).strip().lower(),
            timeout=num("CXD_FUNCTIONS_TIMEOUT", 20),
            memory_mb=int(num("CXD_FUNCTIONS_MEMORY_MB", 1024)),
            max_input=int(num("CXD_FUNCTIONS_MAX_INPUT", 20_000_000)),
            max_output=int(num("CXD_FUNCTIONS_MAX_OUTPUT", 20_000_000)),
            max_concurrent=int(num("CXD_FUNCTIONS_MAX_CONCURRENT", 2)),
            python=os.getenv("CXD_FUNCTIONS_PYTHON") or None,
            rscript=os.getenv("CXD_FUNCTIONS_RSCRIPT") or None,
            wrapper=os.getenv("CXD_FUNCTIONS_WRAPPER", "auto"),
            runtime_url=os.getenv("CXD_FUNCTIONS_RUNTIME_URL") or None,
            probe_target=os.getenv("CXD_FUNCTIONS_PROBE_TARGET") or None,
            runtime_token=os.getenv(RUNTIME_TOKEN_ENV) or None,
        )

    def wrapper(self) -> List[str]:
        """The command prefix that sandboxes a run (resolved once)."""
        if self._wrapper is None:
            self._wrapper, self._isolation = _resolve_wrapper(self.wrapper_setting)
        return self._wrapper

    def isolation(self) -> str:
        """Human-readable network isolation actually in effect."""
        self.wrapper()
        return self._isolation or "none"


def functions_status(config: FunctionsConfig) -> Dict[str, Any]:
    """What the runtime offers: mode, available languages, limits, isolation."""
    if config._languages is None:
        languages = []
        if _works([config.python, "-c", "import pandas"]):
            languages.append("python")
        if _works([config.rscript, "-e", "suppressMessages(library(jsonlite))"]):
            languages.append("r")
        config._languages = languages
    languages = list(config._languages)
    return {
        "enabled": config.mode != "off",
        "mode": config.mode,
        "languages": languages,
        "timeout": config.timeout,
        "memoryMb": config.memory_mb,
        "networkIsolation": config.isolation() if config.mode != "off" else None,
    }


def harden_process() -> Dict[str, Any]:
    """Make this process's ``/proc/<pid>/environ`` unreadable by same-user code.

    Data-function snippets run as the same OS user as the server, so a snippet
    could otherwise read the server's secrets (database URLs, API keys,
    ``ENCRYPTION_KEY``) out of ``/proc/<server pid>/environ``. On Linux,
    ``prctl(PR_SET_DUMPABLE, 0)`` clears the dumpable flag, which makes the
    kernel reparent ``/proc/<pid>`` files to root and deny same-user reads of
    ``environ``/``maps``/``mem``. Call it once per worker process, early at
    startup. It is a no-op (and harmless) on non-Linux platforms.

    Note the limit: this protects *this* process and the ones it spawns, not a
    parent process (e.g. a gunicorn master, or a host supervisor) that the
    operator may run with secrets in its own environment.

    :returns: ``{"applied": bool, "platform": <system>, "reason"?: <str>}``.
    :public:
    """
    system = platform.system()
    if system != "Linux":
        return {"applied": False, "platform": system,
                "reason": "PR_SET_DUMPABLE is Linux-only; no-op here"}
    try:
        import ctypes
        PR_SET_DUMPABLE = 4
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        rc = libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
        if rc != 0:
            err = ctypes.get_errno()
            return {"applied": False, "platform": system,
                    "reason": "prctl(PR_SET_DUMPABLE, 0) failed (errno %d)" % err}
        return {"applied": True, "platform": system}
    except Exception as exc:                       # pragma: no cover - platform specific
        return {"applied": False, "platform": system, "reason": str(exc)}


def self_check(config: FunctionsConfig) -> Dict[str, Any]:
    """Measure, don't guess: run one probe through the real snippet launch path.

    Launches a single Python probe subprocess through exactly the same path as a
    data function (same wrapper, resource limits and minimal environment) and
    has it attempt the things a hostile snippet would. Each check reports
    ``"blocked"`` or ``"allowed"`` (never the data it managed to read). The probe
    is Python-only; if the Python runtime is unavailable the checks report
    ``"unknown"`` and ``available`` is False.

    Checks: reading the server's ``/proc/<pid>/environ`` and its parent's;
    reading any *other* same-user process's ``environ`` under ``/proc``; opening
    a TCP connection to ``config.probe_target`` (skipped when unset); and writing
    a file outside the sandbox temp dir (into the server's working directory).

    :param config: The runtime settings to probe (wrapper, limits, target).
    :returns: ``{available, networkIsolation, languages, checks: {...},
        probeTarget?}`` where each check is ``blocked``/``allowed``/``skipped``/
        ``unknown``.
    :public:
    """
    status = functions_status(config)
    report: Dict[str, Any] = {
        "available": "python" in status["languages"],
        "networkIsolation": config.isolation(),
        "languages": status["languages"],
        "probeTarget": config.probe_target,
        "checks": {},
    }
    if not report["available"]:
        report["checks"] = {name: "unknown" for name in
                            ("serverEnviron", "parentEnviron", "otherEnviron",
                             "network", "fileWrite")}
        report["error"] = "Python runtime unavailable; cannot run the probe"
        return report
    with tempfile.TemporaryDirectory(prefix="cxd-fn-probe-") as workdir:
        # Tell the probe which pids to target and where to try writing / connecting,
        # via a file (the sandbox environment is deliberately minimal).
        spec = {
            "serverPid": os.getpid(),
            "parentPid": os.getppid(),
            "outsidePath": os.path.join(os.getcwd(), ".cxd-fn-selfcheck-probe"),
            "target": config.probe_target,
        }
        with open(os.path.join(workdir, "probe.json"), "w") as fh:
            json.dump(spec, fh)
        harness = os.path.join(workdir, "probe.py")
        with open(harness, "w") as fh:
            fh.write(_PROBE_HARNESS)
        try:
            proc = _launch([config.python, "-I", harness], workdir, config,
                           min(config.timeout, 15))
        except subprocess.TimeoutExpired:
            report["error"] = "Isolation probe timed out"
            return report
        except OSError as exc:
            report["error"] = "Could not start the isolation probe: %s" % exc
            return report
        result_path = os.path.join(workdir, "probe-result.json")
        if proc.returncode != 0 or not os.path.exists(result_path):
            report["error"] = _failure_message(proc)
            return report
        with open(result_path) as fh:
            report["checks"] = json.load(fh)
    return report


def run_function(payload: Any, config: FunctionsConfig) -> Dict[str, Any]:
    """Validate a contract request and run it; return ``{"data": ...}``.

    :raises FunctionError: on a bad request, a failing snippet (400), a timeout
        (504), oversize input/output (413), or a busy runtime (429).
    """
    request = _validate(payload, config)
    if not config._slots.acquire(blocking=False):
        raise FunctionError("Data-function runtime is busy; try again shortly", 429)
    try:
        return {"data": _execute(request, config)}
    finally:
        config._slots.release()


def _selfcheck_url(run_url: str) -> str:
    """The runtime's ``/selfcheck`` URL, derived from its ``/run`` URL."""
    if run_url.endswith("/run"):
        return run_url[:-len("/run")] + "/selfcheck"
    return run_url


async def _forward(config: FunctionsConfig, url: str, method: str,
                   json_body: Any = None, timeout: float = None) -> Dict[str, Any]:
    """Forward one request to the standalone runtime and return its JSON.

    Sends the shared token (:data:`RUNTIME_TOKEN_HEADER`) so the runtime accepts
    it. Maps transport problems and the runtime's own error responses to
    :class:`FunctionError` with a matching status (504 timeout, 502 unreachable /
    non-JSON, else the runtime's status — 429 for busy flows straight through).

    :raises FunctionError: on timeout, transport failure, or a non-200 response.
    """
    import httpx

    headers = {}
    if config.runtime_token:
        headers[RUNTIME_TOKEN_HEADER] = config.runtime_token
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(method, url, json=json_body, headers=headers)
    except httpx.TimeoutException:
        raise FunctionError("The data-function runtime did not respond in time", 504)
    except httpx.HTTPError as exc:
        raise FunctionError("Could not reach the data-function runtime: %s" % exc, 502)
    if resp.status_code != 200:
        raise FunctionError(_forward_detail(resp), resp.status_code)
    try:
        return resp.json()
    except ValueError:
        raise FunctionError("The data-function runtime returned a non-JSON response", 502)


def _forward_detail(resp: Any) -> str:
    """The ``detail`` message from a runtime error response (never a token)."""
    try:
        body = resp.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and body.get("detail"):
        return str(body["detail"])
    return "Data-function runtime error (HTTP %d)" % resp.status_code


async def forward_run(payload: Any, config: FunctionsConfig) -> Dict[str, Any]:
    """Forward an already-authorized run to ``config.runtime_url`` and return its
    ``{"data": ...}``. The main app calls this instead of :func:`run_function`
    when a runtime URL is configured; snippets then never execute on this host.

    :raises FunctionError: on timeout (504), an unreachable runtime (502), or the
        runtime's own error status (429 busy, 4xx/5xx) with its message.
    """
    return await _forward(config, config.runtime_url, "POST", json_body=payload,
                          timeout=config.timeout + FORWARD_TIMEOUT_MARGIN)


async def forward_self_check(config: FunctionsConfig) -> Dict[str, Any]:
    """Forward the admin isolation self-check to the standalone runtime and return
    its report (so an operator measures the runtime that actually runs the code).

    :raises FunctionError: as :func:`forward_run`.
    """
    timeout = min(config.timeout, 15) + FORWARD_TIMEOUT_MARGIN
    return await _forward(config, _selfcheck_url(config.runtime_url), "GET", timeout=timeout)


def _validate(payload: Any, config: FunctionsConfig) -> Dict[str, Any]:
    """Check the contract shape and sizes."""
    if not isinstance(payload, dict):
        raise FunctionError("Request body must be a JSON object")
    language = payload.get("language")
    if language not in LANGUAGES:
        raise FunctionError('language must be "python" or "r"')
    code = payload.get("code")
    if not isinstance(code, str) or not code.strip():
        raise FunctionError("code must be a non-empty string")
    inputs = payload.get("inputs") or {}
    if not isinstance(inputs, dict):
        raise FunctionError("inputs must be an object of {name: {data, axis}}")
    for name, entry in inputs.items():
        if not isinstance(name, str) or not name.isidentifier():
            raise FunctionError('input name "%s" must be a valid identifier' % name)
        if not isinstance(entry, dict) or not isinstance(entry.get("data"), dict):
            raise FunctionError(
                'input "%s" must be {data: <CanvasXpress data object>, axis?}' % name)
        if entry.get("axis", "smps") not in ("smps", "vars"):
            raise FunctionError('input "%s" axis must be "smps" or "vars"' % name)
    params = payload.get("params") or {}
    if not isinstance(params, dict):
        raise FunctionError("params must be an object")
    axis = payload.get("axis", "smps") or "smps"
    if axis not in ("smps", "vars"):
        raise FunctionError('axis must be "smps" or "vars"')
    size = len(json.dumps(payload))
    if size > config.max_input:
        raise FunctionError("Request is too large (%d bytes > %d)" % (size, config.max_input), 413)
    return {"language": language, "code": code, "inputs": inputs, "params": params, "axis": axis}


def _execute(request: Dict[str, Any], config: FunctionsConfig) -> Any:
    """Run the snippet in a sandboxed subprocess and read back its result."""
    with tempfile.TemporaryDirectory(prefix="cxd-fn-") as workdir:
        with open(os.path.join(workdir, "payload.json"), "w") as fh:
            json.dump(request, fh)
        if request["language"] == "python":
            harness = os.path.join(workdir, "run.py")
            with open(harness, "w") as fh:
                fh.write(_PYTHON_HARNESS)
            command = [config.python, "-I", harness]
        else:
            harness = os.path.join(workdir, "run.R")
            with open(harness, "w") as fh:
                fh.write(_R_HARNESS)
            command = [config.rscript, "--vanilla", harness]
        try:
            proc = _launch(command, workdir, config, config.timeout)
        except subprocess.TimeoutExpired:
            raise FunctionError("Data function timed out after %gs" % config.timeout, 504)
        except OSError as exc:
            raise FunctionError(
                "Could not start the %s runtime: %s" % (request["language"], exc), 500)
        result_path = os.path.join(workdir, "result.json")
        if proc.returncode != 0 or not os.path.exists(result_path):
            raise FunctionError(_failure_message(proc))
        if os.path.getsize(result_path) > config.max_output:
            raise FunctionError("Result is too large (> %d bytes)" % config.max_output, 413)
        with open(result_path) as fh:
            result = json.load(fh)
        if "error" in result:
            raise FunctionError(str(result["error"]))
        data = result.get("data")
        if request["axis"] == "vars" and result.get("fromTable"):
            data = _transpose(data)
        return data


def _transpose(data: Dict[str, Any]) -> Dict[str, Any]:
    """Swap a CanvasXpress data object's axes (samples <-> variables)."""
    y = data.get("y") or {}
    matrix = y.get("data") or []
    smps = y.get("smps") or []
    out: Dict[str, Any] = {"y": {
        "vars": smps,
        "smps": y.get("vars") or [],
        "data": [[row[i] if i < len(row) else None for row in matrix] for i in range(len(smps))],
    }}
    if data.get("x"):
        out["z"] = data["x"]
    if data.get("z"):
        out["x"] = data["z"]
    return out


def _failure_message(proc: subprocess.CompletedProcess) -> str:
    """The useful tail of a failed run's stderr (or stdout)."""
    text = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace").strip()
    if not text:
        return "Data function failed (exit code %s)" % proc.returncode
    lines = text.splitlines()[-12:]
    return "Data function failed:\n" + "\n".join(lines)[-2000:]


def _sandbox_env(workdir: str) -> Dict[str, str]:
    """The minimal environment every sandboxed run (and the self-check) gets.

    Deliberately omits the server's own variables so a snippet cannot read a
    secret out of its own environment; the self-check runs through this same
    function so what it measures is what real snippets see.

    :param workdir: The run's temporary directory (becomes ``HOME``/``TMPDIR``).
    :returns: The environment dict passed to the subprocess.
    :private:
    """
    return {"PATH": os.getenv("PATH", "/usr/bin:/bin"), "HOME": workdir, "TMPDIR": workdir,
            "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}


def _launch(command: List[str], workdir: str, config: FunctionsConfig,
            timeout: float) -> subprocess.CompletedProcess:
    """Run ``command`` through the sandbox launch path shared by every snippet.

    Applies the resolved wrapper, the minimal environment, the working
    directory, stdin on ``/dev/null`` and (on POSIX) the resource-limit
    ``preexec_fn`` — exactly the path a real data function takes, so the
    isolation self-check measures the real conditions.

    :param command: The interpreter invocation (wrapper is prepended here).
    :param workdir: Working directory and sandbox ``HOME``/``TMPDIR``.
    :param config: The runtime settings (wrapper, limits).
    :param timeout: Wall-clock timeout in seconds.
    :returns: The completed process (stdout/stderr captured).
    :raises subprocess.TimeoutExpired: if it runs past ``timeout``.
    :raises OSError: if the interpreter cannot be started.
    :private:
    """
    return subprocess.run(
        config.wrapper() + command, cwd=workdir, env=_sandbox_env(workdir),
        capture_output=True, stdin=subprocess.DEVNULL, timeout=timeout,
        preexec_fn=_limits(config) if os.name == "posix" else None,
    )


def _limits(config: FunctionsConfig):
    """A ``preexec_fn`` applying CPU, file-size and memory rlimits (best effort)."""
    def apply() -> None:
        import resource
        os.setsid()
        for name, value in (("RLIMIT_CPU", int(config.timeout) + 1),
                            ("RLIMIT_FSIZE", max(config.max_output * 2, 1_000_000)),
                            ("RLIMIT_AS", config.memory_mb * 1024 * 1024)):
            if hasattr(resource, name):
                try:
                    resource.setrlimit(getattr(resource, name), (value, value))
                except (ValueError, OSError):
                    pass   # e.g. RLIMIT_AS is not enforceable on macOS
    return apply


def _resolve_wrapper(setting: str):
    """Resolve the sandbox wrapper: ``auto``, ``none``, or an explicit command."""
    setting = (setting or "auto").strip()
    if setting.lower() == "none":
        return [], "none"
    if setting.lower() != "auto":
        return shlex.split(setting), "custom wrapper: " + setting
    system = platform.system()
    if system == "Darwin" and shutil.which("sandbox-exec"):
        prefix = ["sandbox-exec", "-p", "(version 1)(allow default)(deny network*)"]
        if _works(prefix + ["/usr/bin/true"]):
            return prefix, "sandbox-exec (network denied)"
    if system == "Linux" and shutil.which("unshare"):
        prefix = ["unshare", "-rn"]
        if _works(prefix + ["true"]):
            return prefix, "unshare -rn (no network namespace access)"
    return [], "none"


def _works(command: List[str]) -> bool:
    """Whether a command runs and exits 0 within a few seconds."""
    try:
        return subprocess.run(command, capture_output=True, timeout=15).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


_PYTHON_HARNESS = r'''
import json, math, traceback

def main():
    with open("payload.json") as fh:
        payload = json.load(fh)
    import pandas as pd

    def to_frame(obj, axis):
        y = obj.get("y") or {}
        names = [str(v) for v in (y.get("vars") or [])]
        smps = [str(s) for s in (y.get("smps") or [])]
        matrix = y.get("data") or []
        if axis == "vars":
            ids, cols, ann = names, smps, obj.get("z") or {}
            columns = {c: [row[j] if j < len(row) else None for row in matrix]
                       for j, c in enumerate(cols)}
        else:
            ids, cols, ann = smps, names, obj.get("x") or {}
            columns = {c: (matrix[i] if i < len(matrix) else []) for i, c in enumerate(cols)}
        index = pd.Index(ids, name=axis)
        def numeric(values):
            series = pd.Series(list(values), index=index, dtype="object")
            return pd.to_numeric(series, errors="coerce")
        frame = pd.DataFrame({c: numeric(v) for c, v in columns.items()}, index=index)
        for key, values in ann.items():
            name = key if key not in frame.columns else key + ".annotation"
            frame[name] = pd.Series(list(values), index=frame.index, dtype="object")
        return frame

    def clean(v):
        if v is None:
            return None
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        if hasattr(v, "item"):
            v = v.item()
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                return None
        return v

    def from_result(res):
        if isinstance(res, dict) and "y" in res:
            return res
        if isinstance(res, pd.Series):
            res = res.to_frame()
        if not isinstance(res, pd.DataFrame):
            raise TypeError("result must be a DataFrame or a CanvasXpress data object "
                            "(got %s)" % type(res).__name__)
        frame = res
        default_index = isinstance(frame.index, pd.RangeIndex)
        is_num = pd.api.types.is_numeric_dtype
        first_named = len(frame.columns) and not is_num(frame[frame.columns[0]])
        if default_index and first_named:
            ids = [str(v) for v in frame[frame.columns[0]]]
            frame = frame.drop(columns=[frame.columns[0]])
        else:
            ids = [str(v) for v in frame.index]
        numeric = [c for c in frame.columns
                   if is_num(frame[c]) and not pd.api.types.is_bool_dtype(frame[c])]
        others = [c for c in frame.columns if c not in numeric]
        out = {"y": {"vars": [str(c) for c in numeric], "smps": ids,
                     "data": [[clean(v) for v in frame[c].tolist()] for c in numeric]}}
        if others:
            out["x"] = {str(c): [None if clean(v) is None else str(v) for v in frame[c].tolist()]
                        for c in others}
        return out

    namespace = {"pd": pd, "params": payload.get("params") or {}}
    for name, entry in (payload.get("inputs") or {}).items():
        namespace[name] = to_frame(entry["data"], entry.get("axis", "smps"))
    try:
        exec(compile(payload["code"], "<data function>", "exec"), namespace)
        if "result" not in namespace:
            raise NameError("the code must assign `result`")
        res = namespace["result"]
        out = {"data": from_result(res), "fromTable": not (isinstance(res, dict) and "y" in res)}
    except Exception as exc:
        tb = traceback.format_exc().splitlines()
        user = [line for line in tb if "<data function>" in line]
        where = ("\n" + user[-1].strip()) if user else ""
        out = {"error": "%s: %s%s" % (type(exc).__name__, exc, where)}
    with open("result.json", "w") as fh:
        json.dump(out, fh, allow_nan=False, default=str)

main()
'''

_PROBE_HARNESS = r'''
import json, os, socket

def can_read_environ(pid):
    try:
        with open("/proc/%d/environ" % pid, "rb") as fh:
            fh.read(1)
        return "allowed"
    except OSError:
        return "blocked"

def other_environ():
    # Any OTHER same-user process whose environ we can read (not ourselves).
    me = os.getpid()
    uid = os.getuid() if hasattr(os, "getuid") else None
    try:
        pids = [int(n) for n in os.listdir("/proc") if n.isdigit()]
    except OSError:
        return "blocked"
    for pid in pids:
        if pid == me:
            continue
        try:
            if uid is not None and os.stat("/proc/%d" % pid).st_uid != uid:
                continue
            with open("/proc/%d/environ" % pid, "rb") as fh:
                fh.read(1)
            return "allowed"
        except OSError:
            continue
    return "blocked"

def network(target):
    if not target:
        return "skipped"
    host, _, port = target.rpartition(":")
    try:
        sock = socket.create_connection((host, int(port)), timeout=3)
        sock.close()
        return "allowed"
    except (OSError, ValueError):
        return "blocked"

def file_write(path):
    try:
        with open(path, "w") as fh:
            fh.write("probe")
        os.remove(path)
        return "allowed"
    except OSError:
        return "blocked"

def main():
    with open("probe.json") as fh:
        spec = json.load(fh)
    linux = os.path.isdir("/proc")
    checks = {
        "serverEnviron": can_read_environ(spec["serverPid"]) if linux else "unknown",
        "parentEnviron": can_read_environ(spec["parentPid"]) if linux else "unknown",
        "otherEnviron": other_environ() if linux else "unknown",
        "network": network(spec.get("target")),
        "fileWrite": file_write(spec["outsidePath"]),
    }
    with open("probe-result.json", "w") as fh:
        json.dump(checks, fh)

main()
'''

_R_HARNESS = r'''
suppressMessages(library(jsonlite))
payload <- fromJSON("payload.json", simplifyVector = FALSE)

num <- function(v) vapply(v, function(e) {
  if (is.null(e)) NA_real_ else suppressWarnings(as.numeric(e))
}, numeric(1))
chr <- function(v) vapply(v, function(e) {
  if (is.null(e)) NA_character_ else as.character(e)
}, character(1))

to_frame <- function(obj, axis) {
  y <- obj$y
  vars <- chr(if (is.null(y$vars)) list() else y$vars)
  smps <- chr(if (is.null(y$smps)) list() else y$smps)
  matrix <- if (is.null(y$data)) list() else y$data
  if (identical(axis, "vars")) {
    ids <- vars; cols <- smps; ann <- obj$z
    cell <- function(row, j) if (j <= length(row)) row[[j]] else NULL
    values <- lapply(seq_along(cols), function(j) num(lapply(matrix, cell, j)))
  } else {
    ids <- smps; cols <- vars; ann <- obj$x
    values <- lapply(seq_along(cols), function(i) {
      num(if (i <= length(matrix)) matrix[[i]] else list())
    })
  }
  frame <- data.frame(row.names = ids, check.names = FALSE, stringsAsFactors = FALSE)
  for (i in seq_along(cols)) frame[[cols[i]]] <- values[[i]]
  for (key in names(ann)) {
    name <- if (key %in% names(frame)) paste0(key, ".annotation") else key
    frame[[name]] <- chr(ann[[key]])
  }
  frame
}

from_result <- function(res) {
  if (is.list(res) && !is.data.frame(res) && !is.null(res$y)) return(res)
  if (is.matrix(res)) res <- as.data.frame(res, stringsAsFactors = FALSE)
  if (!is.data.frame(res)) stop("result must be a data.frame or a CanvasXpress data object")
  auto <- identical(rownames(res), as.character(seq_len(nrow(res))))
  if (auto && ncol(res) > 0 && !is.numeric(res[[1]])) {
    ids <- as.character(res[[1]])
    res <- res[, -1, drop = FALSE]
  } else {
    ids <- rownames(res)
  }
  numeric <- names(res)[vapply(res, function(col) is.numeric(col) && !is.logical(col), logical(1))]
  others <- setdiff(names(res), numeric)
  out <- list(y = list(vars = I(as.character(numeric)), smps = I(ids),
                       data = lapply(numeric, function(col) I(as.numeric(res[[col]])))))
  if (length(others)) {
    out$x <- setNames(lapply(others, function(col) I(as.character(res[[col]]))), others)
  }
  out
}

env <- new.env(parent = globalenv())
assign("params", if (is.null(payload$params)) list() else payload$params, envir = env)
for (name in names(payload$inputs)) {
  entry <- payload$inputs[[name]]
  assign(name, to_frame(entry$data, if (is.null(entry$axis)) "smps" else entry$axis), envir = env)
}
out <- tryCatch({
  eval(parse(text = payload$code, keep.source = FALSE), envir = env)
  if (!exists("result", envir = env, inherits = FALSE)) stop("the code must assign `result`")
  res <- get("result", envir = env)
  is_cx <- is.list(res) && !is.data.frame(res) && !is.null(res$y)
  list(data = from_result(res), fromTable = !is_cx)
}, error = function(e) list(error = conditionMessage(e)))
writeLines(toJSON(out, auto_unbox = TRUE, null = "null", na = "null", digits = NA), "result.json")
'''
