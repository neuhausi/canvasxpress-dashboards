"""Publish & embed a single chart from a shared dashboard.

A share token publishes a whole dashboard; these helpers let one of its panels
be embedded on its own:

* :func:`single_panel_spec` prunes a spec down to one panel, the data sources
  it transitively depends on (join inputs, function inputs) and the
  relationships among those sources. The server applies it *before* resolving
  stored datasets, so the other panels' data is never read or sent.
* :func:`embed_snippets` builds the copy-paste embed codes for a share: a stable
  URL, an ``<iframe>`` whose height follows its content (``postMessage``), a
  ``<cxd-embed>`` web component, and a static PNG fallback for RSS / email.

The share token stays the publish handle, so saving the dashboard republishes
every embed in place, and each save is already recorded in the version history.
"""

from __future__ import annotations

import copy
import html
from typing import Any, Dict, List, Optional, Set
from urllib.parse import quote

# Page-level keys that make no sense for a lone embedded chart: page controls,
# saved filter schemes and fixed page sizes (the embed fills its iframe).
_DROPPED_KEYS = ("controls", "filterSchemes", "width", "height")


def _source_inputs(source: Any) -> List[str]:
    """Refs a data source reads from (join sides, function inputs)."""
    if not isinstance(source, dict):
        return []
    kind = source.get("kind")
    if kind == "join":
        return [ref for ref in (source.get("left"), source.get("right")) if isinstance(ref, str)]
    if kind == "function":
        inputs = source.get("inputs")
        if isinstance(inputs, list):
            return [ref for ref in inputs if isinstance(ref, str)]
        if isinstance(inputs, dict):
            return [ref for ref in inputs.values() if isinstance(ref, str)]
    return []


def _required_sources(data: Dict[str, Any], root: Optional[str]) -> Set[str]:
    """The source ``root`` plus everything it transitively reads."""
    keep: Set[str] = set()
    pending = [root] if root else []
    while pending:
        ref = pending.pop()
        if ref in keep or ref not in data:
            continue
        keep.add(ref)
        pending.extend(_source_inputs(data[ref]))
    return keep


def single_panel_spec(spec: Dict[str, Any], panel_id: str) -> Dict[str, Any]:
    """Return a copy of ``spec`` holding only panel ``panel_id``.

    The panel keeps its own config and gets one full-width layout item; only the
    data sources it depends on survive, and only the relationships whose two
    sources both survive.

    :raises KeyError: When the spec has no such panel.
    """
    panels = spec.get("panels") or {}
    if panel_id not in panels:
        raise KeyError(panel_id)
    out = copy.deepcopy(spec)
    panel = out["panels"][panel_id]
    out["panels"] = {panel_id: panel}

    layout = out.get("layout") or {}
    cols = layout.get("cols") or 12
    height = 3
    for item in layout.get("items") or []:
        if isinstance(item, dict) and item.get("panel") == panel_id:
            height = item.get("h") or height
            break
    layout["items"] = [{"panel": panel_id, "x": 0, "y": 0, "w": cols, "h": height}]
    out["layout"] = layout

    data = out.get("data") or {}
    keep = _required_sources(data, panel.get("dataRef") if isinstance(panel, dict) else None)
    out["data"] = {ref: source for ref, source in data.items() if ref in keep}

    relationships = out.get("relationships")
    if isinstance(relationships, list):
        out["relationships"] = [
            rel for rel in relationships
            if isinstance(rel, dict)
            and all(ref in keep for ref in _relationship_refs(rel))
        ]

    for key in _DROPPED_KEYS:
        out.pop(key, None)
    # Fill the iframe instead of the 1600px page cap.
    out["maxWidth"] = "none"
    return out


def _relationship_refs(rel: Dict[str, Any]) -> List[str]:
    """The two source refs a relationship ties together (schema: left, right)."""
    return [rel.get("left"), rel.get("right")]


def embed_snippets(base_url: str, token: str, panel: Optional[str] = None,
                   height: int = 480) -> Dict[str, str]:
    """Copy-paste embed codes for a share token (optionally one panel).

    :param base_url: Absolute origin + path prefix the viewer pages live under.
    :param token: The dashboard's share token.
    :param panel: Panel id to embed alone; ``None`` embeds the whole dashboard.
    :param height: Initial iframe height before the content reports its own.
    :returns: ``url`` (stable embed page), ``iframe`` (with its resize listener),
        ``script`` (the ``<cxd-embed>`` web component) and ``image`` (PNG
        fallback for RSS / email).
    """
    base = base_url.rstrip("/")
    query = "token=" + quote(token, safe="")
    if panel:
        query += "&panel=" + quote(panel, safe="")
    url = base + "/embed.html?" + query
    image = base + "/api/shared/" + quote(token, safe="") + "/image.png" + (
        "?panel=" + quote(panel, safe="") if panel else "")
    attr_url = html.escape(url, quote=True)
    iframe = (
        '<iframe src="%s" title="CanvasXpress chart" loading="lazy" '
        'style="width:100%%;height:%dpx;border:0" data-cxd-embed></iframe>\n'
        "<script>window.addEventListener('message',function(e){"
        "if(!e.data||e.data.type!=='cxd-embed:resize')return;"
        "document.querySelectorAll('iframe[data-cxd-embed]').forEach(function(f){"
        "if(f.contentWindow===e.source)f.style.height=e.data.height+'px';});});</script>"
    ) % (attr_url, int(height))
    script = (
        '<script src="%s/embed.js" async></script>\n'
        '<cxd-embed src="%s"></cxd-embed>'
    ) % (html.escape(base, quote=True), attr_url)
    return {"url": url, "iframe": iframe, "script": script, "image": image}


def apply_brand(spec: Dict[str, Any], brand: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Force the organisation brand (``CXD_BRAND``) onto a spec's top-level keys.

    Only the brand's own keys are touched (e.g. ``theme``, ``colorScheme``,
    ``fontName``, ``background``); everything else is left as the author wrote
    it. Returns the same (mutated) spec.
    """
    if brand:
        for key, value in brand.items():
            spec[key] = value
    return spec
