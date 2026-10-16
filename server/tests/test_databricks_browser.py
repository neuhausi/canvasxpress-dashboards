"""The Databricks catalog browser routes (cxd_server.databricks_browser) with the
token exchange, the REST call and the SQL all faked: no network, no Databricks."""

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.databricks_browser import (
    AuthError,
    databricks_host,
    install_databricks,
    make_auth,
    source_url,
    table_sql,
    valid_name,
)
from cxd_server.store import DashboardStore

HOST = "dbc-1234.cloud.databricks.com"
WAREHOUSES = {"warehouses": [
    {"id": "abc123", "name": "Main", "state": "RUNNING"},
    {"id": "def456", "name": "Idle", "state": "STOPPED"},
    {"id": "old789", "name": "Gone", "state": "DELETED"}]}


class FakeStore:
    def __init__(self):
        self.saved = {}

    def list_sources(self, user):
        return [n for (u, n) in self.saved if u == user]

    def save_source(self, user, name, url, sql, **kw):
        self.saved[(user, name)] = (url, sql)


class Calls:
    """Records every SQL batch; answers by token so users can be told apart."""

    def __init__(self):
        self.sql = []
        self.rest_tokens = []

    def rest(self, host, path, token):
        assert host == HOST and path == "/api/2.0/sql/warehouses"
        self.rest_tokens.append(token)
        return WAREHOUSES

    mode = None

    def run(self, url, queries):
        if self.mode:
            return self.mode(url, queries)
        self.sql.append((url, queries))
        who = url.split("token:")[1].split("@")[0]
        out = []
        for sql, params, cap in queries:
            if "information_schema.catalogs" in sql:
                out.append((["catalog_name"], [["main_" + who], ["samples"]], False))
            elif "schemata" in sql:
                out.append((["schema_name"], [["default"], ["sales"]], False))
            elif "information_schema.tables" in sql:
                out.append((["table_name", "table_type"], [["orders", "MANAGED"], ["v_orders", "VIEW"]], True))
            elif "information_schema.columns" in sql:
                out.append((["column_name", "data_type"], [["id", "bigint"], ["amt", "decimal(10,2)"]], False))
            else:
                out.append((["id", "amt"], [[1, __import__("decimal").Decimal("2.50")]], False))
        return out


def _app(tmp_path, env=None, calls=None, token_for=None, oauth=lambda h: True):
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
                                serve_static=False, dataset_store_uri="file://" + str(tmp_path / "ds"))
    calls = calls or Calls()
    store = FakeStore()
    install_databricks(app, store, env={"CXD_DATABRICKS_HOST": HOST} if env is None else env,
                       token_for=token_for or (lambda h: h.get("posit-connect-user-session-token") or _no()),
                       viewer_oauth=oauth, rest=calls.rest, run=calls.run)
    return app, calls, store


def _no():
    raise AuthError("no viewer token", 403)


def _client(app, user="alice"):
    c = TestClient(app)
    assert c.post("/auth/signup", json={"username": user, "password": "secret1"}).status_code == 200
    return c


def _h(token="tok-a"):
    return {"Posit-Connect-User-Session-Token": token}


Q = "/api/connectors/databricks/"


def test_warehouses_are_mapped_and_deleted_ones_dropped(tmp_path):
    app, calls, _ = _app(tmp_path)
    r = _client(app).get(Q + "warehouses", headers=_h())
    assert r.status_code == 200
    assert r.json()["warehouses"] == [
        {"id": "abc123", "name": "Main", "state": "RUNNING", "http_path": "/sql/1.0/warehouses/abc123"},
        {"id": "def456", "name": "Idle", "state": "STOPPED", "http_path": "/sql/1.0/warehouses/def456"}]
    assert calls.rest_tokens == ["tok-a"]


def test_each_tree_level_returns_names_and_flags_truncation(tmp_path):
    app, calls, _ = _app(tmp_path)
    c = _client(app)
    w = "?warehouse=abc123"
    assert c.get(Q + "catalogs" + w, headers=_h("u1")).json()["catalogs"] == ["main_u1", "samples"]
    s = c.get(Q + "schemas" + w + "&catalog=main", headers=_h()).json()
    assert s["schemas"] == ["default", "sales"] and s["count"] == 2 and s["truncated"] is False
    t = c.get(Q + "tables" + w + "&catalog=main&schema=sales", headers=_h()).json()
    assert t["tables"] == [{"name": "orders", "kind": "table"}, {"name": "v_orders", "kind": "view"}]
    assert t["truncated"] is True
    sql = calls.sql[-1][1][0]
    assert "`main`.information_schema.tables" in sql[0] and sql[1]["schema"] == "sales"
    d = c.get(Q + "table" + w + "&catalog=main&schema=sales&table=orders", headers=_h()).json()
    assert d["columns"] == ["id", "amt"] and d["rows"] == 1
    assert d["data"]["y"]["smps"] == ["1"] and d["data"]["y"]["vars"] == ["amt"]   # a CanvasXpress table
    assert len(calls.sql[-1][1]) == 1                    # one query: no separate columns lookup
    preview_sql = calls.sql[-1][1][0][0]
    assert preview_sql == "SELECT * FROM `main`.`sales`.`orders` LIMIT 50"


@pytest.mark.parametrize("path", [
    "schemas?warehouse=abc123&catalog=ma%60in",              # backtick
    "schemas?warehouse=abc123&catalog=a.b",
    "schemas?warehouse=abc123&catalog=",
    "tables?warehouse=abc123&catalog=main&schema=x%27%20OR%201%3D1",
    "table?warehouse=abc123&catalog=main&schema=s&table=t%3B%20DROP",
    "catalogs?warehouse=abc%2Fdef",                          # bad warehouse id
])
def test_invalid_names_are_rejected_before_any_sql(tmp_path, path):
    app, calls, _ = _app(tmp_path)
    assert _client(app).get(Q + path, headers=_h()).status_code == 400
    assert calls.sql == []


def test_unknown_warehouse_is_rejected_before_any_sql(tmp_path):
    app, calls, _ = _app(tmp_path)
    r = _client(app).get(Q + "catalogs?warehouse=zzz999", headers=_h())
    assert r.status_code == 404 and calls.sql == []


def test_no_viewer_token_is_403_before_anything_else(tmp_path):
    app, calls, _ = _app(tmp_path)
    c = _client(app)
    for path in ("warehouses", "catalogs?warehouse=abc123", "schemas?warehouse=bad!&catalog=%60"):
        assert c.get(Q + path).status_code == 403
    assert calls.sql == [] and calls.rest_tokens == []


def test_exchange_failure_is_502(tmp_path):
    def broken(headers):
        raise AuthError("Posit Connect could not supply the viewer's Databricks token", 502)
    app, _, _ = _app(tmp_path, token_for=broken)
    assert _client(app).get(Q + "warehouses", headers=_h()).status_code == 502


def test_login_is_required(tmp_path):
    app, _, _ = _app(tmp_path)
    assert TestClient(app).get(Q + "warehouses", headers=_h()).status_code == 401


def test_two_viewers_never_see_each_others_results(tmp_path):
    app, calls, _ = _app(tmp_path)
    a, b = _client(app, "alice"), _client(app, "bob")
    ra = a.get(Q + "catalogs?warehouse=abc123", headers=_h("alice-token")).json()
    rb = b.get(Q + "catalogs?warehouse=abc123", headers=_h("bob-token")).json()
    assert ra["catalogs"][0] == "main_alice-token" and rb["catalogs"][0] == "main_bob-token"
    assert [u.split("token:")[1].split("@")[0] for u, _ in calls.sql] == ["alice-token", "bob-token"]


def test_permission_errors_are_mapped_and_the_token_never_leaks(tmp_path):
    calls = Calls()

    def deny(url, queries):
        raise RuntimeError("[INSUFFICIENT_PERMISSIONS] User does not have USE CATALOG on Catalog 'main' (%s)" % url)
    calls.mode = deny
    app, _, _ = _app(tmp_path, calls=calls)
    r = _client(app).get(Q + "schemas?warehouse=abc123&catalog=main", headers=_h("secret-tok"))
    assert r.status_code == 403 and "don't have access to catalog main" in r.json()["detail"]
    assert "secret-tok" not in r.text

    calls.mode = lambda url, queries: (_ for _ in ()).throw(RuntimeError("boom " + url))
    r = _client(app, "bob").get(Q + "schemas?warehouse=abc123&catalog=main", headers=_h("secret-tok"))
    assert r.status_code == 502 and "secret-tok" not in r.text


def test_save_as_source_builds_the_url_and_default_select(tmp_path):
    app, _, store = _app(tmp_path)
    c = _client(app)
    body = {"warehouse": "abc123", "catalog": "main", "schema": "sales", "table": "orders"}
    r = c.post(Q + "save-source", json=body, headers=_h())
    assert r.status_code == 200 and r.json()["name"] == "orders"
    url, sql = store.saved[("alice", "orders")]
    assert url == ("databricks://posit-connect@%s?http_path=/sql/1.0/warehouses/abc123"
                   "&catalog=main&schema=sales" % HOST)
    assert sql == "SELECT * FROM `main`.`sales`.`orders`"
    assert c.post(Q + "save-source", json=body, headers=_h()).json()["name"] == "orders-2"   # never replaces
    bad = dict(body, table="x`; DROP")
    assert c.post(Q + "save-source", json=bad, headers=_h()).status_code == 400
    assert c.post(Q + "save-source", json=dict(body, warehouse="nope99"), headers=_h()).status_code == 404


def test_section_is_hidden_when_the_host_is_unset(tmp_path):
    app, calls, _ = _app(tmp_path, env={})
    c = _client(app)
    assert c.get(Q + "config").json()["enabled"] is False
    assert c.get(Q + "warehouses", headers=_h()).status_code == 404
    assert calls.rest_tokens == []


def test_config_reports_host_when_set(tmp_path):
    app, _, _ = _app(tmp_path)
    cfg = _client(app).get(Q + "config").json()
    assert cfg["enabled"] is True and cfg["host"] == HOST


def test_works_without_posit_connect_via_a_shared_token(tmp_path):
    env = {"CXD_DATABRICKS_HOST": "https://%s/" % HOST, "CXD_DATABRICKS_TOKEN": "shared-pat"}
    token_for, oauth = make_auth("auto", env)
    app, calls, store = _app(tmp_path, env=env, token_for=token_for, oauth=oauth)
    c = _client(app)
    assert c.get(Q + "warehouses").status_code == 200           # no Connect header at all
    assert calls.rest_tokens == ["shared-pat"]
    assert c.get(Q + "config").json()["viewer_oauth"] is False
    c.post(Q + "save-source", json={"warehouse": "abc123", "catalog": "main", "schema": "s", "table": "t"})
    assert store.saved[("alice", "t")][0].startswith("databricks://token:REPLACE_WITH_TOKEN@" + HOST)


def test_auto_prefers_connect_when_the_header_is_present_and_forced_modes_hold():
    env = {"CXD_DATABRICKS_TOKEN": "shared-pat"}
    token_for, oauth = make_auth("auto", env, client_factory=None)
    assert oauth({"posit-connect-user-session-token": "x"}) is True and oauth({}) is False
    with pytest.raises(AuthError) as e:
        make_auth("posit-connect", env)[0]({})
    assert e.value.status == 403
    assert make_auth("token", env)[0]({"posit-connect-user-session-token": "x"}) == "shared-pat"
    with pytest.raises(AuthError):
        make_auth("token", {})[0]({})
    assert make_auth("auto", {})[1]({}) is True      # nothing configured: Connect semantics, 403 on use


def test_helpers():
    assert databricks_host({"CXD_DATABRICKS_HOST": "https://dbc-1234.cloud.databricks.com/"}) == HOST
    assert databricks_host({"CXD_DATABRICKS_HOST": "bad host!"}) is None and databricks_host({}) is None
    assert valid_name("my-cat_1") and not valid_name("a`b") and not valid_name("") and not valid_name(None)
    assert table_sql("c", "s", "t") == "SELECT * FROM `c`.`s`.`t`"
    assert source_url(HOST, "w1", "c", "s", True).startswith("databricks://posit-connect@")
