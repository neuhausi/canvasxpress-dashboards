# Plan — Live-data controls (parameterized sources)

**Status:** Phase 1 DONE (client MVP landed, 2026-08-28) · Phases 2–4 open · target v0.9.0

> **Phase 1 shipped (client-side MVP), unreleased:**
> - `dataStore.js`: `resolve(ref, spec, {params})` substitutes `$name` tokens in a
>   source `query`, appends them to the fetch URL, and keys the cache on the resolved
>   (sorted) query so different param values never collide.
> - `renderDashboard.js`: `paramState` seeded from `spec.params`; `refsForParam` +
>   `applyParamChange` re-fetch affected sources and `updateData` bound instances (with
>   per-cell loading/error state, last-good on error); `mode:"param"` control branch with
>   static (`options`) or dynamic (annotation) choices.
> - `validateSpec.js` + `schema/dashboard.schema.json`: `spec.params`, source `query`/
>   `dependsOn`, control `mode`/`param`/`options`, dangling-token checks.
> - Tests: dataStore param substitution / cache-keying (4), validateSpec (4), a
>   render-level change→refetch→updateData integration test (1). Suite green (112).
> - **Still open:** builder UI (Phase 2), `optionsFrom` dynamic option lists (Phase 2),
>   export snapshot behavior for param controls (Phase 2), server SQL/dataset params
>   (Phase 3).
**Scope:** Let a control widget fetch *new* data from a data source and refresh the
bound visualizations, instead of only filtering the data already on the page.

---

## 1. Problem / goal

Today a `type:"control"` panel filters the client-side data of the panels it is bound
to (`modifyFilter('guess', annotation, 'exact', value)` in
[`renderControlWidget`](../../src/renderDashboard.js)). Everything the control can act on
must already be loaded into the browser.

We want the alternative: a control whose change **re-queries a data source with a
parameter** (e.g. "Region = EMEA", "Year = 2025", a free-text search, a date range) and
live-updates the panels bound to that source. This unlocks datasets too large to ship to
the client, always-fresh server data, and true drill-down.

**Non-goals (this phase):** cross-filtering between charts (click a bar → filter others),
computed/joined server queries beyond a single parameterized source, and auth changes
(we keep the existing cookie-auth, server-owns-credentials model).

---

## 2. What already exists (reuse, don't rebuild)

| Capability | Where | Reuse for |
| --- | --- | --- |
| Source kinds `inline`/`connector`/`dataset`, cache + TTL + in-flight de-dup | `src/dataStore.js` | add a *param-aware cache key* + resolved query |
| `store.resolve(ref, sourceSpec)` → data | `src/dataStore.js` | re-resolve a source with new params |
| Bound-instance live update: `instance.updateData(data, true, false)` | `scheduleRefreshes`, `src/renderDashboard.js` | the refresh-on-param-change path is **identical** |
| `refBindings` (dataRef → [{instance}]) | `renderDashboard` | find which panels to refresh when a param changes |
| Connector param forwarding `_get(path, params)` | `server/.../mcp_bridge.py` | pass control values to the connector backend |
| Control widget UI (dropdown/radio) + change handler | `renderControlWidget` | add a second "mode" branch |

The refresh mechanism we need is **already written** — `scheduleRefreshes` re-fetches a
connector source and pushes it into bound instances via `updateData`. A param change is
just a *manually triggered* refresh with a different query. This is the key insight: we
are wiring existing parts together, not adding a new data path.

---

## 3. Design

### 3.1 Dashboard parameters (new, small)

Introduce a dashboard-level parameter bag on the spec:

```jsonc
"params": {
  "region": { "value": "All", "type": "string" },
  "year":   { "value": 2025,  "type": "number" }
}
```

`params` is serializable (survives save/export like everything else). At runtime we keep
a live `paramState` map plus a `paramSubscribers` list (refs whose source reads a param).

### 3.2 Parameterized sources (extend source spec)

A source declares which params it consumes and how they enter the query:

```jsonc
"data": {
  "sales": {
    "kind": "connector",
    "url": "/api/data",
    "source": "sales_by_region",
    "query": { "region": "$region", "year": "$year" },   // $name → param value
    "ttl": 0
  }
}
```

- Resolution substitutes `$name` tokens from `paramState` before building the request.
- **Cache key must include resolved param values** (`keyFor` in dataStore.js): change
  `connector:<url>` → `connector:<url>?<sorted resolved query>` so different param values
  are distinct cache entries and don't collide. This is the one load-bearing dataStore
  change.
- `dataset` kind: optional server-side `filter` param (later phase).
- `sql` kind (server): a parameterized template with **bound** params — never string
  interpolation (see §6 Security).

### 3.3 Control modes

Extend the control panel spec with `mode`:

```jsonc
{
  "type": "control",
  "mode": "param",             // "filter" (default, existing) | "param"
  "param": "region",           // which dashboard param this control writes
  "label": "Region",
  "input": "dropdown",         // dropdown | radio | search | (later) daterange
  "options": ["All", "EMEA", "AMER", "APAC"],   // static, OR:
  "optionsFrom": { "dataRef": "regions", "labelField": "name", "valueField": "id" }
}
```

- `mode:"filter"` → today's behavior, untouched (backward compatible; default).
- `mode:"param"` → on change:
  1. write `paramState[param] = value`;
  2. find every ref whose source `query` references `$param` (or explicitly lists the
     param in a `dependsOn`);
  3. for each such ref: `store.resolve(ref, resolvedSpec)` (new cache key ⇒ real fetch),
     then for each bound instance `instance.updateData(data, true, false)`;
  4. show a per-panel loading state while in flight; keep last-good data on error.
- `optionsFrom` lets the control's *choices* come from a source too (distinct values),
  so the dropdown itself is data-driven — resolved once at render.

### 3.4 Refresh orchestration (new helper)

Add `applyParamChange(param, value)` next to `applyControlFilters`, mirroring
`scheduleRefreshes` but triggered by the control instead of a timer. Debounce rapid
changes (e.g. typing in a search box) ~250ms. Reuse `refBindings` to locate instances.

---

## 4. Client changes (src/)

1. **dataStore.js** — param-aware `keyFor` + `$token` substitution in the connector/
   dataset URL builders; accept a `params` argument to `resolve`.
2. **renderDashboard.js** — `paramState`/`paramSubscribers` init from `spec.params`;
   `applyParamChange()`; `mode:"param"` branch in `renderControlWidget`; per-panel loading
   state; `optionsFrom` resolution.
3. **validateSpec.js** — validate `params`, `mode`, `param`, `query` token references
   (every `$name` must exist in `params`; every control `param` must exist).
4. **builder / builderModel.js** — control config UI: "Data action = Filter this page /
   Query a source", target param picker, source picker, static-vs-dynamic options.

## 5. Server changes (server/)

1. **Connector passthrough** — the bridge already forwards params via `_get`; expose the
   resolved `query` on `GET /api/data?source=…&region=…`. Mostly wiring + allow-list of
   forwardable param names.
2. **SQL datasets (later)** — a parameterized query template stored with the dataset,
   executed with bound params. Phase this after the connector path proves out.

## 6. Security (must-haves)

- **SQL/parameterized queries use bound parameters only** — never f-string/`%`/concat the
  value into SQL. Reject templates that don't parameterize.
- **Param allow-list per source** — only declared params are forwarded to a backend; an
  unknown or injected key is dropped, not passed through.
- **Type/shape validation** on values before they enter a query (number stays number).
- Credentials stay server-side (unchanged cookie-auth model). The browser only ever sends
  parameter *values*, never connection details.
- Exported/offline HTML: a `mode:"param"` control can't reach a server → on export, either
  bake the current data as `inline` (snapshot) or disable the control with a note. Decide
  in Phase 2; default to snapshot so exports stay self-contained.

## 7. UX details

- Loading: dim the panel + spinner during re-fetch; don't blank it (keep last-good).
- Debounce search-type inputs; dropdowns fire immediately.
- Error: inline message in the control ("couldn't load"), panels keep prior data.
- "All"/reset semantics: a sentinel value that removes the param from the query.

## 8. Phasing

- **Phase 1 (MVP):** connector sources + `mode:"param"` dropdown/radio, static options,
  param-aware cache key, `applyParamChange` reusing `updateData`. Hand-authored spec only.
- **Phase 2:** builder UI for configuring param controls; `optionsFrom` dynamic options;
  export snapshot behavior.
- **Phase 3:** SQL/dataset server-side parameterized queries; date-range + search inputs;
  debounce polish.
- **Phase 4 (stretch):** chart-click → set param (cross-filter) on the same machinery.

## 9. Risks / open questions

- **Cache-key correctness** is the subtle part — get param values into `keyFor` or stale
  data leaks across selections. Unit-test this first.
- **`updateData` semantics** — confirm `updateData(data, true, false)` fully re-renders on
  a *different-shaped* result (not just new numbers). If a query can change vars/smps, we
  may need a heavier re-instantiate path for those panels.
- One control writing a param consumed by **multiple** sources → fan-out refresh; ensure
  we de-dup and don't double-fetch a shared ref.
- Multiple controls writing **different** params to the **same** source → combine into one
  resolved query (like `applyControlFilters` combines picks) before a single fetch.

## 10. Test plan

- dataStore unit: param substitution + distinct cache keys per value + shared-ref de-dup.
- renderDashboard integration (jsdom): change control → correct fetch URL → `updateData`
  called on bound instances only.
- validateSpec: rejects dangling `$param`, unknown control `param`.
- Server: connector passthrough forwards only allow-listed params; SQL template binds.
- Manual: a 2-panel dashboard + region dropdown against the demo connector.
