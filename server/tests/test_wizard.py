"""Data-first wizard, Visualize step (Datawrapper-parity P9): /api/wizard/suggest."""

import json

import pytest
from fastapi.testclient import TestClient

from cxd_server import mcp_bridge
from cxd_server.app import create_dashboards_app
from cxd_server.store import DashboardStore

ROWS = [["Country", "Region", "GDP", "LifeExp"],
        ["USA", "Americas", 65000, 79], ["Japan", "Asia", 42000, 84],
        ["India", "Asia", 2100, 70]]

MCP_RESPONSE = {
    "top_recommendation": {"graphType": "Scatter2D", "score": 0.91,
                           "description": "Two numeric measures against each other.",
                           "minimal_config": {"graphType": "Scatter2D", "xAxis": ["GDP"], "yAxis": ["LifeExp"]}},
    "alternatives": [
        {"graphType": "Bar", "score": 0.7, "description": "Compare a value across categories.",
         "minimal_config": {"graphType": "Bar"}},
        {"graphType": "Dotplot", "score": 0.6, "description": "", "minimal_config": None},
    ],
}


@pytest.fixture
def client(tmp_path):
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
                                serve_static=False, scheduler_enabled=False,
                                dataset_store_uri="file://" + str(tmp_path / "ds"))
    c = TestClient(app)
    assert c.post("/auth/signup", json={"username": "alice", "password": "secret1"}).status_code == 200
    return c


def test_suggest_maps_mcp_ranking(client, monkeypatch):
    seen = {}

    def fake_select(rows, intent=""):
        seen["rows"], seen["intent"] = rows, intent
        return MCP_RESPONSE

    monkeypatch.setattr(mcp_bridge, "select_charts", fake_select)
    r = client.post("/api/wizard/suggest", json={"rows": ROWS, "intent": "compare wealth and health"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "mcp"
    assert [s["graphType"] for s in body["suggestions"]] == ["Scatter2D", "Bar", "Dotplot"]
    assert body["suggestions"][0]["config"]["xAxis"] == ["GDP"]
    assert body["suggestions"][0]["reason"].startswith("Two numeric")
    assert body["suggestions"][2]["config"] == {"graphType": "Dotplot"}   # missing config filled
    assert seen["intent"] == "compare wealth and health"


def test_suggest_degrades_when_mcp_unavailable(client, monkeypatch):
    monkeypatch.setattr(mcp_bridge, "select_charts", lambda rows, intent="": None)
    r = client.post("/api/wizard/suggest", json={"rows": ROWS})
    assert r.status_code == 200
    assert r.json() == {"source": "none", "suggestions": []}


def test_suggest_validates_and_requires_login(client, tmp_path):
    assert client.post("/api/wizard/suggest", json={"rows": [["only header"]]}).status_code == 400
    assert client.post("/api/wizard/suggest", json={"rows": "nope"}).status_code == 400
    anon_app = create_dashboards_app(store=DashboardStore(str(tmp_path / "a.db")), session_secret="s",
                                     serve_static=False, scheduler_enabled=False,
                                     dataset_store_uri="file://" + str(tmp_path / "ds2"))
    assert TestClient(anon_app).post("/api/wizard/suggest", json={"rows": ROWS}).status_code == 401


def test_bridge_select_charts_samples_rows_and_passes_count(monkeypatch):
    captured = {}

    def fake_get(path, params):
        captured["path"], captured["params"] = path, params
        return MCP_RESPONSE

    monkeypatch.setattr(mcp_bridge, "_get", fake_get)
    big = [["A", "B"]] + [[i, "x%d" % (i % 3)] for i in range(1000)]
    assert mcp_bridge.select_charts(big, "trend")["top_recommendation"]["graphType"] == "Scatter2D"
    assert captured["path"] == "/select"
    sent = json.loads(captured["params"]["data"])
    assert len(sent) == mcp_bridge._SELECT_SAMPLE_ROWS + 1          # bounded sample + header
    assert captured["params"]["n_samples"] == "1000"                  # true row count
    assert captured["params"]["intent"] == "trend"
    assert mcp_bridge.select_charts([["A"]]) is None                   # no data rows
