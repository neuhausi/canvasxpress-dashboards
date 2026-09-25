"""Live (streaming) sources on the server: spec validation (parity with
src/validateSpec.js), saving a live dashboard, the audit trail of a subscription
(a data read), and lineage."""

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.audit import action_for
from cxd_server.governance import build_lineage
from cxd_server.store import DashboardStore
from cxd_server.validate_spec import validate_spec

LIVE = {"kind": "live", "url": "/connectors/api/stream/demo?vars=cpu,mem", "window": 60,
        "variables": ["cpu", "mem"]}


def _spec(source):
    return {"schemaVersion": "1.2", "id": "live-ops", "title": "Live ops",
            "layout": {"cols": 12, "items": [{"panel": "p", "x": 0, "y": 0, "w": 12, "h": 3}]},
            "data": {"feed": source},
            "panels": {"p": {"title": "CPU", "dataRef": "feed", "config": {"graphType": "Line"}}}}


# ---------------------------------------------------------------- validation
def test_validate_accepts_a_live_source():
    result = validate_spec(_spec(LIVE))
    assert result["valid"] is True, result["errors"]


def test_validate_checks_live_fields_like_the_browser():
    bad = dict(LIVE, url="", window=0, variables=[1], initial={"no": "y"})
    errors = validate_spec(_spec(bad))["errors"]
    for message in ('of kind "live" requires a url string', ".window must be a positive integer",
                    ".variables must be an array of strings",
                    ".initial must be a CanvasXpress data object with a y block"):
        assert any(message in e for e in errors), (message, errors)
    # bool is not an integer window (True == 1 in Python)
    assert any(".window" in e for e in validate_spec(_spec(dict(LIVE, window=True)))["errors"])


# --------------------------------------------------------------- audit mapping
def test_action_for_resolves_mounted_routes_by_their_full_path():
    assert action_for("GET", "/api/stream/{stream}", "/connectors") == "live.subscribe"
    # this app's own routes (no mount) resolve exactly as before
    assert action_for("GET", "/api/stream/{stream}") is None
    assert action_for("GET", "/api/datasets/{dataset_id}") == "dataset.read"
    assert action_for("POST", "/auth/login") == "auth.login"
    # a mounted route is never mistaken for this app's route of the same name
    assert action_for("POST", "/auth/login", "/connectors") == "connectors.login"
    assert action_for("DELETE", "/api/sources/{name}", "/connectors") == "connectors.source.delete"
    # an unmapped mounted write is named by its full path; an unmapped read is not audited
    assert action_for("POST", "/api/other", "/elsewhere") == "api.POST /elsewhere/api/other"
    assert action_for("GET", "/api/stream/{stream}", "/other") is None


# ------------------------------------------------- saving + audit (full stack)
@pytest.fixture
def stack(tmp_path):
    """The dashboards app with the connectors app mounted at /connectors, as in
    examples/serve.py, and one user signed in to both (the bridged session)."""
    pytest.importorskip("cx_connectors")
    from cx_connectors.store import Store, generate_key
    from cx_connectors.web.byo_app import create_byo_app

    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")),
                                session_secret="s", serve_static=False,
                                dataset_store_uri="file://" + str(tmp_path / "datasets"))
    cstore = Store(str(tmp_path / "connectors.db"), generate_key())
    cstore.create_user("alice", "secret1")
    app.mount("/connectors", create_byo_app(store=cstore, session_secret="c",
                                            encryption_key=generate_key(), serve_static=False))
    client = TestClient(app)
    assert client.post("/auth/signup", json={"username": "alice", "password": "secret1"}).status_code == 200
    return app, client


def _events(app, **filters):
    return app.state.audit.query(limit=1000, **filters)["events"]


def test_a_live_dashboard_saves(stack):
    _, client = stack
    r = client.post("/api/dashboards", json=_spec(LIVE))
    assert r.status_code == 200, r.text


def test_a_subscription_is_audited_as_a_data_read(stack):
    app, client = stack
    assert client.post("/connectors/auth/login",
                       json={"username": "alice", "password": "secret1"}).status_code == 200
    r = client.get("/connectors/api/stream/demo?interval=0.1&max=1")
    assert r.status_code == 200 and "event: tick" in r.text
    events = _events(app, action="live.")
    assert [(e["action"], e["actor"], e["target"], e["outcome"]) for e in events] == [
        ("live.subscribe", "alice", "demo", "ok")]


def test_a_refused_subscription_is_audited_as_denied(stack):
    app, client = stack
    # Signed in to the dashboards app, but not (yet) to the connectors app.
    assert client.get("/connectors/api/stream/demo?max=1").status_code == 401
    events = _events(app, action="live.")
    assert [(e["action"], e["target"], e["outcome"]) for e in events] == [
        ("live.subscribe", "demo", "denied")]


def test_listing_streams_is_not_audited(stack):
    app, client = stack
    client.post("/connectors/auth/login", json={"username": "alice", "password": "secret1"})
    assert client.get("/connectors/api/streams").status_code == 200
    assert _events(app, action="live.") == []


# ------------------------------------------------------------------- lineage
def test_lineage_lists_live_streams():
    lineage = build_lineage([("alice", _spec(LIVE))])
    source = lineage["dashboards"][0]["sources"][0]
    assert (source["kind"], source["url"], source["window"]) == ("live", LIVE["url"], 60)
    assert lineage["live"] == [{"url": LIVE["url"],
                                "used_by": [{"owner": "alice", "id": "live-ops", "title": "Live ops"}]}]


def test_the_connectors_bridge_login_is_not_a_dashboards_sign_in(stack):
    app, client = stack
    assert client.post("/connectors/auth/login",
                       json={"username": "alice", "password": "secret1"}).status_code == 200
    logins = [(e["action"], e["actor"]) for e in _events(app, action="auth.login")]
    assert logins == [], "the bridge used to be recorded as a dashboards auth.login"
    assert [(e["action"], e["actor"], e["outcome"]) for e in _events(app, action="connectors.")] == [
        ("connectors.login", "alice", "ok")]


def test_audit_behind_a_reverse_proxy_subpath(tmp_path):
    """Same stack mounted under /dashboards (as on canvasxpress.org)."""
    pytest.importorskip("cx_connectors")
    from fastapi import FastAPI
    from cx_connectors.store import Store, generate_key
    from cx_connectors.web.byo_app import create_byo_app

    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")),
                                session_secret="s", serve_static=False,
                                dataset_store_uri="file://" + str(tmp_path / "datasets"))
    cstore = Store(str(tmp_path / "connectors.db"), generate_key())
    cstore.create_user("alice", "secret1")
    app.mount("/connectors", create_byo_app(store=cstore, session_secret="c",
                                            encryption_key=generate_key(), serve_static=False))
    outer = FastAPI()
    outer.mount("/dashboards", app)
    client = TestClient(outer)
    assert client.post("/dashboards/auth/signup",
                       json={"username": "alice", "password": "secret1"}).status_code == 200
    client.post("/dashboards/connectors/auth/login", json={"username": "alice", "password": "secret1"})
    assert client.get("/dashboards/connectors/api/stream/demo?max=1").status_code == 200
    actions = [e["action"] for e in reversed(_events(app))]
    assert actions == ["auth.signup", "connectors.login", "live.subscribe"], actions
