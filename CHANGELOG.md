# Changelog

Notable changes to `canvasxpress-dashboards` (the npm package) and its server
(`cxd_server`). Versions follow the package version.

## Unreleased

### Security: a stored source login is never shown again
`GET /api/connectors/source` (the read-back behind the Builder's **Edit**) used to return a
source's stored login to the owner's browser. It now masks every secret as `********`: the
password in a database connection URL (so a Databricks token), secret-looking URL parameters, and
the secret fields of a Salesforce, ServiceNow or pins source. Saving a form that still carries the
mask keeps the stored secret, restored on the server (`secret_from` names the source), and only
while the scheme, host and port are unchanged, so a stored password cannot be redirected to a new
server. The Builder explains that a Salesforce, ServiceNow or pins source has no edit form (register
it again to change it) and no longer offers one as "Same database as…". `sources-meta` and the
read-back report each source's `type` (`salesforce`, `databricks`, `databricks-viewer`,
`postgresql` …). The database half needs `canvasxpress-connectors` with `connmask`; with an older
one a database URL is still returned as stored.

### Salesforce: sign in with an OAuth app, no password
A Salesforce source can name an **OAuth app** defined only in the server's settings
(`CXC_SALESFORCE_APPS`) instead of storing a username, password and token; scheduled refreshes
re-check the app's `users` list each run. `CXC_SALESFORCE_PASSWORD_AUTH=off` refuses stored
passwords. The `demo` extra now installs `canvasxpress-connectors[salesforce]`.

### Docs: connecting Salesforce, Databricks and pins
New guides: [Connecting your data](docs/connecting-your-data.md),
[Salesforce](docs/connect-salesforce.md), [Databricks](docs/connect-databricks.md) and
[pins](docs/connect-pins.md).

### Example: Pins Board (live connector)
A new **Pins Board (live connector)** example (`examples/pins-live.html`) reads a
Posit **pins** board **live** through the real
`cx_connectors.sources.pins_board.PinsBoardSource` — nothing baked. The demo
publishes the Palmer Penguins table to a local `board_folder` with `pin_write()`
(what an analyst produces), registers it as a `pins` connector source, and binds two
species-colored scatters + a Species filter to `kind:"connector"`
(`/connectors/api/data?source=pins-penguins`). The standalone page bridges the
connector session from your app login (`prepareConnectors`). Point it at your own
Connect / folder / S3 / URL board by changing the source config. Companion to the
baked **Pins Board Overview**. Docs: [docs/pins-connector.md](docs/pins-connector.md).
Needs `pip install "canvasxpress-connectors[pins]"`; degrades cleanly (the example is
simply absent) when `pins` isn't installed.

### Feature: author panels from code — ggplot2, R `canvasXpress`, Python `canvasxpress`
Already write charts as code? Drop that code into a dashboard. One **📈 Code**
button in the Builder opens a dialog with a **Source** picker — ggplot2, the R
`canvasXpress` package, or the Python `canvasxpress` package (whichever the server
offers). The snippet (which assigns its chart to `g`) runs **once, in the sandboxed
runtime** (`POST /api/ggplot/convert` or `/api/cx/convert`, same OS sandbox + trust
boundary as data functions — admin-gated, embedded-runtime-only, network denied).
ggplot2 converts via `ggplot.as.list()` to a `type:"ggplot"` panel; `canvasXpress`
code extracts the library's own native spec (the R widget's `$x` via htmlwidgets,
or the Python object's `render_to_dict`) into a self-contained `type:"cxcode"`
panel. Both render as ordinary interactive CanvasXpress charts (no new renderer),
and the **`</> Code`** recipe keeps the source so it can be edited and re-converted.
CLIs: `bin/cxd-ggplot` and the new `bin/cxd-cx` build a whole dashboard from a folder
of snippets. `GET /api/cx/status` reports which languages have a CanvasXpress package
installed, so a server with only R offers only R; the Python `canvasxpress` package
is an optional runtime dependency. See [docs/code-panels.md](docs/code-panels.md),
the **CanvasXpress Code Gallery** example (a ggplot2, an R and a Python panel), and a
served `/llms.txt` so agents can discover the app's features and examples.

### Fix: PNG/PDF export failed with "Error parsing CSS component value, unexpected EOF"
Exporting a dashboard (or a preview) to PNG/PDF threw
`Export failed: Error parsing CSS component value, unexpected EOF` whenever the
board contained a design-system checkbox or radio — e.g. the **Filters** panel in
the Cohort Explorer. html2canvas 1.4.1 crashes on any `<input>` that carries a
`::before` pseudo-element, and the engine's primitive checkbox/radio draws its
check mark and dot exactly that way. `dashboardToPng` now swaps those controls for
equivalent `<span>`s (same box + an inline-SVG check/dot) inside html2canvas's
clone via `onclone`, so the raster renders identically and no longer aborts.

### Reference-database dashboards on a packaged server (`CXD_REFERENCE_SOURCES`)
The GTEx / GENCODE / CCLE / TCGA / WikiPathways science dashboards used to work
only on the examples' dev launcher (`examples/serve.py`), because their serving
code lived there, not in the package — so a plain `pip install` + `python -m
cxd_server` had no way to serve them even with the data present. That serving
side now ships in the package, **off by default**:
- New `cxd_server.reference_services` (the SQLite → CanvasXpress `.data` logic,
  read-only, looked up in `CXD_SQLITE_DIR`) and `cxd_server.reference_sources`
  (the wiring). Set `CXD_REFERENCE_SOURCES=on` to register `GET /api/<db>` for
  the five reference databases (the GENCODE genome browser needs only the data
  file; no connectors).
- GTEx tissue expression is additionally seeded as a `cx_connectors` database
  source per bridged user when `CXD_CONNECTORS=on` as well — a no-op on a host
  without `gtex.sqlite`.
- A known database with no file installed answers a clear **503** ("not
  installed; set `CXD_SQLITE_DIR`"), not a 500. Nothing is enabled unless the
  flag is on, so existing deployments are unaffected.
- New **`cxd-reference-data`** CLI (`cxd_server.reference_data`) to install those
  databases, offline-first for air-gapped sites: `status` (what is installed in
  `CXD_SQLITE_DIR`), `verify <db>|all` (a hand-dropped file is readable + has the
  expected tables — catches a truncated/corrupt copy), and `fetch <db>` (download
  from a host-agnostic `CXD_REFERENCE_DATA_BASE_URL`, streamed to a temp file and
  checksum-verified against a `.sha256` sidecar, then moved into place so an
  interrupted download never leaves a half-written database). Air-gapped install:
  copy `<db>.sqlite` in, `cxd-reference-data verify <db>`, set the flag, restart.
- A deployment can **publish** the databases it holds (`CXD_REFERENCE_DATA_SERVE=on`)
  at `GET /reference-data/<db>.sqlite` (+ a cached `.sha256` sidecar, Range-resumable),
  so another install can `fetch` from it. Restricted to the openly-redistributable
  set (`gencode`/`gtex`/`wp`) by default; `CXD_REFERENCE_DATA_PUBLISH` overrides it
  once an operator has cleared TCGA/CCLE terms.
- **Docker:** [`Dockerfile.refdata`](Dockerfile.refdata) bakes the databases into a
  single self-contained image for air-gapped sites (you supply the files in the build
  context; a build-time check fails a mis-pathed/empty bake); `docker-compose.reference.yml`
  fetches them into a shared volume on first run for sites with egress. See
  [docs/reference-data.md](docs/reference-data.md).
- A packaged `python -m cxd_server` install now also **seeds the GTEx/GENCODE explorer
  dashboards** onto the Dashboards page when `CXD_REFERENCE_SOURCES=on` and the database
  is present (shipped as package data, read-only via the `/api/<db>` services — no
  connectors needed). Previously these dashboards existed only in the examples dev
  launcher, so a fresh install had the data + services but no pre-built board.
- `examples/dbservices.py` is now a thin re-export of `cxd_server.reference_services` (one
  source of truth, no drift); `cxd_server`'s package init is lazy so a stdlib-only submodule
  import no longer pulls in the web stack.

### Fixes
- **Significance brackets no longer collapse a multi-variable panel.** Bracket heights and
  the value-axis headroom were computed over the panel's *entire* bound matrix, so a Boxplot
  that plots one variable from a wide source (e.g. one gene from an expression matrix) took
  its extent from unrelated rows — pushing the brackets and the forced axis maximum far above
  the boxes and collapsing them. The extent is now taken from only the plotted variables
  (`config.xAxis`).
- **Removing significance restores the axis.** The brackets forced a value-axis maximum
  (`setMaxX`) for headroom; **Remove brackets** now clears it too, so the panel auto-ranges
  back to its data instead of staying expanded.
- **Significance brackets can be removed.** The ✴ Significance dialog only let you
  delete individual comparison rows (and Apply still required ≥1), so there was no way
  to take significance off a panel once added. The dialog now shows a **Remove brackets**
  button when the panel already has significance; it clears `showStatInference` /
  `statInference` from the panel config and re-renders.
- **Transform control honours its widget style.** A `mode:"transform"` control ignored
  `style` and always rendered a dropdown, so picking **Radio** or **Buttons** in the
  builder had no effect. It now builds radios/segmented buttons/dropdown (matching
  annotation filters; `auto` = buttons for ≤4 methods, dropdown above), each preselecting
  the current method and applying the transform on change.

### Publication figure composer (multi-panel vector export)
- **Compose panels into one figure.** `composeFigureSvg(handle, opts)` /
  `exportFigureSvg(...)` stitch the chosen graph panels into a single **true-vector**
  multi-panel SVG — each panel is the engine's own `getSVGString()` output, re-rooted
  with a `viewBox` and placed on the dashboard grid (no rasterization). Auto **A/B/C**
  subplot labels (`labelStyle` `A`/`a`/`1`/`none`), an optional shared caption, explicit
  panel selection/order, and a `cols` override. Viewer toolbar **Download → Publication
  figure**.
- **Journal sizing + DPI.** `JOURNAL_PRESETS` (Nature/Cell/Science/PLOS/generic one- &
  two-column widths in mm), `figureDimensions({preset, columns, dpi, aspect})` and
  `mmToPx` size the figure to a journal column at print DPI.
- **PDF.** `composeFigurePdf` / `exportFigurePdf` flatten the composite to a single-page
  PDF — true-vector with an injected `svg2pdf`, high-DPI raster fallback otherwise.
- Engine requirement: the per-panel SVG seam needs the engine's `getSVGString()` preserved
  through `--secure` obfuscation (engine ≥ 71.9; the live CDN engine obfuscates it until 71.9
  is built and shipped).

### Reproducibility: provenance method lines + reproducible bundle export
- **Panel method footers.** A graph panel with `provenance.show` renders a one-line,
  auto-derived method line (figure-legend footer) describing what it computed — source
  origin, join, `pushdown` aggregate/filter/sort/limit, `calculatedFields`, data-function
  language, and chart stat overlays (loess/regression/forecast + CI). Author-pinnable
  (`auto:false` + `method`). Builder: select a panel → **Method** toggle.
- **Reproducible bundle export.** `exportReproducibleBundle(handle)` (viewer toolbar
  **Download → Reproducible bundle**) downloads a `.zip`: self-contained `spec.json`,
  per-source `data/` snapshots, per-panel `code/<panel>.R` + `.py` (from the engine's
  own emitters) plus data-function source snippets, a `methods.md`, and a `manifest.json`
  with capture time, dashboard/engine version, and a SHA-256 content hash (a stable
  figure fingerprint). Dependency-free (own ZIP + SHA-256 writers).
- **Spec 1.5.** Optional `panel.provenance` and `source.provenance`; additive migration.
- New [reproducibility guide](docs/reproducibility.md) and **Reproducible Provenance**
  example.

### Fixed: PNG/PDF export no longer paints the screen-reader data table over charts
- **The "Data table for chart" a11y overlay leaked into exports.** CanvasXpress's
  screen-reader-only data table (and live region) hide with `clip:rect(0 0 0 0)`, which
  html2canvas does not honour, so they rasterized on top of every chart in PNG/PDF.
  `dashboardToPng` now skips those nodes via `ignoreElements` (PDF inherits the fix).

### Data page sections collapse; one resizable side-panel width
- **File sources, Database sources and Databricks collapse** to their header (click the
  ▾ header). A collapsed card keeps only its header, the File/Database splitter hides
  meanwhile, and the choice is remembered in the browser.
- **The left column of every page is resizable, and they move together.** Drag the
  thin handle on its right edge (Builder's Assistant, the Dashboards list, Data, Settings);
  the width is one shared `--cxd-left-w` (240 px to half the window, default 320 px —
  Data's column was 300 px), remembered in the browser; double-click the handle to reset.
- The section chevrons are a proper line chevron (18 px, text colour) with a hover
  highlight on the header.

### Fixed: charts re-fit when their area changes width
- **Dashboards never re-fitted a chart to its cell on resize.** The per-cell observer
  required `setDimensions` when it attached, but the CanvasXpress constructor attaches its
  methods asynchronously, so no observer was ever installed. It now attaches and checks
  `setDimensions` when a resize applies; a chart is redrawn only when its cell size really
  changed. Fixes dashboards in the viewer, the Dashboards View pane and Settings preview
  after a window or side-panel resize.
- **Builder:** after the stage changes width, graphs that no longer match their cell are
  re-fitted (only those); the listener is removed when the builder is destroyed.
- **Data page:** the preview table is redrawn on every resize (debounced), at the width its
  card now has — measured from the card, since a CanvasXpress table shrink-wraps its host
  and the host alone would never let it grow (a table view also ignores `setDimensions`).
  Later previews reuse the new width.
- `resizeInstance(instance, w, h)` is exported.

### Comments / Ask / Reset cross-filter: centered in the View pane's bottom strip
- The bottom-strip controls share `--cxd-pill-bottom` (default 16 px). The Dashboards View
  pane centers them vertically between the preview and the window's bottom, re-placing them
  (and their left edge) on resize, so they follow the side-panel width.

### Fixed: comments, Ask history and dashboard deletion on the SQL (Postgres) store
- `SqlDashboardStore` now has the comments and Ask-history methods `DashboardStore` has
  (`cxd_comments` / `cxd_asks` tables, created on start), so every comments/Ask route works
  on a Postgres deployment instead of returning 500. A test fails if the two stores' public
  methods ever diverge again.
- **Deleting a dashboard** forgets its grants first, then removes the dashboard, its comments
  and its asks in one transaction (`purge_dashboard`): a failure no longer leaves a deleted
  dashboard with grants behind, and a re-created id starts clean. Retrying is safe.
- **Deleting a user** now also removes the comments and asks on their dashboards, and cleans
  grants/schedules/SSO links before the account, so a failure deletes nothing. Comments they
  wrote on other people's dashboards are kept.

### Data page: Databricks catalog browser
- With `CXD_DATABRICKS_HOST` set, **Data → Databricks** browses Unity Catalog (SQL warehouse
  picker, catalogs → schemas → tables, filter and counts, columns and a 50-row preview) with
  **Save as source** and **Dashboard from this table**; a Home notice announces it. Works
  on or off Posit Connect (`CXD_DATABRICKS_AUTH`: `auto` | `posit-connect` | `token`); hidden
  when the host is unset. SQLAlchemy is capped below 2.1 (it breaks the Databricks driver).
  Docs: `docs/databricks-viewer-oauth.md`.

### View-time AI Q&A — "ask this dashboard"
- A signed-in viewer can **ask a question of a dashboard's data** and get an answer
  **computed from the numbers, not hallucinated**. New `POST /api/dashboards/{id}/ask`
  runs a bounded tool-use loop where the model may only call read-only data tools
  (`describe`/`aggregate`/`top_n`/`filter_count` in `ask_tools.py`) over the dashboard's
  resolved inline/dataset sources (row/column security applied) — no `eval`, no SQL; the
  model sees only tool results. Returns `{answer, used}` (the figures behind the answer).
  A floating **✨ Ask** box in the viewer (`mountAsk`, shown for users with `llm.use`).
  Gated on `llm.use` + view access; `503` when no `CXD_LLM_API_KEY`. Guide: `docs/ask.md`.

### Fixed: Escape no longer corrupts dashboard panels
- The engine's own "Click ESC to reset graph" handler was running on each panel and
  resetting its data view — revealing series/variables a dashboard had intentionally
  constrained (e.g. a hidden second measure appearing in a bar/boxplot) and double-restoring
  cross-filtered data (duplicated bars). A dashboard owns the composed view, so **Escape now
  does a dashboard-level reset only** (clear an active cross-filter, else snap controls and
  Filters back to All) and no longer lets the engine reset individual panels. Affects any
  board with bars/boxplots/constrained series (Sales Model, Cohort Explorer, Live Ops, the
  cross-filter demos, …).

### Collaboration: dashboard comments + threads + @mentions (server)
- **Viewer comments on a dashboard.** New `comments` table + store methods and REST API:
  `GET/POST /api/dashboards/{id}/comments`, `POST …/comments/{cid}/resolve`,
  `DELETE …/comments/{cid}`. Anyone who can **view** a dashboard (owner, a shipped example,
  or a share grant) may comment; **resolve/delete** is limited to the comment's author, the
  dashboard owner, or an admin. Comments thread (a `parentId` reply), can anchor to a
  `panelId`, carry parsed **@mentions** (validated against real users), and are audited.
  Deleting a dashboard removes its comments.
- **Comments rail in the viewer.** A floating **💬 Comments** control (with an unread count)
  opens a side rail where signed-in viewers post, reply in threads, **anchor a comment to a
  panel**, resolve/reopen, and delete their own comments; @mentions of known users are
  highlighted. `mountComments()` is exported and wired into the hosted app's `view.html` (it
  stays hidden for anonymous viewers).
- **@mention email.** Mentioning `@user` emails them a notification (the mention + a link to
  the dashboard) when the server has SMTP configured and the user has a deliverable address;
  best-effort, so a mail failure never blocks the comment. Guide: `docs/collaboration.md`.

### True no-code cross-filter (`markingMode: "filter"`)
- **A selection now filters, not just highlights.** A new fourth marking mode,
  `"filter"`, narrows every related panel to the selected (relationship-translated)
  rows — the signature BI cross-filter gesture — instead of highlighting them. The
  existing `focus`/`highlight`/`ghost` modes are unchanged. The panel the selection
  was made in is never narrowed by its own selection, and an empty selection clears
  the cross-filter on every related panel.
- **Composes with the Filters panel.** Cross-filter runs through the same
  `applyControlFilters` pass as control picks and Filters-panel predicates, so when
  both target a panel their row sets **intersect** rather than clobber. Implemented
  entirely client-side (reuses `filterUserData`); no SQL pushdown of synthetic row ids,
  so database-backed sources are unaffected. No engine (`build/js`) change.
- Added `"filter"` to the `markingMode` enum (`validateSpec`, `builderModel`, JSON Schema).
- **Three ways to clear a cross-filter.** The floating **✕ Reset cross-filter** control, the
  **Escape** key (the engine already shows "Click ESC to reset graph", so ESC now also undoes
  the cross-filter even on a board with no filter controls), or a click on empty space.
- **Cross-filter now works from a bar click.** Bar charts fire `select` with the picked
  rows and then, ~instantly, fire it again empty as the engine auto-deselects the bar; that
  spurious empty was wiping the filter the moment it was applied. In filter mode an empty
  selection landing within a short window of a real one is now ignored, so clicking a bar
  (or any chart that auto-deselects) filters and stays filtered — a genuine clear (the Reset
  control, or an empty-space click) still works.
- **Builder + viewer affordances.** The Links dialog's "When you select marks" picker now
  offers *Filter: narrow related panels to the selection (cross-filter)*, and the links
  summary reads "selections filter related panels" in that mode. At runtime a floating
  **✕ Reset cross-filter** control appears while a cross-filter is active and clears it in
  one click (an empty selection in the origin panel clears it too).
- **Docs + examples.** New guide `docs/cross-filter.md`, and two gallery examples:
  `cross-filter-demo` (orders ↔ reps on Region) and `cross-filter-genomics` (clinical
  patients ↔ expression samples on patient id — a tumor-response scatter cross-filtering
  an expression heatmap and a PD-L1 boxplot).

## 0.14.0 — 2026-10-14

### Remote function runtime: the main app is the only authorizer
- **Authorized runs are forwarded server-side.** With `CXD_FUNCTIONS_RUNTIME_URL`
  set, the browser still posts every function source to the main app, which applies
  all its checks (mode, role, approved admin code, audit) and then forwards the
  request to the runtime **server-side** — the main app never executes user code while
  a runtime URL is set, and no longer advertises the runtime URL to the browser.
- **Shared-secret auth on the standalone runtime.** `cxd_server.functions_app:app` now
  **refuses to start** without `CXD_FUNCTIONS_RUNTIME_TOKEN` and rejects any
  `run`/`selfcheck` whose `X-Cxd-Runtime-Token` header doesn't match (constant-time) with
  `401`; `status` stays open. Set the same token on the main app and the runtime. The
  token is never logged and never reaches the browser config. A spec's own `runtime`
  still calls its URL directly and bypasses this authorization (document before exposing).
- **Admin self-check forwards.** `GET /api/functions/selfcheck` forwards to the runtime
  when a runtime URL is set and returns its report, labelled as the remote runtime's.
- The server **warns at startup** if `CXD_FUNCTIONS_RUNTIME_URL` is set without
  `CXD_FUNCTIONS_RUNTIME_TOKEN` (forwarded runs would otherwise get a confusing `401`).
- `CXD_FUNCTIONS_RUNTIME_CONNECT_KEY` sends a Posit Connect API key
  (`Authorization: Key …`) on forwarded requests, for a runtime behind Connect's login.

### Harden whenever snippets may run on this host
- The server now calls `prctl(PR_SET_DUMPABLE, 0)` at startup when functions are enabled
  **or** a runtime URL is configured (a same-host runtime runs as the same OS user), not
  only when the embedded runtime is on.

### Built-in connectors on any database, with packaged demo sources
- **`CXD_CONNECTORS_DB` may be a URL.** A bare SQLite path (as before), a `sqlite://` URL,
  or a `postgresql://` URL (via `cx_connectors.sqlstore.open_store`), so the connectors
  store can live in the same database as the rest of the deployment. A directory is only
  created for a bare path, and the startup log shows `scheme@host` (never a password).
- **Demo sources shipped with the package.** `CXD_CONNECTORS_DEMO_SOURCES=on` seeds every
  bridged user with read-only demo database sources from a demo SQLite database shipped as
  package data (rebuilt deterministically if an install lacks it) — so a plain server-only
  deploy behaves like the `examples/` dev launcher. Seeding adds each source once, re-saves
  one whose stored path has drifted between deploys, and never touches a user-created source.
- The `/connectors` session cookie now honours `CXD_HTTPS_ONLY` (gets the `Secure`
  flag), matching the dashboards app's own session cookie.
- Demo-database copies are written atomically (temp + `os.replace`) and re-copied if
  their size drifts from the packaged database — safe under multiple worker processes.
- **Sales Live** is now a packaged `sales` demo source (revenue by region, live jitter via
  SQL `RANDOM()`), so the example renders on any install / Connect, not just the dev launcher.
- Requires `canvasxpress-connectors[web,sql]>=0.8`.

### Data-function sandbox hardening
- **BLAS/OpenMP thread pools pinned to 1** in the snippet environment
  (`OPENBLAS_NUM_THREADS` etc.), so numpy's OpenBLAS no longer over-reserves per-core
  buffers and fails under the memory cap on many-core hosts.
- **Filesystem writes confined.** The `auto` wrapper now denies writes outside the run's
  temp dir: macOS `sandbox-exec` denies file-write outside the temp roots; Linux prefers
  `bwrap` (read-only root, writable temp, no network) and falls back to `unshare -rn`.
  The self-check reports `fileWrite: blocked` where supported.
- R functions still need the `jsonlite` package on the host (install it on Connect); the
  runtime already hides R when it is missing.

## 0.13.0 — 2026-10-14

### Data functions: runtime hardening for shared hosts
- **Server environment hidden from snippets.** On Linux, when data functions are
  enabled the server calls `prctl(PR_SET_DUMPABLE, 0)` at startup (per worker), so a
  same-user snippet can no longer read the server's secrets out of
  `/proc/<pid>/environ`. No-op on other platforms; the startup log reports whether it
  applied.
- **Isolation self-check.** New admin-only `GET /api/functions/selfcheck` runs one
  probe through the exact snippet launch path (same wrapper, limits, minimal
  environment) and reports `blocked`/`allowed` — never the data — for reading the
  server's / other processes' `/proc/.../environ`, connecting to
  `CXD_FUNCTIONS_PROBE_TARGET`, and writing outside the sandbox temp dir. Measure
  isolation instead of trusting the wrapper.
- **Server-wide remote runtime.** `CXD_FUNCTIONS_RUNTIME_URL` sets a default runtime
  for function sources without their own `runtime` (a per-spec `runtime` still wins),
  injected into the served app. New standalone `cxd_server.functions_app:app` serves
  only the runtime contract (run / status / selfcheck), needs no database or secrets,
  and refuses to start if the server's secret variables are present — so untrusted code
  can run in a separate, secret-free app.

### Database dashboards: source editor, query controls, panel dialog, guided path
- **Data → + Database (and ✎) is a full editor** in a wide dialog: name; the connection
  (same database as an existing source, or a URL); a **table browser** (tables and
  views → columns with their types, click a column to insert it); templates — **All
  rows**, **Values for a Control** (`SELECT DISTINCT`), **Rows for a :parameter**; the
  SQL with its `:parameters` detected, each with a sample value; and **▶ Test**, which
  runs the UNSAVED query (read-only, capped at 200 rows in the database) and previews
  it. Server: `POST /api/connectors/schema` (tables, or one table's columns: catalog
  only, SQLAlchemy `inspect`) and `POST /api/connectors/test` (same read-only check as a
  saved source; params bound, never interpolated) — both session-guarded, taking
  `{source}` (one of the user's SQL sources) or `{conn_url}` in the body.
- **Builder → + Control asks what the control does:** *Filter this page* (as before) or
  *Query a source*: values from a column of one source (its value count and first
  values shown), the source it re-runs, the `:parameter` read from that source's SQL
  (highlighted), a starting value (type-ahead over the values), title and style. One
  click wires the parameter, the choices and the query binding; a database source the
  dashboard does not use yet is added. Enabled with database sources even on an empty
  dashboard. New model helper `addQueryControl(spec, opts)`.
- **Builder → + Panel opens a dialog** with a live preview: data source (defaults to the
  one a control re-runs), chart type, then X / Y / Color by for a scatter plot or X
  (measure) / Group by / Color by for the others (Ridgeline groups by `ridgeBy`;
  Histogram / Density take no group; default groups only a column with ≤ 100 values),
  plus **Extra config (JSON)** applied last (invalid JSON reported, not applied). A
  source with no number column says so instead of drawing. Helpers (wizard.js):
  `WIZARD_CHART_TYPES`, `chartFieldsFor`, `buildChartConfig`, `chartColumns`,
  `orientConfig`. The builder handle gains `openControlDialog(prefill)` and
  `openPanelDialog(prefill)`.
- **＋ Dashboard from database** (Dashboards toolbar, Data → + Dashboard, the Home card)
  is now a guided path through those same tools: a title, then the source editor twice
  (*the values to pick from*, *the query a pick re-runs* — same database, parameter name
  carried over, the template written on the first column click), then a new dashboard
  in the Builder with **+ Control** and **+ Panel** opened prefilled; saved at the end.
  Suggested source names never replace existing ones (`-2`, `-3`…); cancelling midway
  removes the sources it saved. Pure helpers kept: `sqlParamNames`, `paramNameFor`,
  `choicesSql`, `detailSql`, `connectorSourceUrl`, `databaseExplorerSpec`.
- A full-width **Dashboard from database** card on Home explains the pattern and starts
  the guided path (sign-in first when signed out).
### Dropdowns and wizard fields
- **Every dropdown** in the app, dashboards, builder and dialogs draws the engine's chevron
  (two `currentColor` diagonals: follows light/dark) inset ~12px from the right border,
  with 30px of padding so text never runs under it (it used to sit on the border). Scoped
  to the dashboards' own roots — an embedding page keeps its selects — and the engine's own
  selects (customizer, data filter) keep theirs; forced-colors falls back to the native arrow.
- **Wizard fields:** inputs and dropdowns share one 38px box (same padding, border, font)
  with 6px between label and field.

### Wizards: scatter-family charts and card picking
- **Ridgeline, CDF, Density, Scatter2D… work on uploaded and database data.** The chart
  selector names columns; when rows are samples (a CSV or a SQL query), scatter-family
  charts now get the engine's `transposeData` (new `orientConfig(config, data)`,
  wizard.js), so a Ridgeline has its ridges (it used to crash the engine) and a CDF its
  curve (it used to plot one point) — in the cards and in the saved dashboard. Both
  wizards ("Chart from data", "Dashboard from database").
- Clicking a card's **chart** now picks it (the chart used to swallow the click; only
  the title worked).
- UI tokens regenerated from the engine (`--cx-z-footer-link`, dark `--cx-ui-border-accent`
  follows `--cx-ui-dark-border-accent`); the token-fallback test is green again.
- New pure helpers (wizard.js, exported): `sqlParamNames`, `paramNameFor`,
  `choicesSql`, `detailSql`, `connectorSourceUrl`, `databaseExplorerSpec` — a param
  Control (`dropdown`, or type-ahead `search` past 50 choices) over a chart re-queried
  with `query: {<param>: "$<param>"}`.

### Builder: data-flow card
- Selecting a **param control** or a **chart it feeds** shows a floating card with the
  wiring: control (and where its choices come from) → `$param = <current value>` → the
  source it fills → the panels it feeds. Names select the element; a 🗄 database
  source offers **SQL** (read-only, `:param` bind parameters highlighted) via the new
  `describeConnectorSource(name)` builder option. Updates live as controls change
  (new `onParamChange(param, value, done)` render option). `×` hides it until the
  selection changes; it never shifts the layout.
- `sourceUsesParam(source, param)` (spec.js) is now the single definition of "this
  parameter feeds this source", shared by the renderer's re-query and the card.

### Builder: chart ↔ table switch
- **▦** on a chart's frame (or **▦ Table** in the toolbar when a chart is selected)
  switches that panel's own CanvasXpress plot between its canvas and its built-in
  data table — the engine's `changeView` (what its toolbar "View table" does), so
  it is the chart's real data. **◧ Chart** / ▦ switches back.
- **Record limit:** the Data page's database-source preview is capped at 500 rows in
  the database itself (pushdown `limit`).

### GTEx and GENCODE explorers in the app
- **GTEx Gene Explorer** and **GENCODE Genome Browser** ship as Dashboards-page
  examples (positions 5 and 6), openable in the Builder. GTEx reads two connectors
  database sources seeded per user (`gtex-genes`, `gtex-expression` with `:gene`),
  so its query and data are visible in the Builder; GENCODE's nested genome tracks
  stay on `/api/gencode`.
- **Connector URLs resolve against a subpath `baseUrl`:** a root-relative connector
  URL (`/api/x`, `/connectors/...`) is prefixed with a same-origin path base
  (`/dashboards`), like dataset and live sources — so stored specs work at the app
  root, behind Apache, and from `examples/view.html`. Absolute-origin bases
  (cross-origin embeds) are unchanged. New `prepareConnectors` store option (falls
  back to `prepareLive`): opens the connectors session before the first database
  fetch; `view.html` now bridges that session.

### Filters reach every panel that shares the field
- A Filters-panel predicate now also narrows a panel on another source that carries
  the same field, with no declared relationship: a sample (x) annotation narrows
  samples (`filterSmpBy`), a variable (z) annotation narrows variables
  (`filterVarBy`). A source shaped with `pushdown.groupBy` on that field matches its
  row ids (Sales Model: Product → "Revenue by product").

### Shipped examples stay in sync
- `examples/serve.py` re-seeds a shipped example when its spec file changes
  (sha256 in `seed-state.json`), so fixes reach the stored copy the Builder opens;
  an explicit `shipped_order` sets their order on the Dashboards page.
- Reproducible Bench: the survival grouping is named `cluster` (was `group`), so one
  cluster control filters the heatmap and the Kaplan–Meier plot.

### Assistant sees the shared example datasets
- **Fix:** the assistant (`POST /api/llm/dashboard`) cataloged only the signed-in
  user's own datasets, while its checklist (`GET /api/datasets`) also shows the
  shared example datasets (owner = `CXD_EXAMPLES_OWNER`) — so ticking "Bench: …"
  still produced "no stored datasets" and inline sample panels. The catalog now
  matches the checklist (own + example datasets, the user's own id winning on a
  clash, row/column security applied). Grant-shared datasets remain out of the
  catalog: a spec source cannot name an owner yet.

### Phones: single-column stacking
- **`layout.stackBelow` (default 640):** when the dashboard container is narrower than
  the breakpoint, the grid stacks to one full-width column in reading order (by row,
  then column), each panel keeping its own height; it restores on resize back. The
  per-cell ResizeObservers re-fit every chart to its new cell. `false` disables;
  the builder is never stacked (it edits the real grid coordinates). Schema + both
  validators (JS and server) accept the key.

### Builder: undo / redo
- **Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z (or Ctrl+Y), ↶/↷ toolbar buttons**, and `undo()`/
  `redo()` on the builder handle. Snapshot history over the spec (100 entries);
  rapid commits — a drag's per-move previews, a typing burst — coalesce into one
  entry, so undo reverts the whole interaction. Text fields keep the browser's
  native text undo; a JSON-editor apply is one discrete step.

### Follow the website's style preset
- **Site-theme bridge:** the app shell now follows the style preset a visitor picks on
  canvasxpress.org (navbar palette icon; same-origin `localStorage` `cx-site-theme`, or
  `?theme=<name>`). `examples/site-themes.css` is GENERATED from the website's design
  tokens (`canvas-ai/tools/site-theme/gen-dashboards-themes.py`) and maps each preset
  onto the `--cx-ui-*` roles the chrome is built on; `examples/site-theme.js` applies the
  pick before paint and forces `data-cx-ui-theme="dark"` for the always-dark presets.
  No pick (or "classic") = the engine look, unchanged. `scripts/build.mjs` copies both
  next to the served shell; `examples/serve.py` routes them app-root-relative.

### Drill-through actions (spec 1.4)
- **Per-panel `actions`:** graph panels can declare `actions` — on a mark click,
  `setParam` (set a dashboard parameter and re-query, generalizing
  `clickParam`/`clickField`), `setFilter` (`{dataRef, field}` → write a `values`
  predicate into the global filter model so the Filters panel and cross-source marking
  follow), or `focusPanel` (scroll a target panel into view). Additive spec **1.4**
  (`clickParam`/`clickField` still accepted). Schema, validator (name ∈ params, dataRef ∈
  data, focusPanel ∈ panels) and builder model updated.

### New chart from data (data-first wizard)
- **Dashboards → ＋ Chart from data:** Upload (file, paste or URL — parsed by the
  CanvasXpress engine's `loadFile`, no new parser) → Check (per-column type,
  missing values and flagged bad cells over a live table; transpose; decimal-comma
  conversion) → Visualize (chart types ranked by the canvasxpress-mcp selector,
  each drawn live; editorial theme preselected; full picker without the MCP) →
  Publish (dataset + one-chart dashboard + share link + embed codes).
- `POST /api/wizard/suggest` (via `mcp_bridge.select_charts`, bounded sample);
  helpers `tableFromData`, `profileColumns`, `applyDecimalComma`, `wizardSpec`;
  client `wizardSuggest`. New browser gate `npm run test:wizard`; new `shell-wizard`
  UI case.

### Publish & embed a chart
- **Embed a whole dashboard or one chart** from its share token: a minimal-chrome
  `embed.html` that grows its iframe to its content (`postMessage`), a `<cxd-embed>`
  web component (`embed.js`), and a PNG fallback (`/api/shared/{token}/image.png`)
  for RSS and email, rendered anonymously through the snapshot renderer and cached.
- `GET /api/shared/{token}?panel=…` prunes to one panel and its source dependencies
  **before** datasets are read; `GET /api/shared/{token}/embed` returns the codes;
  the share response carries whole-dashboard codes. Client: `loadShared(token,
  {panel})`, `embedCodes(token, {panel, height})`.
- The builder's share box gains an **Embed** picker with copy buttons. Saving
  republishes every embed in place (same URL; every save is a version).
- **Organisation brand lock:** `CXD_BRAND` forces top-level spec keys (theme,
  colorScheme, fontName, background, …) on non-admin saves and on every shared
  view; the builder greys out those controls.
- The builder's theme list includes the engine's new `editorial` theme.
- New browser gate `npm run test:embed` (real server + cross-origin host page).

## 0.11.0 — 2026-09-29

### One look with CanvasXpress (UI design system)
- **The dashboard styles use the CanvasXpress design tokens.** `dashboardCss` reads the engine's
  `--cx-ui-*` roles and `--cx-*` steps (colours, radius, shadows, fonts, z-layers) from
  `canvasXpress.css`, so the dashboard chrome and the charts' own widgets share one palette, and a
  `dataUIStyle`-free page gets the CanvasXpress look.
  - The dashboards' own `--cxd-*` properties now default to those roles (still overridable per
    dashboard: panel colours, `fontName`).
  - A generated fallback (`src/uiTokens.js`, from the engine's `tokens.json`: `npm run tokens`,
    checked by `npm run tokens:check`) keeps it working on a page without `canvasXpress.css`.
- **One accent.** The builder's blue (`#2f6feb`) is the CanvasXpress indigo now.
  - Builder buttons are the shared `.cX-Button` (the `cxb-btn` classes stay).
  - Filled buttons and the active segment use the AA-safe strong accent.
- **Fixed:** the Filters panel checkboxes were a near-invisible 10% tint; they now use the accent.
- **Fixed:** builder modals sat on the same z-index as CanvasXpress panels (10000); they use the
  shared modal layer now.
- Muted text is darker (WCAG AA), panel corners are 10px, and shadows and backdrops match the
  engine's dialogs.
- Needs CanvasXpress 70.6 or later for the shared primitives. With an older engine the tokens
  still come from the fallback, but builder buttons render unstyled.
- **The app and its pages use the same tokens.** The builder shell, the viewer toolbar
  (`view.html`, moved into `dashboardCss`), the examples gallery, the example pages, the shared
  read-only view, the server banner, the snapshot page and exported HTML all read the
  CanvasXpress roles. Links and the active accents are the CanvasXpress indigo.
  - The 18 example pages no longer each carry a copy of the top-nav CSS; `example-header.css`
    owns it. The gallery links the new generated `examples/ui-tokens.css`.
  - In OS dark mode, example-page and gallery links use the dark accent (the old blue was below
    WCAG AA on the dark bars).
  - The exported page's favicon is the indigo accent.
- **One dark mode.** A dashboard's theme now sets `data-cx-ui-theme` (`light` / `dark` /
  `auto`) on its container: the same switch CanvasXpress uses, so the charts' own toolbar,
  menus, Customizer and data table go dark with a dark dashboard (they used to stay light).
  - The builder's modals follow the dashboard; the viewer, shared and exported pages follow the
    dashboard they show; the app shell and example pages follow the OS (`auto`). Every
    separate OS dark-mode stylesheet is gone.
  - A dark dashboard paints its own backdrop, so embedded in a light page its text stays
    readable.
  - Dark-mode contrast meets WCAG AA across the app (checked by the UI gate).
  - Needs CanvasXpress 70.6 or later for the charts to follow; the dashboard chrome works with
    any version (the tokens come with the package).
- **Your own colours.** Override any `--cx-ui-*` variable with `!important` on `.cxd-dashboard`
  (dashboard chrome) or `[data-cx-ui-scope]` (the charts' widgets); it holds in light and dark.
- The app's dialogs and its remaining buttons use the shared CanvasXpress modal and button.
- `npm test` now also checks that the package stays on the shared tokens and the one dark mode.
- **Checkboxes and radios match CanvasXpress:** a rounded box with an accent fill and check
  (a ring and dot for radios), in light and dark, across the Filters panel, builder dialogs and
  the app (the dashboard adds the `cX-UI-Controls` class; needs CanvasXpress 70.6).
- The shipped examples' description text uses the theme's muted colour, so it reads in dark mode.

### Linked selection without JSON
- **🔗 Links (builder toolbar).** Link two data sources on a key, so selecting
  marks in a panel on one source marks the related rows in panels on the other:
  pick each source and its key (the row id, an annotation, or a column, listed
  from the source's data), then **+ Link**. The dialog lists the links (each
  removable) and sets how a selection shows (**Focus** / **Highlight** /
  **Ghost**). It writes the existing `spec.relationships` and `markingMode`, so
  the spec format doesn't change. Enabled once a dashboard has two sources.
- **+ Data → Join two sources.** Blend two sources into one on a key, choosing
  which rows to keep (inner / left / right / outer). It writes a `kind: "join"`
  source; the join also links its inputs for marking.
- New pure model functions, exported: `addRelationship`, `removeRelationship`,
  `setMarkingMode`, `buildJoinSource`, `encodeKeys`, `describeLink`,
  `MARKING_MODES`.
- With CanvasXpress 70.4 and earlier, **Highlight** and **Ghost** don't draw
  marked sample rows differently (the engine's mark colouring checked only
  variable highlights). Fixed in the engine's next release; **Focus**, the
  default, works on every version.

### Filters panel in the CanvasXpress Data Filter style
- Each field is a **card** like the core library's Data Filter. A list of
  values has a **Search values…** box, a **(Select All)** row (mixed when only
  some values are picked; unticking it filters everything out) and live
  **"visible / total"** counts: rows with that value that pass every current
  filter / all rows with it. The counts update on every change without
  redrawing the panel, so a search or scroll is kept. With several fields, a
  **Search filters…** box narrows the cards by name.
- The elements carry the Data Filter's own classes (`cX-DataFilter-Container-
  Hoverable`, `cX-DataFilter-Search`, `cX-Checkbox`, `cX-DataFilter-Count`, …),
  so the panel follows the loaded CanvasXpress theme. The dashboards styles
  repeat the same values through the same `--cx-*` variables, so it looks the
  same without `canvasXpress.css`.
- Unchanged: the scheme bar, the range sliders (already styled like the Data
  Filter's), and database sources showing values without counts.
- **Dark / auto theme:** the cards follow the dashboard's dark palette (light
  field names, dark search boxes and lists, a brighter accent). The core Data
  Filter has no dark variant, so its light colours had left dark field names on
  dark cards and white boxes in a dark panel. **Fixed** in the same change: the
  scheme bar's picker and buttons were white with light text in dark mode
  (`--cxd-ctrl-bg` had no dark value).
- Cohort Explorer: the Filters panel is 18 rows tall (was 14), so all five
  fields show without scrolling. The charts beside it take two rows of 9, and
  widths are unchanged.

### Sales Model example
- `examples/sales-model.html` shows all four features on 24 orders and 8
  customers: calculated fields (Margin, Margin %, a quantile Size band that the
  Filters panel lists), a product summary grouped in the browser, orders and
  customers linked by customer, and a join for revenue by segment. With a
  CanvasXpress older than the release after 70.4 it explains that the fields
  are missing and plots revenue against cost instead. It's seeded as a shipped
  dashboard in the demo host; its sources keep their `calculatedFields` and
  `pushdown` when moved into the dataset store.
- App Home page: new **Calculated fields** and **Shape your data** cards
  (both link to the Sales Model). **Blend and link sources** now points at
  🔗 Links and + Data → Join, and **Scheduling** mentions parameter values.

### Build: bundles can no longer miss a module or an export
- **Fixed:** the bundles left out the new `src/pushdown.js`, so
  "runPushdown is not defined" broke Shape data and any browser-run query in
  the built app. `scripts/build.mjs` inlined a hand-kept module list, and a
  module missing from it had its import line dropped silently.
- The build now fails, naming the file, when a source module or an internal
  import is missing from that list or listed after a module that needs it.
- The bundles' public API is now read from `src/index.js` instead of a second
  hand-kept list. Besides the new functions, `parseSchemaVersion`,
  `DASHBOARD_SCHEMA_URL`, `MIGRATIONS` and `pushdownQuery` were missing from
  the bundles before this and are now exported.

### Database sources in the server itself (`CXD_CONNECTORS=on`)
- The canvasxpress-connectors integration moved from the demo host
  (`examples/serve.py`) into `cxd_server.connectors`. `python -m cxd_server`
  (and so the Docker image) now offers per-user database sources when
  `CXD_CONNECTORS=on`. That covers the `/connectors` app, the session bridge
  (`/api/connectors/credentials`, `/sources-meta`, `/source`), and scheduled
  refresh from a database source. Before, only the demo host had them.
- **`ENCRYPTION_KEY` is required and never generated** by the server: it is the
  only way to read stored connections back. A missing or invalid key, a missing
  package or a missing session secret stops the server at start with a message
  saying what to do. New `[connectors]` extra (canvasxpress-connectors 0.6+).
- **Scheduled refresh binds parameter values:** a refresh origin takes `params`
  (`{kind: "connector", source, params: {region: "EMEA"}}`) for the source
  query's bind parameters. A name the query does not declare fails the run, and
  a parameter left out stays NULL, as before. Host fetchers with two arguments
  keep working.
- The routes install ahead of the server's static app shell, which is mounted
  at `/` and would otherwise swallow them.
- The demo host now calls the same code, keeping only its demo conveniences
  (a generated key file for the demo data, seeded inventory sources).
- Docs: `docs/deployment.md` (including one-store-one-host: the connection store is a
  SQLite file), `.env.example`, the Dockerfile.

### `pushdown` runs in the browser for sources without a database
- **inline, dataset and function sources** now take a `pushdown` query
  (`where`, `columns`, `groupBy` + `measures`, `orderBy`, `limit`, `$param`
  values). It runs in the browser with the connector's semantics (SQL null
  rules, the same measures and operators, `orderBy` over outputs, and the
  connector's rows → CanvasXpress rule for aggregates), so a spec gives the same
  answer whether its rows come from a database or a file. The new
  `tests/fixtures/pushdown-parity.json` holds the real connector's output over
  SQLite for 10 queries; the browser executor must match it exactly.
- A **Filters panel** over such a source applies its picks inside the query,
  before any group-by, as a database does.
- **Fixed:** a join whose query could not run in the database (inputs in
  different databases) silently dropped its query after the browser join; the
  query now runs in the browser.
- A `$param` in any source's `pushdown.where` re-resolves the source when the
  param changes (was connector-only).
- New module `src/pushdown.js` (`runPushdown`, `rowsToCx`). Sources without a
  query resolve exactly as before.
- **▦ Shape data (builder toolbar):** build a source's query without JSON:
  keep only rows where (readable operators, `a, b, c` lists, `lo, hi` ranges,
  `$param` values), then keep some columns or summarize (group by + count,
  count distinct, sum, average, min, max, optionally named), sort, and keep the
  first N. A live preview runs the query on the source's rows (a database
  source's query runs in its database). New model function `setSourcePushdown`.

### Calculated fields on a source (spec format 1.3)
- **`calculatedFields` on a data source.** Fields computed once on the
  source's data, so every panel, Filters panel, join and link on the source
  sees them, like columns of the source itself: `{name, target?, formula}`
  (e.g. `"Revenue / Units"`, `"Revenue / sum(Revenue)"`,
  `"Age >= 50 ? \"50+\" : \"<50\""`) or `{name, target?, bin: {field, method?,
  bins?, breaks?}}`. `target` is `variable` (a number column, default),
  `sampleAnnotation` or `variableAnnotation`. Fields apply in order, so a later
  one may use an earlier one; a join adds its own on top of its inputs'.
- Evaluated by the CanvasXpress engine's own formula language (tokenizer +
  parser, never `eval`) through its new static
  `CanvasXpress.applyCalculatedFields`, so a dashboard field behaves exactly
  like a chart's calculated field. **Needs the CanvasXpress release after
  70.4**; with an older engine the data shows without the fields and a warning
  is logged once per source.
- **ƒx Fields (builder toolbar):** per source, list, add and remove fields: a
  formula (with the fields and functions listed) or bins of a number column,
  with live validation and a preview of the first values.
- Spec format **1.3** (additive; 1.2 specs migrate with no rewrite). The
  client and server validators check the shape; the JSON Schema documents it.
- `createDataStore` takes a `CanvasXpress` option; the store's `resolve`
  applies the fields, and the new `resolveSource` resolves without them. New
  model functions: `setCalculatedField`, `removeCalculatedField`,
  `describeCalculatedField`.

### Live data (streaming) ([docs/live-streaming.md](docs/live-streaming.md))
- **`kind: "live"` source.** A panel subscribes to a canvasxpress-connectors
  Server-Sent-Events stream (`url`) and each message appends new samples to the
  chart via the engine's `pushData`, keeping a bounded rolling `window`
  (default 1000). Optional `variables` and `initial` seed the starting chart;
  without `initial` the panel shows *Loading…* until the first message.
- **One redraw per frame:** messages arriving between frames are merged first.
- **Fallback:** a CanvasXpress build without `pushData`, or a transposing panel,
  gets `updateData` over the window the renderer keeps.
- Cookie-authenticated (no credential in the browser); native reconnection
  keeps the last data on screen; `destroy()` closes the streams.
- `createDataStore` gains `subscribe()` and an `EventSource` option;
  `renderDashboard` gains `EventSource` / `requestAnimationFrame` options.
  `validateSpec` checks `url`, `window`, `variables` and `initial`.
- **No code:** the builder's Data list offers the server's streams (📡, via the
  new `listLiveSources` option); a bound panel gets **Window** and **Every (s)**
  fields. The app lists streams from the connectors app's `GET /api/streams`.
- **Session:** `renderDashboard` / `createBuilder` take `prepareLive`, run once
  before streams open; the app passes its connectors bridge, so a live dashboard
  opened in a fresh session still streams.
- **Spec format 1.2** (additive): the live source kind, in `src/spec.js`, the
  server validator and `schema/dashboard.schema.json`. The server now accepts —
  and the AI builder can author — live dashboards.
- **Governance:** subscriptions are audited as `live.subscribe` (actor, stream,
  allowed or refused); lineage lists live streams (`live`). Streams follow the
  connectors access model; row/column rules stay dataset-only.
- **Home:** a *Real-time streams* card.
- **Example:** [Live Ops](examples/live-ops.html) — two live panels over a 24-hour
  snapshot. Signed in, it streams from the server; on a static host or for an
  anonymous visitor, the page simulates the same messages in the browser. Works
  behind a reverse-proxy subpath.
- A tick that reaches a chart before it has initialised (or that fails) is no
  longer lost: the chart resyncs from the full window, then continues with
  increments.
- A stream that fails for good (e.g. the server has no such stream) marks the
  panels still waiting for data as *Live stream unavailable* instead of leaving
  them on *Loading…*.
- **Audit:** requests into the mounted connectors app are resolved by their full
  path, so the connectors sign-in (the session bridge) is recorded as
  `connectors.login` — no longer as a dashboards `auth.login` — and source changes
  as `connectors.source.save` / `.delete`.
- Live Ops ships in the app's Dashboards view (seeded like the other examples).

### Electronic records and signatures ([docs/compliance.md](docs/compliance.md))
- **Versions.** Every dashboard save appends an immutable version (spec, who,
  when, SHA-256). Versions are kept when the dashboard is deleted; restoring
  saves a new version; an older dashboard gets a baseline version.
- **E-signatures** on a version:
  - a meaning (`CXD_SIGNATURE_MEANINGS`) and re-authentication (password, or a
    single sign-on within `CXD_SIGN_REAUTH_SECONDS`, with `prompt=login`);
  - bound to the version's SHA-256 and hash-chained;
  - shown with the version, with a validity check;
  - `/api/admin/signatures/verify` re-checks all of them.
  - A new `dashboard.sign` permission (editor).
- **UI:** Dashboards → **History** lists versions, signatures, preview, restore
  and sign.
- **Guide:** a control-by-control Part 11 mapping stating what the software
  provides and what the regulated company must still do.

### Running several servers ([docs/deployment.md](docs/deployment.md))
- `GET /healthz` (liveness) and `GET /readyz` (readiness: stores, governance,
  schedules, audit log, datasets, scheduler thread; `503` names the failure).
- Verified on Postgres: two servers sharing one database and `SESSION_SECRET`
  share sessions and data, keep one audit chain, and run a due schedule exactly
  once (`tests/test_postgres.py`, run in CI against the Postgres service).
- A guide for several processes and hosts: requirements, the scheduler, health
  checks, rolling upgrades, backups.

### Data functions: see the code, survive a busy runtime
- A chart fed (directly or through a join) by a `kind:"function"` source gets a
  **`</> Code`** button in its title bar: a dialog lists each source step (data,
  join, the R / Python code with Copy) and the CanvasXpress config that draws
  it. Opt out per panel with `showCode: false`.
- In the **Builder** the button moves into the panel toolbar (next to ⚙, where
  the title-bar button was covered) and the dialog is an **editor**: change the
  R / Python code or the chart config JSON and Apply to re-run and re-render
  (invalid JSON is reported, not applied). Save as usual to keep the edits.
- **Admin-authored functions for everyone.** In `CXD_FUNCTIONS=admin` mode,
  code saved in an administrator's dashboard (exact language + code, checked
  server-side on every call) now runs for any signed-in user; other code stays
  admin-only. `GET /api/functions/status` adds `canAuthor`; for non-authors the
  Builder's *+ Function* and the code editor's Apply are disabled (the code stays
  readable). The demo seeds Cohort Explorer and Dose–Response Lab under `admin`,
  locked and shared view-only with everyone (an earlier `app`-owned copy is moved).
- **Dashboards list:** the "👥 from <owner> · view only" pill is now a small icon
  describing *your* access, with the owner and permissions on hover: 🔒 = view
  only; 👥 = you can edit a board shared with you, or you own a board you shared
  (tooltip lists who, from the new `sharedWith` on your own rows in
  `GET /api/dashboards`); no icon = yours / editable and unshared. The two
  data-function showcases are pinned 2nd (Cohort Explorer) and 4th
  (Dose–Response Lab).
- **Disposable dashboards** (`CXD_DISPOSABLE_DASHBOARDS=owner/id,…`): any
  signed-in user may view, save and **delete** them (list rows carry
  `disposable`). The demo ships a **Sandbox** (`admin/sandbox`, shared edit with
  everyone) that it recreates from `examples/sandbox.spec.json` whenever it is
  missing — on every restart / deploy; an edited copy is kept as is.
- **Admin view in tabs:** Users, roles & groups · Lineage · Default examples ·
  Audit log (the last tab is remembered).
- **No silent same-name forks.** Saving a NEW dashboard under the id of one you
  can see but not change (a shipped example, a view-only share, another
  owner's board) is refused with `409` ("owner: …; save under another name").
  In the Builder, Save on such a board opens **Save a copy** (prefilled
  "<title> (copy)"; names taken by a visible dashboard's id **or title** are
  blocked, and the board you opened is recognised by its id, not its title's
  slug); the first save of a new dashboard
  opens **Save dashboard** with its name and **access** — private, everyone
  (view / edit) or specific users and groups (applied as grants). Re-saving your
  own dashboard, or one shared with you for editing, saves straight away. Admins
  are not offered in share lists (`/api/directory` omits them): they always
  have full access. Dialog dropdowns draw their chevron inset from the border. An
  admin editing a shipped example now saves back to its owner (`?owner=app`).
- **Maximized charts cover the whole dashboard again.** While a chart is maximized
  or shows its customizer / data filters (CanvasXpress `body.has-fullscreen`, the
  chart fixed at z-index 1), text / image / control cells and a selected builder
  cell no longer paint over it (cells drop their z-index), and the builder's
  panel toolbar and resize handles are hidden.
- **+ Function** in the Builder toolbar (shown when the server runs data
  functions for the user): pick R or Python, tick the input sources, write the
  code; it adds the function as a source and a panel charting its result.
- A function the runtime refuses as busy (`429`, more functions than
  `CXD_FUNCTIONS_MAX_CONCURRENT`) is retried with backoff instead of failing.
- New example **Dose–Response Lab** (`examples/dose-response-lab.html`, seeded
  in the demo): an R `nls()` Emax fit and two Python pandas summaries.

### Filters panel range slider
- Numeric (range) fields are now a dual-thumb slider styled like the
  CanvasXpress Data Filter range: editable min / max on top, a tick ruler over
  the "pretty" data extent; drag to filter on release, a thumb at its end is
  unbounded. Fields without a numeric extent keep the min / max boxes.

### CanvasXpress engine on every page
- `CXD_CANVASXPRESS_URL` and `CXD_CANVASXPRESS_LICENSE` now apply to every
  served HTML page (example boards, `view.html`, `shared.html`, the demo
  builder), not only the app shell — e.g. `http://localhost:8080/dist` to test
  a local engine build. Unset, nothing changes (public CDN).

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
- Fixed: rotating `SESSION_SECRET` locked every user out of their saved database
  connections. The connectors session bridge now derives its password from
  `ENCRYPTION_KEY`. Users created with the old `SESSION_SECRET` derivation are
  re-keyed on their next visit (needs canvasxpress-connectors `Store.set_password`;
  on an older connectors they keep the old credential). Sign those users in once
  before a rotation. `CXD_DEMO_DATA_DIR` relocates the demo server's data.

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
