# Single sign-on (OpenID Connect)

The dashboards server (`cxd_server`) signs users in through your identity
provider over OpenID Connect: Okta, Microsoft Entra ID (Azure AD), Google
Workspace, Keycloak, Auth0, Ping, or any other OIDC provider. Users click
**Sign in with …** on the login page and come back signed in. Their groups and
email can come along, so [roles, sharing and row security](governance.md)
follow the identity provider.

## How it works

The server is an OIDC *relying party* using the **authorization-code flow with
PKCE**:

1. **To the provider.** `/auth/oidc/login` sends the browser to the provider
   with a fresh `state`, `nonce` and PKCE challenge, kept in the session.
2. **Back with a code.** The provider returns the browser to
   `/auth/oidc/callback`. The server exchanges the code at the provider's token
   endpoint, using the PKCE verifier and its client secret.
3. **The ID token is verified** against the provider's published keys (JWKS,
   re-fetched when the provider rotates them):
   - an asymmetric signature (RS/PS/ES-256/384/512; `none` and HMAC are refused);
   - `iss`, `aud`, `exp` / `iat` (60 s clock tolerance) and the `nonce`.
4. **Signed in.** The provider's `sub` is linked to a local account, created
   on first sign-in, and the user gets a fresh session.

**Accounts are linked by `sub`,** so a user keeps their account when their name
or email changes at the provider.

**No takeover.** A provider user is never signed into an existing local account
that happens to have the same name: the sign-in is refused with "ask an
administrator to link it". Turn `CXD_OIDC_LINK_EXISTING` on to link same-named
accounts deliberately, for example when moving existing users to SSO. A linked
account cannot sign in with a password.

## Setting it up

1. **Register an application** (a "web" / confidential client) at the provider:
   - redirect URI: `https://<your server>/auth/oidc/callback` (under
     `CXD_PUBLISH_BASE_URL` when the app lives under a path, e.g.
     `https://example.org/dashboards/auth/oidc/callback`);
   - post-logout redirect URI: `https://<your server>/`;
   - scopes: `openid email profile` (plus `groups` where the provider needs it).
2. **Install** the extra: `pip install 'canvasxpress-dashboards-server[web,sso]'`.
3. **Configure** the server and restart:

   ```bash
   CXD_OIDC_ISSUER=https://login.example.org/realms/acme
   CXD_OIDC_CLIENT_ID=cxd-dashboards
   CXD_OIDC_CLIENT_SECRET_FILE=/etc/cxd/oidc-secret   # or CXD_OIDC_CLIENT_SECRET
   CXD_OIDC_NAME="Acme SSO"                           # the button: "Sign in with Acme SSO"
   CXD_OIDC_GROUPS_CLAIM=groups
   CXD_OIDC_ADMIN_GROUPS=dashboards-admins
   CXD_PUBLISH_BASE_URL=https://example.org/dashboards
   ```

| Variable | Default | Effect |
|---|---|---|
| `CXD_OIDC_ISSUER` | (none: SSO off) | The provider's issuer URL (its `/.well-known/openid-configuration` must be reachable) |
| `CXD_OIDC_CLIENT_ID` | | The registered application's client id |
| `CXD_OIDC_CLIENT_SECRET` / `_FILE` | | Its client secret (the file form keeps it out of the environment) |
| `CXD_OIDC_NAME` | `single sign-on` | Shown on the button |
| `CXD_OIDC_SCOPES` | `openid email profile` | Requested scopes |
| `CXD_OIDC_USERNAME_CLAIM` | `preferred_username` | Claim for the local username (falls back to `email`, then `sub`; other characters become `-`) |
| `CXD_OIDC_GROUPS_CLAIM` | (none) | Claim holding the user's groups (`groups`, `roles`, …); a list or a comma/space separated string |
| `CXD_OIDC_ADMIN_GROUPS` | (none) | Comma-separated provider groups whose members are dashboards admins |
| `CXD_OIDC_ALLOWED_DOMAINS` | (any) | Comma-separated email domains allowed to sign in |
| `CXD_OIDC_ONLY` | `off` | `on`: SSO only (see below) |
| `CXD_OIDC_LINK_EXISTING` | `off` | `on`: a provider user may sign into a local account with the same name |
| `CXD_OIDC_REDIRECT_URL` | `<base>/auth/oidc/callback` | Override the redirect URI |

## What comes from the provider

- **Groups.** With `CXD_OIDC_GROUPS_CLAIM`, the user's provider groups become
  dashboards groups at every sign-in.
  - Missing groups are created, marked **SSO** in Admin → *Groups*.
  - The user is added to the groups in the claim and removed from the SSO groups
    that are no longer in it. Groups created by hand are never emptied by SSO.
  - Give these groups roles, share dashboards with them, and use them in dataset
    security rules; access then follows the provider.
  - If the ID token lacks the claim, the userinfo endpoint is asked.
- **Admins.** With `CXD_OIDC_ADMIN_GROUPS`, admin rights follow those groups at
  each sign-in: granted when the user is in one, removed when not. Users in
  `CXD_ADMINS` stay admins regardless.
- **Email.** A verified `email` claim (`email_verified: true`) becomes the user's
  notification address, already confirmed, for
  [alerts and emailed dashboards](scheduling.md).

Provider claims per product, as a starting point:

| Provider | Issuer | Groups |
|---|---|---|
| Okta | `https://<org>.okta.com/oauth2/default` | add a `groups` claim to the authorization server; `CXD_OIDC_GROUPS_CLAIM=groups` |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | enable the `groups` claim (group ids) or app `roles`; `CXD_OIDC_GROUPS_CLAIM=groups` or `roles`; `CXD_OIDC_USERNAME_CLAIM=preferred_username` |
| Google Workspace | `https://accounts.google.com` | no group claim; use `CXD_OIDC_ALLOWED_DOMAINS=yourdomain.com`; `CXD_OIDC_USERNAME_CLAIM=email` |
| Keycloak | `https://<host>/realms/<realm>` | add a "Group Membership" mapper (full path off) named `groups` |
| Auth0 | `https://<tenant>.auth0.com` | add groups/roles with an Action to a namespaced claim, and name it in `CXD_OIDC_GROUPS_CLAIM` |

## SSO only

With `CXD_OIDC_ONLY=on`:

- the login page shows only **Sign in with …**;
- self sign-up is off;
- password sign-in is refused, except for the usernames in `CXD_ADMINS`. That
  is a **break-glass** way in if the provider is down: *Administrator password
  sign-in* on the login page.

## Signing out

**Sign out** ends the dashboards session and, when the provider supports it
(`end_session_endpoint`), the provider session too, then returns to the app.

## Audit

Every SSO sign-in, and every refused one, is recorded as `auth.sso` in the
[audit log](governance.md#audit-log), with the username, the issuer, the
number of groups, whether the account was created, and why a sign-in failed.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/auth/config` | `{password, signup, oidc: {enabled, name}}`: how users sign in here |
| `GET` | `/auth/oidc/login` | Start single sign-on |
| `GET` | `/auth/oidc/callback` | The redirect URI |
| `POST` | `/auth/logout` | Sign out; returns `logout_url` after an SSO session |
| `GET` | `/auth/me` | Includes `sso: true` for a single sign-on session |
