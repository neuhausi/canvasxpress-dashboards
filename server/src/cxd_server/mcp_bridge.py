"""Bridge to the canvasxpress-mcp server — precise graph-config generation.

The MCP server (https://github.com/neuhausi/canvasxpress-mcp) turns a plain
English description plus column metadata into a *validated* CanvasXpress
config (RAG few-shot retrieval, tiered knowledge base, hallucinated-parameter
stripping, header validation). This module wraps its REST facade so the
dashboard chat can delegate the "what config" job to it, keeping the LLM
planner for the "what dashboard" job.

Configuration (all via environment / .env):

    CXD_MCP_ENABLED   "1"/"true" (default) or "0"/"false" to disable entirely.
    CXD_MCP_URL       Base URL of the MCP server (default http://127.0.0.1:8100).
    CXD_MCP_TIMEOUT   Per-request timeout in seconds (default 90).
    CXD_MCP_AUTH      Authorization header value sent on every call, for an MCP
                      server behind an authenticating proxy (e.g. "Bearer <token>",
                      or "Key <api key>" on Posit Connect). Default: none.
    CXD_MCP_REQUIRED  "1"/"on" to fail loudly: a call that cannot reach the server
                      (network error, HTTP error such as 401) raises BridgeError
                      instead of returning None, and /readyz checks the server.
                      Default off.

By default every call degrades gracefully: any failure returns None and the
caller falls back to the LLM planner, so the app never hard-depends on the MCP
server. That also hides a misconfigured deployment, hence CXD_MCP_REQUIRED.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from typing import Optional


class BridgeError(RuntimeError):
    """The bridge is required (CXD_MCP_REQUIRED) but the MCP server could not be used."""


def _truthy(value: Optional[str], default: bool = True) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() not in ("0", "false", "no", "off")


def enabled() -> bool:
    """Whether the MCP bridge is turned on (CXD_MCP_ENABLED)."""
    return _truthy(os.getenv("CXD_MCP_ENABLED"), True)


def required() -> bool:
    """Whether a failure to reach the MCP server is an error (CXD_MCP_REQUIRED)."""
    return _truthy(os.getenv("CXD_MCP_REQUIRED"), False)


def _open(url: str):
    """urlopen with the configured Authorization header (CXD_MCP_AUTH), if any."""
    auth = os.getenv("CXD_MCP_AUTH")
    request = urllib.request.Request(url, headers={"Authorization": auth} if auth else {})
    return urllib.request.urlopen(request, timeout=timeout_seconds())


def ping() -> Optional[str]:
    """None when the MCP server answers an authenticated request, else why not.

    Uses ``/cache-stats``: a cheap GET that makes no LLM call.
    """
    if not enabled():
        return "disabled (CXD_MCP_ENABLED)"
    try:
        with _open(base_url() + "/cache-stats") as resp:
            json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - reported, never raised
        return "%s: %s" % (type(exc).__name__, exc)
    return None


def base_url() -> str:
    """The MCP server base URL (CXD_MCP_URL)."""
    return (os.getenv("CXD_MCP_URL") or "http://127.0.0.1:8100").rstrip("/")


def timeout_seconds() -> float:
    """Per-request timeout (CXD_MCP_TIMEOUT)."""
    try:
        return float(os.getenv("CXD_MCP_TIMEOUT") or 90)
    except ValueError:
        return 90.0


def log_path() -> Optional[str]:
    """JSONL log of every bridge request/response (CXD_MCP_LOG; empty = off)."""
    return os.getenv("CXD_MCP_LOG") or None


def _log(entry: dict) -> None:
    """Append one JSONL record to the bridge log (best-effort, never raises)."""
    path = log_path()
    if not path:
        return
    try:
        import datetime
        entry = dict(entry)
        entry["ts"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def read_log(limit: int = 50) -> list:
    """The last ``limit`` bridge log records (newest last); [] when no log."""
    path = log_path()
    if not path or not os.path.isfile(path):
        return []
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.readlines()[-max(1, min(limit, 500)):]
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out
    except Exception:
        return []


def clear_log() -> bool:
    """Delete all recorded bridge exchanges by truncating the log file.

    Returns True if the log is enabled and now empty (truncated, or already
    absent), False only when logging is off or the file could not be truncated.
    """
    path = log_path()
    if not path:
        return False
    if not os.path.isfile(path):
        return True
    try:
        with open(path, "w", encoding="utf-8"):
            pass
        return True
    except Exception:
        return False


def _get(path: str, params: dict) -> Optional[dict]:
    """GET a REST endpoint on the MCP server; None on any failure, or
    :class:`BridgeError` when the bridge is required.

    Every exchange is recorded to the bridge log (CXD_MCP_LOG): the endpoint,
    the exact request parameters, and the full response or the error.
    """
    if not enabled():
        return None
    url = base_url() + path + "?" + urllib.parse.urlencode(params)
    record = {"endpoint": path, "request": {
        k: (json.loads(v) if k in ("column_types", "config") else v)
        for k, v in params.items()}}
    try:
        with _open(url) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        record["error"] = "%s: %s" % (type(exc).__name__, exc)
        _log(record)
        if required():
            raise BridgeError("canvasxpress-mcp %s failed: %s" % (path, record["error"]))
        return None
    record["response"] = body if isinstance(body, dict) else {"raw": str(body)[:2000]}
    _log(record)
    return body if isinstance(body, dict) else None


def generate_config(description: str, headers: list, column_types: dict) -> Optional[dict]:
    """Description + columns -> validated CanvasXpress config.

    :returns: The full MCP response (``config``, ``warnings``, ``valid``, ...)
        or None when disabled/unreachable/unsuccessful.
    """
    params = {
        "description": description,
        "headers": ",".join(headers),
        "column_types": json.dumps(column_types),
    }
    body = _get("/generate", params)
    if body and body.get("success") and isinstance(body.get("config"), dict):
        return body
    # One self-correcting retry: when validation rejected column references the
    # user got wrong (e.g. "Cluster" vs the real "group"), restate the request
    # with the actual columns so the generator maps the intent onto them.
    if body and body.get("invalid_refs"):
        params["description"] = (
            description
            + ". The dataset's ONLY columns are: " + ", ".join(headers)
            + " — map the request onto these columns."
        )
        body = _get("/generate", params)
        if body and body.get("success") and isinstance(body.get("config"), dict):
            body.setdefault("warnings", []).append(
                "Column names were adjusted to match the dataset.")
            return body
    return None


# Keys that are live CanvasXpress *instance state* (folded into panel configs
# by the builder's customizer sync), not authoring intent — stripped before a
# modify call so the MCP reasons over the meaningful config only.
_INSTANCE_STATE_KEYS = (
    "broadcastGroup", "resizable", "toolbarSize", "llmHeader",
    "fontScaleFontFactor", "smpTextScaleFontFactor",
)
_INSTANCE_STATE_PREFIXES = ("customizer", "dataTable")


def strip_instance_state(config: dict) -> dict:
    """Drop renderer/customizer bookkeeping keys from a panel config."""
    out = {}
    for key, value in (config or {}).items():
        if key in _INSTANCE_STATE_KEYS:
            continue
        if any(key.startswith(p) for p in _INSTANCE_STATE_PREFIXES):
            continue
        out[key] = value
    return out


def modify_config(config: dict, instruction: str, headers: Optional[list] = None) -> Optional[dict]:
    """Existing config + plain-English instruction -> revised config (Phase 3)."""
    params = {"config": json.dumps(strip_instance_state(config)), "instruction": instruction}
    if headers:
        params["headers"] = ",".join(headers)
    body = _get("/modify", params)
    if body and body.get("success") and isinstance(body.get("config"), dict):
        return body
    return None


def dataset_columns(data: dict):
    """Column names + coarse types for a stored CanvasXpress data object.

    Datasets may be stored in either orientation; the shorter of vars/smps is
    treated as the column axis (matching how the app displays tables), and
    per-sample (x) / per-variable (z) annotation keys are appended as factors.

    :returns: ``(headers, column_types)`` ready for :func:`generate_config`.
    """
    if isinstance(data, list):        # tabular 2D array: header + data rows
        headers = [str(c) for c in (data[0] if data else [])]
        sample = data[1] if len(data) > 1 else []
        types = {}
        for i, name in enumerate(headers):
            cell = sample[i] if i < len(sample) else None
            types[name] = "numeric" if isinstance(cell, (int, float)) else "factor"
        return headers, types
    y = (data or {}).get("y") or {}
    vars_, smps = y.get("vars") or [], y.get("smps") or []
    cols = vars_ if len(vars_) <= len(smps) else smps
    matrix = y.get("data") or []
    first_row = matrix[0] if matrix else []
    numeric = all(isinstance(v, (int, float)) for v in first_row) if first_row else True
    types = {str(c): ("numeric" if numeric else "string") for c in cols}
    headers = [str(c) for c in cols]
    for annot in ("x", "z"):
        for key in ((data or {}).get(annot) or {}).keys():
            if key not in types:
                headers.append(str(key))
                types[str(key)] = "factor"
    return headers, types
