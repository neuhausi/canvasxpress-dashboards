"""The /api/dashboards/{id}/ask HTTP endpoint: gating, data resolution, wiring."""

import pytest
from fastapi.testclient import TestClient

from cxd_server import ask as ask_module
from cxd_server.app import create_dashboards_app
from cxd_server.store import DashboardStore


def _spec_with_data(dashboard_id="d1"):
    return {
        "id": dashboard_id, "title": "Sales", "layout": {"items": []}, "panels": {},
        "data": {"orders": {"kind": "inline", "value": {
            "y": {"vars": ["Revenue"], "smps": ["O1", "O2"], "data": [[100, 250]]},
            "x": {"Region": ["North", "South"]}}}},
    }


def _signup(client, username="alice", password="secret1"):
    assert client.post("/auth/signup", json={"username": username, "password": password}).status_code == 200


@pytest.fixture
def app_no_ai(tmp_path):
    store = DashboardStore(str(tmp_path / "dash.db"))
    return create_dashboards_app(store=store, session_secret="s", serve_static=False,
                                 dataset_store_uri="file://" + str(tmp_path / "ds"))


@pytest.fixture
def app_ai(tmp_path):
    store = DashboardStore(str(tmp_path / "dash.db"))
    return create_dashboards_app(store=store, session_secret="s", serve_static=False,
                                 dataset_store_uri="file://" + str(tmp_path / "ds"),
                                 llm_api_key="test-key")


def test_ask_requires_login(app_no_ai):
    anon = TestClient(app_no_ai)
    assert anon.post("/api/dashboards/d1/ask", json={"question": "hi"}).status_code == 401


def test_ask_empty_question_is_400(app_no_ai):
    c = TestClient(app_no_ai)
    _signup(c)
    c.post("/api/dashboards", json=_spec_with_data())
    assert c.post("/api/dashboards/d1/ask", json={"question": "  "}).status_code == 400


def test_ask_503_when_ai_not_configured(app_no_ai):
    c = TestClient(app_no_ai)
    _signup(c)
    c.post("/api/dashboards", json=_spec_with_data())
    r = c.post("/api/dashboards/d1/ask", json={"question": "which region leads?"})
    assert r.status_code == 503


def test_ask_answers_via_the_tool_loop(app_ai, monkeypatch):
    c = TestClient(app_ai)
    _signup(c)
    c.post("/api/dashboards", json=_spec_with_data())

    captured = {}

    def fake_run_ask(client, model, data_by_ref, question, **kw):
        captured["data_by_ref"] = data_by_ref
        captured["question"] = question
        return {"answer": "South leads with 250.",
                "used": [{"tool": "aggregate", "args": {}, "result": {"groups": []}}]}

    monkeypatch.setattr(ask_module, "run_ask", fake_run_ask)
    r = c.post("/api/dashboards/d1/ask", json={"question": "which region leads on revenue?"})
    assert r.status_code == 200, r.text
    assert r.json()["answer"] == "South leads with 250."
    # the dashboard's inline source was resolved and handed to the loop
    assert "orders" in captured["data_by_ref"]
    assert captured["question"] == "which region leads on revenue?"


def test_ask_422_when_no_inspectable_data(app_ai, monkeypatch):
    c = TestClient(app_ai)
    _signup(c)
    c.post("/api/dashboards", json={"id": "d2", "title": "Empty", "layout": {"items": []}, "panels": {}})
    monkeypatch.setattr(ask_module, "run_ask", lambda *a, **k: {"answer": "", "used": []})
    assert c.post("/api/dashboards/d2/ask", json={"question": "anything?"}).status_code == 422
