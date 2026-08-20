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

Every call degrades gracefully: any failure returns None and the caller falls
back to the LLM planner, so the app never hard-depends on the MCP server.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from typing import Optional


def _truthy(value: Optional[str], default: bool = True) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() not in ("0", "false", "no", "off")


def enabled() -> bool:
    """Whether the MCP bridge is turned on (CXD_MCP_ENABLED)."""
    return _truthy(os.getenv("CXD_MCP_ENABLED"), True)


def base_url() -> str:
    """The MCP server base URL (CXD_MCP_URL)."""
    return (os.getenv("CXD_MCP_URL") or "http://127.0.0.1:8100").rstrip("/")


def timeout_seconds() -> float:
    """Per-request timeout (CXD_MCP_TIMEOUT)."""
    try:
        return float(os.getenv("CXD_MCP_TIMEOUT") or 90)
    except ValueError:
        return 90.0


def _get(path: str, params: dict) -> Optional[dict]:
    """GET a REST endpoint on the MCP server; None on any failure."""
    if not enabled():
        return None
    url = base_url() + path + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=timeout_seconds()) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None
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


def modify_config(config: dict, instruction: str, headers: Optional[list] = None) -> Optional[dict]:
    """Existing config + plain-English instruction -> revised config (Phase 3)."""
    params = {"config": json.dumps(config), "instruction": instruction}
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
