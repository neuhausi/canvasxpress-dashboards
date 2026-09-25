"""Sign-in delegated to Posit Connect's RStudio-Connect-Credentials header."""

import json

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.posit_connect import connect_user
from cxd_server.store import DashboardStore


def make_app(tmp_path, **cfg):
    return create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")),
        session_secret="test-secret",
        serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "datasets"),
        scheduler_enabled=False,
        **cfg,
    )


def creds(user, groups=()):
    return {"RStudio-Connect-Credentials": json.dumps({"user": user, "groups": list(groups)})}


def _spec(dashboard_id="d1"):
    return {"id": dashboard_id, "title": "Sales", "layout": {"items": []}, "panels": {}}


@pytest.mark.parametrize("raw, expected", [
    ('{"user": "alice", "groups": ["g"]}', "alice"),
    ('{"user": "  bob "}', "bob"),
    ('{"user": ""}', None),
    ('{"user": null}', None),
    ('{"groups": []}', None),
    ('["alice"]', None),
    ("not json", None),
])
def test_connect_user_parses_header(raw, expected):
    assert connect_user({"rstudio-connect-credentials": raw}) == expected
    assert connect_user({}) is None


def test_header_signs_in_and_creates_account(tmp_path):
    client = TestClient(make_app(tmp_path, posit_connect_auth=True))
    me = client.get("/auth/me", headers=creds("alice")).json()
    assert me["user"] == "alice" and me["sso"] is True
    # The account is real: it can save, and the session carries on without the header.
    assert client.post("/api/dashboards", json=_spec(), headers=creds("alice")).status_code == 200
    assert [d["id"] for d in client.get("/api/dashboards").json()["dashboards"]] == ["d1"]


def test_returning_user_keeps_their_dashboards(tmp_path):
    app = make_app(tmp_path, posit_connect_auth=True)
    first = TestClient(app)
    first.post("/api/dashboards", json=_spec(), headers=creds("alice"))
    second = TestClient(app)   # new browser, no session cookie
    listing = second.get("/api/dashboards", headers=creds("alice")).json()["dashboards"]
    assert [d["id"] for d in listing] == ["d1"]


def test_a_different_connect_user_replaces_the_session(tmp_path):
    client = TestClient(make_app(tmp_path, posit_connect_auth=True))
    client.post("/api/dashboards", json=_spec(), headers=creds("alice"))
    me = client.get("/auth/me", headers=creds("bob")).json()
    assert me["user"] == "bob"
    assert client.get("/api/dashboards", headers=creds("bob")).json()["dashboards"] == []


def test_off_by_default_ignores_the_header(tmp_path, monkeypatch):
    monkeypatch.delenv("CXD_POSIT_CONNECT_AUTH", raising=False)
    client = TestClient(make_app(tmp_path))
    assert client.get("/auth/me", headers=creds("alice")).json()["user"] is None
    assert client.get("/api/dashboards", headers=creds("alice")).status_code == 401
    assert client.get("/auth/config").json()["posit_connect"] is False


def test_env_var_turns_it_on(tmp_path, monkeypatch):
    monkeypatch.setenv("CXD_POSIT_CONNECT_AUTH", "on")
    client = TestClient(make_app(tmp_path))
    assert client.get("/auth/me", headers=creds("alice")).json()["user"] == "alice"
    assert client.get("/auth/config").json()["posit_connect"] is True


def test_no_header_falls_back_to_password_login(tmp_path):
    client = TestClient(make_app(tmp_path, posit_connect_auth=True))
    assert client.get("/auth/me").json()["user"] is None
    r = client.post("/auth/signup", json={"username": "carol", "password": "secret1"})
    assert r.status_code == 200
    assert client.get("/auth/me").json()["user"] == "carol"


def test_same_named_password_account_is_not_taken_over(tmp_path, monkeypatch):
    monkeypatch.delenv("CXD_POSIT_CONNECT_LINK_EXISTING", raising=False)
    app = make_app(tmp_path, posit_connect_auth=True)
    pw = TestClient(app)
    pw.post("/auth/signup", json={"username": "alice", "password": "secret1"})
    pw.post("/api/dashboards", json=_spec())
    via_connect = TestClient(app)
    r = via_connect.get("/api/dashboards", headers=creds("alice"))
    assert r.status_code == 409 and "already exists" in r.text
    assert via_connect.get("/auth/me").json()["user"] is None


def test_link_existing_signs_into_the_same_named_account(tmp_path, monkeypatch):
    monkeypatch.setenv("CXD_POSIT_CONNECT_LINK_EXISTING", "on")
    app = make_app(tmp_path, posit_connect_auth=True)
    pw = TestClient(app)
    pw.post("/auth/signup", json={"username": "alice", "password": "secret1"})
    pw.post("/api/dashboards", json=_spec())
    via_connect = TestClient(app)
    listing = via_connect.get("/api/dashboards", headers=creds("alice")).json()["dashboards"]
    assert [d["id"] for d in listing] == ["d1"]


def test_connect_admins_come_from_cxd_admins(tmp_path):
    client = TestClient(make_app(tmp_path, posit_connect_auth=True, admins={"alice"}))
    assert client.get("/auth/me", headers=creds("alice")).json()["is_admin"] is True
    other = TestClient(client.app)
    assert other.get("/auth/me", headers=creds("bob")).json()["is_admin"] is False


def test_signins_are_audited_once_per_session(tmp_path, monkeypatch):
    monkeypatch.delenv("CXD_POSIT_CONNECT_LINK_EXISTING", raising=False)
    app = make_app(tmp_path, posit_connect_auth=True)
    client = TestClient(app)
    client.get("/auth/me", headers=creds("alice"))
    client.get("/auth/me", headers=creds("alice"))       # same session: no new event
    TestClient(app).get("/auth/me", headers=creds("alice"))   # new browser: returning user
    pw = TestClient(app)
    pw.post("/auth/signup", json={"username": "bob", "password": "secret1"})
    TestClient(app).get("/auth/me", headers=creds("bob"))     # refused
    events = app.state.audit.query(action="auth.sso")["events"]
    got = [(e["target"], e["status"], (e.get("detail") or {}).get("created")) for e in events]
    assert got == [("bob", 409, None), ("alice", 200, None), ("alice", 200, True)]
    assert all(e["detail"]["issuer"] == "posit-connect" for e in events)
