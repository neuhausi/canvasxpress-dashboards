# Changelog

Notable changes to `canvasxpress-dashboards` (the npm package) and its server
(`cxd_server`). Versions follow the package version.

## Unreleased

Server features, live on the demo; the client additions ship in the next npm
release.

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
