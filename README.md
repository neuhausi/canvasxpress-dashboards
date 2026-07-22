# canvasxpress-dashboards

Compose, coordinate, and render **dashboards** — collections of linked
[CanvasXpress](https://www.canvasxpress.org) visualizations — from a single
declarative JSON spec.

CanvasXpress already ships the hard part: cross-chart coordination (a selection
or filter in one chart propagates to the others via its `broadcast` mechanism).
This package adds the missing layer: a **spec**, a **grid layout**, a
**renderer**, and (in later phases) data binding, persistence, and a no-code
builder. It does **not** re-implement chart rendering or coordination.

> **Status:** All 4 phases shipped — spec + renderer + connector binding + persistence & sharing + no-code builder. See
> [`docs/plans/dashboards`](https://github.com/neuhausi/canvasxpress) for the roadmap.

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

### Persistence & sharing (Phase 3)

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

### No-code builder (Phase 4)

A vanilla, zero-dependency builder — drag/move/resize on the grid + a per-panel
editor form — that reads and writes the same spec. Every gesture routes through
pure spec operations, so the builder is *only* a spec editor. Live preview reuses
the renderer; Save/Share/Export reuse the Phase-3 client.

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

## Roadmap

| Phase | Deliverable | Status |
|---|---|---|
| **1** | Spec + client renderer + showcase | ✅ done |
| **2** | Authenticated data binding via [`canvasxpress-connectors`](https://github.com/neuhausi/canvasxpress-connectors) + cache | ✅ done |
| **3** | Persistence & sharing ([`server/`](server/README.md)) | ✅ done |
| **4** | No-code builder | ✅ this release |

## License

MIT © Isaac Neuhaus
