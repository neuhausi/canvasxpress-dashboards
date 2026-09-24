# Changelog

Notable changes to `canvasxpress-dashboards` (the npm package) and its server
(`cxd_server`). Versions follow the package version.

## Unreleased

Server features, live on the demo; the client additions ship in the next npm
release.

### Running several servers ([docs/deployment.md](docs/deployment.md))
- `GET /healthz` (liveness) and `GET /readyz` (readiness: stores, governance,
  schedules, audit log, datasets, scheduler thread; `503` names the failure).
- Verified on Postgres: two servers sharing one database and `SESSION_SECRET`
  share sessions and data, keep one audit chain, and run a due schedule exactly
  once (`tests/test_postgres.py`, run in CI against the Postgres service).
- A guide for several processes and hosts: requirements, the scheduler, health
  checks, rolling upgrades, backups.

### Single sign-on ([docs/sso.md](docs/sso.md))
- **OpenID Connect sign-in** (authorization code + PKCE) with ID tokens verified
  against the provider's keys (signature, iss, aud, exp, nonce; no `none` / HMAC).
  Needs the `sso` extra (PyJWT).
- **Accounts:** created on first sign-in and linked by `sub`. A same-named local
  account is never taken over (`CXD_OIDC_LINK_EXISTING` to allow), and a linked
  account cannot use a password.
- **From the provider:** groups sync into dashboards groups (marked SSO; hand-made
  groups are never emptied); admin rights follow `CXD_OIDC_ADMIN_GROUPS`; a
  verified email becomes the confirmed notification address; `CXD_OIDC_ALLOWED_DOMAINS`.
- **`CXD_OIDC_ONLY`** hides passwords and sign-up, keeping break-glass password
  sign-in for `CXD_ADMINS`.
- **Sign-out** ends the provider session. `/auth/config` tells the login page
  what to show. Sign-ins are audited as `auth.sso`.
- The login page's secondary buttons are readable again.

### Large data ([docs/large-data.md](docs/large-data.md))
- **Pushdown on connector sources.** A `kind:"connector"` source's `pushdown` block
  (groupBy, measures, where, columns, orderBy, limit) is sent as `_q`, and the
  connector (canvasxpress-connectors 0.6+) aggregates, filters and limits in the
  database. `$param` filter values re-query when a param control changes; an unset
  one drops its filter.
- **Filters on demand.** A Filters panel over a pushdown source sends value lists
  and ranges to the database and re-queries (text search stays in the browser).
  Its value lists come from the unfiltered answer; per-value counts are hidden.
- **Joins in the database.** A `kind:"join"` with `pushdown` (`true`, or a query
  over the joined rows) of two connector sources on one database runs as one SQL
  join via `/api/join`, named like the browser join. Otherwise it falls back to
  the browser join.
- `pushdownQuery()` is exported. The schema and both validators know `pushdown`,
  and their messages match.

### Scheduling ([docs/scheduling.md](docs/scheduling.md))
- **Refresh** a stored dataset on a schedule from a URL (CSV/JSON; private
  addresses refused) or a database source (a host-registered fetcher; the demo
  wires canvasxpress-connectors). Title, config and lock are kept.
- **Alerts** on a dataset value (mean/sum/min/max of a column or a row count, an
  optional `where`, a comparison and a threshold).
  - Evaluated per recipient on their row/column-secured view.
  - Edge-triggered: emailed when the condition becomes true.
  - Also checked right after the dataset refreshes.
- **Subscriptions** email a dashboard: a link plus a PNG snapshot rendered as
  each recipient (Playwright, optional), and link only otherwise. Only
  recipients who can open the dashboard get it.
- **When:** cron with a time zone, including daylight saving.
- **Runner:** a background runner (`CXD_SCHEDULER`, `CXD_SCHEDULER_TICK`) that
  claims due jobs atomically, so several processes never run one twice.
- **Run history:** Run now, and the last 50 runs per schedule.
- **Email:** SMTP (`CXD_SMTP_*`, or `CXD_SMTP_PASSWORD_FILE`); addresses live on user
  profiles (`/api/me/profile`).
  - A new address must be **confirmed** through an emailed link before anything
    else is sent to it (`CXD_EMAIL_VERIFY`; admin-set addresses are trusted).
  - Each person gets at most `CXD_EMAIL_DAILY_CAP` (default 50) emails a day, so
    an open-sign-up server cannot be used to flood an inbox.
- **Permission:** new `schedule.create`, held by the `editor` role.
- **Audit:** schedule changes and runs are audited.
- **UI:** a Schedules view with presets and a next-run preview, a Subscribe
  action on dashboards, ⏱ on datasets, and email addresses in Admin.
- **Links:** `view.html` accepts `?owner=`, so emailed links open a shared
  dashboard.

### Governance ([docs/governance.md](docs/governance.md))
- **Roles and permissions.** Permissions: create dashboards, upload datasets,
  share with people, publish share links, run data functions, use the AI builder
  (and `schedule.create`, below).
  - `viewer` and `editor` are built in; admins create custom roles.
  - Roles are given to users or groups, and a user holds every permission of
    their own and their groups' roles.
  - `CXD_DEFAULT_ROLE` (default `editor`) applies to everyone else, so nothing
    changes until roles are assigned.
- **Groups**, managed in Admin → *Groups*.
- **Sharing with people and groups.** Share a dashboard with a user, a group or
  everyone signed in, to view or to edit.
  - Shared dashboards appear in the recipient's list and read the owner's
    stored datasets. An edit share saves back to the owner.
  - Datasets can be shared on their own.
  - New: `GET /api/dashboards/{id}?owner=`, `POST /api/dashboards?owner=` and
    `/api/{dashboards,datasets}/{id}/grants`. A `kind:"dataset"` source may
    carry `owner`.
- **Row- and column-level security** per dataset (`/api/datasets/{id}/policy`).
  - Row rules keep the rows allowed for the viewer's user or groups; column
    rules hide columns except from named principals.
  - Applied on every dataset read and on share links (as `anonymous` when not
    signed in). Fails closed.
- **Lineage**: which dashboards read which datasets and connectors
  (`/api/lineage`, `/api/admin/lineage`).
- **UI:**
  - Dashboards → *People* and Data → 👥 for sharing, Data → 🔒 for security.
  - Admin → *Roles*, *Groups* and *Lineage*, and a role picker per user.
  - The builder's `owner` option saves an edit-shared dashboard back to its
    owner.
- **Client:** `directory`, `grants`, `setGrant`, `getPolicy`, `setPolicy`,
  `lineage`, `governance`, `saveGroup`, `deleteGroup`, `saveRole`,
  `deleteRole`, `assignRole`; `load`/`save`/`getDataset` accept `{owner}`.

### Audit log
- Records who did what:
  - sign-ins, including failed ones;
  - dashboard and dataset changes, shares and share-link views;
  - data-function runs and AI-builder calls;
  - admin and governance actions, and reads of the log itself.
- Events are append-only and **hash-chained**; `GET /api/admin/audit/verify`
  detects an edited or deleted entry.
- Filter, page and export (CSV, JSON lines) from Admin → *Audit log* or
  `/api/admin/audit`.
- Never stores passwords, specs, data or code.
- `CXD_AUDIT=off` disables it; `CXD_AUDIT_RETENTION_DAYS` prunes old events.
- Client: `auditLog`, `auditExportUrl`, `auditVerify`.

### Other
- The Home page has cards for blending and linking, R/Python functions,
  governance, the audit log and scheduling.
- Fixed: `DashboardStore.create_user` left its transaction open after a
  duplicate username, locking the database for other writers.

## 0.10.0 — 2026-09-24

Dashboards can combine and relate several sources.

- **Joins.** `kind:"join"` blends two sources on a key: inner, left, right or
  outer, with composite keys, over sample- or variable-oriented tables. It
  recomputes live when an input is re-queried or refreshed.
- **Relationships.** `spec.relationships` links sources without blending them.
  Selecting rows in one chart marks the related rows in the others, and filter
  controls narrow related panels.
- **Filters panel.** `type:"filters"` gives checkbox lists with counts, ranges
  and search. Named filter schemes are stored in `spec.filterSchemes`, and
  `handle.getFilterState`/`setFilterState` read and restore the state.
- **Data functions.** `kind:"function"` runs an R or Python snippet over other
  sources. There is a documented runtime contract, and the server ships an
  opt-in sandboxed runtime (`CXD_FUNCTIONS=admin|users`).
- **Versioned specs.** Specs carry `schemaVersion` (`1.1`) and migrate on load.
  `serializeSpec`, `dashboardDiff` and the `cxd-spec` CLI (validate, migrate,
  format, diff) support keeping dashboards in git.
- **Table data, one point per row.** Scatter, Kaplan–Meier and Pie panels over
  table data transpose automatically; `panel.transpose` overrides it.
- **Fixed:** saving an unedited dashboard from the builder rewrote it; saves now
  contain only real edits (`npm run test:roundtrip`).
- **New example:** Cohort Explorer.
- The `canvasxpress` peer range is now `>=66.2.0`.
