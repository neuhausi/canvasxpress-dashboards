"""End-to-end tests for the CanvasXpress Cloud paywall (billing + entitlements).

Drives the real FastAPI app through TestClient: a simulated (signature-verified)
PayPal webhook flips an account to Pro from the pre-filled token pool, the
live-source + free-dashboard-count gates enforce entitlements, a credit-pack
event tops up AI credits, and the internal meter endpoint decrements them.

Run from ``server/``::

    pytest tests/test_billing.py -v

The paywall is enabled via env (``CXD_PAYWALL=on`` etc.) set BEFORE the app is
built, since the factory reads those once. Nothing here touches real PayPal — the
webhook signature check is monkeypatched to pass so the rest of the chain runs.
"""

import pytest
from fastapi.testclient import TestClient

from cxd_server import billing
from cxd_server.app import create_dashboards_app
from cxd_server.store import DashboardStore


def _live_spec(spec_id):
    """A dashboard spec that binds a live/streaming source (the Pro-gated case)."""
    return {"id": spec_id,
            "data": {"stream1": {"kind": "live", "url": "/connectors/api/stream/x",
                                 "window": 100}},
            "panels": {"p1": {"dataRef": "stream1"}}}


def _static_spec(spec_id):
    """A static inline dashboard spec (always free)."""
    return {"id": spec_id, "data": {"d": {"kind": "inline", "rows": [[1], [2]]}},
            "panels": {"p1": {"dataRef": "d"}}}


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    # Enable the paywall BEFORE building the app (factory reads env once).
    monkeypatch.setenv("CXD_PAYWALL", "on")
    monkeypatch.setenv("CXD_TOKEN_SIGNING_KEY", "test-signing-key")
    monkeypatch.setenv("CXD_BILLING_DIR", str(tmp_path))
    monkeypatch.setenv("CXD_METER_KEY", "meter-secret")
    # Webhook signature always "valid" for the test (no real PayPal call).
    monkeypatch.setattr("cxd_server.billing.verify_paypal_webhook", lambda h, b: True)

    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "d.db")),
                                session_secret="s", serve_static=False,
                                scheduler_enabled=False,
                                dataset_store_uri="file://" + str(tmp_path / "ds"))
    # Pre-fill the pool with Pro tokens (what cxd-pool does in production).
    app.state.token_pool.add(billing.generate_pool("pro", 3), "pro")

    def signup(username):
        c = TestClient(app)
        assert c.post("/auth/signup",
                      json={"username": username, "password": "secret1"}).status_code == 200
        return c

    # First signup becomes admin (always treated as Enterprise) — keep it aside so
    # the gated users below are ordinary accounts.
    admin = signup("adminuser")
    bob = signup("bob")      # will be upgraded to Pro via the webhook
    carol = signup("carol")  # stays Community
    return app, admin, bob, carol


def _webhook(client, event_type, account, resource_extra=None):
    resource = {"id": "I-TEST", "custom_id": account}
    if resource_extra:
        resource.update(resource_extra)
    return client.post("/billing/paypal/webhook",
                       json={"event_type": event_type, "resource": resource})


def test_webhook_grants_pro_from_pool(ctx):
    app, admin, bob, carol = ctx
    assert bob.get("/billing/status").json()["tier"] == "community"
    r = _webhook(bob, "BILLING.SUBSCRIPTION.ACTIVATED", "bob")
    assert r.status_code == 200 and r.json()["action"] == "granted"
    assert bob.get("/billing/status").json()["tier"] == "pro"
    # One pool token is now sold.
    assert app.state.token_pool.count_available("pro") == 2


def test_live_source_gated_for_community_allowed_for_pro(ctx):
    app, admin, bob, carol = ctx
    # Community carol cannot save a live-source dashboard.
    r = carol.post("/api/dashboards", json=_live_spec("live-carol"))
    assert r.status_code == 402 and "Cloud Pro" in r.json()["detail"]
    # But a static dashboard is fine.
    assert carol.post("/api/dashboards", json=_static_spec("static-carol")).status_code == 200
    # Upgrade bob -> Pro, then the same live save succeeds.
    _webhook(bob, "BILLING.SUBSCRIPTION.ACTIVATED", "bob")
    assert bob.post("/api/dashboards", json=_live_spec("live-bob")).status_code == 200


def test_free_dashboard_limit(ctx):
    app, admin, bob, carol = ctx
    limit = billing.COMMUNITY_LIMITS["saved_dashboards"]
    for i in range(limit):
        assert carol.post("/api/dashboards", json=_static_spec("d%d" % i)).status_code == 200
    # One past the limit is refused.
    r = carol.post("/api/dashboards", json=_static_spec("d-over"))
    assert r.status_code == 402 and "free plan" in r.json()["detail"]


def test_subscription_cancel_revokes(ctx):
    app, admin, bob, carol = ctx
    _webhook(bob, "BILLING.SUBSCRIPTION.ACTIVATED", "bob")
    assert bob.get("/billing/status").json()["tier"] == "pro"
    assert _webhook(bob, "BILLING.SUBSCRIPTION.CANCELLED", "bob").json()["action"] == "revoked"
    assert bob.get("/billing/status").json()["tier"] == "community"


def test_credit_pack_and_consume(ctx):
    app, admin, bob, carol = ctx
    # A credit-pack purchase tops up carol's AI balance.
    r = _webhook(carol, "PAYMENT.SALE.COMPLETED", "carol")
    assert r.json()["action"] == "credits_added"
    bal = carol.get("/billing/status").json()["ai_credits"]
    assert bal == billing.DEFAULT_AI_PACK_CREDITS

    # The internal meter endpoint decrements (MCP server path).
    hdr = {"X-Cloud-Meter-Key": "meter-secret"}
    r = carol.post("/billing/consume", json={"account": "carol", "n": 1}, headers=hdr)
    assert r.status_code == 200 and r.json()["ok"] is True
    assert r.json()["ai_credits"] == bal - 1

    # Wrong meter secret is refused (fails closed).
    assert carol.post("/billing/consume", json={"account": "carol", "n": 1},
                      headers={"X-Cloud-Meter-Key": "WRONG"}).status_code == 403


def test_webhook_idempotent_activation(ctx):
    app, admin, bob, carol = ctx
    # Two ACTIVATED events for the same account claim only ONE pool token.
    r1 = _webhook(bob, "BILLING.SUBSCRIPTION.ACTIVATED", "bob")
    assert r1.json()["action"] == "granted"
    r2 = _webhook(bob, "BILLING.SUBSCRIPTION.ACTIVATED", "bob")
    assert r2.json()["action"] == "already_pro"
    assert app.state.token_pool.count_available("pro") == 2  # only one sold, not two
    assert bob.get("/billing/status").json()["tier"] == "pro"


def test_custom_id_binds_account_not_email(ctx):
    app, admin, bob, carol = ctx
    # custom_id "carol" must grant carol — even though PayPal also sends a
    # different subscriber email on the event.
    r = carol.post("/billing/paypal/webhook", json={
        "event_type": "BILLING.SUBSCRIPTION.ACTIVATED",
        "resource": {"id": "I-CUSTOM", "custom_id": "carol",
                     "subscriber": {"email_address": "someone-else@paypal.test"}}})
    assert r.json()["action"] == "granted"
    assert carol.get("/billing/status").json()["tier"] == "pro"


def test_ai_credit_pack_capture_with_credits_in_custom_id(ctx):
    app, admin, bob, carol = ctx
    # One-time Orders capture event, custom_id encodes the account + pack size.
    r = carol.post("/billing/paypal/webhook", json={
        "event_type": "PAYMENT.CAPTURE.COMPLETED",
        "resource": {"id": "CAP-1", "custom_id": "carol|ai=750"}})
    assert r.json()["action"] == "credits_added" and r.json()["credits"] == 750
    assert carol.get("/billing/status").json()["ai_credits"] == 750


def test_admin_dev_grant(ctx):
    app, admin, bob, carol = ctx
    # Admin can grant a tier without a real payment (sandbox helper).
    r = admin.post("/billing/dev/grant", json={"account": "carol", "tier": "pro"})
    assert r.status_code == 200 and r.json().get("granted") == "pro"
    assert carol.get("/billing/status").json()["tier"] == "pro"
    # A non-admin cannot.
    assert bob.post("/billing/dev/grant", json={"account": "bob", "tier": "pro"}).status_code == 403
