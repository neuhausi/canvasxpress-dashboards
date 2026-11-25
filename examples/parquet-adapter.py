#!/usr/bin/env python3
"""Standalone live-data adapter for the parquet-explorer example.

Serves ``GET /api/parquet`` (with the dashboard's pushdown ``_q`` forwarded to DuckDB
via canvasxpress-connectors) from a seed Parquet file, AND the repo's static files, so
the example page loads same-origin with no framework. This is the no-framework way to
run the Parquet dashboard; the demo ``serve.py`` exposes the same ``/api/parquet`` route.

    python3 examples/gen-parquet.py                 # once: writes examples/data/demo.parquet
    CXD_PARQUET=examples/data/demo.parquet python3 examples/parquet-adapter.py   # serves :8899
    # then open  http://localhost:8899/examples/parquet-explorer.html

The 300k-row file is aggregated in DuckDB: a grouped ``_q`` returns a dozen rows, not
the whole file (see the ``X-Cx-Rows`` response header).
"""
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PORT = int(os.environ.get("CXD_PORT", "8899"))
PARQUET = os.environ.get(
    "CXD_PARQUET", os.path.join(os.path.dirname(__file__), "data", "demo.parquet"))
ROW_CAP = int(os.environ.get("CX_MAX_ROWS", "100000"))


def _pushdown_cx(header, rows, query):
    """CanvasXpress data for a pushdown result (mirrors the connectors app helper)."""
    from cx_connectors.reshape import rows_to_cx

    groups = query.get("groupBy") or []
    if groups:
        header = ["id"] + list(header)
        rows = [[" · ".join(str(v) for v in r[:len(groups)])] + list(r) for r in rows]
    if not rows:
        measures = [h for h in header[1:] if h not in groups]
        return {"y": {"vars": measures, "smps": [], "data": [[] for _ in measures]}}
    return rows_to_cx(header, rows)


def handle(qs):
    """Serve /api/parquet: a pushdown ``_q`` query, else the whole (capped) file."""
    from cx_connectors.pushdown import parse_query, run_pushdown
    from cx_connectors.sources import ParquetSource, to_cx

    src = ParquetSource(PARQUET)
    raw_q = (qs.get("_q") or [None])[0]
    if raw_q:
        query = parse_query(raw_q)
        header, rows, truncated = run_pushdown(src.conn_url, src.sql, {}, query, ROW_CAP)
        return _pushdown_cx(header, rows, query), len(rows), truncated
    obj = to_cx(src)
    return obj, len(obj.get("y", {}).get("smps", [])), False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.strip("/") == "api/parquet":
            try:
                payload, nrows, truncated = handle(parse_qs(parsed.query))
            except Exception as exc:
                self.send_error(500, str(exc)); return
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Cx-Rows", str(nrows))
            self.send_header("X-Cx-Truncated", "1" if truncated else "0")
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def log_message(self, fmt, *args):
        if args and "/api/" in str(args[0]):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    if not os.path.exists(PARQUET):
        print("ERROR: %s missing — run: python3 examples/gen-parquet.py" % PARQUET)
        sys.exit(1)
    print("Parquet adapter serving %s" % ROOT)
    print("  Parquet file: %s" % PARQUET)
    print("  open: http://localhost:%d/examples/parquet-explorer.html" % PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
