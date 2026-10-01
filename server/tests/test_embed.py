"""Publish & embed a single chart (Datawrapper-parity P8) + organisation brand lock."""

import pytest
from fastapi.testclient import TestClient

from cxd_server.app import create_dashboards_app
from cxd_server.embed import embed_snippets, single_panel_spec
from cxd_server.snapshot import SnapshotUnavailable
from cxd_server.store import DashboardStore


def _two_panel_spec():
    return {
        "id": "sales", "title": "Sales",
        "layout": {"cols": 12, "items": [
            {"panel": "revenue", "x": 0, "y": 0, "w": 6, "h": 4},
            {"panel": "costs", "x": 6, "y": 0, "w": 6, "h": 3},
        ]},
        "data": {
            "orders": {"kind": "inline", "value": {"y": {"vars": ["a"], "smps": ["s"], "data": [[1]]}}},
            "regions": {"kind": "inline", "value": {"y": {"vars": ["r"], "smps": ["s"], "data": [[2]]}}},
            "blend": {"kind": "join", "left": "orders", "right": "regions", "on": "id"},
            "secret": {"kind": "inline", "value": {"y": {"vars": ["x"], "smps": ["s"], "data": [[9]]}}},
        },
        "relationships": [
            {"left": "orders", "right": "regions"},
            {"left": "orders", "right": "secret"},
        ],
        "controls": [{"type": "select", "param": "region"}],
        "params": {"region": "EU"},
        "width": 1200,
        "panels": {
            "revenue": {"dataRef": "blend", "config": {"graphType": "Bar"}},
            "costs": {"dataRef": "secret", "config": {"graphType": "Line"}},
        },
    }


# ---- pure helpers ----
def test_single_panel_keeps_panel_and_transitive_sources():
    out = single_panel_spec(_two_panel_spec(), "revenue")
    assert list(out["panels"]) == ["revenue"]
    # join + both of its inputs survive; the other panel's source does not
    assert set(out["data"]) == {"blend", "orders", "regions"}
    assert out["layout"]["items"] == [{"panel": "revenue", "x": 0, "y": 0, "w": 12, "h": 4}]
    # only relationships whose two sources both survive
    assert out["relationships"] == [{"left": "orders", "right": "regions"}]
    # page chrome dropped, params kept (sources may bind to them), fills the frame
    assert "controls" not in out and "width" not in out
    assert out["params"] == {"region": "EU"}
    assert out["maxWidth"] == "none"


def test_single_panel_does_not_mutate_input():
    spec = _two_panel_spec()
    single_panel_spec(spec, "costs")
    assert set(spec["panels"]) == {"revenue", "costs"}
    assert "secret" in spec["data"]


def test_single_panel_function_inputs_map():
    spec = {"id": "f", "layout": {"items": []}, "data": {
        "a": {"kind": "inline", "value": {}},
        "b": {"kind": "inline", "value": {}},
        "fn": {"kind": "function", "inputs": {"x": "a", "y": "b"}},
        "z": {"kind": "inline", "value": {}}},
        "panels": {"p": {"dataRef": "fn"}}}
    assert set(single_panel_spec(spec, "p")["data"]) == {"fn", "a", "b"}


def test_single_panel_unknown_raises():
    with pytest.raises(KeyError):
        single_panel_spec(_two_panel_spec(), "nope")


def test_embed_snippets_shapes_and_escaping():
    codes = embed_snippets("https://pub.example.com/dash/", "tok-1", "rev&x")
    assert codes["url"] == "https://pub.example.com/dash/embed.html?token=tok-1&panel=rev%26x"
    assert 'src="https://pub.example.com/dash/embed.html?token=tok-1&amp;panel=rev%26x"' in codes["iframe"]
    assert "cxd-embed:resize" in codes["iframe"]
    assert '<script src="https://pub.example.com/dash/embed.js" async></script>' in codes["script"]
    assert "<cxd-embed " in codes["script"]
    assert codes["image"] == "https://pub.example.com/dash/api/shared/tok-1/image.png?panel=rev%26x"


# ---- server routes ----
class FakeSnapshots:
    def __init__(self, available=True):
        self.calls = []
        self._available = available

    def render(self, spec, username):
        if not self._available:
            raise SnapshotUnavailable("Snapshots need Playwright with Chromium on the server")
        self.calls.append((spec, username))
        return b"\x89PNG-fake"


def _app(tmp_path, **kwargs):
    return create_dashboards_app(
        store=DashboardStore(str(tmp_path / "dash.db")), session_secret="test-secret",
        serve_static=kwargs.pop("serve_static", False),
        dataset_store_uri="file://" + str(tmp_path / "datasets"), scheduler_enabled=False,
        **kwargs)


def _signup(client, username, password="secret1"):
    r = client.post("/auth/signup", json={"username": username, "password": password})
    assert r.status_code == 200, r.text


def _published(app):
    owner = TestClient(app)
    _signup(owner, "alice")
    assert owner.post("/api/dashboards", json=_two_panel_spec()).status_code == 200
    r = owner.post("/api/dashboards/sales/share", json={"visibility": "public"})
    assert r.status_code == 200, r.text
    return owner, r.json()["dashboard"]


def test_share_response_carries_embed_codes(tmp_path):
    app = _app(tmp_path, publish_base_url="https://pub.example.com")
    _, summary = _published(app)
    embed = summary["embed"]
    assert embed["url"] == "https://pub.example.com/embed.html?token=" + summary["share_token"]
    assert "<iframe" in embed["iframe"] and "<cxd-embed" in embed["script"]


def test_shared_panel_prunes_before_datasets(tmp_path):
    app = _app(tmp_path)
    _, summary = _published(app)
    anon = TestClient(app)
    r = anon.get("/api/shared/%s?panel=revenue" % summary["share_token"])
    assert r.status_code == 200
    spec = r.json()["spec"]
    assert list(spec["panels"]) == ["revenue"]
    assert "secret" not in spec["data"]          # other panel's data never sent
    whole = anon.get("/api/shared/%s" % summary["share_token"]).json()["spec"]
    assert set(whole["panels"]) == {"revenue", "costs"}   # unchanged without ?panel
    assert anon.get("/api/shared/%s?panel=nope" % summary["share_token"]).status_code == 404


def test_republish_in_place(tmp_path):
    app = _app(tmp_path)
    owner, summary = _published(app)
    token = summary["share_token"]
    edited = _two_panel_spec()
    edited["panels"]["revenue"]["config"]["graphType"] = "Line"
    assert owner.post("/api/dashboards", json=edited).status_code == 200
    anon = TestClient(app)
    got = anon.get("/api/shared/%s?panel=revenue" % token).json()["spec"]
    assert got["panels"]["revenue"]["config"]["graphType"] == "Line"   # same URL, new content
    versions = owner.get("/api/dashboards/sales/versions").json()["versions"]
    assert len(versions) >= 2                                          # history kept


def test_embed_codes_endpoint_respects_visibility(tmp_path):
    app = _app(tmp_path)
    owner, summary = _published(app)
    token = summary["share_token"]
    anon = TestClient(app)
    r = anon.get("/api/shared/%s/embed?panel=costs&height=300" % token)
    assert r.status_code == 200
    assert "panel=costs" in r.json()["embed"]["url"]
    assert "height:300px" in r.json()["embed"]["iframe"]
    owner.post("/api/dashboards/sales/share", json={"visibility": "private"})
    assert anon.get("/api/shared/%s/embed" % token).status_code == 404


def test_shared_image_renders_anonymously_and_caches(tmp_path):
    snaps = FakeSnapshots()
    app = _app(tmp_path, snapshots=snaps)
    _, summary = _published(app)
    anon = TestClient(app)
    url = "/api/shared/%s/image.png?panel=revenue" % summary["share_token"]
    r = anon.get(url)
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content == b"\x89PNG-fake"
    assert snaps.calls[0][1] is None                      # no session: anonymous render
    assert list(snaps.calls[0][0]["panels"]) == ["revenue"]
    anon.get(url)
    assert len(snaps.calls) == 1                           # cached


def test_shared_image_unavailable_is_503(tmp_path):
    app = _app(tmp_path, snapshots=FakeSnapshots(available=False))
    _, summary = _published(app)
    r = TestClient(app).get("/api/shared/%s/image.png" % summary["share_token"])
    assert r.status_code == 503


def test_embed_static_assets_served(tmp_path):
    app = _app(tmp_path, serve_static=True)
    client = TestClient(app)
    page = client.get("/embed.html")
    assert page.status_code == 200
    assert "cxd-embed:resize" in page.text
    script = client.get("/embed.js")
    assert script.status_code == 200
    assert "customElements.define('cxd-embed'" in script.text


# ---- organisation brand lock (P4 carry-over) ----
BRAND = {"theme": "light", "colorScheme": "Tableau"}


def test_brand_enforced_for_non_admin_saves(tmp_path):
    app = _app(tmp_path, brand=BRAND)
    admin = TestClient(app)
    _signup(admin, "root")                       # first signup is the admin
    bob = TestClient(app)
    _signup(bob, "bob")
    spec = _two_panel_spec()
    spec["theme"] = "dark"
    spec["colorScheme"] = "Economist"
    assert bob.post("/api/dashboards", json=spec).status_code == 200
    saved = bob.get("/api/dashboards/sales").json()
    assert saved["theme"] == "light" and saved["colorScheme"] == "Tableau"
    me = bob.get("/auth/me").json()
    assert me["brand"] == BRAND and me["brandLocked"] is True


def test_brand_admin_exempt_but_shared_view_branded(tmp_path):
    app = _app(tmp_path, brand=BRAND)
    admin = TestClient(app)
    _signup(admin, "root")
    spec = _two_panel_spec()
    spec["theme"] = "dark"
    assert admin.post("/api/dashboards", json=spec).status_code == 200
    assert admin.get("/api/dashboards/sales").json()["theme"] == "dark"   # admin keeps it
    assert admin.get("/auth/me").json()["brandLocked"] is False
    token = admin.post("/api/dashboards/sales/share", json={"visibility": "public"}) \
        .json()["dashboard"]["share_token"]
    shared = TestClient(app).get("/api/shared/%s" % token).json()["spec"]
    assert shared["theme"] == "light"                                      # published = branded


def test_no_brand_by_default(tmp_path):
    app = _app(tmp_path)
    client = TestClient(app)
    _signup(client, "root")
    me = client.get("/auth/me").json()
    assert me["brand"] is None and me["brandLocked"] is False


def test_bad_brand_env_fails_fast(tmp_path, monkeypatch):
    monkeypatch.setenv("CXD_BRAND", "{not json")
    with pytest.raises(ValueError):
        _app(tmp_path)
