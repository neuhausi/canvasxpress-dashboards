"""Standalone data-function runtime: the function contract, and nothing else.

A second, secret-free app that serves *only* the data-function runtime contract
— ``POST /api/functions/run``, ``GET /api/functions/status`` and ``GET
/api/functions/selfcheck``. It needs no database and no secrets, so it can be
deployed as its own app (e.g. a separate Posit Connect content item) that runs
the untrusted R/Python snippets, while the main dashboards app — which holds the
database URLs, ``ENCRYPTION_KEY`` and session secret — never executes user code.

Point the main app at it with ``CXD_FUNCTIONS_RUNTIME_URL`` (the default runtime
for function sources), or a single spec's ``runtime``. Deploy it at a
same-origin path so the browser's ``credentials: 'include'`` POST reaches it.

It **refuses to start** if it sees any of the main app's secret variables in its
environment (see :data:`_FORBIDDEN_ENV`): their presence means it was deployed
with the server's secrets, which defeats the purpose.

Run it with any ASGI server, e.g.::

    uvicorn cxd_server.functions_app:app --host 0.0.0.0 --port 8010

Settings come from the same ``CXD_FUNCTIONS*`` variables as the embedded runtime
(:class:`cxd_server.functions.FunctionsConfig`); the mode gate does not apply
here (this app *is* the runtime — the calling app does the authorization), so an
unset/``off`` mode is treated as ``users``.
"""

import os
from typing import Any, Dict, List

from .functions import (FunctionError, FunctionsConfig, functions_status, harden_process,
                        run_function, self_check)

# Variables that must NOT be present: the standalone runtime is meant to run
# without the main app's secrets. Store URLs can carry embedded credentials, so
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


def create_functions_app(config: FunctionsConfig = None):
    """Build the standalone runtime app; refuse to start if secrets are present.

    :param config: Runtime settings; defaults to :meth:`FunctionsConfig.from_env`
        with an unset/``off`` mode promoted to ``users`` (this app is the runtime,
        not the authorizer).
    :returns: A FastAPI application serving the runtime contract.
    :raises RuntimeError: if a forbidden secret variable is set, or FastAPI is
        not installed.
    :public:
    """
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

    @app.get("/api/functions/status")
    def status() -> Dict[str, Any]:
        return functions_status(config)

    @app.get("/api/functions/selfcheck")
    def selfcheck() -> Dict[str, Any]:
        return self_check(config)

    @app.post("/api/functions/run")
    async def run(request: Request) -> Dict[str, Any]:
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(status_code=400, detail="Request body must be JSON")
        try:
            return await run_in_threadpool(run_function, payload, config)
        except FunctionError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc))

    return app


# Importable ASGI target: `uvicorn cxd_server.functions_app:app`.
app = create_functions_app()
