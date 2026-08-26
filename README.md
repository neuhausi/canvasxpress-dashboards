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
- The spec is **forward-compatible**: unknown fields are ignored; `version` gates
  migrations.

The canonical contract is [`schema/dashboard.schema.json`](schema/dashboard.schema.json)
(JSON Schema, for validation + editor autocomplete). `validateSpec(spec)` is the
runtime guard.

---

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
- `createDashboardClient(opts)` — thin, credentialed client for the server API
  (`login`/`signup`/`logout`/`me`, `list`/`save`/`load`/`remove`, `share`/`loadShared`).

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
