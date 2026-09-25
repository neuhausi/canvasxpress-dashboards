"""The canvasxpress-mcp bridge: auth header, and failing loudly when it is required."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient

from cxd_server import mcp_bridge
from cxd_server.app import create_dashboards_app
from cxd_server.store import DashboardStore

CONFIG = {"graphType": "Bar", "xAxis": ["sales"]}


class FakeMcp(BaseHTTPRequestHandler):
    """/generate and /cache-stats, behind an optional required Authorization value."""

    auth = None     # the Authorization value the server demands (None = open)
    seen = []       # Authorization headers received, in order

    def do_GET(self):
        got = self.headers.get("Authorization")
        FakeMcp.seen.append(got)
        if FakeMcp.auth is not None and got != FakeMcp.auth:
            self.send_response(401)
            self.end_headers()
            return
        path = self.path.split("?", 1)[0]
        body = ({"success": True, "config": dict(CONFIG), "warnings": []}
                if path == "/generate" else {"hits": 0})
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


@pytest.fixture
def mcp(monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), FakeMcp)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    FakeMcp.auth, FakeMcp.seen = None, []
    for name in ("CXD_MCP_AUTH", "CXD_MCP_REQUIRED", "CXD_MCP_LOG", "CXD_LLM_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CXD_MCP_ENABLED", "1")
    monkeypatch.setenv("CXD_MCP_URL", "http://127.0.0.1:%d" % server.server_port)
    yield FakeMcp
    server.shutdown()


def signed_in(tmp_path):
    client = TestClient(create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
        serve_static=False, dataset_store_uri="file://" + str(tmp_path / "datasets"),
        scheduler_enabled=False))
    signup = client.post("/auth/signup", json={"username": "alice", "password": "secret1"})
    assert signup.is_success
    assert client.post("/api/datasets", json={"format": "csv", "title": "Sales",
                                              "data": "id,sales\nA,10\nB,20\n"}).is_success
    return client


def ask(client):
    return client.post("/api/llm/dashboard", json={"message": "bar chart of sales"})


def test_no_auth_configured_sends_no_header(mcp):
    assert mcp_bridge.generate_config("bar", ["id", "sales"], {})["config"] == CONFIG
    assert mcp.seen == [None]


def test_auth_header_is_sent(mcp, monkeypatch):
    mcp.auth = "Key test-key"
    monkeypatch.setenv("CXD_MCP_AUTH", "Key test-key")
    assert mcp_bridge.generate_config("bar", ["id", "sales"], {})["config"] == CONFIG
    assert mcp.seen == ["Key test-key"]


def test_rejected_by_default_degrades_quietly(mcp):
    mcp.auth = "Key test-key"
    assert mcp_bridge.generate_config("bar", ["id", "sales"], {}) is None


def test_rejected_when_required_raises_with_the_reason(mcp, monkeypatch):
    mcp.auth = "Key test-key"
    monkeypatch.setenv("CXD_MCP_REQUIRED", "on")
    with pytest.raises(mcp_bridge.BridgeError, match="401"):
        mcp_bridge.generate_config("bar", ["id", "sales"], {})


def test_ping(mcp, monkeypatch):
    assert mcp_bridge.ping() is None
    mcp.auth = "Key test-key"
    assert "401" in mcp_bridge.ping()
    monkeypatch.setenv("CXD_MCP_AUTH", "Key test-key")
    assert mcp_bridge.ping() is None
    monkeypatch.setenv("CXD_MCP_ENABLED", "0")
    assert "disabled" in mcp_bridge.ping()


def test_chat_fast_path_uses_the_authenticated_bridge(mcp, monkeypatch, tmp_path):
    mcp.auth = "Key test-key"
    monkeypatch.setenv("CXD_MCP_AUTH", "Key test-key")
    r = ask(signed_in(tmp_path))
    assert r.status_code == 200, r.text
    assert r.json()["spec"]["panels"]["p1"]["config"]["graphType"] == "Bar"


def test_chat_with_a_broken_required_bridge_is_a_502_not_a_fallback(mcp, monkeypatch,
                                                                     tmp_path):
    mcp.auth = "Key test-key"                        # the app sends no key
    monkeypatch.setenv("CXD_MCP_REQUIRED", "on")
    r = ask(signed_in(tmp_path))
    assert r.status_code == 502 and "canvasxpress-mcp /generate failed" in r.json()["detail"]


def test_readyz_checks_the_bridge_only_when_required(mcp, monkeypatch, tmp_path):
    mcp.auth = "Key test-key"
    client = signed_in(tmp_path)
    assert "mcp" not in client.get("/readyz").json()["checks"]
    monkeypatch.setenv("CXD_MCP_REQUIRED", "on")
    r = client.get("/readyz")
    assert r.status_code == 503 and "401" in r.json()["checks"]["mcp"]
    monkeypatch.setenv("CXD_MCP_AUTH", "Key test-key")
    r = client.get("/readyz")
    assert r.status_code == 200 and r.json()["checks"]["mcp"] == "ok"
