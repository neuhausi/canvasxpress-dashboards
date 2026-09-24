"""Single sign-on with OpenID Connect (Okta, Microsoft Entra ID, Google Workspace,
Keycloak, Auth0, …).

The server is an OIDC *relying party* using the authorization-code flow with
PKCE:

1. ``/auth/oidc/login`` sends the browser to the provider with a fresh
   ``state``, ``nonce`` and PKCE challenge, which are kept in the session.
2. The provider sends it back to ``/auth/oidc/callback`` with a code. The
   server exchanges the code (with the PKCE verifier and its client secret)
   and verifies the ID token against the provider's published keys: an
   asymmetric signature, ``iss``, ``aud``, ``exp`` / ``iat`` and ``nonce``.
3. The provider's ``sub`` is linked to a local account, created on first
   sign-in. The username comes from a configurable claim. An existing local
   account is never taken over by a provider user with the same name unless
   ``CXD_OIDC_LINK_EXISTING`` is on.

Optional: provider groups (a claim) are synced into dashboards groups; members
of ``CXD_OIDC_ADMIN_GROUPS`` are admins; a verified email claim becomes the
user's notification address. Needs PyJWT with its crypto extra (the ``sso``
extra: ``pip install 'canvasxpress-dashboards-server[sso]'``).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"]
_USERNAME_RE = re.compile(r"[^A-Za-z0-9._@-]+")


class OidcError(Exception):
    """A sign-in that must be refused (the message is safe to show)."""


class OidcConfig:
    """Settings from ``CXD_OIDC_*`` (single sign-on is off without an issuer)."""

    def __init__(self, issuer: str, client_id: str, client_secret: Optional[str] = None,
                 scopes: str = "openid email profile", name: str = "single sign-on",
                 username_claim: str = "preferred_username", groups_claim: Optional[str] = None,
                 admin_groups: Optional[List[str]] = None, only: bool = False,
                 link_existing: bool = False, redirect_url: Optional[str] = None,
                 allowed_domains: Optional[List[str]] = None):
        self.issuer = issuer.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.scopes = scopes
        self.name = name
        self.username_claim = username_claim
        self.groups_claim = groups_claim
        self.admin_groups = [g for g in (admin_groups or []) if g]
        self.only = only
        self.link_existing = link_existing
        self.redirect_url = redirect_url
        self.allowed_domains = [d.lower().lstrip("@") for d in (allowed_domains or []) if d]

    @classmethod
    def from_env(cls) -> Optional["OidcConfig"]:
        issuer = os.getenv("CXD_OIDC_ISSUER")
        if not issuer:
            return None
        client_id = os.getenv("CXD_OIDC_CLIENT_ID")
        if not client_id:
            raise ValueError("CXD_OIDC_ISSUER is set but CXD_OIDC_CLIENT_ID is not")
        secret = os.getenv("CXD_OIDC_CLIENT_SECRET") or None
        secret_file = os.getenv("CXD_OIDC_CLIENT_SECRET_FILE")
        if not secret and secret_file:
            with open(os.path.expanduser(secret_file), encoding="utf-8") as fh:
                secret = fh.read().strip() or None

        def listed(name: str) -> List[str]:
            return [v.strip() for v in (os.getenv(name) or "").split(",") if v.strip()]

        def flag(name: str) -> bool:
            return (os.getenv(name) or "").lower() in ("1", "on", "true", "yes")
        return cls(issuer, client_id, secret,
                   scopes=os.getenv("CXD_OIDC_SCOPES") or "openid email profile",
                   name=os.getenv("CXD_OIDC_NAME") or "single sign-on",
                   username_claim=os.getenv("CXD_OIDC_USERNAME_CLAIM") or "preferred_username",
                   groups_claim=os.getenv("CXD_OIDC_GROUPS_CLAIM") or None,
                   admin_groups=listed("CXD_OIDC_ADMIN_GROUPS"),
                   only=flag("CXD_OIDC_ONLY"),
                   link_existing=flag("CXD_OIDC_LINK_EXISTING"),
                   redirect_url=os.getenv("CXD_OIDC_REDIRECT_URL") or None,
                   allowed_domains=listed("CXD_OIDC_ALLOWED_DOMAINS"))


def _http_json(method: str, url: str, data: Optional[Dict[str, str]] = None,
               headers: Optional[Dict[str, str]] = None) -> Tuple[int, Any]:
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers=dict(
        {"Accept": "application/json"}, **(headers or {})))
    if body is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8") or "null")
        except ValueError:
            return exc.code, None


def pkce_pair() -> Tuple[str, str]:
    """``(verifier, S256 challenge)`` for the authorization-code flow."""
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return verifier, base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


class OidcClient:
    """Talks to one provider. ``fetch(method, url, data, headers) -> (status, json)``
    is injectable for tests."""

    def __init__(self, config: OidcConfig,
                 fetch: Optional[Callable[..., Tuple[int, Any]]] = None):
        self.config = config
        self._fetch = fetch or _http_json
        self._discovery: Optional[Dict[str, Any]] = None
        self._discovered_at = 0.0
        self._jwks: Optional[Dict[str, Any]] = None

    def discovery(self) -> Dict[str, Any]:
        if self._discovery is None or time.time() - self._discovered_at > 3600:
            status, doc = self._fetch(
                "GET", self.config.issuer + "/.well-known/openid-configuration")
            if status != 200 or not isinstance(doc, dict) or "authorization_endpoint" not in doc:
                raise OidcError("The identity provider's configuration could not be read")
            if doc.get("issuer", "").rstrip("/") != self.config.issuer:
                raise OidcError("The identity provider reports a different issuer")
            self._discovery, self._discovered_at, self._jwks = doc, time.time(), None
        return self._discovery

    def authorize_url(self, redirect_uri: str, state: str, nonce: str, challenge: str,
                      prompt: Optional[str] = None) -> str:
        params = {"response_type": "code", "client_id": self.config.client_id,
                  "redirect_uri": redirect_uri, "scope": self.config.scopes, "state": state,
                  "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256"}
        if prompt in ("login", "consent", "select_account"):
            params["prompt"] = prompt      # "login" forces re-authentication (e-signatures)
        endpoint = self.discovery()["authorization_endpoint"]
        return endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)

    def exchange(self, code: str, redirect_uri: str, verifier: str) -> Dict[str, Any]:
        data = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
                "client_id": self.config.client_id, "code_verifier": verifier}
        headers = {}
        if self.config.client_secret:
            basic = base64.b64encode(("%s:%s" % (
                urllib.parse.quote(self.config.client_id, safe=""),
                urllib.parse.quote(self.config.client_secret, safe=""))).encode()).decode()
            headers["Authorization"] = "Basic " + basic
        status, tokens = self._fetch("POST", self.discovery()["token_endpoint"], data, headers)
        if status != 200 or not isinstance(tokens, dict) or "id_token" not in tokens:
            detail = (tokens or {}).get("error_description") or (tokens or {}).get("error") \
                if isinstance(tokens, dict) else None
            raise OidcError("The identity provider refused the sign-in%s"
                            % (": " + str(detail) if detail else ""))
        return tokens

    def _key_for(self, kid: Optional[str]):
        import jwt
        for attempt in range(2):
            if self._jwks is None or attempt == 1:
                status, jwks = self._fetch("GET", self.discovery()["jwks_uri"])
                if status != 200 or not isinstance(jwks, dict):
                    raise OidcError("The identity provider's signing keys could not be read")
                self._jwks = jwks
            keys = [k for k in self._jwks.get("keys", []) if k.get("use", "sig") == "sig"]
            match = [k for k in keys if kid is None or k.get("kid") == kid]
            if match:
                return jwt.PyJWK(match[0]).key
        raise OidcError("The ID token was signed with an unknown key")

    def verify_id_token(self, token: str, nonce: str) -> Dict[str, Any]:
        """The ID token's claims, after checking signature, issuer, audience,
        expiry and nonce."""
        import jwt
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError:
            raise OidcError("The ID token is malformed")
        if header.get("alg") not in ALGORITHMS:
            raise OidcError("The ID token uses a signature algorithm that is not accepted")
        key = self._key_for(header.get("kid"))
        try:
            claims = jwt.decode(token, key, algorithms=[header["alg"]],
                                audience=self.config.client_id,
                                issuer=self.discovery().get("issuer"), leeway=60,
                                options={"require": ["exp", "iat", "sub", "iss", "aud"]})
        except jwt.PyJWTError as exc:
            raise OidcError("The ID token is not valid (%s)" % exc)
        if not nonce or claims.get("nonce") != nonce:
            raise OidcError("The ID token does not belong to this sign-in (nonce)")
        return claims

    def userinfo(self, access_token: Optional[str]) -> Dict[str, Any]:
        endpoint = self.discovery().get("userinfo_endpoint")
        if not endpoint or not access_token:
            return {}
        status, info = self._fetch("GET", endpoint, None,
                                   {"Authorization": "Bearer " + access_token})
        return info if status == 200 and isinstance(info, dict) else {}

    def logout_url(self, id_token: Optional[str], return_to: Optional[str]) -> Optional[str]:
        endpoint = self.discovery().get("end_session_endpoint")
        if not endpoint:
            return None
        params = {"client_id": self.config.client_id}
        if id_token:
            params["id_token_hint"] = id_token
        if return_to:
            params["post_logout_redirect_uri"] = return_to
        return endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)


# ---- identities (provider subject -> local account) --------------------------------
class IdentityStore:
    """``cxd_identities``: which local account a provider's ``sub`` signs in as."""

    def __init__(self, db):
        self._db = db
        self._db.run([(
            "CREATE TABLE IF NOT EXISTS cxd_identities ("
            " issuer TEXT NOT NULL, subject TEXT NOT NULL, username TEXT NOT NULL,"
            " created_at TEXT, last_login TEXT, PRIMARY KEY (issuer, subject))", {})])

    def username_for(self, issuer: str, subject: str) -> Optional[str]:
        rows = self._db.query("SELECT username FROM cxd_identities WHERE issuer = :i"
                              " AND subject = :s", {"i": issuer, "s": subject})
        return rows[0]["username"] if rows else None

    def is_linked(self, username: str) -> bool:
        return bool(self._db.query("SELECT 1 FROM cxd_identities WHERE username = :u",
                                   {"u": username}))

    def link(self, issuer: str, subject: str, username: str, now: str) -> None:
        self._db.run([(
            "INSERT INTO cxd_identities (issuer, subject, username, created_at, last_login)"
            " VALUES (:i, :s, :u, :t, :t) ON CONFLICT (issuer, subject)"
            " DO UPDATE SET last_login = excluded.last_login",
            {"i": issuer, "s": subject, "u": username, "t": now})])

    def forget_user(self, username: str) -> None:
        self._db.run([("DELETE FROM cxd_identities WHERE username = :u", {"u": username})])


def username_from(claims: Dict[str, Any], claim: str) -> str:
    """A local username from the configured claim (falls back to email, then sub)."""
    raw = claims.get(claim) or claims.get("email") or claims.get("sub") or ""
    name = _USERNAME_RE.sub("-", str(raw)).strip("-.")[:64]
    if len(name) < 3:
        raise OidcError("The identity provider sent no usable user name")
    return name


def groups_from(claims: Dict[str, Any], claim: Optional[str]) -> Optional[List[str]]:
    """The provider groups in ``claim`` (a list, or a comma/space separated string)."""
    if not claim or claim not in claims:
        return None
    value = claims[claim]
    if isinstance(value, str):
        value = [v for v in re.split(r"[,\s]+", value) if v]
    if not isinstance(value, list):
        return None
    return [str(v) for v in value if isinstance(v, (str, int)) and str(v)]
