# Dashboard from data

Drop in one dataset and get a whole **linked dashboard** instead of a single chart: a Filters
panel plus the charts that kind of data calls for, all bound to the same dataset, so a selection
in one panel selects the same rows in the rest.

It is a *suggestion*. The data wizard offers it above its single-chart cards when the data is a
shape it recognises; nothing is offered for anything else, and the single-chart flow is
unchanged. It never alters your data.

## What it recognises

**Patient cohort (survival table)** — a numeric time column (`time`, `os_months`, `PFS.days`,
`overall_survival_days` …) and a numeric event column (0/1, named `event`, `status`, `death` …).

| Panel | Shows |
|---|---|
| Filters | the categorical columns (up to 12 levels) and numeric measures, except time and event |
| Survival | Kaplan–Meier curve, coloured by the best grouping column (`arm`, `group`, `treatment`, `stage` … a text column with 2–6 levels), with confidence bands, log-rank p-value and risk table |
| Measure by group | a boxplot of the first other numeric column, by the same grouping column |
| Measure vs time | a scatter of that column against the survival time, coloured by group |

**Sequencing run QC** — a per-sample table with three or more QC metric families among its numeric
columns: reads, mapping / alignment, quality (Q30, Q20 …), duplication, GC, insert size, coverage /
depth, adapter, contamination.

| Panel | Shows |
|---|---|
| Filters | lane / flowcell / batch columns and the metrics |
| Depth per sample | bars of read count (or coverage), coloured by lane / batch |
| Mapping vs duplication | a scatter of the two metrics (or the first two available), coloured by lane / batch |
| Quality spread | a boxplot of the quality metric, by lane / batch when there is one |

A template is only offered when it yields at least three panels.

## The case drill

Each dashboard ends with a **case card** under the charts: a one-row table with every field of one
case — a patient (cohort) or a sample (run QC). **Click a point** on the scatter (or, for run QC, a
depth bar or a scatter point) and the card loads that row. The card starts on the first row.

The charts keep the whole dataset: the clicked case is picked out in every panel that can show one
(its point, its box), and the Filters panel still narrows everything as usual. Nothing is narrowed to
the one case, so the survival curve and the distributions stay meaningful. A box, a curve and the
filters are not wired to the click, because a click there names a group, not a row.

It is plain spec, so it can be copied to any dashboard: a `case` parameter, a second source of the
same data narrowed to it (a browser-side `pushdown` on the row id), a table panel on that source, and
a click action on the panels whose marks are single rows.

```jsonc
{
  "params": { "case": { "value": "P001" } },
  "data": {
    "cohort": { "kind": "dataset", "id": "trial" },
    "case":   { "kind": "dataset", "id": "trial",
                "pushdown": { "where": [{ "column": "smps", "op": "=", "value": "$case" }] } }
  },
  "panels": {
    "scatter": { "dataRef": "cohort", "config": { "graphType": "Scatter2D", "xAxis": ["age"], "yAxis": ["os_months"] },
                 "actions": [{ "on": "click", "setParam": { "name": "case" } }] },
    "case":    { "title": "Patient record", "dataRef": "case",
                 "config": { "graphType": "Bar", "view": "table", "dataTableBannerShow": false,
                             "dataTableToolbarShow": false, "dataTableStatusShow": false,
                             "dataTablePaginationShow": false, "dataTableFitHeight": true,
                             "dataTableColorTransparency": 0 } }
  }
}
```

`setParam` with no `field` takes the clicked **row** along the axis the panel shows its source's rows
on, so it works on a scatter (whose rows the renderer transposes) as well as on a bar. Click actions
are edited in the spec JSON; the builder keeps them through every edit but does not yet have a form
for them.

## Insights

The generated dashboards opt in to an **insights strip** — a few captions above the charts pointing at
what stands out (a group that differs, values far from the rest, and any limit you declare), each with
the figures behind it and the flagged records clickable into the case card. They come from fixed,
deterministic checks, not a language model; see [insights](insights.md).

## Limits

- **Orientation.** Rows must be the samples and the columns the variables (what a CSV, a database
  query or the wizard produces). A table stored the other way round — more variables than
  samples, annotations on the variables — gets no suggestion.
- **Shared and exported copies.** A share link resolves the dataset for the viewer and keeps the
  drill working. A static snapshot export bakes stored-dataset sources, so it freezes the card on
  the case it was exported with (an inline source keeps its pushdown and stays live).
- **The event must be numeric.** A text event (`Dead` / `Alive`) is not offered a cohort
  dashboard: the engine's Kaplan–Meier reads the event from a numeric column, and drawing it from
  a text one would give a wrong curve. Recode it to 0/1 first.

## Use it

**In the app:** *Dashboards → ＋ Chart from data* → Upload → Check → **Visualize**. The offer is
drawn live with your data and preselected; click a single-chart card to take that instead, then
**Publish**.

**In code:**

```js
const data = /* a CanvasXpress data object */;
const suggestion = CanvasXpressDashboards.suggestDashboard(data);   // null when nothing fits
if (suggestion) {
  const spec = CanvasXpressDashboards.dashboardSpec(suggestion, {
    id: 'trial', title: 'Trial',
    source: { kind: 'inline', value: data }   // or datasetId (+ store) for a stored dataset
  });
  CanvasXpressDashboards.renderDashboard(spec, 'dashboard');
}
```

`suggestion` is plain data (`{template, label, reason, panels}`), so it can be shown, edited or
stored before it becomes a spec.

**From an AI client:** the `suggest_canvasxpress_dashboard` tool in
[canvasxpress-mcp](https://github.com/neuhausi/canvasxpress-mcp) returns the same dashboard,
validated, from a data object in one call.
