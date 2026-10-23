"""Reading a dashboard spec."""

from __future__ import annotations

import json
import os
from typing import Any, Dict


def read_spec(spec: Any) -> Dict[str, Any]:
    """A spec as a dict from a dict, a JSON string, or the path of a ``.json`` file (for example one saved
    from the dashboards builder or returned by the ``suggest_canvasxpress_dashboard`` MCP tool).

    :raises ValueError: When it is not a JSON object, or not valid JSON.
    :raises TypeError: For any other type.
    """
    if isinstance(spec, dict):
        return spec
    if isinstance(spec, os.PathLike):
        spec = os.fspath(spec)
    if isinstance(spec, str):
        stripped = spec.lstrip()
        if stripped[:1] in ("{", "["):
            text = spec
        elif os.path.isfile(spec):
            with open(spec, encoding="utf-8") as handle:
                text = handle.read()
        else:
            raise ValueError("`spec` is not JSON and no such file: %s" % spec)
        try:
            parsed = json.loads(text)
        except ValueError as exc:
            raise ValueError("`spec` is not valid JSON: %s" % exc) from None
        if not isinstance(parsed, dict):
            raise ValueError("a dashboard spec is a JSON object")
        return parsed
    raise TypeError("`spec` must be a dict, a JSON string or a file path")
