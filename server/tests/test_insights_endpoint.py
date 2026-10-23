"""The insights endpoints: opt-in, computed from what the viewer may see, for owners and share links."""

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.store import DashboardStore


def cohort(n=60):
    """60 patients: lane drives q30, and S8 is a far outlier in reads."""
    smps = ["P%02d" % (i + 1) for i in range(n)]
    lane = ["L%d" % (1 + i % 3) for i in range(n)]
    q30 = [80 + (i % 3) * 6 + (i * 7) % 5 for i in range(n)]
    reads = [1000 + (i * 13) % 40 + (900 if i == 7 else 0) for i in range(n)]
    return {"y": {"vars": ["q30", "reads"], "smps": smps, "data": [q30, reads]},
            "x": {"lane": lane, "site": ["A" if i < 30 else "B" for i in range(n)]}}


def spec(dashboard_id="qc", insights=None, dataset="qcdata", extra_data=None):
    s = {"id": dashboard_id, "title": "QC", "layout": {"items": []},
         "data": {"d": {"kind": "dataset", "id": dataset}},
         "panels": {"p": {"dataRef": "d", "config": {"graphType": "Bar"}}}}
    if insights is not None:
        s["insights"] = insights
    s["data"].update(extra_data or {})
    return s


@pytest.fixture
def app(tmp_path):
    return create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")), session_secret="s",
                                 serve_static=False, dataset_store_uri="file://" + str(tmp_path / "ds"))


def user(app, name):
    client = TestClient(app)
    assert client.post("/auth/signup", json={"username": name, "password": "secret1"}).status_code == 200
    return client


@pytest.fixture
def owner(app):
    user(app, "root")                      # the first account is the admin
    client = user(app, "owner")
    assert client.post("/api/datasets", json={"id": "qcdata", "title": "QC", "format": "cx",
                                              "data": cohort()}).status_code == 200
    return client


def test_a_dashboard_without_an_insights_block_runs_nothing(owner):
    owner.post("/api/dashboards", json=spec())
    r = owner.get("/api/dashboards/qc/insights")
    assert r.status_code == 200
    assert r.json() == {"enabled": False, "insights": [], "more": 0, "checked": {}}


def test_the_owner_gets_ranked_insights_with_captions_and_figures(owner):
    owner.post("/api/dashboards", json=spec(insights={"thresholds": [
        {"field": "q30", "op": "lt", "value": 84, "label": "Q30 below 84"}]}))
    body = owner.get("/api/dashboards/qc/insights").json()
    assert body["enabled"] is True and body["checked"]["sources"] == ["d"]
    first = body["insights"][0]
    assert first["kind"] == "threshold" and first["caption"].startswith("Q30 below 84: ")
    assert first["figures"]["count"] > 0 and first["ids"]
    kinds = {i["kind"] for i in body["insights"]}
    assert "outliers" in kinds and "group-difference" in kinds
    out = [i for i in body["insights"] if i["kind"] == "outliers"][0]
    assert out["field"] == "reads" and out["ids"][0] == "P08"
    diff = [i for i in body["insights"] if i["kind"] == "group-difference"][0]
    assert diff["group_by"] == "lane" and diff["figures"]["p_adjusted"] < 0.05


def test_a_share_link_gets_the_same_insights_without_logging_in(owner, app):
    owner.post("/api/dashboards", json=spec(insights={}))
    token = owner.post("/api/dashboards/qc/share", json={"visibility": "public"}).json()["dashboard"]["share_token"]
    anonymous = TestClient(app)
    body = anonymous.get("/api/shared/%s/insights" % token).json()
    assert body["enabled"] is True and body["insights"]
    assert {i["id"] for i in body["insights"]} == {i["id"] for i in owner.get("/api/dashboards/qc/insights").json()["insights"]}
    assert anonymous.get("/api/shared/nope/insights").status_code == 404


def test_a_narrowed_copy_is_not_checked_twice(owner):
    narrowed = {"case": {"kind": "dataset", "id": "qcdata",
                         "pushdown": {"where": [{"column": "smps", "op": "=", "value": "$case"}]}}}
    owner.post("/api/dashboards", json=dict(spec(insights={}, extra_data=narrowed), params={"case": {"value": "P01"}}))
    body = owner.get("/api/dashboards/qc/insights").json()
    assert body["checked"]["sources"] == ["d"]
    token = owner.post("/api/dashboards/qc/share", json={"visibility": "public"}).json()["dashboard"]["share_token"]
    assert TestClient(owner.app).get("/api/shared/%s/insights" % token).json()["checked"]["sources"] == ["d"]


def test_a_viewer_only_gets_insights_from_the_rows_they_may_see(owner, app):
    owner.post("/api/dashboards", json=spec(insights={}))
    token = owner.post("/api/dashboards/qc/share", json={"visibility": "public"}).json()["dashboard"]["share_token"]
    # Only group "never" may see rows: an anonymous link viewer gets none, so nothing to report.
    policy = {"rows": [{"field": "site", "allow": {"group:never": "*"}}]}
    assert owner.put("/api/datasets/qcdata/policy", json={"policy": policy}).status_code == 200
    body = TestClient(app).get("/api/shared/%s/insights" % token).json()
    assert body["enabled"] is True and body["insights"] == []
    assert owner.get("/api/dashboards/qc/insights").json()["insights"]        # the owner is unaffected


def test_insights_need_a_login_and_view_access(owner, app):
    owner.post("/api/dashboards", json=spec(insights={}))
    assert TestClient(app).get("/api/dashboards/qc/insights", params={"owner": "owner"}).status_code == 401
    outsider = user(app, "outsider")
    assert outsider.get("/api/dashboards/qc/insights", params={"owner": "owner"}).status_code == 404
    assert owner.get("/api/dashboards/missing/insights").status_code == 404
