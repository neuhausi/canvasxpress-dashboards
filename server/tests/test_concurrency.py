"""Several users at once, against a real uvicorn server (one process, as deployed).

A slow request must not stall everyone else's, and a new user's simultaneous
first requests must all sign in to one account.
"""

import json
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
import pytest

uvicorn = pytest.importorskip("uvicorn")

from cxd_server.app import create_dashboards_app  # noqa: E402
from cxd_server.store import DashboardStore  # noqa: E402

MCP_DELAY = 1.5


class SlowMcp(BaseHTTPRequestHandler):
    """A canvasxpress-mcp /generate that takes MCP_DELAY seconds to answer."""

    def do_GET(self):
        time.sleep(MCP_DELAY)
        data = json.dumps({"success": True, "warnings": [],
                           "config": {"graphType": "Bar"}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server(tmp_path, monkeypatch):
    mcp = HTTPServer(("127.0.0.1", 0), SlowMcp)
    threading.Thread(target=mcp.serve_forever, daemon=True).start()
    for name in ("CXD_MCP_AUTH", "CXD_MCP_REQUIRED", "CXD_LLM_API_KEY",
                 "CXD_POSIT_CONNECT_LINK_EXISTING"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CXD_MCP_ENABLED", "1")
    monkeypatch.setenv("CXD_MCP_URL", "http://127.0.0.1:%d" % mcp.server_port)
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
        serve_static=False, dataset_store_uri="file://" + str(tmp_path / "datasets"),
        scheduler_enabled=False, posit_connect_auth=True)
    port = _free_port()
    web = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=web.run, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    for _ in range(100):
        try:
            httpx.get(base + "/healthz")
            break
        except httpx.TransportError:
            time.sleep(0.05)
    yield base, app
    web.should_exit = True
    mcp.shutdown()


def creds(user):
    return {"RStudio-Connect-Credentials": json.dumps({"user": user, "groups": []})}


def test_a_slow_generation_does_not_stall_other_users(server):
    base, _ = server
    alice = httpx.Client(base_url=base, headers=creds("alice"), timeout=30)
    assert alice.post("/api/datasets", json={"format": "csv", "title": "Sales",
                                             "data": "id,sales\nA,10\nB,20\n"}).is_success
    with ThreadPoolExecutor(max_workers=1) as pool:
        slow = pool.submit(alice.post, "/api/llm/dashboard", json={"message": "bar chart"})
        time.sleep(0.3)                          # alice's request is now waiting on the MCP
        bob = httpx.Client(base_url=base, headers=creds("bob"), timeout=30)
        started = time.monotonic()
        assert bob.get("/auth/me").json()["user"] == "bob"
        assert bob.get("/api/dashboards").status_code == 200
        waited = time.monotonic() - started
        assert slow.result().status_code == 200, slow.result().text
    assert waited < MCP_DELAY / 2, "bob waited %.2fs behind alice's generation" % waited


def test_a_new_users_simultaneous_first_requests_share_one_account(server):
    base, app = server

    def first_visit(_):
        with httpx.Client(base_url=base, headers=creds("zed"), timeout=30) as c:
            r = c.get("/auth/me")
            return r.status_code, r.json().get("user")

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(first_visit, range(8)))
    assert results == [(200, "zed")] * 8
    events = app.state.audit.query(action="auth.sso")["events"]
    assert [(e["status"], (e.get("detail") or {}).get("created")) for e in events].count(
        (200, True)) == 1
