"""Governance: roles and groups, sharing with users/groups, row- and column-level
security on stored datasets, lineage, and cleanup."""

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.governance import (
    Governance,
    GovernanceError,
    _SqlDb,
    apply_policy,
    build_lineage,
    normalize_policy,
)
from cxd_server.store import DashboardStore

TABLE = [["patient", "site", "age", "name"],
         ["p1", "A", 61, "Ann"], ["p2", "B", 55, "Bob"], ["p3", "A", 70, "Cy"]]
CX = {"y": {"vars": ["age", "weight"], "smps": ["p1", "p2", "p3"],
            "data": [[61, 55, 70], [80, 72, 90]]},
      "x": {"site": ["A", "B", "A"], "name": ["Ann", "Bob", "Cy"]},
      "z": {"unit": ["y", "kg"]}}
POLICY = {"rows": [{"field": "site", "allow": {"group:site-a": ["A"], "user:lead": "*"}}],
          "columns": [{"hide": ["name"], "except": ["group:clinicians"]}]}


def _spec(dashboard_id="d1", dataset_id="trial"):
    return {"id": dashboard_id, "title": "Trial", "layout": {"items": []},
            "data": {"t": {"kind": "dataset", "id": dataset_id}},
            "panels": {"p": {"dataRef": "t", "config": {"graphType": "Bar"}}}}


@pytest.fixture
def app(tmp_path):
    return create_dashboards_app(store=DashboardStore(str(tmp_path / "dash.db")),
                                 session_secret="s", serve_static=False,
                                 dataset_store_uri="file://" + str(tmp_path / "datasets"))


def _user(app, name):
    client = TestClient(app)
    r = client.post("/auth/signup", json={"username": name, "password": "secret1"})
    assert r.status_code == 200, r.text
    return client


@pytest.fixture
def org(app):
    """root (admin), owner (uploads + builds), and four viewers."""
    clients = {name: _user(app, name) for name in
               ("root", "owner", "ann", "bea", "lead", "outsider")}
    root = clients["root"]
    assert root.post("/api/admin/groups", json={"name": "site-a", "members": ["ann", "bea"]}
                     ).status_code == 200
    root.post("/api/admin/groups", json={"name": "clinicians", "members": ["bea"]})
    owner = clients["owner"]
    assert owner.post("/api/datasets", json={"id": "trial", "title": "Trial", "format": "json",
                                              "data": TABLE}).status_code == 200
    assert owner.post("/api/dashboards", json=_spec()).status_code == 200
    return clients


# ---- roles and groups ---------------------------------------------------------
def test_default_role_keeps_todays_behaviour(app):
    alice = _user(app, "root") and _user(app, "alice")
    me = alice.get("/auth/me").json()
    assert me["roles"] == ["editor"] and "dashboard.create" in me["permissions"]


def test_viewer_role_cannot_create_but_can_open_what_is_shared(org):
    root, owner, ann = org["root"], org["owner"], org["ann"]
    assert root.post("/api/admin/roles/assign", json={"principal": "group:site-a",
                                                      "role": "viewer"}).status_code == 200
    assert ann.post("/api/dashboards", json=_spec("mine")).status_code == 403
    assert ann.post("/api/datasets", json={"format": "json", "data": TABLE}).status_code == 403
    assert ann.post("/api/llm/dashboard", json={"message": "hi"}).status_code == 403
    owner.post("/api/dashboards/d1/grants", json={"principal": "group:site-a", "level": "view"})
    assert ann.get("/api/dashboards/d1", params={"owner": "owner"}).status_code == 200


def test_custom_role_and_union_of_user_and_group_roles(org):
    root = org["root"]
    assert root.post("/api/admin/roles", json={"name": "uploader",
                                               "permissions": ["dataset.create"]}
                     ).status_code == 200
    root.post("/api/admin/roles/assign", json={"principal": "group:site-a", "role": "viewer"})
    root.post("/api/admin/roles/assign", json={"principal": "user:bea", "role": "uploader"})
    assert org["bea"].get("/auth/me").json()["permissions"] == ["dataset.create"]
    assert org["ann"].get("/auth/me").json()["permissions"] == []
    # Built-ins are fixed; unknown permissions and roles are rejected.
    assert root.post("/api/admin/roles", json={"name": "editor", "permissions": []}
                     ).status_code == 400
    assert root.post("/api/admin/roles", json={"name": "x", "permissions": ["nope"]}
                     ).status_code == 400
    assert root.post("/api/admin/roles/assign", json={"principal": "user:bea", "role": "ghost"}
                     ).status_code == 400
    # Deleting a role clears its assignments.
    root.delete("/api/admin/roles/uploader")
    assert org["bea"].get("/auth/me").json()["roles"] == ["viewer"]


def test_governance_admin_endpoints_are_admin_only(org):
    ann = org["ann"]
    assert ann.get("/api/admin/governance").status_code == 403
    assert ann.post("/api/admin/groups", json={"name": "x"}).status_code == 403
    assert ann.get("/api/admin/lineage").status_code == 403
    body = org["root"].get("/api/admin/governance").json()
    assert [g["name"] for g in body["groups"]] == ["clinicians", "site-a"]
    assert {r["name"] for r in body["roles"]} >= {"viewer", "editor"}
    assert org["root"].post("/api/admin/groups", json={"name": "g", "members": ["ghost"]}
                            ).status_code == 400


# ---- sharing with users and groups -------------------------------------------
def test_no_grant_no_access(org):
    outsider = org["outsider"]
    assert outsider.get("/api/dashboards/d1", params={"owner": "owner"}).status_code == 404
    assert outsider.get("/api/datasets/trial", params={"owner": "owner"}).status_code == 404
    assert all(d["id"] != "d1" for d in outsider.get("/api/dashboards").json()["dashboards"])


def test_view_grant_to_a_group_lists_opens_and_reaches_the_data(org):
    owner, ann = org["owner"], org["ann"]
    r = owner.post("/api/dashboards/d1/grants", json={"principal": "group:site-a",
                                                      "level": "view"})
    assert r.json()["grants"] == [{"principal": "group:site-a", "level": "view"}]
    listed = {d["id"]: d for d in ann.get("/api/dashboards").json()["dashboards"]}
    assert listed["d1"]["owner"] == "owner" and listed["d1"]["readOnly"] is True
    spec = ann.get("/api/dashboards/d1").json()          # found without ?owner= too
    assert spec["data"]["t"]["owner"] == "owner"         # pinned for the data fetch
    data = ann.get("/api/datasets/trial", params={"owner": "owner"}).json()
    assert len(data) == 4                                 # no policy yet: everything
    # A view grant does not allow saving over the owner's dashboard.
    assert ann.post("/api/dashboards", params={"owner": "owner"}, json=spec).status_code == 403


def test_edit_grant_saves_to_the_owner_unless_locked(org):
    owner, bea, root = org["owner"], org["bea"], org["root"]
    owner.post("/api/dashboards/d1/grants", json={"principal": "user:bea", "level": "edit"})
    spec = bea.get("/api/dashboards/d1", params={"owner": "owner"}).json()
    spec["title"] = "Trial (edited by bea)"
    assert bea.post("/api/dashboards", params={"owner": "owner"}, json=spec).status_code == 200
    stored = owner.get("/api/dashboards/d1").json()
    assert stored["title"] == "Trial (edited by bea)"
    assert "owner" not in stored["data"]["t"]             # the pin is not persisted
    root.post("/api/dashboards/d1/lock", params={"owner": "owner"}, json={"locked": True})
    assert bea.post("/api/dashboards", params={"owner": "owner"}, json=spec).status_code == 403


def test_everyone_grant_direct_dataset_grant_and_revoke(org):
    owner, lead, outsider = org["owner"], org["lead"], org["outsider"]
    owner.post("/api/dashboards/d1/grants", json={"principal": "*", "level": "view"})
    assert outsider.get("/api/dashboards/d1", params={"owner": "owner"}).status_code == 200
    owner.post("/api/dashboards/d1/grants", json={"principal": "*", "level": None})
    assert outsider.get("/api/dashboards/d1", params={"owner": "owner"}).status_code == 404
    owner.post("/api/datasets/trial/grants", json={"principal": "user:lead", "level": "view"})
    shared = [d for d in lead.get("/api/datasets").json()["datasets"] if d.get("shared")]
    assert [(d["id"], d["owner"]) for d in shared] == [("trial", "owner")]
    assert lead.get("/api/datasets/trial", params={"owner": "owner"}).status_code == 200


def test_only_the_owner_manages_grants_and_principals_must_exist(org):
    owner, ann = org["owner"], org["ann"]
    assert ann.post("/api/dashboards/d1/grants", params={"owner": "owner"},
                    json={"principal": "user:ann", "level": "edit"}).status_code == 403
    assert owner.post("/api/dashboards/d1/grants", json={"principal": "user:ghost",
                                                         "level": "view"}).status_code == 400
    assert owner.post("/api/dashboards/nope/grants", json={"principal": "user:ann",
                                                           "level": "view"}).status_code == 404
    assert owner.post("/api/dashboards/d1/grants", json={"principal": "user:ann",
                                                         "level": "admin"}).status_code == 400


# ---- row- and column-level security ------------------------------------------
def test_row_and_column_policy_on_a_table_dataset(org):
    owner = org["owner"]
    owner.post("/api/dashboards/d1/grants", json={"principal": "*", "level": "view"})
    assert owner.put("/api/datasets/trial/policy", json={"policy": POLICY}).status_code == 200

    def rows(client):
        r = client.get("/api/datasets/trial", params={"owner": "owner"})
        return r.json() if r.status_code == 200 else r.status_code

    assert rows(org["ann"]) == [["patient", "site", "age"], ["p1", "A", 61], ["p3", "A", 70]]
    assert rows(org["bea"]) == [["patient", "site", "age", "name"],     # a clinician
                                ["p1", "A", 61, "Ann"], ["p3", "A", 70, "Cy"]]
    assert len(rows(org["lead"])) == 4                                   # "*": every site
    assert rows(org["outsider"]) == [["patient", "site", "age"]]         # fails closed
    assert len(rows(owner)) == 4 and len(rows(org["root"])) == 4         # owner, admin
    # The owner reads the policy back; nobody else manages it.
    assert owner.get("/api/datasets/trial/policy").json()["policy"] == POLICY
    assert org["ann"].put("/api/datasets/trial/policy", params={"owner": "owner"},
                          json={"policy": None}).status_code == 403


def test_policy_applies_to_share_links_as_anonymous(org):
    owner = org["owner"]
    owner.put("/api/datasets/trial/policy", json={"policy": POLICY})
    token = owner.post("/api/dashboards/d1/share", json={"visibility": "public"}
                       ).json()["dashboard"]["share_token"]
    anonymous = TestClient(owner.app)
    data = anonymous.get("/api/shared/" + token).json()["spec"]["data"]["t"]["value"]
    assert data == [["patient", "site", "age"]]          # no rows allowed for anonymous
    signed_in = org["ann"].get("/api/shared/" + token).json()["spec"]["data"]["t"]["value"]
    assert [r[0] for r in signed_in[1:]] == ["p1", "p3"]


def test_share_link_cannot_pin_someone_elses_dataset(org):
    # outsider writes a spec pointing at owner's dataset and shares it publicly.
    outsider = org["outsider"]
    spec = _spec("steal")
    spec["data"]["t"]["owner"] = "owner"
    outsider.post("/api/dashboards", json=spec)
    token = outsider.post("/api/dashboards/steal/share", json={"visibility": "public"}
                          ).json()["dashboard"]["share_token"]
    shared = TestClient(outsider.app).get("/api/shared/" + token).json()["spec"]
    assert shared["data"]["t"]["kind"] == "dataset"       # not inlined: no access


def test_apply_policy_on_canvasxpress_data():
    out = apply_policy(CX, POLICY, ["user:ann", "group:site-a", "*"])
    assert out["y"]["smps"] == ["p1", "p3"] and out["y"]["data"] == [[61, 70], [80, 90]]
    assert out["x"] == {"site": ["A", "A"]}               # "name" hidden
    hide_var = {"columns": [{"hide": ["weight"]}]}
    out = apply_policy(CX, hide_var, ["anonymous"])
    assert out["y"]["vars"] == ["age"] and out["y"]["data"] == [[61, 55, 70]]
    assert out["z"] == {"unit": ["y"]}
    missing_field = {"rows": [{"field": "region", "allow": {"*": "*"}}]}
    assert apply_policy(CX, missing_field, ["*"])["y"]["smps"] == ["p1", "p2", "p3"]
    missing_field = {"rows": [{"field": "region", "allow": {"*": ["x"]}}]}
    assert apply_policy(CX, missing_field, ["*"])["y"]["smps"] == []
    assert apply_policy({"nodes": []}, POLICY, ["*"]) is None     # unfilterable: withheld


def test_policy_validation():
    assert normalize_policy({}) is None
    for bad in ({"rows": [{"allow": {}}]}, {"rows": [{"field": "s"}]},
                {"columns": [{"hide": []}]}, {"other": 1}, {"rows": [{"field": "s",
                                                                       "allow": {"*": 3}}]}):
        with pytest.raises(GovernanceError):
            normalize_policy(bad)


# ---- lineage and cleanup ------------------------------------------------------
def test_lineage_maps_dashboards_to_sources_and_back(org):
    owner, root = org["owner"], org["root"]
    spec = _spec("d2")
    spec["data"]["j"] = {"kind": "join", "left": "t", "right": "c", "on": "patient"}
    spec["data"]["c"] = {"kind": "connector", "url": "/connectors/api/data?source=db"}
    owner.post("/api/dashboards", json=spec)
    mine = owner.get("/api/lineage").json()
    assert {d["id"] for d in mine["dashboards"]} == {"d1", "d2"}
    assert mine["datasets"] == [{"owner": "owner", "store": "", "id": "trial",
                                 "used_by": [{"owner": "owner", "id": "d1", "title": "Trial"},
                                             {"owner": "owner", "id": "d2", "title": "Trial"}]}]
    d2 = next(d for d in mine["dashboards"] if d["id"] == "d2")
    kinds = {s["ref"]: s["kind"] for s in d2["sources"]}
    assert kinds == {"t": "dataset", "j": "join", "c": "connector"}
    assert next(s for s in d2["sources"] if s["ref"] == "t")["panels"] == ["p"]
    assert root.get("/api/admin/lineage").json()["connectors"][0]["used_by"][0]["id"] == "d2"
    assert build_lineage([])["dashboards"] == []


def test_deleting_resources_and_users_drops_their_grants(org, app):
    owner, root = org["owner"], org["root"]
    owner.post("/api/dashboards/d1/grants", json={"principal": "user:ann", "level": "view"})
    owner.put("/api/datasets/trial/policy", json={"policy": POLICY})
    owner.delete("/api/datasets/trial")
    gov = app.state.governance
    assert gov.get_policy("owner", "trial", "local") is None
    owner.delete("/api/dashboards/d1")
    assert gov.shared_with("ann", "dashboard") == []
    root.delete("/api/admin/users/ann")
    assert "ann" not in gov.list_groups()[1]["members"]


def test_governance_actions_are_audited(org, app):
    org["owner"].post("/api/dashboards/d1/grants", json={"principal": "group:site-a",
                                                         "level": "view"})
    org["owner"].put("/api/datasets/trial/policy", json={"policy": POLICY})
    events = app.state.audit.query(limit=500)["events"]           # newest first

    def latest(action):
        return next(e for e in events if e["action"] == action)
    assert latest("dashboard.grant")["detail"] == {"principal": "group:site-a", "level": "view"}
    assert latest("dataset.policy")["detail"]["rows"] == 1
    assert latest("admin.group.save")["target"] == "clinicians"


def test_sql_backend_via_sqlalchemy(tmp_path):
    sa = pytest.importorskip("sqlalchemy")
    engine = sa.create_engine("sqlite:///" + str(tmp_path / "gov.db"), future=True)
    gov = Governance(_SqlDb(engine))
    gov.save_group("site-a", members=["ann"])
    gov.save_role("uploader", ["dataset.create"])
    gov.assign_role("group:site-a", "uploader")
    gov.set_grant("dashboard", "owner", "d1", "group:site-a", "view")
    gov.set_grant("dashboard", "owner", "d1", "group:site-a", "edit")     # upsert
    gov.set_policy("owner", "trial", POLICY, "local")
    assert gov.permissions_for("ann") == {"dataset.create"}
    assert gov.shared_with("ann", "dashboard") == [{"owner": "owner", "store": "", "id": "d1",
                                                    "level": "edit"}]
    assert gov.get_policy("owner", "trial", "local") == POLICY
