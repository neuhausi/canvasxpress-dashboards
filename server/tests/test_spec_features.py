import json
from pathlib import Path

from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.spec_features import spec_features
from cxd_server.store import DashboardStore


def test_empty_and_garbage():
    assert spec_features({}) == []
    assert spec_features(None) == []
    assert spec_features({"data": [], "panels": 3}) == []


def test_each_feature():
    spec = {
        "relationships": [{"left": "a", "right": "b"}],
        "data": {
            "a": {"kind": "inline", "calculatedFields": [{"name": "x"}], "pushdown": {"limit": 5}},
            "j": {"kind": "join"},
            "f": {"kind": "function"},
            "l": {"kind": "live"},
        },
        "panels": {"p": {"type": "filters"}, "q": {"type": "chart"}},
    }
    assert spec_features(spec) == ["links", "fields", "shape", "filters", "join", "function", "live"]


def test_join_implies_links():
    assert spec_features({"data": {"j": {"kind": "join"}}}) == ["links", "join"]


def test_shipped_sales_model():
    path = Path(__file__).resolve().parents[2] / "examples" / "sales-model.spec.json"
    got = spec_features(json.loads(path.read_text()))
    assert "links" in got


def test_endpoint(tmp_path):
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
                                serve_static=False, dataset_store_uri="file://" + str(tmp_path / "ds"))
    c = TestClient(app)
    assert c.get("/api/dashboards/features").status_code == 401
    c.post("/auth/signup", json={"username": "alice", "password": "secret1"})
    c.post("/api/dashboards", json={"id": "d1", "layout": {"items": []}, "panels": {},
                                    "relationships": [{"left": "a", "right": "b", "on": {}}]})
    c.post("/api/dashboards", json={"id": "d2", "layout": {"items": []}, "panels": {}})
    got = c.get("/api/dashboards/features").json()["features"]
    assert got["alice/d1"] == ["links"] and got["alice/d2"] == []
