# Live-data controls (parameterized dashboards)

A control can **fetch new data from a source and refresh the bound panels**,
instead of only filtering the data already on the page. This is the difference
between "narrow what's on screen" (a filter control) and "go get the EMEA rows
from the server" (a *parameter* control).

Three concepts make it work:

1. **Parameters** (`spec.params`) — named values the dashboard holds.
2. **Parameterized sources** — a source's `query` reads a parameter via a
   `"$name"` token.
3. **Param controls** (`mode:"param"`) — write a parameter, which re-queries every
   source that consumes it and live-updates the panels bound to those sources.

---

## Quick start (hand-authored spec)

```jsonc
{
  "id": "sales",
  "params": { "region": { "value": null, "type": "string" } },

  "data": {
    "sales": {
      "kind": "connector",
      "url": "/api/data?source=sales",
      "query": { "region": "$region" }        // $region is substituted at fetch time
    }
  },

  "layout": { "items": [
    { "panel": "pick", "x": 0, "y": 0, "w": 3, "h": 1 },
    { "panel": "bar",  "x": 0, "y": 1, "w": 12, "h": 6 }
  ] },

  "panels": {
    "pick": {
      "type": "control", "mode": "param", "param": "region",
      "options": ["EMEA", "APAC", "AMER"]     // "All" is added automatically → clears the param
    },
    "bar": { "dataRef": "sales", "config": { "graphType": "Bar" } }
  }
}
```

Picking **EMEA** sets `region`, which re-fetches `/api/data?source=sales&region=EMEA`
and calls `updateData` on **bar**. Picking **All** clears `region`, so the `region`
entry drops out of the query and it widens back to everything.

---

## Parameters

`spec.params` maps a name to a default — either a bare value or `{ value, type }`
(`type` ∈ `string | number | boolean`, advisory). A `null` default means "unset"
(the token is omitted from the query until a control sets it).

At runtime the live values are on the render handle:

```js
handle.getParams();               // { region: "EMEA" }
handle.setParam("region", "APAC"); // same effect as a control changing
```

## Parameterized sources

Any `connector` or `dataset` source may carry a `query` map. Each value is either
a literal or a `"$name"` token resolved from the current params. Unset tokens are
dropped. The cache key includes the resolved query, so different selections are
distinct fetches and never serve each other's data.

- **connector**: the query is appended to the URL; your connector backend reads it.
- **dataset** (cxd_server): `GET /api/datasets/{id}?region=EMEA` filters the stored
  CanvasXpress object server-side by the `region` **sample annotation** (equality).
  Only keys that name a real annotation participate — it is a mask, not a query
  language, so an unknown/injected key narrows nothing.

Add `dependsOn: ["region"]` to a source if it must refetch on a param it reads
somewhere other than `query`.

## Param controls (`mode:"param"`)

| field | meaning |
| --- | --- |
| `param` | the `spec.params` name this control writes |
| `options` | a static choice list (an "All" clear entry is prepended) |
| `optionsFrom` | `{dataRef, annotation, compartment?}` — choices from another dataset's distinct values |
| `style` | `auto` / `dropdown` / `radio` / `buttons` / `search` |
| `placeholder`, `debounce` | for `style:"search"` (a debounced free-text box; default 250 ms) |

"All" (or an empty search box) sets the param to `null`, widening the query.

## Chart-click cross-filter

A graph panel can set a parameter from a clicked mark:

```jsonc
"panels": {
  "map": { "dataRef": "byRegion", "clickParam": "region", "config": { "graphType": "Bar" } }
}
```

Clicking a bar sets `region` to the clicked sample (or `clickField`'s value) and
refreshes every panel bound to a source that consumes `region`. Any `events.click`
you already defined still runs.

## The builder

Select a control → **Action: Query source** exposes the Param name, Choices
(static list or from data), style (incl. **Search box**), and an **Applies to**
binding (target source + query field) that writes `$param` into the source's
`query`. Select a graph panel → **Click sets** wires the cross-filter.

## Exporting

A self-contained HTML export can't reach a backend, so it is a **snapshot**: each
source is baked inline at the current parameter values, and param controls render
read-only with a "snapshot" note pinned to the value in effect at export time.

---

Implementation: `src/dataStore.js`, `src/renderDashboard.js`, `src/validateSpec.js`,
`src/builder.js`, `server/src/cxd_server/datasets.py`. Plan + status:
[`docs/plans/live-data-controls-plan.md`](plans/live-data-controls-plan.md).
