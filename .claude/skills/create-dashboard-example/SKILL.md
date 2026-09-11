---
name: create-dashboard-example
description: Create a new CanvasXpress dashboard example (spec + page), verify it renders, and optionally seed it into the demo server so it appears on the Dashboards page. Use when asked to create, add, or scaffold a dashboard example, KPI board, or demo dashboard.
---

# Create a dashboard example

Produce a new example under `examples/`: a `<id>.spec.json` dashboard spec, a
`<id>.html` standalone page, a card in `examples/index.html`, and (when asked to
make it available in the app) a seed entry in `examples/serve.py`.

## Workflow

1. **Spec** — write `examples/<id>.spec.json` (format below). The example MUST
   declare at least TWO different datasets in `data` (e.g. per-record raw rows
   feeding meters plus a separate time-series for a trend chart) — a
   single-dataset example does not exercise the multi-source binding the
   examples exist to demonstrate. Generate datasets programmatically with a
   small node script when they are large; write the fully materialized JSON
   into the spec (`"kind": "inline"`), never a generator reference.
   **ALWAYS start the dashboard with a full-width intro text panel** (the house
   default): the FIRST layout item is a `{"type":"text"}` panel spanning all
   columns (`"w": cols`) that shows the dashboard **title** (bold, 25px) with a
   **one-to-three-line description** underneath (18px, muted `#5b6472`) — see the
   spec format. Height `h`: `2` when `rowHeight` is ~40, `1` when it is ~130
   (keep it short — no big gap before the graphs). Only `color`, `font-size`,
   `font-weight`, `font-style`, `text-decoration`, `text-align`, `font-family`
   survive the HTML sanitizer, so style the intro with those (no `margin`/
   `padding`/`line-height`). Place every other panel below it (shift their `y`).
2. **Page** — copy the structure of `examples/kpi-overview.html`: canvasXpress
   CSS+JS from `https://www.canvasxpress.org/dist/`, the local UMD bundle
   `../dist/canvasxpress-dashboards.umd.js`, the shared topnav, a header, and a
   `fetch('<id>.spec.json')` → `CanvasXpressDashboards.renderDashboard(spec, 'dashboard')` script.
3. **Register** — add a card for it in `examples/index.html` under "Standalone examples".
4. **Validate** — from the repo root:
   `node -e "import('./src/validateSpec.js').then(m=>console.log(JSON.stringify(m.validateSpec(JSON.parse(require('fs').readFileSync('examples/<id>.spec.json','utf8'))))))"`
5. **Verify in a browser** — serve the repo root (`python3 -m http.server 8899`)
   and drive it headlessly with Playwright (needs Node 24:
   `PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"`, run node from
   `~/git/canvas-ai/tests` where playwright is installed). Count canvases,
   collect console errors, screenshot, and READ the screenshot — data problems
   (flat meters, tangled lines, ignored config) only show up visually. If the
   dashboard has a filter control, also exercise it (select a value, screenshot,
   select All) and confirm every bound panel responds.
6. **Seed (optional)** — to make it appear on the app's Dashboards page, add a
   block to `_seed_shipped_dashboards` in `examples/serve.py` following the
   existing kpi/bench pattern: move each inline dataset into the dataset store
   (`datasets.create(...)` with a `<prefix>-<ref>` id) and rewire the spec to
   `{"kind": "dataset", "id": ..., "store": "local"}` before
   `dashboards.save_dashboard`. Seeding is idempotent (skips ids already
   saved); restart with `./server.sh restart` (NOTE: server.sh can hang the
   calling shell — run it in the background and confirm via
   `examples/.cxd-demo/server.log` instead of waiting). The seeded copy is then
   decoupled from the spec file; to update it later, edit via the store
   (`server/src/cxd_server/store.py` → `DashboardStore.get_dashboard` /
   `save_dashboard`) or delete it in the app and re-seed.

## Spec format

```jsonc
{
  "id": "my-example",              // dashboard id == filename stem
  "title": "My Example",
  "version": 1,
  "broadcastGroup": "my-example",  // panels in one group coordinate selections/filters
  "theme": "auto",
  "layout": {
    "cols": 12,
    "rowHeight": 40,               // KEEP SMALL (30-44): it is the resize/height granularity;
    "gap": 12,                     // a control at h:1 is then a true single line
    "items": [
      { "panel": "intro", "x": 0, "y": 0, "w": 12, "h": 2 },   // REQUIRED full-width intro (h:1 when rowHeight ~130)
      { "panel": "p1", "x": 0, "y": 2, "w": 12, "h": 1 }
    ]
  },
  "data": {
    // REQUIRED: at least two distinct datasets per example.
    "ref1": { "kind": "inline", "value": { /* canvasXpress data: y.vars/y.smps/y.data, x/z annotations */ } },
    "ref2": { "kind": "inline", "value": { /* second dataset, different shape/purpose */ } }
    // other kinds: {"kind":"dataset","id":...,"store":"local"}, {"kind":"connector","url":...,"refresh":30}
  },
  "panels": {
    "intro": { "type": "text",                                  // REQUIRED: title + 1-3 line description
               "html": "<div style=\"font-weight: 700; font-size: 25px\">My Example</div><div style=\"font-size: 18px; color: #5b6472\">One to three lines describing what this dashboard shows and how to use it.</div>" },
    "p1":  { "type": "control", "title": "Region", "dataRef": "ref1",
             "annotation": "Region", "style": "dropdown" },   // or radio | buttons | auto
    "p2":  { "title": "Chart", "dataRef": "ref1", "config": { "graphType": "Bar", "title": false } }
  },
  "controls": [ { "kind": "table", "dataRef": "ref1", "title": "Data" } ]  // optional full-width strip below grid
}
```

Layout heights: a panel spanning `h` rows measures `h*rowHeight + (h-1)*gap` px.
Panel titles come from the panel `title`; always set `"title": false` in the
canvasXpress config so the graph doesn't draw its own.

## Hard-won gotchas

- **Charts default to horizontal.** Set `"graphOrientation": "vertical"` on Bar
  and Line panels for conventional orientation. Long sample labels: `"smpLabelRotate": 45`.
- **Meters**: `graphType: "Meter"` with `meterType` gauge | speedometer |
  ring | horizontal | vertical. Ring KPI cards: `"meterType": "ring",
  "meterCard": true` plus `summaryType` (`sum` | `average`) to aggregate many
  raw rows into one number; pick the variable with `xAxis: ["VarName"]`;
  single accent color via `rangeColors: ["rgb(...)"]`. Gauges use `setMin`/
  `setMax`/`rangeSegments` — but a non-zero `setMin` window (e.g. 95–100) is
  ignored by the renderer, so keep 0-based scales. The CDN build supports
  `meterCard`/`summaryType`/`groupingFactors` but NOT `meterVar` — use
  single-variable datasets + `xAxis`. `groupingFactors: ["Ann"]` renders one
  ring per annotation value.
- **Filter controls only affect datasets that carry the annotation** (as a
  sample annotation in `x` or a variable annotation in `z` — `z` hides whole
  line-chart series). For a filter to drive the whole board, every dataset
  needs the annotation, which usually means long-format raw records the meters
  re-summarize (that is the point: filtering visibly changes the numbers).
- **Filter matching is substring ("like")**: region names must not contain each
  other ("East"/"Northeast" both match "East") — pick prefix-free names.
- **Dropdown option values are indices**, `"0"` = All; in Playwright select by
  `{ label: 'East' }`, and the widget class is `select.cxd-annctl-select`.
- **Make demo data tell a story.** Give each category a distinct personality
  (a star, a struggler, an incident day) with deterministic pseudo-noise from
  index arithmetic — near-identical series and constant meters read as broken.
  4-ish categories keep line charts legible.
- Do not use `Math.random()`/`Date.now()` patterns that make regeneration
  unstable; derive noise from indices so the spec is reproducible.

## Repo invariants

- `npm test` (100+ node tests) and `npm run build` must stay green; the build
  mirrors the UMD bundle into `server/src/cxd_server/static/` automatically —
  never edit `dist/` or the vendored bundle by hand.
- Controls are SOLID in builder layout (they hold their row); text panels
  float. The grid is WYSIWYG — no auto-compaction.
