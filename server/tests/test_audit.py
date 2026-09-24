"""Audit log: what the server records, the hash chain, access control, export,
retention, the SQL backend, and concurrent writers."""

import json
import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.audit import (
    NullAuditLog,
    SqlAuditLog,
    SqliteAuditLog,
    action_for,
    open_audit_log,
    target_from,
)
from cxd_server.functions import FunctionsConfig
from cxd_server.store import DashboardStore

SPEC = {"id": "d1", "title": "Sales", "layout": {"items": []}, "panels": {}}
CLIN = {"y": {"vars": ["Age"], "smps": ["c1", "c2"], "data": [[61, 55]]}}


@pytest.fixture
def paths(tmp_path):
    return {"db": str(tmp_path / "dash.db"), "ds": "file://" + str(tmp_path / "datasets")}


def _app(paths, **kwargs):
    return create_dashboards_app(store=DashboardStore(paths["db"]), session_secret="s",
                                 serve_static=False, dataset_store_uri=paths["ds"], **kwargs)


def _signup(client, username, password="secret1"):
    r = client.post("/auth/signup", json={"username": username, "password": password})
    assert r.status_code == 200, r.text


def _events(app, **filters):
    return app.state.audit.query(limit=1000, **filters)["events"]


def test_records_auth_including_failed_logins(paths):
    app = _app(paths)
    client = TestClient(app)
    _signup(client, "root")                       # first user: admin
    client.post("/auth/logout")
    login = "/auth/login"
    assert client.post(login, json={"username": "root", "password": "wrong"}).status_code == 401
    assert client.post(login, json={"username": "root", "password": "secret1"}).status_code == 200

    events = list(reversed(_events(app, action="auth.")))
    assert [(e["action"], e["actor"], e["target"], e["outcome"]) for e in events] == [
        ("auth.signup", "root", "root", "ok"),
        ("auth.logout", "root", None, "ok"),       # the actor is who was signed in before
        ("auth.login", None, "root", "denied"),    # failed attempt: target = attempted user
        ("auth.login", "root", "root", "ok"),
    ]
    assert events[0]["detail"] == {"first_admin": True}
    assert all(e["ip"] for e in events)


def test_records_dashboard_lifecycle_and_denials(paths):
    app = _app(paths)
    admin, alice = TestClient(app), TestClient(app)
    _signup(admin, "root")
    _signup(alice, "alice")
    alice.post("/api/dashboards", json=SPEC)
    alice.post("/api/dashboards", json=dict(SPEC, title="Sales v2"))
    alice.get("/api/dashboards/d1")
    alice.post("/api/dashboards/d1/share", json={"visibility": "auth"})
    # a non-admin cannot lock -> denied, still recorded
    assert alice.post("/api/dashboards/d1/lock", json={"locked": True}).status_code == 403
    alice.delete("/api/dashboards/d1")

    events = list(reversed(_events(app, actor="alice", action="dashboard.")))
    assert [(e["action"], e["target"], e["outcome"]) for e in events] == [
        ("dashboard.save", "d1", "ok"),
        ("dashboard.save", "d1", "ok"),
        ("dashboard.open", "d1", "ok"),
        ("dashboard.share", "d1", "ok"),
        ("dashboard.lock", "d1", "denied"),
        ("dashboard.delete", "d1", "ok"),
    ]
    assert events[0]["detail"]["created"] is True and events[1]["detail"]["created"] is False
    assert events[0]["owner"] == "alice"
    assert events[3]["detail"]["visibility"] == "auth"
    # Listings and status probes are not audited.
    alice.get("/api/dashboards")
    assert not _events(app, action="api.GET /api/dashboards")


def test_records_share_views_datasets_and_never_the_token(paths):
    app = _app(paths)
    owner, viewer = TestClient(app), TestClient(app)
    _signup(owner, "owner1")
    owner.post("/api/dashboards", json=SPEC)
    shared = owner.post("/api/dashboards/d1/share", json={"visibility": "public"}).json()
    token = shared["dashboard"]["share_token"]
    viewer.get("/api/shared/" + token)
    dataset = {"title": "Clinical", "format": "json", "data": CLIN}
    created = owner.post("/api/datasets", json=dataset).json()
    owner.get("/api/datasets/" + created["dataset"]["id"])

    view = _events(app, action="shared.view")[0]
    assert (view["actor"], view["target"], view["owner"]) == (None, "d1", "owner1")
    assert token not in json.dumps(_events(app))
    ds = {e["action"]: e for e in _events(app, action="dataset.")}
    assert ds["dataset.create"]["detail"]["rows"] is not None
    assert ds["dataset.read"]["owner"] == "owner1"


def test_records_function_runs_by_hash_not_code(paths):
    app = _app(paths, functions=FunctionsConfig(mode="users", timeout=10))
    client = TestClient(app)
    _signup(client, "alice")
    body = {"language": "python", "code": "result = clin", "inputs": {"clin": {"data": CLIN}}}
    assert client.post("/api/functions/run", json=body).status_code == 200
    bad = dict(body, code="result = nope")
    assert client.post("/api/functions/run", json=bad).status_code == 400

    ok, failed = reversed(_events(app, action="function.run"))
    assert ok["outcome"] == "ok" and ok["detail"]["language"] == "python"
    assert ok["detail"]["inputs"] == ["clin"] and len(ok["detail"]["code_sha256"]) == 16
    assert "duration_ms" in ok["detail"]
    assert failed["outcome"] == "error" and "NameError" in failed["detail"]["error"]
    assert "result = clin" not in json.dumps(_events(app))


def test_audit_endpoints_are_admin_only_and_themselves_audited(paths):
    app = _app(paths)
    admin, alice = TestClient(app), TestClient(app)
    _signup(admin, "root")
    _signup(alice, "alice")
    assert alice.get("/api/admin/audit").status_code == 403
    page = admin.get("/api/admin/audit", params={"action": "auth.", "limit": 1}).json()
    assert page["enabled"] is True and len(page["events"]) == 1 and page["next"] is not None
    assert "function.run" in page["actions"]
    older = admin.get("/api/admin/audit", params={"action": "auth.", "before": page["next"]}).json()
    assert all(e["seq"] < page["next"] for e in older["events"])

    denied = _events(app, action="audit.view", actor="alice")[0]
    assert denied["outcome"] == "denied"
    assert _events(app, action="audit.view", actor="root")[0]["detail"] == {"action": "auth."}


def test_export_csv_and_jsonl(paths):
    app = _app(paths)
    admin = TestClient(app)
    _signup(admin, "root")
    csv_resp = admin.get("/api/admin/audit/export")
    assert csv_resp.status_code == 200 and csv_resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in csv_resp.headers["content-disposition"]
    assert csv_resp.text.splitlines()[0].startswith("seq,ts,actor,action")
    params = {"format": "jsonl", "action": "auth."}
    lines = admin.get("/api/admin/audit/export", params=params).text.splitlines()
    assert json.loads(lines[0])["action"] == "auth.signup"


def test_hash_chain_detects_tampering(paths):
    app = _app(paths)
    admin = TestClient(app)
    _signup(admin, "root")
    admin.post("/api/dashboards", json=SPEC)
    assert admin.get("/api/admin/audit/verify").json()["ok"] is True

    # Rewrite history the way an attacker with DB access would.
    conn = sqlite3.connect(paths["db"])
    conn.execute("UPDATE cxd_audit SET actor = 'mallory' WHERE action = 'dashboard.save'")
    conn.commit()
    result = admin.get("/api/admin/audit/verify").json()
    assert result["ok"] is False
    assert result["broken_at"] == _events(app, action="dashboard.save")[0]["seq"]


def test_off_mode_records_nothing(paths, monkeypatch):
    monkeypatch.setenv("CXD_AUDIT", "off")
    app = _app(paths)
    client = TestClient(app)
    _signup(client, "root")
    assert isinstance(app.state.audit, NullAuditLog)
    page = client.get("/api/admin/audit").json()
    assert page["enabled"] is False and page["events"] == []


def test_retention_prunes_old_events_and_chain_still_verifies(tmp_path):
    log = SqliteAuditLog(str(tmp_path / "a.db"), retention_days=30)
    log.record("auth.login", actor="old", ts="2020-01-01T00:00:00.000+00:00")
    log.record("auth.login", actor="new")
    assert log.prune() == 1
    assert [e["actor"] for e in log.query()["events"]] == ["new"]
    assert log.verify()["ok"] is True


def test_sql_backend_via_sqlalchemy(tmp_path):
    pytest.importorskip("sqlalchemy")
    log = open_audit_log("sqlite:///" + str(tmp_path / "sql.db"), None)
    assert isinstance(log, SqlAuditLog)
    for i in range(3):
        log.record("dashboard.save", actor="u%d" % i, target="d1", detail={"n": i})
    assert [e["actor"] for e in log.query(action="dashboard.")["events"]] == ["u2", "u1", "u0"]
    assert log.query(actor="u1")["events"][0]["detail"] == {"n": 1}
    expected = {"ok": True, "checked": 3, "first_seq": 1, "last_seq": 3, "broken_at": None}
    assert log.verify() == expected


def test_concurrent_writers_keep_one_linear_chain(tmp_path):
    log = SqliteAuditLog(str(tmp_path / "c.db"))

    def burst(n):
        for i in range(25):
            log.record("dashboard.open", actor="t%d" % n, target=str(i))
    threads = [threading.Thread(target=burst, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    result = log.verify()
    assert result["ok"] is True and result["checked"] == 100 and result["last_seq"] == 100


def test_action_mapping_and_targets():
    assert action_for("post", "/api/dashboards") == "dashboard.save"
    assert action_for("GET", "/api/dashboards") is None                   # listing: not audited
    # unmapped writes are still recorded
    assert action_for("POST", "/api/new/thing") == "api.POST /api/new/thing"
    assert action_for("GET", None) is None
    assert target_from({"dataset_id": "x"}) == "x"
    assert target_from({"token": "abcdefghijkl"}) == "share:abcdef…"
