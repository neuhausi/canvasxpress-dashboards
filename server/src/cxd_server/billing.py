"""Billing & entitlements for CanvasXpress Cloud.

Implements the hosted-platform paywall (Pro subscription + prepaid AI credit
packs) on top of PayPal, keeping the open engine entirely free. See
``CLOUD-BILLING.md`` for the setup runbook.

Three pieces live here, all self-contained and framework-agnostic so they can be
unit-tested without a running server:

* :class:`TokenPool` — a file of **pre-generated platform entitlement tokens**
  (the owner's chosen issuance model). The webhook claims the next available
  token for a tier on a successful payment and marks it sold. Pro/AI tokens are
  platform-issued (the attribution mark stays on, so no engine key generator is
  involved); only Enterprise white-label uses real engine mark-removal keys,
  which are generated offline and are out of scope here.
* entitlement tokens — opaque, HMAC-signed strings the platform mints and
  verifies itself (:func:`mint_token` / :func:`verify_token`). The pool is
  filled with these via :func:`generate_pool`.
* :class:`EntitlementStore` — maps an account to its active tier/token/expiry,
  and the AI prepaid credit balance that MCP decrements.
* :func:`verify_paypal_webhook` — verifies an inbound PayPal webhook against the
  PayPal API before any entitlement is granted.

Secrets (PayPal client secret, the token-signing key) are read from the
environment only; nothing secret is stored in the repo.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import urllib.parse
import urllib.request
from typing import Optional

# ---------------------------------------------------------------------------
# Tiers
# ---------------------------------------------------------------------------

TIER_COMMUNITY = "community"
TIER_PRO = "pro"
TIER_AI = "ai"
TIER_ENTERPRISE = "enterprise"

#: Tiers that a self-serve PayPal purchase can grant. Enterprise is contract-only.
SELF_SERVE_TIERS = (TIER_PRO, TIER_AI)

#: Free-plan limits (the "nominal services" in the plan; tunable launch values).
COMMUNITY_LIMITS = {
    "saved_dashboards": 3,
    "live_connectors": 1,
    "ai_calls_per_month": 50,
}

#: Default AI credits granted per prepaid pack (placeholder; set per PayPal product).
DEFAULT_AI_PACK_CREDITS = 500


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64u_decode(txt: str) -> bytes:
    pad = "=" * (-len(txt) % 4)
    return base64.urlsafe_b64decode(txt + pad)


def _signing_key() -> bytes:
    """The HMAC key for entitlement tokens.

    Reads ``CXD_TOKEN_SIGNING_KEY`` (preferred) or falls back to
    ``SESSION_SECRET`` so a dev server works out of the box. Raises if neither is
    set, rather than signing with a guessable constant.
    """
    key = os.getenv("CXD_TOKEN_SIGNING_KEY") or os.getenv("SESSION_SECRET")
    if not key:
        raise RuntimeError(
            "CXD_TOKEN_SIGNING_KEY (or SESSION_SECRET) must be set to mint/verify tokens")
    return key.encode("utf-8")


# ---------------------------------------------------------------------------
# Entitlement tokens (platform-issued, HMAC-signed, opaque)
# ---------------------------------------------------------------------------

_TOKEN_PREFIX = "cxp"  # CanvasXpress Platform


def mint_token(tier: str, days: int = 365, nonce: Optional[str] = None) -> str:
    """Mint a signed platform entitlement token.

    :param tier: one of :data:`SELF_SERVE_TIERS` (or ``enterprise`` for manual
        issuance).
    :param days: validity window in days from now.
    :param nonce: optional caller-supplied uniqueness; a random one is used
        otherwise so two tokens for the same tier never collide.
    :returns: ``cxp.<payload>.<sig>`` where payload is url-safe base64 JSON.
    """
    payload = {
        "t": tier,
        "iat": int(time.time()),
        "exp": int(time.time()) + days * 86400,
        "n": nonce or secrets.token_hex(8),
    }
    body = _b64u(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    sig = _b64u(hmac.new(_signing_key(), body.encode(), hashlib.sha256).digest())
    return f"{_TOKEN_PREFIX}.{body}.{sig}"


def verify_token(token: Optional[str]) -> Optional[dict]:
    """Return the token payload if the signature is valid and it is unexpired,
    else ``None``. Never raises on malformed input."""
    if not token or not isinstance(token, str):
        return None
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != _TOKEN_PREFIX:
        return None
    _, body, sig = parts
    expected = _b64u(hmac.new(_signing_key(), body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        payload = json.loads(_b64u_decode(body))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or "t" not in payload:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


def tier_of(token: Optional[str]) -> str:
    """The entitlement tier a token grants, or ``community`` if absent/invalid."""
    payload = verify_token(token)
    return payload["t"] if payload else TIER_COMMUNITY


# ---------------------------------------------------------------------------
# Token pool — pre-generated tokens the webhook hands out
# ---------------------------------------------------------------------------

class TokenPool:
    """A JSON-file pool of pre-generated entitlement tokens.

    File shape::

        {"entries": [{"token": "...", "tier": "pro", "status": "available",
                      "sold_to": null, "sold_at": null}, ...]}

    Thread-safe for the single-process server; claims are atomic within the lock.
    """

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        if not os.path.exists(path):
            self._write({"entries": []})

    def _read(self) -> dict:
        with open(self.path, encoding="utf-8") as fh:
            return json.load(fh)

    def _write(self, data: dict) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, self.path)

    def add(self, tokens, tier: str) -> int:
        """Append pre-generated ``tokens`` for ``tier``; returns how many added."""
        with self._lock:
            data = self._read()
            for tok in tokens:
                data["entries"].append({
                    "token": tok, "tier": tier, "status": "available",
                    "sold_to": None, "sold_at": None,
                })
            self._write(data)
            return len(tokens)

    def count_available(self, tier: str) -> int:
        return sum(1 for e in self._read()["entries"]
                   if e["tier"] == tier and e["status"] == "available")

    def claim(self, tier: str, account: str) -> Optional[str]:
        """Claim the next available token for ``tier``, binding it to ``account``.

        Returns the token, or ``None`` if the pool is exhausted (the caller must
        handle that — it means top up the pool). Atomic under the lock.
        """
        with self._lock:
            data = self._read()
            for e in data["entries"]:
                if e["tier"] == tier and e["status"] == "available":
                    e["status"] = "sold"
                    e["sold_to"] = account
                    e["sold_at"] = int(time.time())
                    self._write(data)
                    return e["token"]
        return None


def generate_pool(tier: str, count: int, days: int = 365) -> list:
    """Generate ``count`` fresh entitlement tokens for ``tier`` (admin/offline
    helper used to fill a :class:`TokenPool`)."""
    return [mint_token(tier, days=days) for _ in range(count)]


# ---------------------------------------------------------------------------
# Entitlement store — per-account tier/token/expiry + AI credit balance
# ---------------------------------------------------------------------------

class EntitlementStore:
    """Per-account entitlement state, persisted as a JSON file.

    Record per account::

        {"tier": "pro", "token": "cxp...", "expires": 1760000000,
         "ai_credits": 500, "paypal_subscription_id": "I-...", "updated": ...}
    """

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        if not os.path.exists(path):
            self._write({})

    def _read(self) -> dict:
        with open(self.path, encoding="utf-8") as fh:
            return json.load(fh)

    def _write(self, data: dict) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, self.path)

    def get(self, account: str) -> dict:
        """The account's entitlement, or a Community default (never ``None``)."""
        rec = self._read().get(account)
        if not rec:
            return {"tier": TIER_COMMUNITY, "token": None, "expires": None,
                    "ai_credits": 0}
        # Expired Pro falls back to Community but keeps any AI credit balance.
        if rec.get("expires") and int(rec["expires"]) < int(time.time()):
            rec = dict(rec)
            rec["tier"] = TIER_COMMUNITY
            rec["token"] = None
        return rec

    def set_tier(self, account: str, tier: str, token: Optional[str],
                 expires: Optional[int] = None,
                 paypal_subscription_id: Optional[str] = None) -> dict:
        with self._lock:
            data = self._read()
            rec = data.get(account, {"ai_credits": 0})
            rec.update({"tier": tier, "token": token, "expires": expires,
                        "updated": int(time.time())})
            if paypal_subscription_id is not None:
                rec["paypal_subscription_id"] = paypal_subscription_id
            data[account] = rec
            self._write(data)
            return rec

    def revoke(self, account: str) -> None:
        """Drop the account to Community (e.g. subscription cancelled). Keeps
        any remaining AI credits."""
        with self._lock:
            data = self._read()
            if account in data:
                data[account]["tier"] = TIER_COMMUNITY
                data[account]["token"] = None
                data[account]["expires"] = None
                data[account]["updated"] = int(time.time())
                self._write(data)

    def add_credits(self, account: str, credits: int) -> int:
        """Top up prepaid AI credits (a credit-pack purchase). Returns the new
        balance."""
        with self._lock:
            data = self._read()
            rec = data.get(account, {"tier": TIER_COMMUNITY, "token": None,
                                     "expires": None, "ai_credits": 0})
            rec["ai_credits"] = int(rec.get("ai_credits", 0)) + int(credits)
            rec["updated"] = int(time.time())
            data[account] = rec
            self._write(data)
            return rec["ai_credits"]

    def consume_credit(self, account: str, n: int = 1) -> bool:
        """Decrement AI credits (called from the MCP meter). Returns ``True`` if
        there was balance to spend, ``False`` if the account is out of credits."""
        with self._lock:
            data = self._read()
            rec = data.get(account)
            if not rec or int(rec.get("ai_credits", 0)) < n:
                return False
            rec["ai_credits"] = int(rec["ai_credits"]) - n
            rec["updated"] = int(time.time())
            self._write(data)
            return True


# ---------------------------------------------------------------------------
# PayPal webhook verification
# ---------------------------------------------------------------------------

def _paypal_api_base() -> str:
    env = (os.getenv("PAYPAL_ENV") or "sandbox").lower()
    return ("https://api-m.paypal.com" if env == "live"
            else "https://api-m.sandbox.paypal.com")


def _paypal_access_token() -> Optional[str]:
    client_id = os.getenv("PAYPAL_CLIENT_ID")
    secret = os.getenv("PAYPAL_CLIENT_SECRET")
    if not client_id or not secret:
        return None
    cred = base64.b64encode(f"{client_id}:{secret}".encode()).decode()
    req = urllib.request.Request(
        _paypal_api_base() + "/v1/oauth2/token",
        data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
        headers={"Authorization": "Basic " + cred,
                 "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp).get("access_token")
    except Exception:
        return None


def verify_paypal_webhook(headers, body: bytes) -> bool:
    """Verify an inbound PayPal webhook using PayPal's verify-webhook-signature
    API. Requires ``PAYPAL_WEBHOOK_ID`` + client creds in the environment.

    ``headers`` is a mapping with the PayPal transmission headers (case-insensitive
    lookups are attempted). Returns ``True`` only on an explicit ``SUCCESS``
    verification — fails closed on any error.
    """
    webhook_id = os.getenv("PAYPAL_WEBHOOK_ID")
    if not webhook_id:
        return False
    token = _paypal_access_token()
    if not token:
        return False

    def h(name: str) -> Optional[str]:
        # headers may be a Starlette Headers (case-insensitive) or a plain dict
        try:
            v = headers.get(name)
            if v is not None:
                return v
        except Exception:
            pass
        low = {k.lower(): val for k, val in dict(headers).items()}
        return low.get(name.lower())

    try:
        event = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return False

    verify_body = {
        "transmission_id": h("paypal-transmission-id"),
        "transmission_time": h("paypal-transmission-time"),
        "cert_url": h("paypal-cert-url"),
        "auth_algo": h("paypal-auth-algo"),
        "transmission_sig": h("paypal-transmission-sig"),
        "webhook_id": webhook_id,
        "webhook_event": event,
    }
    if not all(verify_body[k] for k in
               ("transmission_id", "transmission_time", "cert_url",
                "auth_algo", "transmission_sig")):
        return False

    req = urllib.request.Request(
        _paypal_api_base() + "/v1/notifications/verify-webhook-signature",
        data=json.dumps(verify_body).encode(),
        headers={"Authorization": "Bearer " + token,
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp).get("verification_status") == "SUCCESS"
    except Exception:
        return False


# ---------------------------------------------------------------------------
# custom_id encoding (binds a PayPal purchase to a Cloud account + pack size)
# ---------------------------------------------------------------------------

def parse_custom_id(raw):
    """Decode the ``custom_id`` the checkout attaches to a PayPal purchase.

    Two forms are accepted:

    * ``"<account>"`` — a plain Cloud account id (Pro subscription, or an AI pack
      using the server's default credit size).
    * ``"<account>|ai=<n>"`` — an AI credit pack that grants ``n`` credits to
      ``<account>``.

    Returns ``(account_or_None, credits_or_None)`` and never raises.
    """
    if not raw or not isinstance(raw, str):
        return (None, None)
    account, sep, rest = raw.partition("|")
    credits = None
    if sep:
        for kv in rest.split(";"):
            if kv.startswith("ai="):
                try:
                    credits = int(kv[3:])
                except ValueError:
                    credits = None
    account = account.strip() or None
    return (account, credits)


# ---------------------------------------------------------------------------
# Webhook event → entitlement mapping
# ---------------------------------------------------------------------------

#: One-time payment events (PayPal Orders v2 capture, plus the legacy v1 sale).
_PAYMENT_EVENTS = ("PAYMENT.CAPTURE.COMPLETED", "PAYMENT.SALE.COMPLETED")


def apply_webhook_event(event: dict, account: str, pool: TokenPool,
                        entitlements: EntitlementStore,
                        ai_pack_credits: int = DEFAULT_AI_PACK_CREDITS) -> dict:
    """Apply a verified PayPal webhook event to an account's entitlement.

    Maps the PayPal subscription/payment lifecycle to tier grants and credit
    top-ups. ``account`` is resolved by the caller from the event (the
    subscription's/order's ``custom_id``, falling back to the subscriber email).
    ``ai_pack_credits`` is the credit count for a one-time pack purchase (the
    caller derives it from the ``custom_id`` or a server default).

    Idempotent for subscription activation: an account that is already Pro is
    refreshed in place rather than claiming (and wasting) another pool token —
    PayPal can deliver ACTIVATED more than once, and resends are common.

    Returns a small result dict describing what happened, for the audit log.
    """
    etype = (event or {}).get("event_type", "")
    if etype == "BILLING.SUBSCRIPTION.ACTIVATED":
        sub_id = (event.get("resource") or {}).get("id")
        current = entitlements.get(account)
        if current.get("tier") == TIER_PRO and verify_token(current.get("token")):
            # Already Pro — refresh the subscription id, keep the existing token.
            entitlements.set_tier(account, TIER_PRO, current.get("token"),
                                  expires=current.get("expires"),
                                  paypal_subscription_id=sub_id)
            return {"action": "already_pro", "tier": TIER_PRO, "subscription": sub_id}
        token = pool.claim(TIER_PRO, account)
        if not token:
            return {"action": "pool_exhausted", "tier": TIER_PRO}
        payload = verify_token(token) or {}
        entitlements.set_tier(account, TIER_PRO, token,
                              expires=payload.get("exp"),
                              paypal_subscription_id=sub_id)
        return {"action": "granted", "tier": TIER_PRO, "subscription": sub_id}
    if etype in ("BILLING.SUBSCRIPTION.CANCELLED",
                 "BILLING.SUBSCRIPTION.SUSPENDED",
                 "BILLING.SUBSCRIPTION.EXPIRED"):
        entitlements.revoke(account)
        return {"action": "revoked", "tier": TIER_COMMUNITY}
    if etype in _PAYMENT_EVENTS:
        # A one-time AI credit-pack purchase (subscription billing is handled by
        # the subscription events above).
        new_balance = entitlements.add_credits(account, ai_pack_credits)
        return {"action": "credits_added", "credits": ai_pack_credits,
                "balance": new_balance}
    return {"action": "ignored", "event_type": etype}


# ---------------------------------------------------------------------------
# Admin CLI — fill / inspect the token pool
# ---------------------------------------------------------------------------

def _default_pool_path() -> str:
    return os.getenv("CXD_TOKEN_POOL") or os.path.join(
        os.getenv("CXD_BILLING_DIR", "."), "token-pool.json")


def _pool_counts(pool: TokenPool) -> dict:
    """Per-tier {available, sold} summary of a pool."""
    data = pool._read()  # noqa: SLF001 - same module
    out = {}
    for e in data["entries"]:
        row = out.setdefault(e["tier"], {"available": 0, "sold": 0})
        row["available" if e["status"] == "available" else "sold"] += 1
    return out


def main(argv=None) -> int:
    """Admin CLI to pre-generate and inspect the entitlement token pool.

    Examples::

        python -m cxd_server.billing fill --tier pro --count 100
        python -m cxd_server.billing status

    Requires ``CXD_TOKEN_SIGNING_KEY`` (or ``SESSION_SECRET``) to mint tokens;
    the pool file is ``CXD_TOKEN_POOL`` (or ``<CXD_BILLING_DIR>/token-pool.json``).
    """
    import argparse

    parser = argparse.ArgumentParser(
        prog="cxd_server.billing",
        description="CanvasXpress Cloud entitlement token pool admin")
    parser.add_argument("--pool", default=None,
                        help="pool file path (default: $CXD_TOKEN_POOL)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    pf = sub.add_parser("fill", help="pre-generate tokens into the pool")
    pf.add_argument("--tier", required=True, choices=list(SELF_SERVE_TIERS),
                    help="tier to generate tokens for")
    pf.add_argument("--count", type=int, required=True, help="how many to add")
    pf.add_argument("--days", type=int, default=365,
                    help="token validity in days (default 365)")

    sub.add_parser("status", help="show per-tier available/sold counts")

    args = parser.parse_args(argv)
    pool = TokenPool(args.pool or _default_pool_path())

    if args.cmd == "fill":
        try:
            _signing_key()  # fail early with a clear message if unset
        except RuntimeError as exc:
            print("error:", exc, file=__import__("sys").stderr)
            return 2
        added = pool.add(generate_pool(args.tier, args.count, days=args.days),
                         args.tier)
        counts = _pool_counts(pool).get(args.tier, {})
        print("added %d %s token(s); %s now has %d available"
              % (added, args.tier, args.tier, counts.get("available", 0)))
        return 0

    if args.cmd == "status":
        counts = _pool_counts(pool)
        if not counts:
            print("pool is empty:", pool.path)
            return 0
        print("pool:", pool.path)
        for tier in sorted(counts):
            c = counts[tier]
            print("  %-12s available=%-6d sold=%d" % (tier, c["available"], c["sold"]))
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
