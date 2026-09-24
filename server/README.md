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
cp .env.example .env          # optional — edit to point at your resources
python -m cxd_server          # or: cxd-server   (installed console script)
```

That's the turnkey path: it loads `.env` (when present), **generates and persists
a `SESSION_SECRET`** on first run (so logins survive restarts — no key management
needed), then serves the **full no-code app** (sign-in, Builder, saved dashboards,
dataset uploads, share links) at `http://127.0.0.1:8000/`. Flags: `--host`,
`--port`, `--reload` (dev auto-reload), `--no-signup`.

**Docker:** from the repo root, `docker compose up` (→ `http://localhost:8000/`).
Persistent state lives in the `cxd-data` volume; see the commented blocks in
[`docker-compose.yml`](../docker-compose.yml) to swap in Postgres / S3.

Config is entirely environment-driven — copy [`.env.example`](.env.example) and
change values to your resources (Postgres, S3, Google Drive, HTTPS, …). Common
vars: `SESSION_SECRET` (auto-generated if unset), `CXD_HOST`/`CXD_PORT`,
`APP_DB_PATH`, `CXD_DASHBOARD_STORE`, `CXD_DATASET_STORE`, `ALLOW_SIGNUP`,
`CXD_HTTPS_ONLY`, `CXD_ADMINS`, `CXD_PUBLISH_BASE_URL`, `CXD_CANVASXPRESS_URL`,
`CXD_CANVASXPRESS_LICENSE`, `CXD_LLM_API_KEY`, `CXD_LLM_MODEL`, `CXD_FUNCTIONS*`,
`CXD_AUDIT`, `CXD_AUDIT_RETENTION_DAYS`, `CXD_DEFAULT_ROLE`, `CXD_SCHEDULER*`,
`CXD_SMTP_*`, `CXD_SNAPSHOTS`, `CXD_INTERNAL_URL`, `CXD_DASHBOARD_URL`.

**Scheduling.** Dataset refresh (from a URL or a database source), alerts on
dataset values, and emailed dashboards with a PNG snapshot run on cron schedules,
each with the rights of the people involved. See
[docs/scheduling.md](../docs/scheduling.md) for setup (SMTP, snapshots) and the API.

**Audit log.** The server records who did what: sign-ins (including failed
attempts), dashboard and dataset changes, shares, share-link views, data-function
runs, natural-language builder calls, admin actions, and reads of the audit log
itself. Denied attempts are recorded with their status. Each event holds the
time, user, action, target, owner, outcome, client IP and a few non-sensitive
details. Passwords, specs, data and function code are never stored; a function
run is identified by a hash of its code. Events are append-only and
**hash-chained**, so an edited or deleted entry shows up in
`GET /api/admin/audit/verify`. They live in a `cxd_audit` table next to the
dashboards (the same SQLite file, or the same database for a SQL store).
Administrators browse, filter and export them in the app's Admin view.
`CXD_AUDIT=off` disables it; `CXD_AUDIT_RETENTION_DAYS=N` prunes older events
(default: keep everything). A failure to write an event is reported on stderr and
never fails the request.

The full guide to the audit log, roles, sharing, security rules and lineage is
[docs/governance.md](../docs/governance.md).

**Roles, groups and sharing.** Administrators create groups of users and roles:
named sets of permissions (create dashboards, upload datasets, share with people,
publish share links, run data functions, use the AI builder). `viewer` (no
permissions: opens what is shared with them) and `editor` (every permission) are
built in. A role is given to a user or a group, and a user holds every permission
of their own and their groups' roles. Users with no role anywhere get
`CXD_DEFAULT_ROLE` (default `editor`, which is how a server without roles
behaves). Owners share a dashboard with a user, a group or everyone signed in, to
view or to edit; people it is shared with read its stored datasets through it.
Datasets can be shared on their own too.

**Row- and column-level security.** A dataset's owner can restrict what everyone
else receives from it: row rules keep only the rows whose value in a column is
allowed for the viewer's user or groups, and column rules hide columns except
from named users or groups. A viewer no rule allows gets no rows. The rules are
applied by the server wherever it hands out the dataset: in the app, through a
shared dashboard, and on share links (where the viewer is `anonymous` unless
signed in). Owners and administrators see everything. The rules protect stored
datasets only; data written into a spec travels with the spec. **Lineage**
(`GET /api/lineage`, and across every user for admins) lists which dashboards
read which datasets and connectors.

**Data functions** (`kind:"function"` sources — R / Python snippets) run in
this server only when `CXD_FUNCTIONS=admin` (administrators) or `users` (any
logged-in user); the default is `off`. Each run is a sandboxed subprocess with a
timeout, resource limits and — where the OS supports it — no network; see the
main README's *Data functions* section for every `CXD_FUNCTIONS_*` knob, and
`GET /api/functions/status` for what is in effect. It executes user-supplied
code: run `users` mode only inside a container / VM you trust.

To turn them on for a deployed demo (e.g. so the shipped Cohort Explorer's R
panel computes): install the interpreters' packages on the host (`pip install
pandas` for `CXD_FUNCTIONS_PYTHON`, `install.packages("jsonlite")` for R), add
`CXD_FUNCTIONS=users` to the server's `.env`, restart, and check
`GET /api/functions/status` — `languages` lists what can run and
`networkIsolation` the sandbox actually in effect (`none` means run it in a
container). `CXD_FUNCTIONS=admin` works too, but then only administrators see
functions computed; every other viewer gets the panel's error message.

`CXD_CANVASXPRESS_URL` points the served app at a (self-hosted) CanvasXpress
build; `CXD_CANVASXPRESS_LICENSE` is injected as `window.cX` before the library
loads to remove the watermark. `CXD_LLM_API_KEY` (for the future
natural-language builder) stays server-side — it is never sent to the browser;
the page only learns whether an LLM is configured (`GET /api/llm/status`).

The **first user to sign up is made an admin automatically**, so a fresh
deployment always has an administrator. Set `CXD_ADMINS` (comma-separated
usernames) to grant additional admins the built-in **user-management screen**
(create/list/delete users, reset passwords) at `/` and the `/api/admin/users`
API. Admin status is the persisted first-user flag OR the `CXD_ADMINS` config.

Advanced / embedding — build the app yourself and run under any ASGI server:

```bash
export SESSION_SECRET=$(python -c "import secrets;print(secrets.token_urlsafe(32))")
uvicorn cxd_server.app:create_dashboards_app --factory --reload
```

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/signup` · `/auth/login` · `/auth/logout` | Session auth (cookie) |
| `GET` | `/auth/me` | Current user (`{user, is_admin, permissions, groups, roles}`) |
| `GET` | `/api/directory` | Users and groups a dashboard or dataset can be shared with |
| `GET`·`POST` | `/api/dashboards/{id}/grants` | Owner: who it is shared with / share (`{principal, level}`, `level: null` revokes). Principals: `user:<name>`, `group:<name>`, `*` |
| `GET`·`POST` | `/api/datasets/{id}/grants` | Owner: the same for a dataset (`?store=`) |
| `GET`·`PUT` | `/api/datasets/{id}/policy` | Owner: row/column security `{policy: {rows: [{field, allow}], columns: [{hide, except}]}}` (`null` clears) |
| `GET` | `/api/lineage` | Dashboards the user can open → their data sources, and datasets/connectors → the dashboards that read them |
| `GET` | `/api/admin/governance` | Admin: permissions, roles, groups, role assignments, default role |
| `POST`·`DELETE` | `/api/admin/groups` · `/api/admin/groups/{name}` | Admin: create/update a group (`{name, description, members, role}`) / delete it |
| `POST`·`DELETE` | `/api/admin/roles` · `/api/admin/roles/{name}` | Admin: create/update a custom role (`{name, permissions}`) / delete it |
| `POST` | `/api/admin/roles/assign` | Admin: give `user:<name>` or `group:<name>` a role (`role: null` clears it) |
| `GET` | `/api/admin/lineage` | Admin: lineage across every user's dashboards |
| `GET` | `/api/schedules/status` | What scheduling can do here (`email`, `snapshots`, `origins`, …) |
| `GET`·`POST` | `/api/schedules` | Your schedules (`?all=1` admin) / create or update `{id?, kind, name, cron, tz, enabled, config}` |
| `DELETE` | `/api/schedules/{id}` | Delete a schedule |
| `POST` | `/api/schedules/{id}/run` | Run now |
| `GET` | `/api/schedules/{id}/runs` | Recent runs |
| `GET` | `/api/cron/preview` | Read a cron expression and list its next runs |
| `GET`·`PUT` | `/api/me/profile` | Your email address for alerts and subscriptions |
| `POST` | `/api/admin/users/{name}/email` | Admin: set a user's email address |
| `GET` | `/api/llm/status` | Whether the NL builder is configured (`{enabled, model}`; no key) |
| `GET` | `/api/admin/audit` | Admin: audit events, newest first (`actor`, `action` (a trailing `.` matches a prefix), `target`, `outcome`, `since`, `until`, `before`, `limit`) |
| `GET` | `/api/admin/audit/export` | Admin: the same filters as a CSV (default) or `format=jsonl` download |
| `GET` | `/api/admin/audit/verify` | Admin: re-check the hash chain → `{ok, checked, first_seq, last_seq, broken_at}` |
| `GET` | `/api/functions/status` | Data-function runtime: `{enabled, mode, languages, timeout, memoryMb, networkIsolation}` |
| `POST` | `/api/functions/run` | Run a data function (`{language, code, inputs, params, axis}` → `{data}`); needs `CXD_FUNCTIONS` |
| `GET`·`POST` | `/api/admin/users` | Admin: list / create users (needs `CXD_ADMINS`) |
| `POST` | `/api/admin/users/{u}/password` | Admin: reset a user's password |
| `DELETE` | `/api/admin/users/{u}` | Admin: delete a user + their dashboards |
| `GET` | `/api/dashboards` | List the user's dashboards (summaries) |
| `POST` | `/api/dashboards` | Create/update a spec (keyed by `spec.id`) |
| `GET` | `/api/dashboards/{id}` | Load one of the user's specs, an example, or one shared with them (`?owner=`); another owner's stored-dataset sources come back with `owner` set |
| `DELETE` | `/api/dashboards/{id}` | Delete |
| `POST` | `/api/dashboards/{id}/share` | Set visibility (`public` / `auth` / `private`); returns `share_token` + `share_url` |
| `GET` | `/api/shared/{token}` | Read-only spec for a share link (public: open; `auth`: any logged-in viewer) |
| `GET` | `/api/stores` | List configured named stores the user may target (`[{name, capability, default}]`, optional `?capability=`) — names only, never URIs/credentials |
| `GET` | `/api/datasets` | List the user's datasets across all stores (each tagged with its `store`) |
| `POST` | `/api/datasets` | Upload `{format:"csv"\|"json"\|"cx", data, title?, id?, store?}`; reshaped and stored; returns `{id, rows, cols, store, url}` |
| `GET` | `/api/datasets/{id}` | Fetch the CanvasXpress data object (owner-scoped; `?store=` selects a non-default store; `?owner=` another owner's dataset shared with the user, after its row/column security) |
| `DELETE` | `/api/datasets/{id}` | Delete (`?store=`) |

The bundled read-only viewer is served at `/shared.html?token=…`.

**Datasets & pluggable storage.** Uploaded datasets are reshaped
once into a CanvasXpress data object and persisted in a pluggable `ObjectStore`,
selected by URI scheme. Backends: **`file://`** (local, default, zero-dep),
**`s3://`** (S3 / S3-compatible MinIO·R2·GCS-interop; `[s3]` extra; `url_for`
hands panels a short-lived presigned GET URL), and **`postgresql://` / `sqlite://`**
(SQL via SQLAlchemy; `[sql]` extra + a driver such as `psycopg2-binary`; one row
per `(owner, id)`, optional `?table=` so datasets and dashboards can share a
database), and **`gdrive://folderId`** (Google Drive; `[gdrive]` extra; each
owner's objects in their own `cxd-<owner>` folder; `url_for` = Drive
`webViewLink`; OAuth reuses `canvasxpress-connectors` — connect a Google account
once with the `drive.file` scope and the store mints per-owner credentials from
its `TokenStore`). Panels bind by id —
`{"kind":"dataset","id":"sales-2026","store?":"s3-prod"}` — so specs stay path-
and credential-free and resolve with the viewer's own permissions.

**Dashboards on Postgres.** The dashboard store (users + specs +
share tokens) is relational, so it upgrades SQLite→Postgres via the *same*
SQLAlchemy code path: set `CXD_DASHBOARD_STORE=postgresql://…` (or `sqlite://…`)
to run dashboards on Postgres; unset (or a bare path / `file://`) keeps the
zero-dependency stdlib SQLite store. The older `postgres://` spelling is accepted
too — it is normalized to `postgresql://`, since SQLAlchemy dropped that dialect
alias in 1.4. A parametrized suite runs both backends
through identical asserts, proving parity.

**Config & the store picker.** The browser only ever names a
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

The SQL stores run against SQLite in CI. Before a durable Postgres cutover, prove
the identical code path on a real Postgres by pointing the suite at one — the
`pg` backend then joins the object-store and dashboard-store conformance tests
(unset, it's simply absent, never red):

```bash
pip install -e '.[dev,web,postgres]'
CXD_TEST_PG_URL=postgresql://user:pass@localhost:5432/cxd_test \
    pytest -q tests/test_objectstore.py tests/test_store.py
```

## License

MIT © Isaac Neuhaus
