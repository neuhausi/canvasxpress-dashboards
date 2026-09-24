# Changelog

Notable changes to `canvasxpress-dashboards` (the npm package) and its server
(`cxd_server`). Versions follow the package version.

## Unreleased

Server features, live on the demo; the client additions ship in the next npm
release.

### Governance ([docs/governance.md](docs/governance.md))
- **Roles and permissions.** Six permissions: create dashboards, upload datasets,
  share with people, publish share links, run data functions, use the AI
  builder.
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
  governance and the audit log.
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
