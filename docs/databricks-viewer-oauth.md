# Databricks — sign in as the viewer (Posit Connect OAuth)

A Databricks data source normally stores a credential — a personal access token
(PAT) — in its connection URL, and every viewer of the dashboard reads
Databricks as *that one token's* identity.

When the dashboards server runs as **Posit Connect** content, a Databricks
source can instead sign in **as the signed-in viewer**: each person reads
Databricks as themselves, governed by their own Unity Catalog grants, and the
source stores **no credential at all**.

## How it works

Posit Connect authenticates every visitor and, when a Databricks **OAuth
integration of the _Viewer_ type** is attached to the content, adds a
short-lived `Posit-Connect-User-Session-Token` header to each request. On every
request the server exchanges that header for *that viewer's* Databricks access
token — through the public [`posit-sdk`](https://pypi.org/project/posit-sdk/)
package — and connects with it:

```python
from posit.connect import Client
Client().oauth.get_credentials(session_token, audience=<integration GUID>)["access_token"]
```

`Client()` reads `CONNECT_SERVER` and `CONNECT_API_KEY` from the content's
environment, which Connect sets. Databricks accepts the resulting token anywhere
it accepts a PAT. A **fresh token is exchanged on every request**; it is never
stored, logged or cached, and one viewer never reads Databricks as another. The
exchange lives in `cx_connectors.databricks_oauth` and is applied wherever a
stored SQL source is connected (live charting, joins, the pushdown column
probe, and the dashboard-from-database wizard).

## Register a source

In **Data → + Database**, use the username `posit-connect` and **no password** —
everything else is a normal Databricks URL:

```
databricks://posit-connect@dbc-1234.cloud.databricks.com?http_path=/sql/1.0/warehouses/<id>&catalog=<catalog>&schema=<schema>
```

A normal PAT source keeps working unchanged:

```
databricks://token:<PAT>@dbc-1234.cloud.databricks.com?http_path=/sql/1.0/warehouses/<id>&catalog=<catalog>&schema=<schema>
```

## Setup (one time)

1. Install the extra: `pip install 'canvasxpress-dashboards-server[posit-connect]'`
   (it pulls `canvasxpress-connectors[posit-connect]`, i.e. `posit-sdk`).
2. A Connect **admin** creates a Databricks OAuth integration of the **Viewer**
   type (see the [Posit Connect OAuth docs](https://docs.posit.co/connect/user/oauth-integrations/)).
3. The **content owner** attaches that integration to the deployed dashboards
   content in its **Access** panel. The viewer logs in to the integration once.
4. If **more than one** OAuth integration is attached to the content, set
   `CXC_CONNECT_OAUTH_AUDIENCE` to the Databricks integration's GUID so the
   exchange targets the right one. With a single integration it is not needed.

## Limitations

- **Signed-in viewers on Connect only.** The source has no credential of its
  own, so it only works for a viewer visiting the content on Connect. Outside
  Connect (or with no viewer session token) it fails with a **clear 403** — it
  never falls back to another credential.
- **No scheduled refresh.** A [scheduled dataset refresh](scheduling.md) runs
  with no viewer, so a viewer-OAuth source cannot be refreshed on a schedule
  (clear error). Use a PAT source for data that must refresh on a schedule.

## Security

Each viewer reads only what their own Databricks identity is granted — this is
the strongest form of [row/column governance](governance.md) because it is
enforced by Databricks itself, not re-implemented here. No Databricks credential
is ever stored by the dashboards server for these sources, and the exchanged
token is never written to a log, a cache, or the browser.
