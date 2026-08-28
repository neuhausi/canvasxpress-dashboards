#!/usr/bin/env python3
"""Standalone live-data adapter for the five database dashboards.

Serves ``/api/<db>`` (ccle, tcga, gtex, gencode, wp) from the SQLite files
(via :mod:`dbservices`) AND the repo's static files, so the example pages load
from the same origin. This is the no-framework way to run the DB dashboards;
the demo ``serve.py`` exposes the same ``/api/<db>`` routes when you run that.

    CXD_SQLITE_DIR=~/Downloads/sqlite python3 examples/db-adapter.py
    # then open  http://localhost:8899/examples/<dashboard>.html
"""
import os
import sys
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbservices  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PORT = int(os.environ.get("CXD_PORT", "8899"))
DBS = ("ccle", "tcga", "gtex", "gencode", "wp")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_GET(self):
        parsed = urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 2 and parts[0] == "api" and parts[1] in DBS:
            try:
                payload = dbservices.handle(parts[1], parse_qs(parsed.query))
            except Exception as exc:
                self.send_error(500, str(exc)); return
            if payload is None:
                self.send_error(404, "No data for these params"); return
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def log_message(self, fmt, *args):
        if args and "/api/" in str(args[0]):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    missing = [d for d in DBS if not os.path.exists(dbservices.db_path(d))]
    if missing:
        print("WARNING: missing SQLite for: %s (set CXD_SQLITE_DIR)" % ", ".join(missing))
    print("DB adapter serving %s" % ROOT)
    print("  SQLite dir: %s" % dbservices.SQLITE_DIR)
    print("  open: http://localhost:%d/examples/ccle-explorer.html  (and the other 4)" % PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
