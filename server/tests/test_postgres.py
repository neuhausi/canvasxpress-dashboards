"""Several server processes on one Postgres database.

Runs only when ``CXD_TEST_PG_URL`` (as in CI) or ``CXD_TEST_POSTGRES_URL`` points at
a Postgres server the test may create databases on (e.g.
``postgresql://cxd@127.0.0.1:55432/cxd``). Each
test gets a fresh database, dropped afterwards. Two app instances share it and
one ``SESSION_SECRET``, as two servers behind a load balancer would.
"""

import datetime
import os
import secrets
import threading

import pytest

URL = os.getenv("CXD_TEST_POSTGRES_URL") or os.getenv("CXD_TEST_PG_URL")
pytestmark = pytest.mark.skipif(not URL, reason="set CXD_TEST_PG_URL to run")

sa = pytest.importorskip("sqlalchemy")


@pytest.fixture
def pg_url():
    name = "cxd_t_" + secrets.token_hex(4)
    admin = sa.create_engine(URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(sa.text("CREATE DATABASE " + name))
    url = URL.rsplit("/", 1)[0] + "/" + name
    yield url
    with admin.connect() as conn:
        conn.execute(sa.text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity"
                             " WHERE datname = :n AND pid <> pg_backend_pid()"), {"n": name})
        conn.execute(sa.text("DROP DATABASE " + name))
    admin.dispose()


def two_servers(url):
    from fastapi.testclient import TestClient

    from cxd_server.app import create_dashboards_app
    from cxd_server.mailer import MemoryMailer
    from cxd_server.sqldashboard import open_dashboard_store
    apps = []
    for _ in range(2):
        apps.append(create_dashboards_app(
            store=open_dashboard_store(url), session_secret="one-shared-secret",
            serve_static=False, dataset_store_uri=url + "?table=cxd_objects",
            mailer=MemoryMailer(), scheduler_enabled=False,
            publish_base_url="https://example.test"))
    return apps, TestClient


def test_a_session_and_data_from_one_server_work_on_the_other(pg_url):
    (a, b), TestClient = two_servers(pg_url)
    on_a = TestClient(a)
    assert on_a.post("/auth/signup", json={"username": "root", "password": "secret1"}
                     ).status_code == 200
    on_a.post("/auth/signup", json={"username": "ann", "password": "secret1"})
    on_a.post("/auth/login", json={"username": "root", "password": "secret1"})
    on_a.post("/api/datasets", json={"id": "labs", "format": "json",
                                     "data": [["p", "site"], ["p1", "A"], ["p2", "B"]]})
    on_a.post("/api/dashboards", json={"id": "d1", "title": "Labs", "layout": {"items": []},
                                       "data": {"l": {"kind": "dataset", "id": "labs"}},
                                       "panels": {}})
    on_a.post("/api/admin/groups", json={"name": "site-a", "members": ["ann"]})
    on_a.post("/api/dashboards/d1/grants", json={"principal": "group:site-a", "level": "view"})
    on_a.put("/api/datasets/labs/policy", json={"policy": {"rows": [
        {"field": "site", "allow": {"group:site-a": ["A"]}}]}})

    # The same browser, now served by the other process: same session.
    on_b = TestClient(b, cookies=on_a.cookies)
    assert on_b.get("/auth/me").json()["user"] == "root"
    assert [d["id"] for d in on_b.get("/api/dashboards").json()["dashboards"]] == ["d1"]
    ann = TestClient(b)
    ann.post("/auth/login", json={"username": "ann", "password": "secret1"})
    assert ann.get("/api/datasets/labs", params={"owner": "root"}).json() == \
        [["p", "site"], ["p1", "A"]]                       # row security, from server B


def test_the_audit_chain_stays_linear_with_writers_on_both_servers(pg_url):
    (a, b), _ = two_servers(pg_url)

    def burst(app, who):
        for i in range(20):
            app.state.audit.record("dashboard.open", actor=who, target=str(i))
    threads = [threading.Thread(target=burst, args=(app, who))
               for app, who in ((a, "a"), (b, "b"), (a, "a2"), (b, "b2"))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for app in (a, b):
        result = app.state.audit.verify()
        assert result["ok"] is True and result["checked"] == 80


def test_a_due_schedule_runs_once_across_servers(pg_url):
    (a, b), TestClient = two_servers(pg_url)
    owner = TestClient(a)
    owner.post("/auth/signup", json={"username": "owner", "password": "secret1"})
    owner.post("/api/admin/users/owner/email", json={"email": "owner@example.test"})
    owner.post("/api/datasets", json={"id": "labs", "format": "json",
                                      "data": [["p", "v"], ["p1", 5]]})
    s = owner.post("/api/schedules", json={
        "kind": "alert", "name": "any", "cron": "*/5 * * * *",
        "config": {"dataset": "labs", "aggregate": "count", "op": ">", "threshold": 0,
                   "recipients": ["user:owner"]}}).json()["schedule"]
    due = datetime.datetime.fromisoformat(s["next_run"])
    runs = []

    def tick(app):
        runs.extend(app.state.scheduler.run_due(due))
    threads = [threading.Thread(target=tick, args=(app,)) for app in (a, b, a, b)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(runs) == 1 and runs[0]["status"] == "ok"
    assert len(a.state.mailer.sent) + len(b.state.mailer.sent) == 1


def test_profiles_limits_and_sso_identities_on_postgres(pg_url):
    (a, b), _ = two_servers(pg_url)
    from cxd_server.oidc import IdentityStore
    sch_a, sch_b = a.state.schedules, b.state.schedules
    sch_a.set_email("u", "u@example.test")
    token = sch_a.confirmation_token("u", datetime.datetime.now(datetime.timezone.utc))
    assert token and sch_b.verify_token(token) == "u"
    assert sch_a.email_of("u") == "u@example.test"
    assert [sch_a.allow_send("u", 2), sch_b.allow_send("u", 2), sch_a.allow_send("u", 2)] == \
        [True, True, False]
    ids = IdentityStore(a.state.governance._db)
    ids.link("https://idp", "sub-1", "u", "2026-01-01")
    ids.link("https://idp", "sub-1", "u", "2026-01-02")          # upsert
    assert IdentityStore(b.state.governance._db).username_for("https://idp", "sub-1") == "u"
    groups = a.state.governance.sync_managed_groups("u", ["g1", "g2"], "oidc")
    assert groups == ["g1", "g2"]
    assert b.state.governance.sync_managed_groups("u", ["g2"], "oidc") == ["g2"]


def test_health_endpoints_on_postgres(pg_url):
    (a, b), TestClient = two_servers(pg_url)
    client = TestClient(a)
    assert client.get("/healthz").json()["status"] == "ok"
    ready = client.get("/readyz")
    assert ready.status_code == 200 and set(ready.json()["checks"].values()) == {"ok"}


def test_versions_and_signatures_on_postgres(pg_url):
    (a, b), TestClient = two_servers(pg_url)
    owner = TestClient(a)
    owner.post("/auth/signup", json={"username": "owner", "password": "secret1"})
    spec = {"id": "d1", "title": "T", "layout": {"items": []}, "panels": {}}
    owner.post("/api/dashboards", json=spec)
    owner.post("/api/dashboards", json=dict(spec, title="T2"))
    on_b = TestClient(b, cookies=owner.cookies)
    assert on_b.post("/api/dashboards/d1/sign", json={"version": 2, "meaning": "Approved",
                                                      "password": "secret1"}).status_code == 200
    owner.post("/api/dashboards/d1/sign", json={"version": 1, "meaning": "Authored",
                                                "password": "secret1"})
    v = on_b.get("/api/dashboards/d1/versions").json()["versions"]
    assert [(x["version"], [s["meaning"] for s in x["signatures"]]) for x in v] == \
        [(2, ["Approved"]), (1, ["Authored"])]
    assert a.state.records.verify_signatures()["ok"] is True
