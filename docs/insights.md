# Insights: what the data says, before you ask

A dashboard can show a strip of **insights** above its panels: a few plain-language captions that
point at what stands out in the data — a group that differs, values far from the rest, records that
fail a limit you set. Each caption carries the figures behind it, and the records it names are
clickable.

They are not written by a language model. Every insight comes from one of a **fixed set of
checks**, computed from the numbers, and its caption is filled from a fixed template. The same data
always gives the same insights, and nothing needs a login, an API key or credits.

## The checks

| Check | What it flags | How |
|---|---|---|
| **Threshold** | records that fail a limit **you declare** | `field op value` on a numeric column; never inferred |
| **Group difference** | a measure that differs between the groups of a category | Kruskal–Wallis rank test per measure × category, corrected for all the tests run (Benjamini–Hochberg); shown only when the adjusted p ≤ 0.05 **and** the effect is large (ε² ≥ 0.14) |
| **Outliers** | values outside Tukey's fences | Q1 − 1.5·IQR … Q3 + 1.5·IQR (quartiles as R's `quantile` type 7); "far out" beyond 3·IQR |

A measure with only two distinct values (a 0/1 event), a constant, or a category with more than six
levels (an identifier, not a grouping) is not tested. Thresholds come first, then group differences,
then outliers; the strip shows the six most notable and says how many more were left out.

Because many comparisons are run, a single "p < 0.05" would be misleading: the group differences are
corrected for the *number of comparisons*, and the strip says how many that was. The statistics are
checked against R (`kruskal.test`, `quantile`, `p.adjust`) in the server's tests.

## Turn it on

Add an `insights` block to the dashboard spec. An empty block turns on the data-derived checks:

```json
{ "insights": {} }
```

To flag failures, declare the limits — a threshold is only ever checked if you write it down:

```json
{
  "insights": {
    "thresholds": [
      { "field": "q30", "op": "lt", "value": 85, "label": "Q30 below 85%" },
      { "field": "pct_duplication", "op": "gt", "value": 25 }
    ],
    "sources": ["data"],
    "max": 6
  }
}
```

| Key | Meaning |
|---|---|
| `thresholds[].field` / `op` / `value` | the failing condition: `lt` below, `le` at or below, `gt` above, `ge` at or above |
| `thresholds[].label` | shown before the caption |
| `thresholds[].source` | limit a threshold to one data source (default: any source with the field) |
| `sources` | which data sources to check (default: every source that is not a narrowed copy) |
| `max` | the most insights to show (default 6) |

The [dashboards generated from a dataset](dashboard-from-data.md) include the block already, and the
`suggest_canvasxpress_dashboard` MCP tool takes `thresholds` to put your limits in it.

## What the viewer sees

```
Insights  computed from the data by fixed checks (6 group comparisons, corrected for multiple testing)
● Age under 45: 6 of 40 records have age below 45 (P001, P008, P015, …).  [P001] [P008] [P015] …
  ▸ Figures
● CD274 differs by stage: III has the highest median (8, n = 13) and I the lowest (2, n = 14) —
  Kruskal-Wallis p < 0.001 (BH-adjusted p < 0.001), ε² = 1.00, n = 40.
  ▸ Figures
```

**Figures** opens every number the caption used (the counts, the fences, each group's n and median,
the raw and adjusted p). On a dashboard with a [case card](dashboard-from-data.md#the-case-drill),
clicking a record loads it into the card and scrolls to it.

## Who sees what

The checks run on the server over the rows **the viewer is allowed to see**: row- and column-level
security applies as it does to the dashboard itself, so a viewer never gets an insight computed from
rows hidden from them. This works the same on a signed-in dashboard and on a share link
(`GET /api/dashboards/{id}/insights`, `GET /api/shared/{token}/insights`). A dashboard without an
`insights` block runs nothing. Sources larger than 200,000 records are skipped and reported, not
sampled.
