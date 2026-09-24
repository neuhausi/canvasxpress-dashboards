"""Electronic records: immutable dashboard versions and electronic signatures
(re-authentication, meaning, binding to the exact content, tamper evidence)."""

import sqlite3
import urllib.parse

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.records import spec_sha256
from cxd_server.store import DashboardStore


def _spec(title="Trial", n=1):
    return {"id": "d1", "title": title, "layout": {"items": []}, "panels": {},
            "data": {"t": {"kind": "inline", "value": {"y": {"data": [[n]]}}}}}


@pytest.fixture
def app(tmp_path):
    return create_dashboards_app(store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
                                 serve_static=False, scheduler_enabled=False,
                                 dataset_store_uri="file://" + str(tmp_path / "ds"))


def _user(app, name):
    c = TestClient(app)
    assert c.post("/auth/signup", json={"username": name, "password": "secret1"}
                  ).status_code == 200
    return c


def test_every_save_is_a_version_and_restore_adds_one(app):
    owner = _user(app, "owner")
    assert owner.post("/api/dashboards", json=_spec("v one", 1)).json()["dashboard"]["version"] == 1
    owner.post("/api/dashboards", json=_spec("v one", 1))            # unchanged: no new version
    assert owner.post("/api/dashboards", json=_spec("v two", 2)).json()["dashboard"]["version"] == 2
    versions = owner.get("/api/dashboards/d1/versions").json()
    assert [(v["version"], v["title"], v["saved_by"]) for v in versions["versions"]] == \
        [(2, "v two", "owner"), (1, "v one", "owner")]
    assert versions["versions"][0]["sha256"] == spec_sha256(_spec("v two", 2))
    assert versions["meanings"] == ["Authored", "Reviewed", "Approved"]
    old = owner.get("/api/dashboards/d1/versions/1").json()
    assert old["spec"]["title"] == "v one"
    restored = owner.post("/api/dashboards/d1/versions/1/restore").json()["version"]
    assert restored["version"] == 3 and restored["note"] == "restored from version 1"
    assert owner.get("/api/dashboards/d1").json()["title"] == "v one"
    # Deleting the dashboard keeps its records.
    owner.delete("/api/dashboards/d1")
    assert app.state.records.version_spec("owner", "d1", 2)["title"] == "v two"


def test_version_access_follows_dashboard_access(app):
    owner, ann, eve = _user(app, "owner"), _user(app, "ann"), _user(app, "eve")
    owner.post("/api/dashboards", json=_spec())
    owner.post("/api/dashboards/d1/grants", json={"principal": "user:ann", "level": "view"})
    assert ann.get("/api/dashboards/d1/versions", params={"owner": "owner"}).status_code == 200
    assert ann.post("/api/dashboards/d1/versions/1/restore",
                    params={"owner": "owner"}).status_code == 404       # view only
    assert eve.get("/api/dashboards/d1/versions", params={"owner": "owner"}).status_code == 404
    assert eve.get("/api/dashboards/d1/versions/1", params={"owner": "owner"}).status_code == 404


def test_a_dashboard_saved_before_versioning_gets_a_baseline(app, tmp_path):
    owner = _user(app, "owner")
    DashboardStore(str(tmp_path / "d.db")).save_dashboard("owner", _spec("old"), "2026-01-01")
    v = owner.get("/api/dashboards/d1/versions").json()["versions"]
    assert [(x["version"], x["note"], x["saved_by"]) for x in v] == [(1, "baseline", None)]


def test_signing_with_meaning_and_reauthentication(app):
    owner, ann = _user(app, "owner"), _user(app, "ann")
    owner.post("/api/dashboards", json=_spec())
    owner.post("/api/dashboards/d1/grants", json={"principal": "user:ann", "level": "view"})
    sign = {"version": 1, "meaning": "Authored", "password": "secret1"}
    assert owner.post("/api/dashboards/d1/sign", json=dict(sign, password="wrong")
                      ).status_code == 401
    assert owner.post("/api/dashboards/d1/sign", json=dict(sign, meaning="Signed-ish")
                      ).status_code == 400
    s1 = owner.post("/api/dashboards/d1/sign", json=sign).json()["signature"]
    assert (s1["signer"], s1["meaning"], s1["method"]) == ("owner", "Authored", "password")
    assert owner.post("/api/dashboards/d1/sign", json=sign).status_code == 400   # once per meaning
    # A reviewer the dashboard is shared with signs the same version.
    ann.post("/api/dashboards/d1/sign", params={"owner": "owner"},
             json={"version": 1, "meaning": "Reviewed", "password": "secret1"})
    sigs = owner.get("/api/dashboards/d1/versions").json()["versions"][0]["signatures"]
    assert [(s["signer"], s["meaning"], s["valid"]) for s in sigs] == \
        [("owner", "Authored", True), ("ann", "Reviewed", True)]
    assert sigs[1]["prev_hash"] == sigs[0]["hash"]
    # A later edit is a new, unsigned version; the signed one is untouched.
    owner.post("/api/dashboards", json=_spec("edited", 9))
    v = owner.get("/api/dashboards/d1/versions").json()["versions"]
    assert v[0]["signatures"] == [] and len(v[1]["signatures"]) == 2
    # Signing needs the permission.
    owner.post("/api/admin/roles/assign", json={"principal": "user:ann", "role": "viewer"})
    assert ann.post("/api/dashboards/d1/sign", params={"owner": "owner"},
                    json={"version": 2, "meaning": "Approved", "password": "secret1"}
                    ).status_code == 403
    events = {e["action"] for e in app.state.audit.query(action="dashboard.")["events"]}
    assert {"dashboard.sign", "dashboard.save"} <= events


def test_tampering_is_detected(app, tmp_path):
    owner = _user(app, "owner")
    owner.post("/api/dashboards", json=_spec())
    owner.post("/api/dashboards/d1/sign", json={"version": 1, "meaning": "Approved",
                                                "password": "secret1"})
    owner.post("/api/dashboards/d1/sign", json={"version": 1, "meaning": "Reviewed",
                                                "password": "secret1"})
    assert owner.get("/api/admin/signatures/verify").json() == {"ok": True, "checked": 2,
                                                                "broken_at": None}
    db = sqlite3.connect(str(tmp_path / "d.db"))
    # Someone edits the signed version's content directly in the database.
    db.execute("UPDATE cxd_dashboard_versions SET spec = replace(spec, 'Trial', 'Forged')")
    db.commit()
    sigs = owner.get("/api/dashboards/d1/versions").json()["versions"][0]["signatures"]
    assert [s["valid"] for s in sigs] == [False, False]
    bad = owner.get("/api/admin/signatures/verify").json()
    assert bad["ok"] is False and bad["reason"] == "the signed version's content changed"
    db.execute("UPDATE cxd_dashboard_versions SET spec = replace(spec, 'Forged', 'Trial')")
    # ... or re-attributes a signature.
    db.execute("UPDATE cxd_signatures SET signer = 'mallory' WHERE seq = 1")
    db.commit()
    bad = owner.get("/api/admin/signatures/verify").json()
    assert bad == {"ok": False, "checked": 0, "broken_at": 1,
                   "reason": "the signature record was altered or removed"}


def test_single_sign_on_users_sign_after_a_recent_sign_in(tmp_path, monkeypatch):
    pytest.importorskip("jwt")
    from test_oidc import FakeIdP, make_app, sign_in
    idp = FakeIdP()
    app = make_app(tmp_path, idp)
    client = TestClient(app)
    sign_in(client, idp, {"sub": "s-1", "preferred_username": "sam"})
    client.post("/api/dashboards", json=_spec())
    assert client.get("/api/dashboards/d1/versions").json()["reauth"] == "sso"
    ok = client.post("/api/dashboards/d1/sign", json={"version": 1, "meaning": "Approved"})
    assert ok.status_code == 200 and ok.json()["signature"]["method"] == "sso"
    # An SSO session older than the window must sign in again (prompt=login).
    (tmp_path / "b").mkdir()
    monkeypatch.setenv("CXD_SIGN_REAUTH_SECONDS", "-1")
    stale = make_app(tmp_path / "b", idp)
    c2 = TestClient(stale)
    sign_in(c2, idp, {"sub": "s-2", "preferred_username": "sue"})
    c2.post("/api/dashboards", json=_spec())
    r = c2.post("/api/dashboards/d1/sign", json={"version": 1, "meaning": "Approved"})
    assert r.status_code == 401 and r.json()["detail"].startswith("reauth")
    loc = c2.get("/auth/oidc/login", params={"prompt": "login"},
                 follow_redirects=False).headers["location"]
    assert dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(loc).query))["prompt"] == "login"
