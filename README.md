# canvasxpress-dashboards

[![tests](https://github.com/neuhausi/canvasxpress-dashboards/actions/workflows/tests.yml/badge.svg)](https://github.com/neuhausi/canvasxpress-dashboards/actions/workflows/tests.yml)

Compose, coordinate, and render **dashboards** — collections of linked
[CanvasXpress](https://www.canvasxpress.org) visualizations — from a single
declarative JSON spec.

CanvasXpress already ships the hard part: cross-chart coordination (a selection
or filter in one chart propagates to the others via its `broadcast` mechanism).
This package adds the missing layer: a **spec**, a **grid layout**, a
**renderer**, data binding, persistence, and a no-code builder. It does **not**
re-implement chart rendering or coordination.

**Guides:** [governance and audit](docs/governance.md) (roles, sharing, row/column
security, lineage, audit log) · [scheduling](docs/scheduling.md) (refresh, alerts,
emailed dashboards) · [large data](docs/large-data.md) (aggregate, filter and join in the
database) · [live-data controls](docs/live-data-controls.md) ·
[server](server/README.md) · [changelog](CHANGELOG.md)

---

## Install

```bash
npm install canvasxpress-dashboards canvasxpress
```

CanvasXpress is a **peer dependency** — load it however you already do (npm, CDN,
or a `<script>` tag).

### ESM

```js
import { renderDashboard } from 'canvasxpress-dashboards';
import spec from './sales-overview.spec.json' assert { type: 'json' };

await renderDashboard(spec, document.getElementById('dashboard'));
```

### `<script>` drop-in (UMD)

```html
<link href="https://www.canvasxpress.org/dist/canvasXpress.css" rel="stylesheet" />
<script src="https://www.canvasxpress.org/dist/canvasXpress.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/canvasxpress-dashboards/dist/canvasxpress-dashboards.umd.js"></script>

<div id="dashboard"></div>
<script>
  fetch('sales-overview.spec.json')
    .then(function (r) { return r.json(); })
    .then(function (spec) { return CanvasXpressDashboards.renderDashboard(spec, 'dashboard'); });
</script>
```

Open [`examples/sales-overview.html`](examples/sales-overview.html) for a complete,
backend-free showcase: three linked panels (Bar, Pie, Line) plus a broadcast-aware
data table. Click a bar, slice, or row — the selection coordinates across the board.

---

## Run the full app on your premises

The library above is embeddable. If you want the **complete, self-hostable
application** — a sign-in screen, the no-code Builder, saved dashboards, dataset
uploads, and share links — run the bundled server. It serves the whole app at
`/`, so users just open a browser.

**Docker (recommended):**

```bash
docker compose up            # → http://localhost:8000/
```

**Or directly with Python:**

```bash
cd server && pip install -e '.[web]'
python -m cxd_server         # → http://localhost:8000/
```

Then open the app, create an account (or click **Use demo account**), and start
building. On first run the server generates and persists its own session secret —
no key management required.

**Point it at your own resources.** The entire deployment is environment-driven:
copy [`server/.env.example`](server/.env.example) and change values to swap the
dashboard store (SQLite → Postgres), the dataset store (local files → S3 /
Google Drive / SQL), sharing base URL, HTTPS, and signup policy. Nothing in the
app code changes — you reconfigure, not fork.

For example, run the whole stack on **Postgres** (both the dashboard store and
the dataset store) with the bundled override file:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up
```

(The host port is overridable — `CXD_HOST_PORT=8080 docker compose up`.)

See [`server/README.md`](server/README.md) for the full env-var reference and API.

---

## The dashboard spec

A single JSON document describes panels, layout, and data bindings. `config` is
passed **straight to `new CanvasXpress`**, so the full library is available with
no wrapper API.

```jsonc
{
  "id": "sales-overview",
  "broadcastGroup": "sales-overview",   // isolate this dashboard's coordination
  "layout": {                            // responsive 12-col grid
    "cols": 12,
    "rowHeight": 130,
    "items": [
      { "panel": "revenue-bar", "x": 0, "y": 0, "w": 6, "h": 3 },
      { "panel": "region-pie",  "x": 6, "y": 0, "w": 6, "h": 3 }
    ]
  },
  "data": {
    "sales": { "kind": "inline", "value": { "y": { "vars": [], "smps": [], "data": [] } } }
  },
  "panels": {
    "revenue-bar": { "title": "Revenue", "dataRef": "sales", "config": { "graphType": "Bar" } },
    "region-pie":  { "title": "By Region", "dataRef": "sales", "config": { "graphType": "Pie" } }
  },
  "controls": [
    { "kind": "table", "dataRef": "sales" }
  ]
}
```

- **`dataRef`** decouples panels from sources — panels sharing a ref share one
  fetch and one broadcast domain.
- **`broadcastGroup`** defaults to the dashboard `id`, so two dashboards on a page
  don't cross-talk; panels within a dashboard coordinate automatically.
- **`broadcast: false`** on a panel opts it out of coordination.
- **Annotation-filter controls**: a panel with `"type": "control"` renders a
  compact widget (dropdown / radio / segmented buttons) listing the unique
  values of **one** annotation of its dataset (`"compartment": "x"` for sample
  annotations, `"z"` for variable annotations; `"annotation"` names it).
  Choosing a value calls `modifyFilter('guess', annotation, 'like', value)`
  serially on every CanvasXpress instance in the dashboard, filtering each
  panel to the matching samples/variables; "All" clears (`resetDataFilter`). Like text
  elements, control panels float free on the grid and may overlap any panel.

  ```jsonc
  "panels": {
    "tissue-filter": { "type": "control", "title": "Tissue", "dataRef": "sales",
      "compartment": "x", "annotation": "Tissue", "style": "auto" }
  }
  ```
- **Image elements**: a panel with `"type": "image"` shows a picture (an external
  URL or an embedded `data:` URI) instead of a graph — for a logo, a legend, a
  screenshot, an annotation. It **resizes with its cell** (drag the cell's resize
  handle, like any panel) and scales via `fit` (CSS object-fit: `contain` |
  `cover` | `fill` | `none` | `scale-down`); `align`/`valign` pin a `cover`/`none`
  image, and an optional `href` makes it a link. In the builder, **+ Image** adds
  one and the props toolbar takes a URL or an **Upload** (which embeds the file as
  a `data:` URI so the dashboard stays self-contained). An empty `src` renders a
  placeholder.

  ```jsonc
  "panels": {
    "logo": { "type": "image", "src": "https://example.com/logo.png",
      "fit": "contain", "alt": "Company logo", "href": "https://example.com" }
  }
  ```
- **Live-data controls**: a control with `"mode": "param"` *re-queries a data
  source* and refreshes the bound panels, instead of filtering what's already on
  the page — the control writes a dashboard **parameter** (`spec.params`) that a
  source's `query` reads via a `"$name"` token. Also covers search-box params,
  chart-click cross-filter, and self-contained snapshot export. See the guide:
  [`docs/live-data-controls.md`](docs/live-data-controls.md).

  ```jsonc
  "params": { "region": { "value": null } },
  "data":   { "sales": { "kind": "connector", "url": "/api/data?source=sales",
                          "query": { "region": "$region" } } },
  "panels": {
    "pick": { "type": "control", "mode": "param", "param": "region",
              "options": ["EMEA", "APAC", "AMER"] }
  }
  ```
- **Config controls**: a control with `"mode": "config"` drives a **target
  panel's live config** via `updateConfig` — instead of filtering data or
  re-querying, each option carries a `config` fragment that is applied to the
  target when chosen. Styles include a new `"slider"` (an ordered range over the
  options) alongside `buttons`/`dropdown`. Several config controls can target the
  same panel and their current fragments merge, so independent controls compose
  (e.g. an expiry slider + an IV/Premium metric toggle over one chart — see the
  `options-wall` example). The initial UI position comes from `value` and is not
  applied on load (the target already carries the matching config from the spec).

  ```jsonc
  "panels": {
    "wall":   { "dataRef": "prices", "config": { "graphType": "OptionsWall" } },
    "expiry": { "type": "control", "mode": "config", "target": "wall",
                "style": "slider", "value": "2026-09-04",
                "options": [
                  { "label": "Sep 4",  "value": "2026-09-04",
                    "config": { "optionsWallExpiry": "2026-09-04", "optionsWallChain": {} } },
                  { "label": "Sep 11", "value": "2026-09-11",
                    "config": { "optionsWallExpiry": "2026-09-11", "optionsWallChain": {} } }
                ] }
  }
  ```
- The spec is **forward-compatible**: unknown fields are ignored; `version` gates
  migrations.

The canonical contract is [`schema/dashboard.schema.json`](schema/dashboard.schema.json)
(JSON Schema, for validation + editor autocomplete). `validateSpec(spec)` is the
runtime guard.

---

## Table data: one point per row

Uploads, connectors and joins arrive as tables: one row per record, one column
per field. CanvasXpress's scatter-type charts plot one mark per *variable*, with
samples as the axes. So, left alone, a Scatter2D of `age` against `response` over
a patient table would plot each column instead of each patient.

The renderer handles this: a **Scatter2D, Scatter3D, ScatterBubble2D,
KaplanMeier or Pie** panel whose `xAxis` / `yAxis` name only columns of the data
(and no row) gets the data transposed first. That gives one point, curve entry
or slice per row. So does a Pie with no axis named over a single column of
several rows, which would otherwise be one 100% slice. Set `"transpose": true`
or `false` on a panel to decide yourself:

```jsonc
"pdl1": { "dataRef": "cohort",
          "config": { "graphType": "Scatter2D", "xAxis": ["CD274"], "yAxis": ["os_months"], "colorBy": "arm" } }
// -> one point per patient, no transpose needed in the spec
```

## Data blending (joins)

A `kind: "join"` source combines two other sources — inline, connector, dataset,
or another join — into one CanvasXpress data object, so a panel can plot
columns from both. Each input is read as a table with one row per sample
(`y.smps`), whose columns are the numeric variables and the `x` annotations.

```jsonc
"data": {
  "expr":   { "kind": "dataset", "id": "expression" },
  "clin":   { "kind": "connector", "url": "/api/data?source=clinical" },
  "cohort": {
    "kind": "join",
    "left": "expr", "right": "clin",
    "on": { "left": "smps", "right": "patient_id" },  // default "smps" (the sample ids)
    "how": "left",                                    // inner (default) | left | right | outer
    "suffix": ".clin"                                 // clashing right names; default ".<right ref>"
  }
}
```

- **`on`** — `"smps"` is the sample id; any other string names a variable or
  annotation on both sides; `{left, right}` maps differently named columns; an
  array of those is a composite key. Keys compare as strings, and a missing key
  never matches (as in SQL / R `merge()`).
- **Output** — left columns first, then right. A key column with the same name
  on both sides appears once. A one-to-many match emits one row per pair; the
  repeated sample ids are made unique as `<left id>|<right id>`.
- **Live** — a join re-computes when an input changes: a `param` that re-queries
  an input, or an input's `refresh` poll, live-updates the panels bound to the
  join. A join shares its inputs' fetches with the panels bound to them.
- The blend runs in the browser on the already-fetched inputs; `joinData(left,
  right, options)` is exported for direct use, with `matchIds` /
  `joinProvenance` for mapping row ids between related data objects.

### Row axis

Sources are read as tables along a row **axis**. `"smps"` (default) means one row
per sample — how connectors and CSV uploads arrive. `"vars"` means one row per
variable: the scatter orientation, where genes or cells are the points and the
samples are `logFC` / `UMAP1`… Set `"axis": "vars"` on such a source; its
row-id key is then `"vars"`. A join's sides default to their sources' axes (or
set `axis` / `leftAxis` / `rightAxis`), and its output follows the left side.

## Cross-source marking and filtering (relationships)

Panels bound to the same source already link through CanvasXpress's own
selection broadcast. To link panels on *different* sources whose rows are
keyed differently, declare how the sources relate:

```jsonc
"relationships": [
  { "left": "expr", "right": "clin", "on": { "left": "smps", "right": "patient_id" } },
  { "left": "expr", "right": "genes", "on": { "left": "Top", "right": "vars" } }
],
"markingMode": "focus"   // focus (default) | highlight | ghost
```

- **Marking** — selecting rows in a panel marks the related rows in the panels
  of every source reachable through relationships (several hops, both
  directions), shown with CanvasXpress's declarative highlight in
  `markingMode`. A related source with no matching rows shows fully dimmed.
  Esc / an empty selection clears the marks.
- **Filtering** — a filter control on one source also narrows panels whose
  source lacks that annotation but is related: the control source's matching
  rows are translated and kept (several picks intersect).
- A `kind: "join"` source relates its two inputs through its `on`, and relates
  itself to each input row by row, with no extra declaration.
- `on` uses the join key grammar (row id by default, a shared column,
  `{left, right}`, or an array).

## Data functions (R / Python)

A `kind: "function"` source runs a short R or Python snippet over other sources
and feeds the result to panels like any other source:

```jsonc
"data": {
  "clin":   { "kind": "dataset", "id": "clinical" },
  "byArm":  {
    "kind": "function", "language": "r",
    "inputs": ["clin"],                        // or { "d": "clin" } to rename
    "args":   { "minAge": "$minAge" },         // literals or $params
    "code":   "d <- clin[clin$Age >= params$minAge, ]\nresult <- aggregate(Age ~ Arm, data = d, FUN = mean)"
  }
}
```

- Inputs arrive as pandas `DataFrame`s / R `data.frame`s named after `inputs`:
  row ids as the index / row names, numeric columns and row annotations as
  columns (sources with `axis: "vars"` are read one variable per row).
- The code assigns `result`: a table (row ids from its index / row names, or
  its first column when those are the defaults; numeric columns become
  variables, the rest annotations) or a CanvasXpress data object. Set `axis:
  "vars"` on the function to emit one variable per row (scatter orientation).
- A function re-runs when an input changes (param re-query, refresh) or one of
  its `$param` args changes; joins, relationships and Filters panels treat it
  like any source.

[`examples/cohort-explorer.html`](examples/cohort-explorer.html) shows one in
context — an R function ranking genes against survival on a joined cohort,
alongside a join, relationships and a Filters panel. On a static host its R
panel explains that data functions are not available; everything else runs
in the browser.

**Runtime.** The browser POSTs `{language, code, inputs: {name: {data, axis}},
params, axis}` to `runtime` (default `<server>/api/functions/run`) and expects
`{data}`. Any service honouring that contract works. The bundled server's
runtime is **off by default**:

| Env | Meaning |
|---|---|
| `CXD_FUNCTIONS` | `off` (default) · `admin` (administrators only) · `users` (any logged-in user) |
| `CXD_FUNCTIONS_TIMEOUT` / `_MEMORY_MB` | per-run wall-clock seconds (20) / memory cap MB (1024, where the OS enforces it) |
| `CXD_FUNCTIONS_MAX_CONCURRENT` | concurrent runs (2); extra requests get 429 |
| `CXD_FUNCTIONS_PYTHON` / `_RSCRIPT` | interpreters (need `pandas` / `jsonlite`) |
| `CXD_FUNCTIONS_WRAPPER` | sandbox command prefix: `auto` (sandbox-exec on macOS, `unshare -rn` on Linux, when they work) · `none` · e.g. `firejail --net=none` |

Each run is a fresh subprocess in an empty temp directory with a minimal
environment, CPU / file-size limits and size caps. `GET /api/functions/status`
reports the languages and the **network isolation actually in effect**. This is
defence in depth, not a multi-tenant sandbox — expose `users` mode only inside a
container / VM you trust. Shared links (anonymous viewers) cannot run functions;
export the dashboard as HTML to share a snapshot.

## Filters panel and filter schemes

A `type: "filters"` panel is a multi-field filter inspector (like Spotfire's
Filters panel): a checkbox list with counts for each categorical field, a min /
max range for numeric fields, and a search box for fields with many values (or
the row ids). Without `fields` it lists every row annotation and numeric column
of its `dataRef`.

```jsonc
"panels": {
  "filters": { "type": "filters", "dataRef": "clin",
               "fields": ["Arm", "Age", { "field": "Chr", "dataRef": "genes", "kind": "values" }] }
},
"filterSchemes": {
  "Drug arm, 65+": [{ "dataRef": "clin", "field": "Arm", "values": ["drug"] },
                    { "dataRef": "clin", "field": "Age", "min": 65 }]
}
```

- Filters on one source AND together. They filter that source's panels and —
  through `relationships` / joins — the related rows of other sources; they
  combine with the annotation filter controls.
- **Schemes** are named filter states: pick one from the panel's header, or type
  a name and **Save** the current filters (reported through the
  `onFilterSchemesChange(schemes)` render option; the builder writes them to
  `spec.filterSchemes`). **Reset** or Esc clears every filter.
- `handle.getFilterState()` / `handle.setFilterState(state)` /
  `handle.getFilterSchemes()` read and restore the state programmatically.
- In the builder, **+ Filters** adds one over the first data source.

## Portable, versioned specs (git-native dashboards)

A spec is the whole dashboard — data bindings, layout, panels, filters — in one
JSON file you can keep in git, review, and re-render anywhere.

- **Format version.** Specs carry `schemaVersion: "MAJOR.MINOR"` (currently
  `1.1`; an unstamped spec is `1.0`). The builder and `exportSpec` stamp it; the
  renderer, builder and importer **migrate** older specs on load (`migrateSpec`).
  A MINOR bump is additive — a reader on an older MINOR renders what it knows
  and skips the rest with a warning; a MAJOR bump is migrated on load, and a
  spec from a newer MAJOR is refused with a clear message. (`version` stays the
  dashboard's own revision counter.)
- **Round-trip guarantee.** Loading a spec into the builder and saving it with
  no edits returns the same spec; only real edits change it. This is enforced
  by `npm run test:roundtrip` (every example, real browser + engine; set
  `CX_LIB_DIR` to test a local CanvasXpress build).
- **Canonical text + diff.** `serializeSpec` writes a stable form (fixed
  top-level key order, 2-space indent) and `dashboardDiff(a, b)` compares two
  specs structurally — layout items matched by panel id, so moving panels
  around the array is not a change — with a readable summary.

The `cxd-spec` CLI wraps these for scripts and git:

```bash
npx cxd-spec validate sales.spec.json          # errors (exit 1) and warnings
npx cxd-spec migrate  sales.spec.json --write  # upgrade in place to the current format
npx cxd-spec format   sales.spec.json --write  # canonical text
npx cxd-spec diff old.spec.json new.spec.json  # "changed panels.bar.config.graphType: ..."; exit 1 if different

# readable dashboard diffs in git:
git config diff.cxd.textconv "npx cxd-spec format"
echo '*.spec.json diff=cxd' >> .gitattributes
```

## Large data: aggregate, filter and join in the database

A connector source can ask its database for the answer instead of the table
(guide: **[docs/large-data.md](docs/large-data.md)**; needs canvasxpress-connectors
0.6+ and a SQL source):

```jsonc
"orders": { "kind": "connector", "url": "/connectors/api/data?source=orders",
  "pushdown": { "groupBy": ["region"], "measures": [{ "fn": "sum", "column": "amount" }],
                "where": [{ "column": "status", "op": "in", "value": "$status" }], "limit": 1000 } }
```

- The database filters, groups, sorts and limits; only the result travels. Chart
  the measures by name (`sum_amount`).
- `$param` filter values re-query when a param control changes.
- A **Filters panel** over the source sends its picks to the database and
  re-queries. Its value lists keep every option.
- A `kind:"join"` of two connector sources with `pushdown` runs as one SQL join
  (aggregated there too, if given a query). It falls back to the browser join
  when the sources are in different databases.

The browser never writes SQL: column names are checked against the source's own
query, and values are bound.

## Governance and audit (server)

The dashboards server controls who can do what and who sees which data, and
records what happened. The full guide is **[docs/governance.md](docs/governance.md)**.

- **Audit log.** Sign-ins (including failed ones), dashboard and dataset changes,
  shares, share-link views, data-function runs, AI-builder calls and admin
  actions are recorded. Events are append-only and hash-chained, so *Verify
  chain* detects an edited or deleted entry. Admins filter and export them from
  Admin → *Audit log*. Passwords, specs, data and code are never stored.
- **Roles and groups.** A role is a set of permissions: create dashboards, upload
  datasets, share with people, publish links, run data functions, use the AI
  builder. `viewer` and `editor` are built in, and admins add their own. Roles are
  given to users or groups. `CXD_DEFAULT_ROLE` (default `editor`) covers everyone
  else, so a server nobody configures behaves as before.
- **Sharing with people and groups.** Owners share a dashboard with a user, a
  group or everyone signed in, to view or to edit. It appears in their Dashboards
  list and reads the owner's stored datasets. An edit share saves back to the
  owner. Datasets can be shared on their own.
- **Row- and column-level security.** Per-dataset rules, for example "site-A
  staff see site-A rows; only clinicians see patient names". The server applies
  them wherever it hands out the dataset: in the app, through shared dashboards,
  and on share links. They fail closed.
- **Lineage.** Which dashboards read which datasets and connectors.

```jsonc
// PUT /api/datasets/trial/policy
{ "policy": {
    "rows":    [{ "field": "site", "allow": { "group:site-a": ["A"], "user:lead": "*" } }],
    "columns": [{ "hide": ["name"], "except": ["group:clinicians"] }] } }
```

## Scheduling: refresh, alerts, emailed dashboards (server)

The server runs three kinds of schedule, created in the app's **Schedules** view
(guide: **[docs/scheduling.md](docs/scheduling.md)**):

- **Refresh** re-pulls a stored dataset from a URL (CSV/JSON) or one of your
  database sources, keeping its title, config and lock. Dashboards bound to it
  show the new data.
- **Alert** emails people when a value crosses a threshold, for example "mean CRP
  at site A above 12". It is checked **per recipient on the rows they may see**
  and sent when the condition becomes true, not on every check.
- **Subscription** emails a dashboard on a schedule: a link plus a **PNG snapshot
  rendered as each recipient** (needs Playwright on the server; link only
  otherwise).

Schedules use cron plus a time zone (presets in the app). Every run is kept in a
history and recorded in the audit log. Email goes out over SMTP (`CXD_SMTP_*`).

## Authenticated data binding (connectors)

A `kind: "connector"` data source fetches live from a
[`canvasxpress-connectors`](https://github.com/neuhausi/canvasxpress-connectors)
endpoint (`GET /api/data?source=…`, which returns a CanvasXpress data object).
Requests are sent with `credentials: "include"` — **no credentials ever live in
the browser**; the connectors session cookie carries identity and the DB query
runs server-side.

```jsonc
"data": {
  "sales": {
    "kind": "connector",
    "url": "/api/data?source=sales",
    "ttl": 60000,      // serve from cache for 60s (optional)
    "refresh": 300      // re-poll every 5 min and live-update bound panels (optional)
  }
}
```

- **One request per source.** Panels sharing a `dataRef` — and any two sources
  with the same URL — resolve to a single fetch; concurrent requests are
  de-duplicated and results are cached.
- **`ttl`** (ms) keeps a source warm so re-renders and sibling dashboards load
  instantly from cache instead of re-querying the database.
- **`refresh`** (seconds) polls the source on an interval and pushes new data
  into the bound instances via `updateData` — no full re-render.
- **Per-panel states.** Each cell shows a loading overlay, an **empty** state
  ("No data") when a source returns no rows, and an **error** overlay carrying
  the connector's `detail` message.

The cache is process-wide by default; pass `options.cache = new Map()` to isolate
a dashboard, or `options.ttl` to set a default lifetime for sources without one.

### Per-user database sources (bridged canvasxpress-connectors)

The demo server goes one step further and mounts the **full
canvasxpress-connectors BYO-database app** at `/connectors`, with a **bridged
session** — users sign in once (to the dashboards app) and get their own
database sources with no second login:

```python
# examples/serve.py (requires: pip install 'canvasxpress-connectors[sql]')
from cx_connectors.store import Store
from cx_connectors.web.byo_app import create_byo_app

store = Store(db_path, encryption_key)            # conn strings stored ENCRYPTED
app.mount("/connectors", create_byo_app(store=store, serve_static=False))
```

**How the session bridge works.** The two apps keep separate session cookies
(`cxd_session` / `cxc_session`) and user tables. `GET /api/connectors/credentials`
— guarded by the *dashboards* session — returns a derived credential for the
connectors app: same username, password = `HMAC(SESSION_SECRET, user)` (stable,
never stored, only obtainable with a valid dashboards session). The front-end
fetches it and POSTs `/connectors/auth/login` behind the scenes; from then on
every `/connectors/*` call is authenticated as that user.

**In the app.** The Data page shows a **Database sources** card: each user's
registered sources (the demo seeds `inventory` and `furniture-only`, backed by
a real SQLite database COMMITTED to the repo — `examples/data/inventory.db`,
regenerate with `examples/data/make_inventory_db.py` — and opened strictly
read-only via `sqlite:///file:…?mode=ro&uri=true`), a **+ Database** form (name, connection URL, read-only SQL),
per-source **edit** (✎ opens a floating dialog, prefilled; saving upserts by
name) and delete, each row showing rows×cols · backend · last-saved date,
and click-to-preview — the preview queries the database
LIVE through the connectors app and renders the result as a table. The
Builder's per-panel **Data dropdown** also lists the user's database
sources (🗄) — picking one binds the panel to a live connector source.

**Binding a source in a spec** is the standard connector shape:

```jsonc
"data": {
  "sales": { "kind": "connector", "url": "/connectors/api/data?source=my-sales", "refresh": 60 }
}
```

**Configuration & guarantees:**

- `ENCRYPTION_KEY` — Fernet key encrypting stored connection strings. The demo
  server reads it from `.env` or generates one and persists it at
  `examples/.cxd-demo/encryption.key`. Losing the key orphans stored sources.
- `SESSION_SECRET` is shared by both apps and also drives the bridge HMAC.
- SQL is validated **read-only** by `SqlSource` before it is saved or run;
  credentials never reach the browser; users are isolated by session.
- Without `canvasxpress-connectors[sql]` installed the mount is skipped with a
  log note (and the seeded SQLite demo dataset falls back to stdlib sqlite3) —
  the server always boots.

---

## API

### `renderDashboard(spec, target, options?) → Promise<handle>`

Renders `spec` into `target` (an element or its id). Returns a handle with:

- `instances` — the created CanvasXpress instances
- `broadcastGroup` — the resolved coordination domain
- `store` — the data store (shared cache, `resolve`/`invalidate`)
- `ready` — a promise that resolves once every panel/control has settled
- `destroy()` — stop refresh timers, tear down instances, clear the DOM

**Options:** `CanvasXpress` (constructor override; defaults to global),
`fetch` (for `kind: "connector"` sources), `cache` (a `Map`; defaults to a
process-wide shared cache), `ttl` (default connector cache lifetime in ms),
`validate` (default `true`).

### `createDataStore(options) → store`

Standalone data resolver (inline + connector) with caching, in-flight
de-duplication, and TTL. Also exported: `isEmptyData(data)`, `DataError`
(carries `.status`), `clearSharedCache()`.

### Persistence & sharing

Save/load/share is provided by an optional server
([`server/`](server/README.md), `canvasxpress-dashboards-server`) that mirrors the
connectors auth model: per-owner isolation, cookie sessions, and a per-dashboard
**share link** (public or auth-gated). The store is stdlib-only SQLite (swaps for
Postgres); dashboard specs hold no credentials, so only the share token is a
secret. The bundled read-only viewer is served at `/shared.html?token=…`.

Client helpers (in this package):

```js
import { createDashboardClient, exportSpec, importSpecFromFile } from 'canvasxpress-dashboards';

const client = createDashboardClient({ baseUrl: '' });   // cookie auth
await client.login('alice', '…');
await client.save(spec);                 // create/update (keyed by spec.id)
const specs   = await client.list();     // the user's dashboards
const loaded  = await client.load('sales-overview');
const shared  = await client.share('sales-overview', 'public'); // -> { share_token, share_url }
const viewer  = await client.loadShared(shared.share_token);     // { spec, readOnly, owner }

exportSpec(spec);                        // download spec.json
const imported = await importSpecFromFile(file); // parse + validate a File
```

- `exportSpec` / `importSpecFromFile` / `parseAndValidate` — download and load a
  spec as `.json` (validated on import).
- `createDashboardClient(opts)` — thin, credentialed client for the server API:
  - session: `login`, `signup`, `logout`, `me` (with `permissions`, `groups`, `roles`)
  - dashboards: `list`, `save(spec, {owner})`, `load(id, {owner})`, `remove`,
    `share`, `loadShared`
  - datasets: `listDatasets`, `getDataset(id, {store, owner})`, `uploadDataset`,
    `deleteDataset`, `listStores`
  - sharing and security: `directory`, `grants`, `setGrant`, `getPolicy`,
    `setPolicy`, `lineage`
  - scheduling: `scheduleStatus`, `listSchedules`, `saveSchedule`, `deleteSchedule`,
    `runSchedule`, `scheduleRuns`, `cronPreview`, `getProfile`, `setProfile`
  - admin: `listUsers`, `createUser`, `setUserPassword`, `setUserAdmin`, `setUserEmail`,
    `deleteUser`, `governance`, `saveGroup`, `deleteGroup`, `saveRole`,
    `deleteRole`, `assignRole`, `auditLog`, `auditExportUrl`, `auditVerify`

  See [docs/governance.md](docs/governance.md#client-methods) for the sharing,
  security, lineage and audit calls.

### No-code builder

A vanilla, zero-dependency builder that owns the *dashboard's* concerns — layout
(drag a title to move, drag the corner to resize), add/delete panels, assign a
data source, and Save/Share/Export/Import — and **delegates all graph editing to
CanvasXpress's own customizer**. Panels render live; a **⚙ icon** on each panel
title opens the native customizer (`instance.showCustomizer`), where chart type,
colors, grouping, axes, and every other option are edited with CanvasXpress's own
widgets. Edits are read back via `instance.getConfig()` and folded into
`panel.config`, so the builder stays a pure spec editor. Preview hides the editing
chrome; Save/Share/Export reuse the persistence client.

> Column projection is still available in the spec: `panel.measures` (an array of
> variable names) plots just those numeric columns while the source stays shared
> (one fetch, one broadcast domain). The renderer applies it; set it via the API
> (`updatePanel(spec, id, { measures })`) if you want per-panel column subsets.

```js
import { createBuilder, blankSpec, setDataSource, createDashboardClient } from 'canvasxpress-dashboards';

const seed = setDataSource(blankSpec('my-dashboard', 'My Dashboard'), 'sample',
  { kind: 'inline', value: { y: { vars: ['R'], smps: ['A', 'B'], data: [[1, 2]] } } });

const builder = createBuilder(document.getElementById('builder'), {
  spec: seed,
  client: createDashboardClient({ baseUrl: '' }),  // optional (Save/Share)
  // owner: 'alice',   // editing a dashboard alice shared with edit access:
  //                   // Save writes back to hers and keeps its id
  onChange: (spec) => { /* autosave, undo stack, … */ }
});

builder.getSpec();                 // current spec (a copy)
builder.addPanel({ id: 'p1', dataRef: 'sample', config: { graphType: 'Bar' } });
```

Open [`examples/builder.html`](examples/builder.html) to build a dashboard end to
end with no code. The pure operations are also exported directly (`addPanel`,
`removePanel`, `movePanel`, `resizePanel`, `updatePanel`, `setDataSource`,
`blankSpec`) along with `pointerToCell` for custom drag surfaces.

### `validateSpec(spec) → { valid, errors }`

Structural validation; returns human-readable error strings.

### `injectStyles(doc?)` / `dashboardCss`

The grid stylesheet (auto-injected by `renderDashboard`).

---

## Develop

```bash
npm run build     # regenerate dist/ (ESM + UMD) from src/
npm test          # node --test unit + renderer smoke tests
```

The source is authored as small ES modules under `src/`; `scripts/build.mjs` is a
zero-dependency bundler that inlines them into `dist/*.esm.js` and `dist/*.umd.js`.

---

## Deploying behind a reverse-proxy subpath (canvasxpress.org)

The full app runs as a plain localhost service and is exposed by Apache under a
path prefix — the same pattern as the
[canvasxpress-mcp](https://github.com/neuhausi/canvasxpress-mcp) server. The
front end derives its API base from the path it is served under
([`examples/builder.html`](examples/builder.html),
`server/src/cxd_server/static/shared.html`), so the identical code works at `/`
in development and at `/dashboards/` in production. The production deployment
at `https://www.canvasxpress.org/dashboards/` was set up exactly as follows
(2026-08-20).

### 1 — Install the service (as the site user)

```bash
ssh canvasxpress@canvasxpress.org -p 7822
git clone https://github.com/neuhausi/canvasxpress-dashboards.git
cd canvasxpress-dashboards
python3 -m venv .venv
.venv/bin/pip install -e 'server[web]'
```

### 2 — Configure via `.env` (next to `server.sh`, gitignored)

```bash
cat > .env <<'EOF'
CXD_HOST=127.0.0.1
CXD_PORT=8200
CXD_PYTHON=/home/canvasxpress/canvasxpress-dashboards/.venv/bin/python
CXD_HTTPS_ONLY=1
CXD_PUBLISH_BASE_URL=https://www.canvasxpress.org/dashboards
CXD_MCP_ENABLED=1
CXD_MCP_URL=http://127.0.0.1:8100
CXD_MOUNT_PREFIX=/dashboards
EOF
```

Port **8200** avoids the MCP server on 8100. `CXD_PUBLISH_BASE_URL` makes share
links point at the public URL rather than the internal one. The Chat/NL builder
needs no API key here — `CXD_MCP_URL` points it at the canvasxpress-mcp service
already running on the same host.

`CXD_MOUNT_PREFIX` is needed because cPanel's LiteSpeed (which parses the
Apache config) forwards the request path **unstripped** through a
`ProxyPass`-in-`<Location>` — the backend receives `/dashboards/...`, not
`/...`. With the prefix set, `examples/serve.py` mounts the whole app at both
`/` and `/dashboards`, so it works direct and proxied. (On genuine Apache
httpd, which strips the matched prefix, you can omit it.)

### 3 — Start it

```bash
./server.sh start        # stop | restart | status | logs
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8200/   # → 200
```

`server.sh` seeds the demo datasets on boot and writes logs/pidfile under
`examples/.cxd-demo/`. It does **not** auto-start on reboot; add a crontab entry
if you want that:

```
@reboot /home/canvasxpress/canvasxpress-dashboards/server.sh start
```

### 4 — Expose it through Apache (as root, one time)

On a cPanel host, drop a userdata include next to the existing
`mcp-proxy.conf`. The file is staged at
`~canvasxpress/dashboards-connectors-proxy.conf` and contains:

```apache
# Trailing-slash URLs are required: the front end derives its API base
# from the path prefix.
RedirectMatch ^/dashboards$ /dashboards/
RedirectMatch ^/connectors$ /connectors/

<Location /dashboards>
    PassengerEnabled Off
    ProxyPass http://127.0.0.1:8200
    ProxyPassReverse http://127.0.0.1:8200
</Location>
<Location /connectors>
    PassengerEnabled Off
    ProxyPass http://127.0.0.1:8300
    ProxyPassReverse http://127.0.0.1:8300
</Location>
```

Install and reload:

```bash
cp ~canvasxpress/dashboards-connectors-proxy.conf \
   /etc/apache2/conf.d/userdata/ssl/2_4/canvasxpress/canvasxpress.org/
/scripts/ensure_vhost_includes --user=canvasxpress
/scripts/restartsrv_httpd
```

The app is then live at `https://www.canvasxpress.org/dashboards/`.

### Notes

- A path prefix (rather than proxying `/api` at the site root) is required
  because the website's own `/api` is a documentation directory.
- The session cookie is named `cxd_session` so it can't collide with the
  co-hosted canvasxpress-connectors demo (`cxc_session`).
- To update the deployment: `git pull && ./server.sh restart` (re-run
  `pip install -e 'server[web]'` if server dependencies changed).

---

## License

MIT © Isaac Neuhaus
