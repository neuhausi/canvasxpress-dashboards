# canvasxpress-dashboards (Python)

Linked, multi-panel [CanvasXpress](https://www.canvasxpress.org) dashboards in Python — for
Jupyter, VS Code and Quarto notebooks, Dash, Streamlit, Flask and standalone pages. It renders a
[canvasxpress-dashboards](../README.md) spec, or builds a whole dashboard from a DataFrame. The
renderer is bundled; there are no required dependencies (pandas only for a DataFrame).

```python
from canvasxpress_dashboards import Dashboard

# A table in, a linked dashboard out. A patient cohort (numeric time + 0/1 event columns) gets
# filters, a Kaplan-Meier curve, a measure by group and against time, and a case card; a per-sample
# sequencing run-QC table gets filters, depth, mapping vs duplication and quality by lane.
Dashboard(data=trial, id="patient")

# Or render a spec you wrote, saved from the builder, or returned by the MCP tool.
Dashboard("my-dashboard.spec.json")
```

Click a patient's point and its record loads into the case card; every panel shares the data, so a
selection in one panel selects the same rows in the others. If no template fits the table the page
says so rather than guessing — pass a spec instead.

## Where it runs

| Where | How |
|---|---|
| Jupyter, VS Code, Quarto, Colab | evaluate a `Dashboard` as the last line of a cell (it is an `<iframe>` that grows with the dashboard) |
| a file | `Dashboard(...).save("dashboard.html")` (standalone: the renderer is inlined) or `.show()` |
| Flask / FastAPI / Django | return `Dashboard(...).to_html()` from a view |
| Dash | `html.Iframe(srcDoc=Dashboard(...).to_html(frame=True), style={"width": "100%", "height": "1400px", "border": "0"})` |
| Streamlit | `streamlit.components.v1.html(Dashboard(...).to_html(), height=1400, scrolling=True)` |
| Shiny for Python | `ui.HTML(Dashboard(...).iframe_html(1400))` |

Flask and Dash are covered by the package's browser tests; Streamlit and Shiny for Python go through
the same page but are not run in them.

## Data

`cxd_data(df, id="patient")` is what `Dashboard(data=df)` uses: numeric columns are the measures, every
other column an annotation of the records, rows are the records (more rows than numeric columns is the
orientation the templates expect). A DataFrame, a dict of columns or a list of records all work; missing
values become `null`.

## Talking to the page

A dashboard rendered with `frame=True` (the notebook output does) reports to the page that embeds it with
`window.postMessage`: `{type: "cxd-params", id, params}` whenever a parameter changes — for the case-card
dashboards, `params.case` is the patient last clicked — and `{type: "cxd-resize", id, height}` as it grows.
`Dashboard.frame_id` is the `id`.

## Engine and bundle

The dashboards need the CanvasXpress engine, loaded from canvasxpress.org by default (the current release,
which dashboards use features of); pass `engine_url=` for a mirror or an offline folder holding
`canvasXpress.min.js` and `canvasXpress.css`. The dashboards bundle (1 MB) is inlined in each page;
`bundle_url=` loads it from a URL instead, which keeps notebooks small.

## Not included

The server-computed **insights strip** (`insights` in a spec) needs the dashboards server and is not shown.
Connector, dataset and live sources need it too; inline data (what a DataFrame becomes) works anywhere.

MIT licensed.
