"""Standalone data-function runtime: the function contract, and nothing else.

A second, secret-free app that serves *only* the data-function runtime contract
— ``POST /api/functions/run``, ``GET /api/functions/status`` and ``GET
/api/functions/selfcheck``. It needs no database and no secrets, so it can be
deployed as its own app (e.g. a separate Posit Connect content item) that runs
the untrusted R/Python snippets, while the main dashboards app — which holds the
database URLs, ``ENCRYPTION_KEY`` and session secret — never executes user code.

The main dashboards app is the ONLY authorizer. It applies its mode / role /
approved-code checks, then forwards each authorized ``run`` to this runtime
server-side (the browser never calls the runtime directly for the default
runtime). To prove a request came from the main app and not from anyone who can
reach this runtime's URL, the main app sends a shared secret in the
``X-Cxd-Runtime-Token`` header. This runtime **refuses to start** without that
secret (``CXD_FUNCTIONS_RUNTIME_TOKEN``), and rejects any ``run`` or
``selfcheck`` whose header does not match (constant-time) with ``401``. The
token is this runtime's only secret, so it is fine for it to be in the runtime's
environment — it must never appear in the main app's browser config, and is
never logged. ``GET /api/functions/status`` stays open (it carries no secrets
and runs no code).

Point the main app at it with ``CXD_FUNCTIONS_RUNTIME_URL`` (the server-wide
default runtime the main app forwards to), setting the same
``CXD_FUNCTIONS_RUNTIME_TOKEN`` on both. A single spec's own ``runtime`` still
calls its URL directly from the browser and bypasses the main app's
authorization — only expose such a runtime deliberately.

It **also refuses to start** if it sees any of the main app's secret variables in
its environment (see :data:`_FORBIDDEN_ENV`): their presence means it was deployed
with the server's secrets, which defeats the purpose.

Run it with any ASGI server, e.g.::

    uvicorn cxd_server.functions_app:app --host 0.0.0.0 --port 8010

Settings come from the same ``CXD_FUNCTIONS*`` variables as the embedded runtime
(:class:`cxd_server.functions.FunctionsConfig`); the mode gate does not apply
here (this app *is* the runtime — the calling app does the authorization), so an
unset/``off`` mode is treated as ``users``.
"""

import hmac
import os
from typing import Any, Dict, List

from .functions import (RUNTIME_TOKEN_ENV, RUNTIME_TOKEN_HEADER, FunctionError, FunctionsConfig,
                        functions_status, harden_process, run_function, self_check)

# Variables that must NOT be present: the standalone runtime is meant to run
# without the main app's secrets (it trusts only requests carrying the shared
# CXD_FUNCTIONS_RUNTIME_TOKEN, i.e. those the main app has already authorized, so
# it never needs any of these). Store URLs can carry embedded credentials, so
# they count too. Keep in sync with the secret-bearing config the main app reads.
_FORBIDDEN_ENV = (
    "ENCRYPTION_KEY",
    "SESSION_SECRET",
    "CXD_DASHBOARD_STORE",
    "CXD_DATASET_STORE",
    "CXD_STORES",
    "CXD_SECRET_FILE",
    "CXD_TOKEN_SIGNING_KEY",
    "CXD_OIDC_CLIENT_SECRET",
    "CXD_OIDC_CLIENT_SECRET_FILE",
    "CXD_SMTP_PASSWORD",
    "CXD_SMTP_PASSWORD_FILE",
    "CXD_METER_KEY",
    "CXD_LLM_API_KEY",
    "PAYPAL_CLIENT_SECRET",
)


def _forbidden_present() -> List[str]:
    """Which secret-bearing variables are set in this environment (sorted)."""
    return sorted(name for name in _FORBIDDEN_ENV if os.getenv(name))


def runtime_token(env: Dict[str, str] = None) -> str:
    """The shared secret this runtime requires, from ``CXD_FUNCTIONS_RUNTIME_TOKEN``.

    :returns: The token, or ``""`` when unset.
    :public:
    """
    env = os.environ if env is None else env
    return (env.get(RUNTIME_TOKEN_ENV) or "").strip()


def create_functions_app(config: FunctionsConfig = None, token: str = None):
    """Build the standalone runtime app; refuse to start without the shared token
    or if secrets are present.

    :param config: Runtime settings; defaults to :meth:`FunctionsConfig.from_env`
        with an unset/``off`` mode promoted to ``users`` (this app is the runtime,
        not the authorizer).
    :param token: The shared secret the main app must present (header
        ``X-Cxd-Runtime-Token``); defaults to ``CXD_FUNCTIONS_RUNTIME_TOKEN``.
    :returns: A FastAPI application serving the runtime contract.
    :raises RuntimeError: if the shared token is unset, a forbidden secret
        variable is set, or FastAPI is not installed.
    :public:
    """
    if token is None:
        token = runtime_token()
    if not token:
        raise RuntimeError(
            "Refusing to start the standalone data-function runtime: it needs the "
            "shared secret the main app authenticates with. Set %s to the same "
            "value on this runtime and on the main app (CXD_FUNCTIONS_RUNTIME_TOKEN)."
            % RUNTIME_TOKEN_ENV)
    leaked = _forbidden_present()
    if leaked:
        raise RuntimeError(
            "Refusing to start the standalone data-function runtime: it must run "
            "without the dashboards app's secrets, but these are set in its "
            "environment: " + ", ".join(leaked))
    try:
        from fastapi import FastAPI, HTTPException, Request
        from fastapi.concurrency import run_in_threadpool
    except ImportError as exc:                      # pragma: no cover - import guard
        raise RuntimeError(
            "FastAPI is not installed. Install the web extra:\n"
            "    pip install 'canvasxpress-dashboards-server[web]'") from exc

    if config is None:
        config = FunctionsConfig.from_env()
        if config.mode == "off":
            config.mode = "users"

    hardened = harden_process()
    print("[functions-runtime] environ hardening: applied=%s platform=%s%s"
          % (hardened["applied"], hardened["platform"],
             (" (" + hardened["reason"] + ")") if hardened.get("reason") else ""),
          flush=True)

    app = FastAPI(title="canvasxpress-dashboards · data-function runtime")

    def require_token(request: "Request") -> None:
        """Reject (401) any request not carrying the shared token. Constant-time
        compare; the token is never logged or echoed."""
        presented = request.headers.get(RUNTIME_TOKEN_HEADER, "")
        if not hmac.compare_digest(presented, token):
            raise HTTPException(status_code=401, detail="Invalid or missing runtime token")

    @app.get("/api/functions/status")
    def status() -> Dict[str, Any]:
        # Open: carries no secrets and runs no code.
        return functions_status(config)

    @app.get("/api/functions/selfcheck")
    def selfcheck(request: Request) -> Dict[str, Any]:
        require_token(request)
        return self_check(config)

    @app.post("/api/functions/run")
    async def run(request: Request) -> Dict[str, Any]:
        require_token(request)
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(status_code=400, detail="Request body must be JSON")
        try:
            return await run_in_threadpool(run_function, payload, config)
        except FunctionError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc))

    return app


# Importable ASGI target: `uvicorn cxd_server.functions_app:app`. Built lazily so
# that merely importing this module (e.g. to call create_functions_app in tests)
# does not require the runtime token / a secret-free environment — only resolving
# the `app` attribute (as an ASGI server does) builds and validates it.
def __getattr__(name: str):
    if name == "app":
        return create_functions_app()
    raise AttributeError("module %r has no attribute %r" % (__name__, name))
