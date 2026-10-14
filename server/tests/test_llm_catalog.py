"""The assistant's dataset catalog matches what the user can SEE.

Regression for: shipped example datasets (owner = examples_owner, e.g. the
seeded "Bench: …" sets) appeared in the checklist (GET /api/datasets) but were
NOT cataloged by POST /api/llm/dashboard, so the model was told no datasets
exist and built panels on inline sample data.

The Anthropic client is stubbed (sys.modules), so no key or network is used;
the test inspects the catalog block the endpoint sends as the system prompt.
"""

import json
import sys
import types

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.store import DashboardStore

DATA = {"y": {"vars": ["G1", "G2"], "smps": ["S1", "S2"], "data": [[1, 2], [3, 4]]}}


class _FakeResponse:
    stop_reason = "end_turn"
    content = [types.SimpleNamespace(type="text",
                                     text=json.dumps({"reply": "ok", "spec": None}))]
    usage = types.SimpleNamespace(input_tokens=0, output_tokens=0)


class _FakeMessages:
    def __init__(self, calls):
        self._calls = calls

    def create(self, **kwargs):
        self._calls.append(kwargs)
        return _FakeResponse()


class _FakeAnthropic:
    calls = []   # kwargs of every messages.create, newest last

    def __init__(self, **kwargs):
        self.messages = _FakeMessages(_FakeAnthropic.calls)


@pytest.fixture
def client(tmp_path, monkeypatch):
    fake = types.ModuleType("anthropic")
    fake.Anthropic = _FakeAnthropic
    _FakeAnthropic.calls = []
    monkeypatch.setitem(sys.modules, "anthropic", fake)
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")),
        session_secret="test-secret",
        serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "datasets"),
        examples_owner="app",
        admins={"app"},
        llm_api_key="test-key",
    )
    return TestClient(app)


def _signup(client, username):
    r = client.post("/auth/signup", json={"username": username, "password": "secret1"})
    assert r.status_code == 200, r.text


def _catalog_sent():
    """The dataset catalog block from the last stubbed LLM call."""
    assert _FakeAnthropic.calls, "the endpoint never called the LLM"
    system = _FakeAnthropic.calls[-1]["system"]
    return json.loads(system[1]["text"].split("\n", 1)[1].split("\n\n")[0])


def test_example_owner_datasets_are_cataloged(client):
    # The examples owner seeds a shared dataset (what serve.py does for Bench).
    _signup(client, "app")
    r = client.post("/api/datasets", json={"data": DATA, "title": "Bench: expression",
                                           "id": "bench-expression"})
    assert r.status_code == 200, r.text
    client.post("/auth/logout")

    # Another user can SEE it in the checklist…
    _signup(client, "alice")
    listed = {d["id"] for d in client.get("/api/datasets").json()["datasets"]}
    assert "bench-expression" in listed

    # …and the assistant catalogs it too (this returned [] before the fix).
    r = client.post("/api/llm/dashboard",
                    json={"message": "a heatmap", "datasets": ["bench-expression"]})
    assert r.status_code == 200, r.text
    catalog = _catalog_sent()
    assert [e["id"] for e in catalog] == ["bench-expression"]
    assert catalog[0]["vars"] == ["G1", "G2"]


def test_own_dataset_shadows_the_example_with_the_same_id(client):
    _signup(client, "app")
    client.post("/api/datasets", json={"data": DATA, "title": "Example", "id": "ds1"})
    client.post("/auth/logout")
    _signup(client, "alice")
    mine = {"y": {"vars": ["Mine"], "smps": ["S1"], "data": [[9]]}}
    client.post("/api/datasets", json={"data": mine, "title": "Mine", "id": "ds1"})
    client.post("/api/llm/dashboard", json={"message": "chart", "datasets": ["ds1"]})
    catalog = _catalog_sent()
    assert len(catalog) == 1
    assert catalog[0]["vars"] == ["Mine"], "the user's own ds1 wins over the example"
