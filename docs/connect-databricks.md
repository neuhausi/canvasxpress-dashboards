# Connect a dashboard to Databricks

A dashboard can read **live data from a Databricks SQL warehouse**: tables, views and queries
you can already run in Databricks. Each time a dashboard loads, the server runs your read-only
`SELECT` in your warehouse; nothing is copied into the dashboard.

Read [Connecting your data](connecting-your-data.md) first for how credentials are protected.

## 1. Choose how the server signs in to Databricks

| | **Sign in as the viewer** | **Personal access token** |
|---|---|---|
| Whose Databricks identity is used | Each viewer's own | The token's owner, for everyone |
| What the server stores | **Nothing** | The token, encrypted, in the connection URL |
| Row and column access | Enforced by Databricks, per viewer | The token owner's grants |
| Needs | The dashboards server running on **Posit Connect** | Any server |
| Scheduled refresh | No (there is no viewer) | Yes |

Use **viewer sign-in** when you can: no credential exists to leak or to expire, and each person
sees only what Databricks lets them see. Use a **token** for anything that must refresh on a
schedule or runs outside Posit Connect.

## 2. Personal access token

### Collect three things from Databricks

1. **Server hostname** and **HTTP path**: open **SQL Warehouses**, choose the warehouse, then its
   **Connection details** tab. They look like `dbc-1234.cloud.databricks.com` and
   `/sql/1.0/warehouses/abc123`.
2. **A personal access token**: in your workspace, your user settings → **Developer** → **Access
   tokens** → **Generate new token** (screen names vary a little between releases). Use a
   **service principal or a dedicated, least-privilege user** with read access to just the
   tables the dashboards need: everyone who can open the dashboard reads as that identity.
3. The **catalog** and **schema** to read (for example `main` and `default`).

### Build the connection URL

```
databricks://token:<TOKEN>@<SERVER HOSTNAME>?http_path=<HTTP PATH>&catalog=<CATALOG>&schema=<SCHEMA>
```

For example:

```
databricks://token:dapi0123456789abcdef@dbc-1234.cloud.databricks.com?http_path=/sql/1.0/warehouses/abc123&catalog=main&schema=default
```

The user name is always the word `token`; the token goes where a password would.

### Register it

1. **Data → + Database**.
2. Under **Database**, choose **A new connection URL…** and paste the URL.
3. Write a read-only query, for example `SELECT sample, gene, expression FROM expression`.
   Use `:name` for a value a dashboard control should supply
   (see [live-data controls](live-data-controls.md)).
4. **▶ Test**, then **Add source**.

The source is now available by name when you build a dashboard. The token is stored encrypted and
shown as `********` if you edit the source.

### Install (server administrator)

```bash
pip install "canvasxpress-dashboards-server[databricks]"
```

This pulls in the Databricks driver. SQLAlchemy is kept below 2.1, which breaks that driver.

## 3. Sign in as the viewer (Posit Connect)

Register the source with the user name `posit-connect` and **no password**:

```
databricks://posit-connect@dbc-1234.cloud.databricks.com?http_path=/sql/1.0/warehouses/abc123&catalog=main&schema=default
```

Everything else is the same as above. Setup needs a Posit Connect administrator to create a
Databricks OAuth integration of the **Viewer** type and attach it to the dashboards content, and
`pip install "canvasxpress-dashboards-server[posit-connect]"`. The full steps, the limits and how
it works are in [Databricks: sign in as the viewer](databricks-viewer-oauth.md).

## 4. Browse Unity Catalog (optional)

If the administrator sets `CXD_DATABRICKS_HOST` (for example `dbc-1234.cloud.databricks.com`),
the Data page gains a **Databricks** card where you pick a warehouse, expand catalogs, schemas and
tables, and **Save as source** or build a dashboard from a table. Off Posit Connect the saved source
carries `databricks://token:REPLACE_WITH_TOKEN@…`: edit it and type your token in place of that
placeholder (it will show as `********` in the form; just type the real token over it). The
**Browse Unity Catalog** section of [Databricks: sign in as the viewer](databricks-viewer-oauth.md)
has the details.

## Changing or rotating the token

**Data →** the pencil on the source, replace `********` with the new token, **Save**. If you also
change the host, retype the token: a stored token is never sent to a different server.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Re-enter the password: it is never shown, so it cannot be reused for a different server." | You changed the host (or scheme or port) but left `********`. Type the token in the URL. |
| Connection or authentication error on **Test** | The token is wrong, revoked or expired (tokens have a lifetime): generate a new one and replace it. |
| "Invalid HTTP path", or no warehouse found | Copy **HTTP path** from the warehouse's **Connection details** again. |
| Permission denied on a table | The token's identity lacks access: grant it in Databricks. |
| 403 on a viewer source | There is no signed-in Posit Connect viewer (the page is outside Connect). Use a token source. |
| A viewer source won't refresh on a schedule | It can't: there is no viewer then. Use a token source. |
| `ModuleNotFoundError` for the Databricks driver | Install the `[databricks]` extra in the environment that runs the server. |
