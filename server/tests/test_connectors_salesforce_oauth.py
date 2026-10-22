"""Scheduled refresh of a Salesforce source that names an OAuth app.

Such a source stores no credential; the operator's CXC_SALESFORCE_APPS entry (and its `users`
list) is the authorization, so the refresh fetcher must re-check it on every run — a user removed
from the app must stop refreshing at once. The Salesforce call itself is faked.
"""

import json

import pytest

byo = pytest.importorskip("cx_connectors.web.byo_app")
if not hasattr(byo, "authorize_saas_source"):          # an older canvasxpress-connectors
    pytest.skip("installed canvasxpress-connectors has no Salesforce OAuth apps", allow_module_level=True)

from cx_connectors.store import Store, generate_key  # noqa: E402

from cxd_server.connectors import refresh_fetcher  # noqa: E402

SOQL = "SELECT Name, Amount FROM Opportunity"


def _apps(user):
    return json.dumps({"default": {"domain": "acme.my", "client_id": "cid",
                                   "client_secret": "s3cr3t", "users": [user]}})


@pytest.fixture
def fetch(tmp_path, monkeypatch):
    monkeypatch.setenv("CXC_SALESFORCE_APPS", _apps("alice"))
    byo._SF_TOKENS.clear()
    store = Store(str(tmp_path / "connectors.db"), generate_key())
    store.create_user("alice", "pw")
    store.save_source("alice", "opps", json.dumps({"oauth_app": "default"}), SOQL, kind="salesforce")

    monkeypatch.setattr(byo, "salesforce_oauth_token", lambda *a, **k: {
        "access_token": "tok", "instance_url": "https://acme.my.salesforce.com"})

    class FakeSource:
        def __init__(self, soql, **kwargs):
            assert kwargs["session_id"] == "tok"          # minted token, no stored credential

        def read(self):
            return ["Name", "Amount"], [["Deal A", 1000.0]]

    monkeypatch.setattr(byo, "SalesforceSource", FakeSource)
    yield refresh_fetcher(store)
    byo._SF_TOKENS.clear()


def test_scheduled_refresh_reads_an_oauth_app_source(fetch):
    data = fetch("alice", "opps")
    assert data["y"]["vars"] == ["Amount"] and data["y"]["smps"] == ["Deal A"]


def test_scheduled_refresh_stops_when_the_user_is_removed_from_the_app(fetch, monkeypatch):
    assert fetch("alice", "opps")["y"]["vars"] == ["Amount"]
    monkeypatch.setenv("CXC_SALESFORCE_APPS", _apps("bob"))          # operator revokes alice
    with pytest.raises(PermissionError):
        fetch("alice", "opps")
