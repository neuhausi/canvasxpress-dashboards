# canvasXpressDashboards (R)

Linked, multi-panel [CanvasXpress](https://www.canvasxpress.org) dashboards in R — an
`htmlwidgets` widget for R Markdown, Quarto, the RStudio viewer and Shiny. It renders a
[canvasxpress-dashboards](../README.md) spec, or builds a whole dashboard from a data frame.

```r
library(canvasXpressDashboards)

# A data frame in, a linked dashboard out: a patient cohort (numeric time + 0/1 event columns)
# gets filters, a Kaplan-Meier curve, a measure by group and against time, and a case card;
# a per-sample sequencing run-QC table gets filters, depth, mapping vs duplication and quality by lane.
cxdashboard(data = trial, id = "patient")

# Or render a spec you wrote, saved from the builder, or returned by the MCP tool.
cxdashboard("my-dashboard.spec.json")
```

Click a patient's point and its record loads into the case card; every panel shares the data,
so a selection in one panel selects the same rows in the others. If no template fits the data
the widget says so rather than guessing — pass a spec instead.

## Data

`cxd_data(df, id = "patient")` is what `cxdashboard(data = df)` uses: numeric columns are the
measures, every other column an annotation of the records, rows are the records (more rows than
numeric columns is the orientation the templates expect). Missing values stay missing.

## Specs

`spec` is a list, a JSON string or a `.json` file. In a hand-built list write one-element arrays
with `I()` — `xAxis = I("age")`, not `xAxis = "age"` (a length-one vector would be sent as a string);
a spec read from JSON needs no care.

## Shiny

```r
ui <- fluidPage(cxdashboardOutput("dash"), actionButton("p18", "Show P018"))
server <- function(input, output, session) {
  output$dash <- renderCxdashboard(cxdashboard(data = trial, id = "patient"))

  # The dashboard reports back: the current parameters (for the case-card dashboards, the patient
  # last clicked) and, when suggested from data, which template was used.
  observe(print(input$dash_params$case))
  observe(print(input$dash_template))          # "cohort" or "ngs-qc"

  # ...and can be driven from R.
  observeEvent(input$p18, cxd_set_param(cxdashboardProxy("dash"), "case", "P018"))
}
```

## Engine

The dashboards need the CanvasXpress engine. By default it comes from canvasxpress.org (the
current release, which dashboards use features of); `engine = "canvasXpress"` uses the copy bundled
with the installed canvasXpress package, for offline use — it may be older, so some dashboard
behaviour (for example highlighting a patient in a grouped boxplot) can differ.

## Not included

The server-computed **insights strip** (`insights` in a spec) needs the dashboards server and is
not shown by this widget. Connector, dataset and live sources need the server too; inline data
(what a data frame becomes) works anywhere, including a saved standalone page
(`htmlwidgets::saveWidget()`).

The bundled JavaScript (`inst/htmlwidgets/lib/canvasxpress-dashboards/`) is MIT-licensed
(`inst/htmlwidgets/LICENSE.dashboards-js`); the R code is GPL-3. Refresh the bundled copy with
`tools/sync-bundle.sh` (the dashboards build does it too).
