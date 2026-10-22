# Connecting your data: Salesforce, Databricks and pins

Start here to connect a dashboard to **Salesforce**, **Databricks** or a **Posit pins** board
with your own credentials, and to see how those credentials are handled. Each connection has
its own step-by-step guide:

| Connect to | Best way to sign in | What the server keeps | Guide |
|---|---|---|---|
| **Salesforce** | An **OAuth app** set up on the server: no password and no token | Only the app's name | [Salesforce](connect-salesforce.md) |
| **Databricks** | **Sign in as the viewer** (Posit Connect), or a personal access token | Nothing (viewer), or the token, encrypted | [Databricks](connect-databricks.md) |
| **Posit pins** | **Add the pin's address** with your own Connect login, or a live source with the board's key | Nothing (address), or the key, encrypted | [Pins](connect-pins.md) |

Other databases (PostgreSQL, MySQL, Snowflake, BigQuery and the rest) connect like a Databricks
token source: **Data → + Database** with a connection URL.

## Who does what

| Role | Does |
|---|---|
| **Server administrator** | Installs the optional package for the source, sets the server settings it needs (for Salesforce, the OAuth app; for pins, the allowed folders), and runs the one-time registration for Salesforce and for live pins sources. |
| **Dashboard author** | Picks the registered source **by name** while building a dashboard, and adds databases under **Data → + Database**. |
| **Viewer** | Nothing. Opens the dashboard; the server reads the data. |

Databases are registered in the Builder (**Data → + Database**). A pin can be added by any author
from its web address (**Data → + Data → External URL / connector**), which stores no credential.
Salesforce, and pins that must stay live, are registered once with a short API call by the
administrator; each guide gives the exact commands.

## How your credentials are protected

- **Stored encrypted, one owner.** A saved login is encrypted with the server's
  `ENCRYPTION_KEY` and belongs to the user who registered it; no other user can read or use it.
- **Never shown again.** The Builder shows a saved password, token or secret as `********`.
  Editing a source and saving it with `********` still in place keeps the stored secret; type a
  new value to replace it. Only the server can put the stored secret back, and only while the
  server, host and port are unchanged. To point a source at a different host you type the
  password again, so a stored password cannot be redirected somewhere new.
- **Not in dashboards.** A dashboard names a source (`/connectors/api/data?source=NAME`). A
  saved dashboard, a download or an export contains that name and nothing else.
- **Not in the audit log.** The audit log records who did what and when, not request bodies.
- **In transit.** Run the server behind HTTPS, and credentials travel encrypted from the browser.

What this does not do: anyone who has both the database and the server's `ENCRYPTION_KEY` can
decrypt every saved login, so protect the server and the key like any other secret, and give
each connection a least-privilege account.

## Changing or rotating a credential

- **A database** (including Databricks with a token): **Data →** the pencil on its card, replace
  `********` with the new password or token, **Save**. If you also change the host, retype the
  password.
- **Salesforce or pins:** register the source again under the same name; it replaces the old one.
  These sources have no edit form, because their login is never shown.
- **Remove a source:** the **×** on its card, or `DELETE /connectors/api/sources/NAME`.

## What type is a source?

Every source has a type: `salesforce`, `servicenow`, `pins`, `databricks`, `databricks-viewer`
(signs in as the viewer and stores no credential), or the database's own name (`postgresql`,
`mysql`, `snowflake`, `sqlite` …). The list returned by `GET /api/connectors/sources-meta`
includes each source's type, and the Builder uses it to decide what can be edited or reused as
a database.
