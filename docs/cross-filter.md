# Cross-filter (click to filter related panels)

A selection in one panel can **filter** every related panel to the matching
rows — the signature BI "click a bar, the board filters" gesture — with no code.
It is the fourth cross-source marking mode.

The dashboard already links sources through `spec.relationships` (and every
`kind:"join"` source). Those links drive *marking*: selecting rows in a panel on
one source marks the related rows in panels on the other. `markingMode` chooses
how that shows:

| `markingMode` | Effect of a selection on related panels |
|---|---|
| `focus` (default) | grey out everything else |
| `highlight` | recolor the marked rows |
| `ghost` | fade everything else |
| **`filter`** | **narrow the related panels to the marked rows (cross-filter)** |

## Quick start

```jsonc
{
  "id": "sales",
  "relationships": [
    { "left": "orders", "right": "reps", "on": { "left": "Region", "right": "Region" } }
  ],
  "markingMode": "filter",

  "data": {
    "orders": { "kind": "inline", "value": { /* … Region annotation … */ } },
    "reps":   { "kind": "inline", "value": { /* … Region annotation … */ } }
  },
  "panels": {
    "orders": { "dataRef": "orders", "config": { "graphType": "Bar", "colorBy": "Region" } },
    "reps":   { "dataRef": "reps",   "config": { "graphType": "Bar", "colorBy": "Region" } }
  }
}
```

Click one or more bars in the *orders* panel: the *reps* panel filters to the
reps in the same region(s). Because relationships are bidirectional, selecting in
*reps* filters *orders* the same way.

## Behavior

- **The panel you select in is never narrowed by its own selection** — only the
  related panels filter. (Filtering is per panel, so other panels on the *same*
  source do filter.)
- **Clearing.** Any of three gestures clears an active cross-filter: the floating
  **✕ Reset cross-filter** control, the **Escape** key (the engine advertises
  "Click ESC to reset graph"), or a click on empty space in the origin panel.
- **Composes with the Filters panel.** When a `type:"filters"` panel and a
  cross-filter both constrain a panel, their row sets **intersect** — the
  cross-filter narrows within the Filters-panel state, it does not replace it.
- **Client-side.** Cross-filtering filters the rows already on the page; it does
  not issue a new database query, so it works the same for inline, dataset,
  connector and joined sources.

## Authoring in the builder

Open **Data → Links**, add the relationship (source + key on each side), and set
**When you select marks** to *Filter: narrow related panels to the selection
(cross-filter)*. The links summary then reads "selections filter related panels".

## Examples

- [`examples/cross-filter-demo`](../examples/cross-filter-demo.spec.json) — orders
  ↔ reps linked on Region.
- [`examples/cross-filter-genomics`](../examples/cross-filter-genomics.spec.json)
  — clinical patients ↔ expression samples linked on patient id (a tumor-response
  scatter cross-filtering an expression heatmap and a PD-L1 boxplot).
- [`examples/linked-highlight`](../examples/linked-highlight.spec.json) — the same
  orders ↔ reps link with `markingMode: "highlight"` (related rows outlined, the
  rest stay visible).
- [`examples/linked-ghost`](../examples/linked-ghost.spec.json) — the same link with
  `markingMode: "ghost"` (unrelated rows fade away, the selection stands out).
