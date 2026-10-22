"""GET /api/connectors/source: a stored secret may be replaced but never shown again.

A SaaS source (Salesforce, ServiceNow, pins) stores a JSON document of credentials; that must
come back with every secret masked, while the non-secret parts (username, domain, app name) stay
readable so the owner can still see what the source points at. A database source's connection
string is masked the same way (``postgresql://app:********@host/db``) and restored on save.

The database half and the source ``type`` come from ``cx_connectors.connmask`` / ``.kinds``;
with a canvasxpress-connectors that predates them those tests skip, and the URL is shown as
stored (the last test).
"""

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

pytest.importorskip("cx_connectors.store")
from cx_connectors.store import generate_key  # noqa: E402

try:
    from cx_connectors import connmask as _connmask  # noqa: F401, E402
    from cx_connectors import kinds as _kinds  # noqa: F401, E402
except ImportError:
    _HAS_MASKING = False
else:
    _HAS_MASKING = True
needs_masking = pytest.mark.skipif(
    not _HAS_MASKING, reason="installed canvasxpress-connectors predates connmask/kinds"
)

from cxd_server.app import create_dashboards_app  # noqa: E402
from cxd_server.connectors import SECRET_MASK, install_connectors, redact_secrets  # noqa: E402
from cxd_server.store import DashboardStore  # noqa: E402

PASSWORD, TOKEN, SECRET, API_KEY = "hunter2-pw", "TOKEN-abc123", "client-s3cr3t", "key-xyz789"


# ---- the masking rule ---------------------------------------------------------------------


def test_masks_secret_fields_and_keeps_the_rest():
    blob = {
        "username": "u@acme.com",
        "password": PASSWORD,
        "security_token": TOKEN,
        "domain": "acme.my",
        "client_id": "cid",
        "client_secret": SECRET,
        "refresh_token": "r",
        "api_key": API_KEY,
        "oauth_app": "default",
        "instance": "acme",
        "table": "incident",
    }
    out = redact_secrets(blob)
    for name in ("password", "security_token", "client_secret", "refresh_token", "api_key"):
        assert out[name] == SECRET_MASK, name
    for name in ("username", "domain", "client_id", "oauth_app", "instance", "table"):
        assert out[name] == blob[name], name


def test_masks_inside_nested_objects_and_lists_without_touching_the_input():
    blob = {
        "auth": {"type": "oauth", "client_secret": SECRET, "password": PASSWORD},
        "config": {"servers": [{"api_key": API_KEY, "url": "https://c.example"}]},
    }
    out = redact_secrets(blob)
    assert out["auth"] == {"type": "oauth", "client_secret": SECRET_MASK, "password": SECRET_MASK}
    assert out["config"]["servers"] == [{"api_key": SECRET_MASK, "url": "https://c.example"}]
    assert blob["auth"]["password"] == PASSWORD  # the original is unchanged


def test_an_empty_secret_stays_empty_so_unset_is_distinguishable_from_set():
    assert redact_secrets({"password": "", "security_token": None}) == {
        "password": "",
        "security_token": None,
    }


def test_non_secret_names_that_merely_look_similar_are_kept():
    # "keyword" does not END in key, "monkey_business" has no "pass"/"secret"/"token".
    out = redact_secrets({"keyword": "k", "monkey_business": "m", "domain": "d"})
    assert out == {"keyword": "k", "monkey_business": "m", "domain": "d"}


# ---- the endpoint -------------------------------------------------------------------------


@pytest.fixture
def app(tmp_path):
    app = create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")),
        session_secret="s",
        serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "datasets"),
        scheduler_enabled=False,
    )
    install_connectors(
        app, str(tmp_path / "sub" / "connectors.db"), generate_key(), session_secret="s"
    )
    return app


def _bridged(app, user):
    client = TestClient(app)
    assert (
        client.post("/auth/signup", json={"username": user, "password": "secret1"}).status_code
        == 200
    )
    cred = client.get("/api/connectors/credentials").json()
    assert client.post("/connectors/auth/login", json=cred).status_code == 200
    return client


def test_a_salesforce_login_is_returned_masked(app):
    client = _bridged(app, "ann")
    registered = client.post(
        "/connectors/api/sources",
        json={
            "name": "opps",
            "kind": "salesforce",
            "soql": "SELECT Name FROM Opportunity",
            "auth": {
                "username": "u@acme.com",
                "password": PASSWORD,
                "security_token": TOKEN,
                "domain": "acme.my",
            },
        },
    )
    assert registered.status_code == 200, registered.text

    response = client.get("/api/connectors/source", params={"name": "opps"})

    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "salesforce" and body["sql"] == "SELECT Name FROM Opportunity"
    shown = json.loads(body["conn_url"])
    assert shown == {
        "domain": "acme.my",
        "password": SECRET_MASK,
        "security_token": SECRET_MASK,
        "username": "u@acme.com",
    }
    assert PASSWORD not in response.text and TOKEN not in response.text  # nowhere in the response


def test_the_source_still_reads_with_its_real_login_after_being_viewed(app):
    """Masking is only in what is shown: the stored login itself is unchanged."""
    client = _bridged(app, "ann")
    client.post(
        "/connectors/api/sources",
        json={
            "name": "opps",
            "kind": "salesforce",
            "soql": "SELECT Name FROM Opportunity",
            "auth": {
                "username": "u",
                "password": PASSWORD,
                "security_token": TOKEN,
                "domain": "acme.my",
            },
        },
    )
    client.get("/api/connectors/source", params={"name": "opps"})
    stored = app.state.connectors_store.get_source("ann", "opps")
    assert json.loads(stored["conn_url"])["password"] == PASSWORD


def test_servicenow_and_pins_secrets_are_masked_too(app):
    client = _bridged(app, "ann")
    store = app.state.connectors_store
    store.save_source(
        "ann",
        "inc",
        json.dumps(
            {
                "instance": "acme",
                "table": "incident",
                "auth": {
                    "type": "oauth",
                    "client_id": "cid",
                    "client_secret": SECRET,
                    "password": PASSWORD,
                },
            }
        ),
        "",
        kind="servicenow",
    )
    store.save_source(
        "ann",
        "board",
        json.dumps(
            {
                "board_type": "connect",
                "pin": "p",
                "config": {"server_url": "https://c.example", "api_key": API_KEY},
            }
        ),
        "",
        kind="pins",
    )
    for name in ("inc", "board"):
        response = client.get("/api/connectors/source", params={"name": name})
        assert response.status_code == 200
        for secret in (SECRET, PASSWORD, API_KEY):
            assert secret not in response.text, name
    assert (
        json.loads(client.get("/api/connectors/source", params={"name": "inc"}).json()["conn_url"])[
            "auth"
        ]["client_id"]
        == "cid"
    )


def test_an_oauth_app_source_has_nothing_to_hide(app):
    client = _bridged(app, "ann")
    app.state.connectors_store.save_source(
        "ann",
        "opps",
        json.dumps({"oauth_app": "default"}),
        "SELECT Name FROM Opportunity",
        kind="salesforce",
    )
    body = client.get("/api/connectors/source", params={"name": "opps"}).json()
    assert json.loads(body["conn_url"]) == {"oauth_app": "default"}


@needs_masking
def test_a_database_url_with_nothing_secret_is_returned_unchanged(app, tmp_path):
    path = tmp_path / "wh.sqlite"
    con = sqlite3.connect(str(path))
    con.execute("CREATE TABLE t (a INTEGER)")
    con.commit()
    con.close()
    conn_url = "sqlite:///" + str(path)
    client = _bridged(app, "ann")
    assert (
        client.post(
            "/connectors/api/sources",
            json={"name": "wh", "conn_url": conn_url, "sql": "SELECT a FROM t"},
        ).status_code
        == 200
    )
    body = client.get("/api/connectors/source", params={"name": "wh"}).json()
    assert body["kind"] == "sql" and body["type"] == "sqlite" and body["conn_url"] == conn_url


PG = "postgresql+psycopg://app:pg-s3cr3t@db.invalid:5432/sales"
DBX = "databricks://token:dapi-TOKEN-123@dbc-1.cloud.databricks.com?http_path=/sql/1.0/warehouses/abc&catalog=main"
VIEWER = "databricks://posit-connect@dbc-1.cloud.databricks.com?http_path=/sql/1.0/warehouses/abc"


def _register_db(client, name, conn_url):
    response = client.post(
        "/connectors/api/sources", json={"name": name, "conn_url": conn_url, "sql": "SELECT 1"}
    )
    assert response.status_code == 200, response.text


@needs_masking
def test_a_database_password_and_a_databricks_token_are_masked(app):
    client = _bridged(app, "ann")
    _register_db(client, "pg", PG)
    _register_db(client, "dbx", DBX)

    pg = client.get("/api/connectors/source", params={"name": "pg"})
    assert pg.json()["type"] == "postgresql" and pg.json()["masked"] is True
    assert (
        pg.json()["conn_url"] == "postgresql+psycopg://app:%s@db.invalid:5432/sales" % SECRET_MASK
    )
    assert "pg-s3cr3t" not in pg.text

    dbx = client.get("/api/connectors/source", params={"name": "dbx"})
    assert dbx.json()["type"] == "databricks"
    assert "dapi-TOKEN-123" not in dbx.text
    assert "http_path=/sql/1.0/warehouses/abc" in dbx.json()["conn_url"]  # the rest stays readable


@needs_masking
def test_a_databricks_viewer_source_has_nothing_to_hide_and_is_named_as_such(app):
    client = _bridged(app, "ann")
    _register_db(client, "viewer", VIEWER)
    body = client.get("/api/connectors/source", params={"name": "viewer"}).json()
    assert body["type"] == "databricks-viewer" and body["conn_url"] == VIEWER


@needs_masking
def test_the_source_list_names_each_sources_type(app):
    client = _bridged(app, "ann")
    _register_db(client, "pg", PG)
    _register_db(client, "dbx", DBX)
    _register_db(client, "viewer", VIEWER)
    client.post(
        "/connectors/api/sources",
        json={
            "name": "opps",
            "kind": "salesforce",
            "soql": "SELECT Name FROM Opportunity",
            "auth": {"username": "u", "password": PASSWORD},
        },
    )
    app.state.connectors_store.save_source(
        "ann", "board", json.dumps({"board_type": "folder", "pin": "p"}), "", kind="pins"
    )
    types = {
        s["name"]: s["type"] for s in client.get("/api/connectors/sources-meta").json()["sources"]
    }
    assert types == {
        "pg": "postgresql",
        "dbx": "databricks",
        "viewer": "databricks-viewer",
        "opps": "salesforce",
        "board": "pins",
    }
    assert PASSWORD not in client.get("/api/connectors/sources-meta").text


@needs_masking
def test_test_and_schema_calls_restore_the_secret_only_for_the_same_server(app):
    """The edit form sends the masked URL back to test it; the stored password is put back only
    while the server is unchanged, and never appears in a response."""
    client = _bridged(app, "ann")
    _register_db(client, "pg", PG)
    masked = PG.replace("pg-s3cr3t", SECRET_MASK)

    same = client.post(
        "/api/connectors/test", json={"conn_url": masked, "secret_from": "pg", "sql": "SELECT 1"}
    )
    assert same.status_code != 400, same.text  # the secret was restored; only the connection fails
    assert "pg-s3cr3t" not in same.text

    moved = client.post(
        "/api/connectors/test",
        json={
            "conn_url": masked.replace("db.invalid", "attacker.invalid"),
            "secret_from": "pg",
            "sql": "SELECT 1",
        },
    )
    assert moved.status_code == 400 and "Re-enter the password" in moved.json()["detail"]

    nobody = client.post("/api/connectors/schema", json={"conn_url": masked})
    assert nobody.status_code == 400  # no secret_from: nothing to restore it from


def test_with_an_old_connectors_package_a_database_url_is_shown_as_stored(app, monkeypatch):
    """Without the restore half, masking would make Save store the mask as the password."""
    import cxd_server.connectors as bridge

    monkeypatch.setattr(bridge, "_connmask", lambda: None)
    client = _bridged(app, "ann")
    _register_db(client, "pg", PG)
    body = client.get("/api/connectors/source", params={"name": "pg"}).json()
    assert body["masked"] is False and body["conn_url"] == PG


def test_an_unreadable_saas_record_shows_nothing_rather_than_leaking(app):
    client = _bridged(app, "ann")
    app.state.connectors_store.save_source(
        "ann", "odd", "password=" + PASSWORD, "", kind="salesforce"
    )
    response = client.get("/api/connectors/source", params={"name": "odd"})
    assert response.status_code == 200 and response.json()["conn_url"] == ""
    assert PASSWORD not in response.text


def test_only_the_owner_can_read_a_source_and_a_session_is_required(app):
    ann = _bridged(app, "ann")
    ann.post(
        "/connectors/api/sources",
        json={
            "name": "opps",
            "kind": "salesforce",
            "soql": "SELECT Name FROM Opportunity",
            "auth": {"username": "u", "password": PASSWORD},
        },
    )
    bob = _bridged(app, "bob")
    assert bob.get("/api/connectors/source", params={"name": "opps"}).status_code == 404
    assert TestClient(app).get("/api/connectors/source", params={"name": "opps"}).status_code == 401
