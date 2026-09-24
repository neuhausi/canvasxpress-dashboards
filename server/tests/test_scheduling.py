"""Scheduling: cron, claiming, dataset refresh, alerts (per recipient, under
row/column security, edge-triggered), subscriptions, permissions and audit."""

import datetime
import http.server
import threading

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.jobs import fetch_url, measure_value
from cxd_server.mailer import MemoryMailer
from cxd_server.scheduler import Cron, ScheduleError, ScheduleStore
from cxd_server.store import DashboardStore

UTC = datetime.timezone.utc
LABS = [["patient", "site", "crp"], ["p1", "A", 14], ["p2", "A", 10], ["p3", "B", 3]]


def at(*args):
    return datetime.datetime(*args, tzinfo=UTC)


# ---- cron ---------------------------------------------------------------------------
def test_cron_next_runs_aliases_and_descriptions():
    assert Cron("*/15 * * * *").next_after(at(2026, 9, 24, 10, 7)) == at(2026, 9, 24, 10, 15)
    assert Cron("0 7 * * *").next_after(at(2026, 9, 24, 7, 0)) == at(2026, 9, 25, 7, 0)
    assert Cron("@daily").next_after(at(2026, 12, 31, 23, 59)) == at(2027, 1, 1, 0, 0)
    assert Cron("0 9 * * mon-fri").next_after(at(2026, 9, 25, 9, 0)) == at(2026, 9, 28, 9, 0)
    # day-of-month OR day-of-week (cron semantics): the 1st, or any Sunday
    assert Cron("0 0 1 * 0").next_after(at(2026, 9, 24)) == at(2026, 9, 27)
    assert Cron("0 0 31 2 *").expr == "0 0 31 2 *"
    with pytest.raises(ScheduleError):
        Cron("0 0 31 2 *").next_after(at(2026, 1, 1))        # never matches
    for bad in ("* * *", "61 * * * *", "*/0 * * * *", "x * * * *", "0 0 * 13 *"):
        with pytest.raises(ScheduleError):
            Cron(bad)
    assert Cron("*/15 * * * *").describe() == "every 15 minutes"
    assert Cron("30 7 * * *").describe() == "every day at 07:30"
    assert Cron("0 8 * * 1").describe() == "every Mon at 08:00"
    assert Cron("0 9 * * 1-5").describe() == "weekdays at 09:00"


def test_cron_time_zone_and_daylight_saving():
    # 07:00 in New York is 11:00 UTC in summer and 12:00 UTC in winter.
    assert Cron("0 7 * * *").next_after(at(2026, 9, 24, 12), "America/New_York") == \
        at(2026, 9, 25, 11)
    assert Cron("0 7 * * *").next_after(at(2026, 11, 2, 12), "America/New_York") == \
        at(2026, 11, 3, 12)
    with pytest.raises(ScheduleError):
        Cron("0 7 * * *").next_after(at(2026, 1, 1), "Mars/Olympus")


def test_claim_is_exclusive(tmp_path):
    from cxd_server.governance import _SqliteDb
    store = ScheduleStore(_SqliteDb(str(tmp_path / "s.db")))
    other = ScheduleStore(_SqliteDb(str(tmp_path / "s.db")))   # a second worker
    saved = store.save("alice", "refresh", "r", "*/5 * * * *", "UTC", {}, now=at(2026, 9, 24, 10))
    due = store.due(at(2026, 9, 24, 10, 6))
    assert [d["id"] for d in due] == [saved["id"]]
    assert store.claim(due[0], at(2026, 9, 24, 10, 6)) is True
    assert other.claim(due[0], at(2026, 9, 24, 10, 6)) is False
    assert store.get(saved["id"])["next_run"] == "2026-09-24T10:10:00+00:00"


# ---- values ---------------------------------------------------------------------------
def test_measure_value_on_both_shapes():
    assert measure_value(LABS, "crp", "mean") == (9.0, 3)
    assert measure_value(LABS, "crp", "max", {"site": "A"}) == (14.0, 2)
    assert measure_value(LABS, None, "count", {"site": "B"}) == (1.0, 1)
    assert measure_value(LABS, "missing", "sum") == (None, 3)
    cx = {"y": {"vars": ["crp"], "smps": ["p1", "p2", "p3"], "data": [[14, 10, None]]},
          "x": {"site": ["A", "A", "B"]}}
    assert measure_value(cx, "crp", "sum", {"site": "A"}) == (24.0, 2)
    assert measure_value(cx, "crp", "mean", {"site": "B"}) == (None, 1)


# ---- app fixtures ---------------------------------------------------------------------
@pytest.fixture
def mailer():
    return MemoryMailer()


@pytest.fixture
def app(tmp_path, mailer, monkeypatch):
    monkeypatch.setenv("CXD_FETCH_ALLOW_PRIVATE", "1")       # the tests serve data locally
    fetched = {"rows": [["item", "stock"], ["a", 5]]}
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
        serve_static=False, dataset_store_uri="file://" + str(tmp_path / "datasets"),
        mailer=mailer, publish_base_url="https://example.test/dashboards",
        origin_fetchers={"connector": lambda owner, name: fetched["rows"]},
        scheduler_enabled=False)
    app.state.fetched = fetched
    return app


def _confirm_link(mailer):
    """The confirmation link in the newest confirmation email (then forget it)."""
    msg = mailer.sent.pop()
    assert msg["Subject"] == "Confirm your email address"
    text = msg.get_body(("plain",)).get_content()
    return next(w for w in text.split() if "/api/me/verify-email?token=" in w)


def _user(app, name, email=True):
    client = TestClient(app)
    assert client.post("/auth/signup", json={"username": name, "password": "secret1"}
                       ).status_code == 200
    if email:
        r = client.put("/api/me/profile", json={"email": name + "@example.test"})
        assert r.status_code == 200 and r.json()["confirmation_sent"] is True
        link = _confirm_link(app.state.mailer)
        assert client.get(link.split("example.test/dashboards", 1)[1]).status_code == 200
    return client


@pytest.fixture
def org(app):
    users = {n: _user(app, n) for n in ("root", "owner", "ann", "bea")}
    users["nomail"] = _user(app, "nomail", email=False)
    root = users["root"]
    root.post("/api/admin/groups", json={"name": "site-a", "members": ["ann", "bea", "nomail"]})
    owner = users["owner"]
    owner.post("/api/datasets", json={"id": "labs", "title": "Labs", "format": "json",
                                      "data": LABS})
    return users


@pytest.fixture
def csv_server():
    body = {"text": "item,stock\nbolts,40\nnuts,12\n"}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            data = body["text"].encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/csv")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/stock.csv" % server.server_address[1], body
    server.shutdown()


def _save(client, **body):
    r = client.post("/api/schedules", json=body)
    assert r.status_code == 200, r.text
    return r.json()["schedule"]


def _run(client, schedule_id):
    r = client.post("/api/schedules/%s/run" % schedule_id)
    assert r.status_code == 200, r.text
    return r.json()["run"]


# ---- refresh --------------------------------------------------------------------------
def test_refresh_from_url_keeps_title_and_lock(org, app, csv_server):
    url, body = csv_server
    owner = org["owner"]
    s = _save(owner, kind="refresh", name="Stock", cron="0 * * * *",
              config={"dataset": "stock", "title": "Stock levels",
                      "origin": {"kind": "url", "url": url}})
    assert s["description"] == "every hour at :00" and s["next_run"]
    run = _run(owner, s["id"])
    assert run["status"] == "ok" and "2 rows" in run["message"]
    assert owner.get("/api/datasets/stock").json()[1] == ["bolts", 40.0]
    org["root"].post("/api/datasets/stock/lock", params={"owner": "owner"}, json={"locked": True})
    body["text"] = "item,stock\nbolts,7\n"
    assert _run(owner, s["id"])["status"] == "ok"
    listed = {d["id"]: d for d in owner.get("/api/datasets").json()["datasets"]}
    assert listed["stock"]["title"] == "Stock levels" and listed["stock"]["locked"] is True
    assert owner.get("/api/datasets/stock").json() == [["item", "stock"], ["bolts", 7.0]]


def test_refresh_from_a_connector_and_private_urls_are_refused(org, app):
    owner = org["owner"]
    s = _save(owner, kind="refresh", name="Inventory", cron="@daily",
              config={"dataset": "inv", "origin": {"kind": "connector", "source": "inventory"}})
    assert _run(owner, s["id"])["status"] == "ok"
    assert owner.get("/api/datasets/inv").json() == [["item", "stock"], ["a", 5]]
    with pytest.raises(ScheduleError, match="private or local"):
        fetch_url("http://127.0.0.1:9/x.csv", allow_private=False)
    with pytest.raises(ScheduleError):
        fetch_url("file:///etc/passwd", allow_private=True)


# ---- alerts ---------------------------------------------------------------------------
def test_alert_is_per_recipient_under_row_security_and_edge_triggered(org, app, mailer):
    owner = org["owner"]
    # site-a members see site A rows only; bea sees everything.
    owner.put("/api/datasets/labs/policy", json={"policy": {"rows": [
        {"field": "site", "allow": {"group:site-a": ["A"], "user:bea": "*"}}]}})
    owner.post("/api/datasets/labs/grants", json={"principal": "group:site-a", "level": "view"})
    s = _save(owner, kind="alert", name="CRP high", cron="*/15 * * * *",
              config={"dataset": "labs", "measure": "crp", "aggregate": "mean", "op": ">",
                      "threshold": 11, "recipients": ["group:site-a"]})
    run = _run(owner, s["id"])
    # ann: mean over site A = 12 > 11 -> emailed. bea: mean over all = 9 -> not true.
    # nomail: true but has no address.
    assert run["detail"]["true"] == 2 and run["detail"]["emailed"] == 1
    assert run["detail"]["no_email"] == 1
    assert [m["To"] for m in mailer.sent] == ["ann@example.test"]
    assert "The mean of crp is 12, above 11." in mailer.sent[0].get_body(("plain",)).get_content()
    # Still true: not emailed again.
    assert _run(owner, s["id"])["detail"]["emailed"] == 0
    # It clears, then becomes true again -> emailed again.
    owner.post("/api/datasets", json={"id": "labs", "format": "json",
                                      "data": [LABS[0], ["p1", "A", 1], ["p3", "B", 3]]})
    assert _run(owner, s["id"])["detail"]["true"] == 0
    owner.post("/api/datasets", json={"id": "labs", "format": "json", "data": LABS})
    assert _run(owner, s["id"])["detail"]["emailed"] == 1
    assert len(mailer.sent) == 2


def test_refresh_checks_the_alerts_on_its_dataset(org, app, mailer):
    owner = org["owner"]
    app.state.fetched["rows"] = [["item", "stock"], ["a", 2], ["b", 1]]
    _save(owner, kind="alert", name="Low stock", cron="@daily",
          config={"dataset": "inv", "measure": "stock", "aggregate": "min", "op": "<",
                  "threshold": 3, "recipients": ["user:owner"]})
    refresh = _save(owner, kind="refresh", name="Inventory", cron="@daily",
                    config={"dataset": "inv",
                            "origin": {"kind": "connector", "source": "inventory"}})
    run = _run(owner, refresh["id"])
    assert run["detail"]["alerts"] == 1 and "checked 1 alert" in run["message"]
    assert [m["Subject"] for m in mailer.sent] == ["Alert: Low stock"]


# ---- subscriptions -------------------------------------------------------------------
def test_subscription_emails_people_who_can_open_it(org, app, mailer):
    owner = org["owner"]
    owner.post("/api/dashboards", json={"id": "d1", "title": "Labs board", "layout": {"items": []},
                                        "data": {"l": {"kind": "dataset", "id": "labs"}},
                                        "panels": {}})
    owner.post("/api/dashboards/d1/grants", json={"principal": "user:ann", "level": "view"})
    s = _save(owner, kind="subscription", name="Weekly labs", cron="0 8 * * 1",
              config={"dashboard": "d1", "recipients": ["user:owner", "user:ann", "user:bea"]})
    app.state.scheduler.store  # noqa: B018 - the scheduler is wired
    run = _run(owner, s["id"])
    assert run["detail"]["emailed"] == 2 and run["detail"]["no_access"] == 1
    assert sorted(m["To"] for m in mailer.sent) == ["ann@example.test", "owner@example.test"]
    text = mailer.sent[0].get_body(("plain",)).get_content()
    assert "https://example.test/dashboards/view.html?id=d1&owner=owner" in text
    assert "every Mon at 08:00" in text


# ---- permissions, validation, audit --------------------------------------------------
def test_permissions_ownership_and_validation(org, app):
    owner, ann, root = org["owner"], org["ann"], org["root"]
    s = _save(owner, kind="alert", name="a", cron="@hourly",
              config={"dataset": "labs", "aggregate": "count", "op": ">", "threshold": 0,
                      "recipients": ["user:owner"]})
    assert ann.post("/api/schedules/%s/run" % s["id"]).status_code == 404
    assert ann.get("/api/schedules").json()["schedules"] == []
    assert len(root.get("/api/schedules", params={"all": 1}).json()["schedules"]) == 1
    root.post("/api/admin/roles/assign", json={"principal": "user:ann", "role": "viewer"})
    assert ann.post("/api/schedules", json={"kind": "alert"}).status_code == 403
    bad = [
        {"kind": "alert", "cron": "nope", "config": {"dataset": "labs", "aggregate": "count",
                                                    "threshold": 1, "recipients": ["user:owner"]}},
        {"kind": "alert", "cron": "@daily", "config": {"dataset": "labs", "aggregate": "count",
                                                      "threshold": 1, "recipients": ["user:x"]}},
        {"kind": "alert", "cron": "@daily",
         "config": {"dataset": "labs", "aggregate": "mean", "threshold": 1,
                    "recipients": ["user:owner"]}},
        {"kind": "subscription", "cron": "@daily",
         "config": {"dashboard": "nope", "dashboard_owner": "root", "recipients": ["user:owner"]}},
        {"kind": "refresh", "cron": "@daily",
         "config": {"dataset": "x", "origin": {"kind": "url", "url": "ftp://x"}}},
        {"kind": "bogus", "cron": "@daily", "config": {}},
    ]
    for body in bad:
        assert owner.post("/api/schedules", json=body).status_code == 400, body
    assert owner.put("/api/me/profile", json={"email": "not-an-email"}).status_code == 400
    preview = owner.get("/api/cron/preview", params={"cron": "0 7 * * *", "count": 2}).json()
    assert preview["description"] == "every day at 07:00" and len(preview["next"]) == 2
    status = owner.get("/api/schedules/status").json()
    assert status["email"] is True and status["origins"] == ["url", "connector"]
    assert status["email_address"] == "owner@example.test"


def test_due_schedules_run_in_the_background_loop_and_are_audited(org, app, mailer):
    owner = org["owner"]
    s = _save(owner, kind="alert", name="Any rows", cron="*/5 * * * *",
              config={"dataset": "labs", "aggregate": "count", "op": ">", "threshold": 0,
                      "recipients": ["user:owner"]})
    scheduler = app.state.scheduler
    due_at = datetime.datetime.fromisoformat(s["next_run"])
    assert scheduler.run_due(due_at - datetime.timedelta(minutes=1)) == []
    runs = scheduler.run_due(due_at)
    assert len(runs) == 1 and runs[0]["status"] == "ok" and len(mailer.sent) == 1
    assert scheduler.run_due(due_at) == []                   # claimed: moved on
    assert owner.get("/api/schedules/%s/runs" % s["id"]).json()["runs"][0]["cause"] == "schedule"
    events = app.state.audit.query(action="schedule.")["events"]
    assert {e["action"] for e in events} == {"schedule.save", "schedule.run"}
    assert next(e for e in events if e["action"] == "schedule.run")["detail"]["cause"] == \
        "schedule"


def test_background_thread_starts_with_the_app(tmp_path):
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
                                serve_static=False, scheduler_enabled=True,
                                dataset_store_uri="file://" + str(tmp_path / "ds"))
    with TestClient(app):
        assert app.state.scheduler.running
    assert not app.state.scheduler.running


def test_smtp_mailer_sends_multipart_with_an_inline_snapshot():
    import email
    import socketserver

    from cxd_server.mailer import SmtpMailer
    received = []

    class Smtp(socketserver.StreamRequestHandler):
        def handle(self):
            self.wfile.write(b"220 test\r\n")
            data = None
            while True:
                line = self.rfile.readline()
                if not line:
                    return
                if data is not None:
                    if line == b".\r\n":
                        received.append(b"".join(data))
                        data = None
                        self.wfile.write(b"250 queued\r\n")
                    else:
                        data.append(line[1:] if line.startswith(b"..") else line)
                    continue
                verb = line[:4].upper()
                if verb == b"EHLO":
                    self.wfile.write(b"250-test\r\n250 OK\r\n")
                elif verb == b"DATA":
                    data = []
                    self.wfile.write(b"354 go\r\n")
                elif verb == b"QUIT":
                    self.wfile.write(b"221 bye\r\n")
                    return
                else:
                    self.wfile.write(b"250 OK\r\n")

    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Smtp)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        mailer = SmtpMailer("127.0.0.1", server.server_address[1], sender="cxd@example.test",
                            security="none")
        png = b"\x89PNG\r\n\x1a\nfake"
        assert mailer.send([("ann@example.test", "Board", "text body", "<img src='cid:shot'>",
                             [("board.png", png, "image/png", "shot")])]) == 1
    finally:
        server.shutdown()
    msg = email.message_from_bytes(received[0])
    assert msg["To"] == "ann@example.test" and msg["Subject"] == "Board"
    parts = [p.get_content_type() for p in msg.walk()]
    assert "text/plain" in parts and "text/html" in parts and "image/png" in parts
    image = next(p for p in msg.walk() if p.get_content_type() == "image/png")
    assert image["Content-ID"] == "<shot>" and image.get_payload(decode=True) == png


def test_email_addresses_must_be_confirmed_and_sends_are_capped(tmp_path, monkeypatch):
    monkeypatch.setenv("CXD_EMAIL_DAILY_CAP", "2")
    mailer = MemoryMailer()
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
                                serve_static=False, mailer=mailer, scheduler_enabled=False,
                                publish_base_url="https://example.test/dashboards",
                                dataset_store_uri="file://" + str(tmp_path / "ds"))
    owner = TestClient(app)
    owner.post("/auth/signup", json={"username": "owner", "password": "secret1"})
    owner.post("/api/datasets", json={"id": "labs", "format": "json", "data": LABS})
    r = owner.put("/api/me/profile", json={"email": "victim@example.test"})
    assert r.json() == {"user": "owner", "email": "victim@example.test", "verified": False,
                        "confirmation_sent": True}
    link = _confirm_link(mailer)
    # Unconfirmed: an alert sends nothing to that address.
    s = _save(owner, kind="alert", name="rows", cron="@hourly",
              config={"dataset": "labs", "aggregate": "count", "op": ">", "threshold": 0,
                      "recipients": ["user:owner"]})
    run = _run(owner, s["id"])
    assert run["detail"]["no_email"] == 1 and mailer.sent == []
    assert "without a confirmed email address" in run["message"]
    # Resending is throttled; a wrong token does nothing.
    assert owner.post("/api/me/profile/confirm").json()["confirmation_sent"] is False
    assert owner.get("/api/me/verify-email", params={"token": "nope"}).status_code == 400
    # Confirming unlocks sending; the daily cap then limits it.
    anonymous = TestClient(app)
    assert anonymous.get(link.split("example.test/dashboards", 1)[1]).status_code == 200
    assert owner.get("/api/me/profile").json()["verified"] is True
    owner.post("/api/dashboards", json={"id": "d1", "title": "B", "layout": {"items": []},
                                        "panels": {}})
    sub = _save(owner, kind="subscription", name="board", cron="@daily",
                config={"dashboard": "d1", "recipients": ["user:owner"]})
    assert _run(owner, sub["id"])["detail"]["emailed"] == 1
    assert _run(owner, sub["id"])["detail"]["emailed"] == 1
    third = _run(owner, sub["id"])
    assert third["detail"]["emailed"] == 0 and third["detail"]["capped"] == 1
    assert "over today's email limit" in third["message"]
    # Changing the address needs a new confirmation; an admin-set one does not.
    owner.put("/api/me/profile", json={"email": "other@example.test"})
    assert owner.get("/api/me/profile").json()["verified"] is False
    owner.post("/api/admin/users/owner/email", json={"email": "ops@example.test"})
    assert owner.get("/api/me/profile").json() == {"user": "owner", "email": "ops@example.test",
                                                   "verified": True}


def test_smtp_password_can_come_from_a_file(tmp_path, monkeypatch):
    from cxd_server.mailer import SmtpMailer
    secret = tmp_path / "pass"
    secret.write_text("app pass word\n")
    monkeypatch.setenv("CXD_SMTP_HOST", "smtp.example.test")
    monkeypatch.delenv("CXD_SMTP_PASSWORD", raising=False)
    monkeypatch.setenv("CXD_SMTP_PASSWORD_FILE", str(secret))
    assert SmtpMailer.from_env().password == "app pass word"
