"""Throwaway server for tests/browser/embed.cjs: a temp store with one published
two-panel dashboard. Prints {"token": ...} on stdout once seeded, then serves.

Usage: python embed-server.py <port> <tmpdir>
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "server", "src"))

import uvicorn  # noqa: E402

from cxd_server.app import create_dashboards_app  # noqa: E402
from cxd_server.store import DashboardStore  # noqa: E402

port, tmp = int(sys.argv[1]), sys.argv[2]
store = DashboardStore(os.path.join(tmp, "dash.db"))


def _data(n):
    return {"y": {"vars": ["V%d" % i for i in range(n)], "smps": ["A", "B", "C"],
                  "data": [[i + 1, i + 3, i + 2] for i in range(n)]}}


SPEC = {
    "id": "embedme", "title": "Embed me",
    "layout": {"cols": 12, "rowHeight": 120, "items": [
        {"panel": "tall", "x": 0, "y": 0, "w": 6, "h": 5},
        {"panel": "short", "x": 6, "y": 0, "w": 6, "h": 2},
    ]},
    "data": {"t": {"kind": "inline", "value": _data(3)},
             "s": {"kind": "inline", "value": _data(2)}},
    "panels": {"tall": {"dataRef": "t", "config": {"graphType": "Bar"}},
               "short": {"dataRef": "s", "config": {"graphType": "Line"}}},
}
store.save_dashboard("alice", SPEC, "2026-09-30T00:00:00Z")
summary = store.set_visibility("alice", "embedme", "public")
print(json.dumps({"token": summary["share_token"]}), flush=True)

app = create_dashboards_app(store=store, session_secret="embed-test", serve_static=True,
                            dataset_store_uri="file://" + os.path.join(tmp, "datasets"),
                            scheduler_enabled=False)
uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
