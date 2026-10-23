"""The :class:`Dashboard`: a dashboards spec (or a DataFrame to suggest one for) that renders in a
notebook, saves as a standalone page, or embeds in Dash, Streamlit, Flask and friends."""

from __future__ import annotations

import html as _html
import json
import os
import tempfile
import uuid
import webbrowser
from typing import Any, Dict, Optional

from .data import cxd_data
from .spec import read_spec

ENGINE_URL = "https://www.canvasxpress.org/dist"
_ASSET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "canvasxpress-dashboards.umd.js")


def _bundle() -> str:
    with open(_ASSET, encoding="utf-8") as handle:
        return handle.read()


def _json_for_script(value: Any) -> str:
    """JSON that is safe inside a ``<script>`` element: no ``</script>``, no U+2028/9."""
    text = json.dumps(value, allow_nan=False, ensure_ascii=False, separators=(",", ":"))
    return (text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


class Dashboard:
    """A dashboard to render.

    Give **either** a ``spec`` (rendered as written) **or** ``data`` (a dashboard is suggested for it).
    With ``data`` the dashboard is assembled in the browser from the same templates as the dashboards
    wizard: a patient cohort (a numeric time column such as ``os_months`` or ``time`` plus a numeric 0/1
    event column) gets filters, a Kaplan-Meier curve, a measure by group and against time, and a case
    card; a per-sample sequencing run-QC table (three or more of reads, mapping, quality, duplication,
    GC, insert size, coverage, adapter, contamination) gets filters, depth per sample, mapping against
    duplication and quality by lane or batch. Clicking a patient or sample loads its record into the case
    card. If no template fits, the page says so instead of guessing; pass a ``spec``.

    The server-computed insights strip (``insights`` in a spec) needs the dashboards server and is not
    shown here; neither are connector, dataset or live sources. Inline data (what a DataFrame becomes)
    works anywhere, including a saved standalone page.

    :param spec: A dashboard spec: a dict, a JSON string, or the path of a ``.json`` file.
    :param data: A DataFrame, a dict of columns, a list of records, or a CanvasXpress data object.
    :param id: With tabular data: the column holding the record names (default: the index).
    :param title: A dashboard title (overrides the spec's, or the template's).
    :param theme: A theme (``"light"``, ``"dark"``, ``"auto"``, ``"editorial"`` ...), overriding the spec's.
    :param engine_url: Where the CanvasXpress engine comes from: a folder URL holding ``canvasXpress.min.js``
        and ``canvasXpress.css`` (default: the current release from canvasxpress.org).
    :param bundle_url: Load the dashboards bundle from this URL instead of inlining it (1 MB per page).
    :param height: The height, in pixels, a notebook output starts at; it then follows the dashboard.
    """

    def __init__(self, spec: Any = None, data: Any = None, id: Optional[str] = None, title: Optional[str] = None,
                 theme: Optional[str] = None, engine_url: str = ENGINE_URL, bundle_url: Optional[str] = None,
                 height: int = 700) -> None:
        if spec is None and data is None:
            raise ValueError("give a `spec` to render or `data` to suggest a dashboard for")
        if spec is not None and data is not None:
            raise ValueError("give either a `spec` (rendered as written) or `data` (a dashboard is suggested "
                             "for it), not both")
        self.suggest = spec is None
        if self.suggest:
            if isinstance(data, dict) and isinstance(data.get("y"), dict):
                self.data: Optional[Dict[str, Any]] = data          # already a CanvasXpress data object
            else:
                self.data = cxd_data(data, id=id)
            self.spec: Optional[Dict[str, Any]] = None
        else:
            self.spec = read_spec(spec)
            self.data = None
        self.title, self.theme = title, theme
        self.engine_url = engine_url.rstrip("/")
        self.bundle_url = bundle_url
        self.height = int(height)
        self.frame_id = "cxd-" + uuid.uuid4().hex[:12]

    # ---- the payload every wrapper shares -----------------------------------------------------
    def payload(self) -> Dict[str, Any]:
        """What ``CanvasXpressDashboards.renderPayload`` takes: JSON strings plus flags."""
        payload: Dict[str, Any] = {"suggest": self.suggest}
        if self.suggest:
            payload["dataJson"] = json.dumps(self.data, allow_nan=False)
        else:
            payload["specJson"] = json.dumps(self.spec, allow_nan=False)
        if self.title:
            payload["title"] = self.title
        if self.theme:
            payload["theme"] = self.theme
        return payload

    def to_dict(self) -> Optional[Dict[str, Any]]:
        """The spec as written (``None`` for a dashboard suggested from data: it is built in the browser)."""
        return self.spec

    # ---- rendering ----------------------------------------------------------------------------
    def to_html(self, frame: bool = False) -> str:
        """A complete, standalone HTML page.

        :param frame: Also report to the embedding page: ``postMessage`` of ``{type: "cxd-resize", id, height}``
            whenever the dashboard's height changes and ``{type: "cxd-params", id, params}`` when a parameter
            (for the case-card dashboards, the patient last clicked) changes. Used by the notebook output.
        """
        bundle = ('<script src="%s"></script>' % _html.escape(self.bundle_url, quote=True)) if self.bundle_url else \
            "<script>%s</script>" % _bundle().replace("</script", "<\\/script")
        reporting = ""
        if frame:
            reporting = (
                "var frameId = %s;\n"
                "function post(m) { try { parent.postMessage(m, '*'); } catch (e) {} }\n"
                "if (window.ResizeObserver) new ResizeObserver(function () { post({ type: 'cxd-resize', id: frameId, "
                "height: document.documentElement.scrollHeight }); }).observe(document.body);\n" % _json_for_script(self.frame_id))
        on_param = ("onParamChange: function (name, value, done, h) { Promise.resolve(done).then(function () { "
                    "post({ type: 'cxd-params', id: frameId, params: (h || {}).getParams ? h.getParams() : {} }); }); }") if frame else ""
        return (
            "<!doctype html>\n<html><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<link rel=\"stylesheet\" href=\"%(engine)s/canvasXpress.css\">"
            "<script src=\"%(engine)s/canvasXpress.min.js\"></script>%(bundle)s"
            "<style>html,body{margin:0;background:transparent}#cxd-root{width:100%%}</style></head>"
            "<body><div id=\"cxd-root\"></div><script>\n(function () {\n%(reporting)s"
            "CanvasXpressDashboards.renderPayload(document.getElementById('cxd-root'), %(payload)s, "
            "{ idPrefix: %(prefix)s%(comma)s %(onparam)s });\n})();\n</script></body></html>\n"
        ) % {"engine": _html.escape(self.engine_url, quote=True), "bundle": bundle, "reporting": reporting,
             "payload": _json_for_script(self.payload()), "prefix": _json_for_script(self.frame_id),
             "comma": "," if on_param else "", "onparam": on_param}

    def iframe_html(self, height: Optional[int] = None) -> str:
        """The dashboard inside an ``<iframe srcdoc>``, so its scripts and styles cannot touch the host page.
        The frame grows and shrinks with the dashboard (it listens for the page's resize messages)."""
        h = int(height or self.height)
        frame = ('<iframe id="%(id)s" srcdoc="%(doc)s" style="width:100%%;height:%(h)dpx;border:0;display:block" '
                 'title="CanvasXpress dashboard"></iframe>') % {"id": self.frame_id, "h": h,
                                                                 "doc": _html.escape(self.to_html(frame=True), quote=True)}
        listener = ("<script>(function(){var id=%s;window.addEventListener('message',function(e){var d=e.data;"
                    "if(d&&d.type==='cxd-resize'&&d.id===id){var f=document.getElementById(id);"
                    "if(f)f.style.height=Math.max(120,Math.ceil(d.height))+'px';}});})();</script>") % _json_for_script(self.frame_id)
        return frame + listener

    def _repr_html_(self) -> str:       # Jupyter, VS Code, Quarto, Colab
        return self.iframe_html()

    # ---- output -------------------------------------------------------------------------------
    def save(self, path: "str | os.PathLike") -> str:
        """Write a standalone page and return its path."""
        path = os.fspath(path)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(self.to_html())
        return path

    def show(self) -> str:
        """Open the dashboard in the default browser (a temporary file) and return its path."""
        handle, path = tempfile.mkstemp(suffix=".html", prefix="cxdashboard-")
        os.close(handle)
        self.save(path)
        webbrowser.open("file://" + path)
        return path

    def __repr__(self) -> str:
        what = "data (suggested)" if self.suggest else "spec %r" % (self.spec or {}).get("id")
        return "<canvasxpress_dashboards.Dashboard %s>" % what


def dashboard(spec: Any = None, data: Any = None, **kwargs: Any) -> Dashboard:
    """Shorthand for :class:`Dashboard`."""
    return Dashboard(spec=spec, data=data, **kwargs)
