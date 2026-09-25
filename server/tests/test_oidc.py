"""Single sign-on (OpenID Connect) against a fake identity provider that signs
real RS256 ID tokens and enforces PKCE."""

import base64
import hashlib
import json
import time
import urllib.parse

import pytest

jwt = pytest.importorskip("jwt")
pytest.importorskip("cryptography")

from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from cxd_server.app import create_dashboards_app  # noqa: E402
from cxd_server.oidc import OidcClient, OidcConfig, groups_from, username_from  # noqa: E402
from cxd_server.store import DashboardStore  # noqa: E402

ISSUER = "https://idp.example.test"
CLIENT = "cxd-app"
BASE = "https://example.test/dashboards"


class FakeIdP:
    """Discovery, JWKS, a PKCE-checking token endpoint, userinfo, logout."""

    def __init__(self):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        self.jwks = {"keys": [dict(jwk, kid="k1", use="sig", alg="RS256")]}
        self.codes = {}
        self.claims = {}
        self.tamper = None          # a function(claims, header) -> (claims, header, key)

    def issue_code(self, auth_url, claims):
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(auth_url).query))
        code = "code-%d" % len(self.codes)
        self.codes[code] = {"challenge": q["code_challenge"], "nonce": q["nonce"],
                            "redirect_uri": q["redirect_uri"], "claims": claims}
        return code, q["state"]

    def fetch(self, method, url, data=None, headers=None):
        if url == ISSUER + "/.well-known/openid-configuration":
            return 200, {"issuer": ISSUER, "authorization_endpoint": ISSUER + "/authorize",
                         "token_endpoint": ISSUER + "/token", "jwks_uri": ISSUER + "/jwks",
                         "userinfo_endpoint": ISSUER + "/userinfo",
                         "end_session_endpoint": ISSUER + "/logout"}
        if url == ISSUER + "/jwks":
            return 200, self.jwks
        if url == ISSUER + "/userinfo":
            return 200, {"sub": self.last_sub, "groups": ["from-userinfo"]}
        if url == ISSUER + "/token":
            grant = self.codes.pop(data["code"], None)
            assert headers["Authorization"].startswith("Basic ")
            if grant is None:
                return 400, {"error": "invalid_grant"}
            digest = hashlib.sha256(data["code_verifier"].encode()).digest()
            if base64.urlsafe_b64encode(digest).rstrip(b"=").decode() != grant["challenge"]:
                return 400, {"error": "invalid_grant", "error_description": "PKCE failed"}
            now = int(time.time())
            claims = dict({"iss": ISSUER, "aud": CLIENT, "iat": now, "exp": now + 300,
                           "nonce": grant["nonce"]}, **grant["claims"])
            self.last_sub = claims["sub"]
            header, key = {"kid": "k1"}, self.key
            if self.tamper:
                claims, header, key = self.tamper(claims, header, key)
            token = jwt.encode(claims, key, algorithm=header.pop("alg", "RS256"), headers=header)
            return 200, {"id_token": token, "access_token": "at", "token_type": "Bearer"}
        return 404, None


@pytest.fixture
def idp():
    return FakeIdP()


def make_app(tmp_path, idp, **cfg):
    config = OidcConfig(ISSUER, CLIENT, "s3cret", name="Acme SSO",
                        groups_claim=cfg.pop("groups_claim", "groups"),
                        admin_groups=cfg.pop("admin_groups", ["dash-admins"]), **cfg)
    return create_dashboards_app(
        store=DashboardStore(str(tmp_path / "d.db")), session_secret="s", serve_static=False,
        dataset_store_uri="file://" + str(tmp_path / "ds"), publish_base_url=BASE,
        admins={"breakglass"}, scheduler_enabled=False, oidc=OidcClient(config, idp.fetch))


def sign_in(client, idp, claims):
    start = client.get("/auth/oidc/login", follow_redirects=False)
    assert start.status_code == 302 and start.headers["location"].startswith(ISSUER + "/authorize?")
    code, state = idp.issue_code(start.headers["location"], claims)
    return client.get("/auth/oidc/callback", params={"code": code, "state": state},
                      follow_redirects=False)


def test_round_trip_creates_links_and_syncs(tmp_path, idp):
    app = make_app(tmp_path, idp)
    client = TestClient(app)
    assert client.get("/auth/config").json() == {"password": True, "signup": True,
                                                 "oidc": {"enabled": True, "name": "Acme SSO"},
                                                 "posit_connect": False}
    loc = client.get("/auth/oidc/login", follow_redirects=False).headers["location"]
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(loc).query))
    assert q["redirect_uri"] == BASE + "/auth/oidc/callback"
    assert q["code_challenge_method"] == "S256" and q["scope"] == "openid email profile"

    done = sign_in(client, idp, {"sub": "u-1", "preferred_username": "Ada Lovelace",
                                 "email": "ada@example.test", "email_verified": True,
                                 "groups": ["site-a", "dash-admins"]})
    assert done.status_code == 302 and done.headers["location"] == BASE + "/"
    me = client.get("/auth/me").json()
    assert me["user"] == "Ada-Lovelace" and me["sso"] is True and me["is_admin"] is True
    assert me["groups"] == ["dash-admins", "site-a"]
    assert client.get("/api/me/profile").json() == {"user": "Ada-Lovelace",
                                                    "email": "ada@example.test",
                                                    "verified": True}
    gov = client.get("/api/admin/governance").json()
    assert {g["name"]: g["managed"] for g in gov["groups"]} == {"dash-admins": "oidc",
                                                                "site-a": "oidc"}
    # The linked account cannot be used with a password.
    assert TestClient(app).post("/auth/login", json={"username": "Ada-Lovelace",
                                                     "password": "x"}).status_code == 401
    # Next sign-in: same account (by sub, even if the name changed); groups re-synced.
    fresh = TestClient(app)
    sign_in(fresh, idp, {"sub": "u-1", "preferred_username": "ada.renamed",
                         "groups": ["site-b"]})
    me = fresh.get("/auth/me").json()
    assert me["user"] == "Ada-Lovelace" and me["groups"] == ["site-b"]
    assert me["is_admin"] is False                   # admin follows the provider's groups
    events = app.state.audit.query(action="auth.sso")["events"]
    assert [e["target"] for e in events] == ["Ada-Lovelace", "Ada-Lovelace"]
    assert events[-1]["detail"]["created"] is True


def test_provider_user_never_takes_over_a_local_account(tmp_path, idp):
    app = make_app(tmp_path, idp)
    local = TestClient(app)
    local.post("/auth/signup", json={"username": "grace", "password": "secret1"})
    intruder = TestClient(app)
    r = sign_in(intruder, idp, {"sub": "evil", "preferred_username": "grace"})
    assert r.status_code == 401 and "already exists" in r.text
    assert intruder.get("/auth/me").json()["user"] is None
    assert app.state.audit.query(action="auth.sso")["events"][0]["outcome"] == "denied"


def test_linking_existing_accounts_when_allowed(tmp_path, idp):
    app = make_app(tmp_path, idp, link_existing=True)
    TestClient(app).post("/auth/signup", json={"username": "grace", "password": "secret1"})
    client = TestClient(app)
    assert sign_in(client, idp, {"sub": "g-1", "preferred_username": "grace"}).status_code == 302
    assert client.get("/auth/me").json()["user"] == "grace"


def test_forged_expired_foreign_and_replayed_tokens_are_refused(tmp_path, idp):
    app = make_app(tmp_path, idp)
    base = {"sub": "u-9", "preferred_username": "mallory"}
    cases = [
        ("unknown key", lambda c, h, k: (c, dict(h, kid="other"), idp.other_key)),
        ("wrong key", lambda c, h, k: (c, h, idp.other_key)),
        ("audience", lambda c, h, k: (dict(c, aud="someone-else"), h, k)),
        ("expired", lambda c, h, k: (dict(c, exp=int(time.time()) - 3600,
                                          iat=int(time.time()) - 7200), h, k)),
        ("issuer", lambda c, h, k: (dict(c, iss="https://evil.test"), h, k)),
        ("nonce", lambda c, h, k: (dict(c, nonce="replayed"), h, k)),
        ("hmac", lambda c, h, k: (c, dict(h, alg="HS256"), "a-shared-secret-that-is-32-bytes!")),
    ]
    for label, tamper in cases:
        idp.tamper = tamper
        client = TestClient(app)
        r = sign_in(client, idp, base)
        assert r.status_code == 401, label
        assert client.get("/auth/me").json()["user"] is None, label
    idp.tamper = None
    # A callback without a matching started sign-in (state) is refused.
    client = TestClient(app)
    client.get("/auth/oidc/login", follow_redirects=False)
    bad = client.get("/auth/oidc/callback", params={"code": "x", "state": "forged"})
    assert bad.status_code == 401 and "expired or was not started here" in bad.text
    # A provider error is shown, not trusted.
    err = TestClient(app).get("/auth/oidc/callback", params={"error": "access_denied"})
    assert err.status_code == 401


def test_provider_only_mode_keeps_a_break_glass_admin(tmp_path, idp):
    app = make_app(tmp_path, idp, only=True)
    admin = TestClient(app)
    admin.post("/auth/logout")
    # Signup is off; so is password sign-in, except for CXD_ADMINS (break-glass).
    assert admin.post("/auth/signup", json={"username": "x-user", "password": "secret1"}
                      ).status_code == 403
    store = DashboardStore(str(tmp_path / "d.db"))
    store.create_user("breakglass", "secret1")
    store.create_user("someone", "secret1")
    assert admin.post("/auth/login", json={"username": "someone", "password": "secret1"}
                      ).status_code == 403
    assert admin.post("/auth/login", json={"username": "breakglass", "password": "secret1"}
                      ).status_code == 200
    assert TestClient(app).get("/auth/config").json()["password"] is False


def test_logout_ends_the_provider_session_and_userinfo_fills_groups(tmp_path, idp):
    app = make_app(tmp_path, idp)
    client = TestClient(app)
    sign_in(client, idp, {"sub": "u-5", "preferred_username": "linus"})   # no groups claim
    assert client.get("/auth/me").json()["groups"] == ["from-userinfo"]
    out = client.post("/auth/logout").json()
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(out["logout_url"]).query))
    assert out["logout_url"].startswith(ISSUER + "/logout?")
    assert q["post_logout_redirect_uri"] == BASE + "/" and q["id_token_hint"]
    assert client.get("/auth/me").json()["user"] is None


def test_allowed_domains_and_claim_helpers(tmp_path, idp):
    app = make_app(tmp_path, idp, allowed_domains=["example.test"])
    r = sign_in(TestClient(app), idp, {"sub": "x", "preferred_username": "eve",
                                       "email": "eve@other.test", "email_verified": True})
    assert r.status_code == 401 and "email domain" in r.text
    assert username_from({"preferred_username": "a b/c"}, "preferred_username") == "a-b-c"
    assert username_from({"email": "z@x.org"}, "upn") == "z@x.org"
    assert groups_from({"roles": "a, b c"}, "roles") == ["a", "b", "c"]
    assert groups_from({}, "groups") is None


def test_sso_is_off_without_configuration(tmp_path):
    app = create_dashboards_app(store=DashboardStore(str(tmp_path / "d.db")), session_secret="s",
                                serve_static=False, scheduler_enabled=False,
                                dataset_store_uri="file://" + str(tmp_path / "ds"))
    client = TestClient(app)
    assert client.get("/auth/config").json()["oidc"] == {"enabled": False, "name": None}
    assert client.get("/auth/oidc/login", follow_redirects=False).status_code == 404
