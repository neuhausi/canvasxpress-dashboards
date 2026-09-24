# Governance: audit log, roles, sharing, row/column security, lineage

The dashboards server (`cxd_server`) controls who can do what and who sees which
data, and records what happened. This guide covers:

1. [Audit log](#audit-log): who did what, tamper-evident
2. [Roles and permissions](#roles-and-permissions): what each user may do
3. [Groups](#groups)
4. [Sharing with people and groups](#sharing-with-people-and-groups)
5. [Row- and column-level security](#row--and-column-level-security): who sees which rows and columns
6. [Lineage](#lineage): which dashboards read which data
7. [API reference](#api-reference), [client methods](#client-methods), [configuration](#configuration)

Everything lives next to the dashboards: in the same SQLite file by default, or
in the same database when `CXD_DASHBOARD_STORE` points at Postgres. It needs no
extra service or dependency.

**Principals.** Rules name who they apply to with a *principal*:

| Principal | Means |
|---|---|
| `user:<name>` | One user |
| `group:<name>` | Every member of a group |
| `*` | Everyone signed in |
| `anonymous` | A share-link viewer who is not signed in (security rules only) |

A signed-in viewer holds their user, each of their groups, and `*`.

---

## Audit log

Every action that matters is recorded:

- **Sign-ins:** sign-up, sign-in (including failed attempts, with the username
  tried) and sign-out.
- **Dashboards:** save, open, lock, delete and share.
- **Share links:** each time one is opened.
- **Datasets:** upload, read, delete and lock.
- **Other activity:** data-function runs, AI-builder calls, sharing and security
  changes, admin actions, and reads of the audit log itself.

Each event holds the time (UTC), the user, the action, the target, its owner,
the outcome and the client IP, plus a few non-sensitive details. The outcome is
`ok`, `denied` (401/403) or `error`.

**Never stored:** passwords, dashboard specs, data, and data-function code. A
function run is identified by a hash of its code. A share-link token is cut to
a short prefix.

**Tamper evidence.** Events are append-only, and each carries a SHA-256 hash of
its content and of the event before it. **Verify chain** recomputes the chain
and names the first event that was edited or deleted. It sees changes made
directly in the database too.

**Where.** Admin → *Audit log*: filter by user, action or outcome, page back
through older events, verify the chain, export CSV. The API offers the same
(below), plus JSON lines.

**Settings.** `CXD_AUDIT=off` turns recording off. `CXD_AUDIT_RETENTION_DAYS=N`
deletes events older than N days at start-up; the rest of the chain still
verifies. A failed write is reported on the server's stderr and never fails the
user's request.

---

## Roles and permissions

A **role** is a named set of permissions:

| Permission | Allows |
|---|---|
| `dashboard.create` | Create dashboards and edit their own |
| `dataset.create` | Upload datasets |
| `share.grant` | Share dashboards and datasets with users and groups |
| `share.public` | Publish share links |
| `function.run` | Run R/Python data functions (when the server enables them, `CXD_FUNCTIONS`) |
| `llm.use` | Use the AI dashboard builder |
| `schedule.create` | Schedule dataset refreshes, alerts and emailed dashboards ([scheduling](scheduling.md)) |
| `dashboard.sign` | Electronically sign dashboard versions ([records and signatures](compliance.md)) |

Built-in roles:

- **`viewer`** has no permissions. It opens what others share with it and
  creates nothing.
- **`editor`** has every permission.

Admins create more roles in Admin → *Roles*, for example an `analyst` role that
builds and shares but may not upload data.

**Who gets which role.** A role is given to a user (the role picker on each row
in Admin → *Users*) or to a group. A user holds every permission of their own
role and of their groups' roles. A user with no role, directly or through a
group, gets the **default role**, `CXD_DEFAULT_ROLE` (default `editor`).

The default is what makes the feature optional: a server where nobody assigns a
role behaves exactly as before. To lock a server down, set
`CXD_DEFAULT_ROLE=viewer` and grant `editor` to the people who build.

**Admins** (`CXD_ADMINS`, or the first user to sign up) always have every
permission, plus the Admin view.

The server enforces each permission on its endpoint, returning 403 with a
message that names what is missing. The app also hides the sharing buttons
(People, Share link) that a user's role does not allow.

---

## Groups

Admin → *Groups* creates a group with a name, a description, members and
(optionally) a role. Groups are used in three places:

- **Roles:** every member gets the group's role.
- **Sharing:** share a dashboard or dataset with the whole group at once.
- **Security rules:** "site A clinicians see site A rows".

Deleting a group removes its role and every share made to it. Deleting a user
removes their memberships, their role and the shares made to them.

---

## Sharing with people and groups

The owner of a dashboard shares it from **Dashboards → People**. Each share has
a principal (a user, a group, or everyone signed in) and a level:

- **Can view:** the dashboard appears in the person's Dashboards list, marked
  "from ⟨owner⟩ · view only". They can open and preview it. Opening it in the
  builder and saving creates **their own copy**.
- **Can edit:** as above, but Save writes back to **the owner's** dashboard,
  keeping its id, unless an admin has locked it.

**Data comes along, under its rules.** A shared dashboard reads the owner's
stored datasets. When someone other than the owner opens it, each
`kind: "dataset"` source comes back with `owner` set:

```json
{ "kind": "dataset", "id": "trial", "owner": "alice" }
```

The browser then fetches `GET /api/datasets/trial?owner=alice`. The server
checks access on every read: the viewer must be the owner, an admin, or have the
dataset shared with them directly or through a dashboard that reads it. The
dataset's security rules then apply. The pin is removed again when the owner's
dashboard is saved.

**Datasets** are shared on their own from **Data → 👥**, view only. They appear
in the person's Data list, marked "from ⟨owner⟩".

**Share links** (Dashboards → *Share link*) are separate: an unguessable URL
that anyone can open (`public`) or anyone signed in can open (`auth`). They
need the `share.public` permission. Security rules apply to them too (below).

Only the owner or an admin manages a resource's shares. Deleting a dashboard or
dataset removes its shares and its security rules.

---

## Row- and column-level security

A dataset's owner can restrict what everyone else receives from it:
**Data → 🔒**. The rules apply to every viewer except the owner and admins,
wherever the server hands out the dataset:

- in the app (Data view, the builder, dashboards),
- through a dashboard shared with the viewer,
- on share links, where a viewer who is not signed in is `anonymous`.

### Row rules

*Show only the rows whose ⟨column⟩ value is allowed for the viewer.* Each rule
lists, per principal, the values that principal may see, or `*` for all
values:

```json
{
  "rows": [
    { "field": "site",
      "allow": { "group:site-a": ["A"],
                 "group:site-b": ["B"],
                 "user:lead": "*" } }
  ]
}
```

- A viewer sees the union of the values allowed to any principal they hold. A
  member of both site groups sees A and B; `lead` sees every site.
- **Fails closed.** A viewer that no principal in a rule matches gets **no
  rows**, and so does a rule whose column is missing from the data. To give
  everyone signed in some rows, add `"*": [...]`; for share-link viewers, add
  `"anonymous": [...]`.
- With several row rules, a row must pass all of them.

### Column rules

*Hide these columns, except from these principals:*

```json
{
  "columns": [
    { "hide": ["patient_name", "date_of_birth"], "except": ["group:clinicians"] }
  ]
}
```

The hidden columns are simply absent from what the viewer receives, as if the
dataset never had them.

### What counts as a row and a column

| Dataset shape | Rows | Columns |
|---|---|---|
| Table (CSV / JSON-rows uploads: a header row plus records) | Records | Header columns |
| CanvasXpress object `{y: {vars, smps, data}, x, z}` | Samples (`smps`); row rules test sample annotations (`x`) | Variables (`y.vars`) and annotations (`x`, `z`) |

A policy with row rules on any other shape (for example network data) withholds
the dataset entirely, because it cannot be filtered.

### Limits

The rules protect **stored datasets**, the `kind: "dataset"` sources the server
hands out. They do not cover:

- **Inline data**, written into a spec: it travels with the spec. Keep sensitive
  data in a stored dataset.
- **Database connectors** (`kind: "connector"`): they run on each user's own
  database credentials, so the database's own permissions apply.
- **Joins and data functions**: these combine data *in the browser* from sources
  the viewer already received. They therefore only ever see rows and columns the
  rules let through.

### Example

A trial dataset with 30 patients across sites A, B and C, and these groups:

- `site-a`: ann and bea
- `clinicians`: bea

The rules:

```json
{
  "rows":    [{ "field": "site", "allow": { "group:site-a": ["A"], "user:lead": "*" } }],
  "columns": [{ "hide": ["name"], "except": ["group:clinicians"] }]
}
```

| Viewer | Receives |
|---|---|
| owner, admins | All 30 rows, all columns |
| ann (site-a) | 10 site-A rows, without `name` |
| bea (site-a, clinicians) | 10 site-A rows, with `name` |
| lead | All 30 rows, without `name` |
| anyone else signed in | Column headers only, no rows |
| a share-link viewer who is not signed in | Column headers only, no rows |

---

## Lineage

Lineage answers "what feeds this dashboard?" and "what breaks if this dataset
changes?". It is read from the specs:

- **Per dashboard:** each data source with its kind (stored dataset, connector,
  join, data function, inline), what it reads, and which panels use it.
- **Per stored dataset and per connector:** every dashboard that reads it.

Users get it for the dashboards they can open (`GET /api/lineage`). Admins get
it across everyone's dashboards (`GET /api/admin/lineage`, and Admin →
*Lineage*).

---

## API reference

All endpoints use the session cookie. "Owner" means the owner of that dashboard
or dataset, or an admin, who passes `?owner=<name>`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET` | `/auth/me` | anyone | `{user, is_admin, permissions, groups, roles}` |
| `GET` | `/api/directory` | signed in | `{users, groups}` to share with |
| `GET` | `/api/dashboards` | signed in | Own dashboards, examples, and those shared with the user (`shared`, `owner`, `access`, `readOnly`) |
| `GET` | `/api/dashboards/{id}?owner=` | signed in | A dashboard; another owner's needs a share (404 otherwise) |
| `POST` | `/api/dashboards?owner=` | signed in | Save; to another owner needs an `edit` share (403 if locked) |
| `GET`·`POST` | `/api/dashboards/{id}/grants` | owner | List / set a share: `{principal, level: "view"\|"edit"\|null}` |
| `GET` | `/api/datasets/{id}?store=&owner=` | signed in | A dataset, after its security rules |
| `GET`·`POST` | `/api/datasets/{id}/grants?store=` | owner | List / set a share (`view`) |
| `GET`·`PUT` | `/api/datasets/{id}/policy?store=` | owner | Read / set the security rules: `{policy: {rows, columns}}`, `null` clears |
| `GET` | `/api/lineage` | signed in | Lineage of the dashboards the user can open |
| `GET` | `/api/admin/governance` | admin | Permissions, roles, groups, role assignments, default role |
| `POST` | `/api/admin/groups` | admin | Create/update `{name, description, members, role}` (`members` replaces the list) |
| `DELETE` | `/api/admin/groups/{name}` | admin | Delete a group |
| `POST` | `/api/admin/roles` | admin | Create/update a custom role `{name, description, permissions}` |
| `DELETE` | `/api/admin/roles/{name}` | admin | Delete a custom role (its assignments go too) |
| `POST` | `/api/admin/roles/assign` | admin | `{principal: "user:…"\|"group:…", role}` (`null` clears) |
| `GET` | `/api/admin/lineage` | admin | Lineage across every user |
| `GET` | `/api/admin/audit` | admin | Events, newest first: `actor`, `action` (a trailing `.` matches a prefix, e.g. `dashboard.`), `target`, `outcome`, `since`, `until`, `before`, `limit` → `{events, next, enabled, actions}` |
| `GET` | `/api/admin/audit/export` | admin | The same filters as CSV, or JSON lines with `format=jsonl` |
| `GET` | `/api/admin/audit/verify` | admin | `{ok, checked, first_seq, last_seq, broken_at}` |

Audit actions recorded for governance: `dashboard.grant`, `dataset.grant`,
`dataset.policy`, `admin.group.save`, `admin.group.delete`, `admin.role.save`,
`admin.role.delete`, `admin.role.assign` and `admin.lineage`.

## Client methods

`createDashboardClient` (in this package) wraps the endpoints:

```js
import { createDashboardClient } from 'canvasxpress-dashboards';
const client = createDashboardClient({ baseUrl: '' });

// sharing
await client.directory();                                        // { users, groups }
await client.setGrant('dashboard', 'trial-dash', 'group:site-a', 'view');
await client.setGrant('dataset', 'trial', 'user:lead', 'view', { store: 'local' });
await client.grants('dashboard', 'trial-dash');                  // [{ principal, level }]
await client.setGrant('dashboard', 'trial-dash', 'group:site-a', null);   // revoke

// dashboards shared with me
const rows = await client.list();                                // shared ones: { shared, owner, access }
const spec = await client.load('trial-dash', { owner: 'alice' });
await client.save(spec, { owner: 'alice' });                     // needs an edit share
await client.getDataset('trial', { owner: 'alice' });

// row/column security
await client.setPolicy('trial', {
  rows: [{ field: 'site', allow: { 'group:site-a': ['A'] } }],
  columns: [{ hide: ['name'], except: ['group:clinicians'] }]
});
await client.getPolicy('trial');
await client.setPolicy('trial', null);                           // remove all rules

// lineage
await client.lineage();                                          // mine
await client.lineage({ all: true });                             // admin: everyone's

// admin
await client.governance();
await client.saveRole({ name: 'analyst', permissions: ['dashboard.create', 'share.grant'] });
await client.saveGroup({ name: 'site-a', members: ['ann', 'bea'], role: 'viewer' });
await client.assignRole('user:lead', 'analyst');
await client.deleteGroup('site-a');
await client.deleteRole('analyst');
await client.auditLog({ action: 'dashboard.', outcome: 'denied' });
client.auditExportUrl({ actor: 'ann' }, 'csv');                  // download URL
await client.auditVerify();
```

The builder saves a dashboard shared for editing back to its owner when it is
created with `createBuilder(host, { spec, client, owner: 'alice' })`. The owner
applies only to that dashboard; a spec that replaces it (from chat or import)
saves as the user's own.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `CXD_DEFAULT_ROLE` | `editor` | Role of users with no role assigned to them or their groups |
| `CXD_ADMINS` | (none) | Comma-separated admin usernames (the first user to sign up is also an admin) |
| `CXD_AUDIT` | `on` | `off` stops recording |
| `CXD_AUDIT_RETENTION_DAYS` | (keep all) | Delete events older than N days at start-up |

The tables are created on first start:

- `cxd_audit` for the audit log.
- `cxd_groups`, `cxd_group_members`, `cxd_roles`, `cxd_role_assignments`,
  `cxd_grants` and `cxd_policies` for governance.

They live in the dashboards database: the `APP_DB_PATH` SQLite file, or the
`CXD_DASHBOARD_STORE` Postgres database. Back them up with it.
