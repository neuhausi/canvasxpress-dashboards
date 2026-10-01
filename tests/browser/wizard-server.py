"""Throwaway server for tests/browser/wizard.cjs: an empty store serving the app
shell (static index.html) on 127.0.0.1:<port>. Prints {"ready": true} once built.

Usage: python wizard-server.py <port> <tmpdir>
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
os.environ.setdefault("CXD_MCP_ENABLED", "0")   # the test stubs /api/wizard/suggest itself
app = create_dashboards_app(store=DashboardStore(os.path.join(tmp, "dash.db")),
                            session_secret="wizard-test", serve_static=True,
                            dataset_store_uri="file://" + os.path.join(tmp, "datasets"),
                            scheduler_enabled=False, allow_signup=True)
print(json.dumps({"ready": True}), flush=True)
uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
