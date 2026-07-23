# canvasxpress-dashboards-server

Persistence & sharing service for [`canvasxpress-dashboards`](../README.md)
specs — save, load, and share dashboards behind your own origin. Mirrors the
[`canvasxpress-connectors`](https://github.com/neuhausi/canvasxpress-connectors)
app-factory + auth model so the two run side by side under one origin.

The store is **stdlib-only** (SQLite, PBKDF2-salted passwords, per-owner
isolation); the web app adds FastAPI.

## Run

```bash
pip install -e '.[web]'
export SESSION_SECRET=$(python -c "import secrets;print(secrets.token_urlsafe(32))")
uvicorn cxd_server.app:create_dashboards_app --factory --reload
```

Environment: `SESSION_SECRET` (required), `APP_DB_PATH` (default `dashboards.db`),
`ALLOW_SIGNUP` (default `1`).

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/signup` · `/auth/login` · `/auth/logout` | Session auth (cookie) |
| `GET` | `/auth/me` | Current user |
| `GET` | `/api/dashboards` | List the user's dashboards (summaries) |
| `POST` | `/api/dashboards` | Create/update a spec (keyed by `spec.id`) |
| `GET` | `/api/dashboards/{id}` | Load one of the user's specs |
| `DELETE` | `/api/dashboards/{id}` | Delete |
| `POST` | `/api/dashboards/{id}/share` | Set visibility (`public` / `auth` / `private`); returns `share_token` + `share_url` |
| `GET` | `/api/shared/{token}` | Read-only spec for a share link (public: open; `auth`: any logged-in viewer) |
| `GET` | `/api/stores` | List configured named stores the user may target (`[{name, capability, default}]`, optional `?capability=`) — names only, never URIs/credentials |
| `GET` | `/api/datasets` | List the user's datasets across all stores (each tagged with its `store`) |
| `POST` | `/api/datasets` | Upload `{format:"csv"\|"json"\|"cx", data, title?, id?, store?}`; reshaped and stored; returns `{id, rows, cols, store, url}` |
| `GET` | `/api/datasets/{id}` | Fetch the CanvasXpress data object (owner-scoped; `?store=` selects a non-default store) |
| `DELETE` | `/api/datasets/{id}` | Delete (`?store=`) |

The bundled read-only viewer is served at `/shared.html?token=…`.

**Datasets & pluggable storage (Phase 5.1–5.3).** Uploaded datasets are reshaped
once into a CanvasXpress data object and persisted in a pluggable `ObjectStore`,
selected by URI scheme. Backends: **`file://`** (local, default, zero-dep),
**`s3://`** (S3 / S3-compatible MinIO·R2·GCS-interop; `[s3]` extra; `url_for`
hands panels a short-lived presigned GET URL), and **`postgres://` / `sqlite://`**
(SQL via SQLAlchemy; `[sql]` extra + a driver such as `psycopg2-binary`; one row
per `(owner, id)`, optional `?table=` so datasets and dashboards can share a
database), and **`gdrive://folderId`** (Google Drive; `[gdrive]` extra; each
owner's objects in their own `cxd-<owner>` folder; `url_for` = Drive
`webViewLink`; OAuth reuses `canvasxpress-connectors` — connect a Google account
once with the `drive.file` scope and the store mints per-owner credentials from
its `TokenStore`). Panels bind by id —
`{"kind":"dataset","id":"sales-2026","store?":"s3-prod"}` — so specs stay path-
and credential-free and resolve with the viewer's own permissions.

**Dashboards on Postgres (Phase 5.3).** The dashboard store (users + specs +
share tokens) is relational, so it upgrades SQLite→Postgres via the *same*
SQLAlchemy code path: set `CXD_DASHBOARD_STORE=postgres://…` (or `sqlite://…`) to
run dashboards on Postgres; unset (or a bare path / `file://`) keeps the
zero-dependency stdlib SQLite store. A parametrized suite runs both backends
through identical asserts, proving parity.

**Config & the store picker (Phase 5.2).** The browser only ever names a
**configured** store; raw paths/credentials stay server-side.

```
CXD_DATASET_STORE     file:///var/cxd/datasets   # s3://bucket/data · (default local ./cxd-datasets)
CXD_DASHBOARD_STORE   file:///var/cxd/dashboards
CXD_PUBLISH_BASE_URL  https://dash.example.com   # stable public base for share links
CXD_STORES            /etc/cxd/stores.json       # optional named-store registry (authoritative when set)
```

`stores.json` curates the names the picker (`GET /api/stores`) can choose among:

```json
{ "stores": [
  { "name": "local",   "capability": "dataset",   "uri": "file:///var/cxd/datasets", "default": true },
  { "name": "s3-prod", "capability": "dataset",   "uri": "s3://my-bucket/datasets" },
  { "name": "local",   "capability": "dashboard", "uri": "file:///var/cxd/dashboards" }
] }
```

**Isolation & permissions.** Every `/api/dashboards*` route is owner-scoped by the
session cookie. Re-saving a spec preserves its share state (a save never silently
unshares). Data still resolves through `canvasxpress-connectors` at render time
with the *viewer's* own permissions — this service only stores/serves the spec,
never credentials.

## Test

```bash
pip install -e '.[dev,web]'
pytest -q
```

## License

MIT © Isaac Neuhaus
