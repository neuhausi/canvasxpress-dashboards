#' Render a canvasxpress-dashboards dashboard
#'
#' Renders a multi-panel, linked dashboard described by one JSON spec - or builds a whole
#' dashboard from a data frame. Works in R Markdown, Quarto, the RStudio viewer, `htmlwidgets::saveWidget()`
#' and Shiny (see [cxdashboardOutput()]).
#'
#' Give **either** a `spec` (rendered as written) **or** `data` (a dashboard is suggested for it).
#'
#' With `data`, the dashboard is assembled in the browser from the same templates as the
#' dashboards wizard: a patient cohort (a numeric time column such as `os_months` or `time` plus a
#' numeric 0/1 event column) gets filters, a Kaplan-Meier curve, a measure by group and against time,
#' and a case card; a per-sample sequencing run-QC table (three or more of reads, mapping, quality,
#' duplication, GC, insert size, coverage, adapter, contamination) gets filters, depth per sample,
#' mapping against duplication and quality by lane or batch. Clicking a patient or sample loads its
#' record into the case card. If no template fits, the widget says so instead of guessing; pass a `spec`.
#'
#' Arrays in a hand-built `spec` list must stay arrays: write `xAxis = I("age")`, not `xAxis = "age"`
#' (a length-one vector would be sent as a plain string). A spec read from JSON (a string or a file) needs no care.
#'
#' The insights strip (`insights` in a spec) is computed by the dashboards server and is not shown by
#' this widget.
#'
#' @param spec A dashboard spec: a list, a JSON string, or the path of a `.json` file.
#' @param data A data frame (see [cxd_data()]) or a CanvasXpress data object, to suggest a dashboard for.
#' @param id With a data frame: the column holding the record names (default: the row names).
#' @param title A dashboard title (overrides the spec's, or the template's).
#' @param theme A theme to apply (`"light"`, `"dark"`, `"auto"`, `"editorial"`, ...), overriding the spec's.
#' @param engine Where the CanvasXpress engine comes from: `"cdn"` (the current release from
#'   canvasxpress.org; the default, as dashboards use recent engine features) or `"canvasXpress"`
#'   (the copy bundled with the installed canvasXpress R package, for offline use; it may be older).
#' @param width,height Widget size; the height defaults to `"auto"` (the dashboard's own layout height).
#' @param elementId An explicit element id.
#' @return An `htmlwidget`.
#' @examples
#' spec <- list(
#'   id = "demo", title = "Demo",
#'   layout = list(cols = 12, rowHeight = 30,
#'     items = list(list(panel = "bars", x = 0, y = 0, w = 12, h = 10))),
#'   data = list(d = list(kind = "inline", value = cxd_data(
#'     data.frame(region = c("N", "S", "E"), revenue = c(10, 20, 15)), id = NULL))),
#'   panels = list(bars = list(dataRef = "d", config = list(graphType = "Bar", xAxis = I("revenue"))))
#' )
#' if (interactive()) cxdashboard(spec)
#' @export
cxdashboard <- function(spec = NULL, data = NULL, id = NULL, title = NULL, theme = NULL,
                        engine = c("cdn", "canvasXpress"), width = NULL, height = NULL, elementId = NULL) {
  engine <- match.arg(engine)
  if (is.null(spec) && is.null(data)) stop("give a `spec` to render or `data` to suggest a dashboard for", call. = FALSE)
  if (!is.null(spec) && !is.null(data)) {
    stop("give either a `spec` (rendered as written) or `data` (a dashboard is suggested for it), not both", call. = FALSE)
  }
  suggest <- is.null(spec)
  payload <- list(suggest = suggest, title = title, theme = theme)
  if (suggest) {
    cx <- if (is.data.frame(data) || is.matrix(data)) cxd_data(data, id = id) else if (is.list(data) && !is.null(data$y)) data else
      stop("`data` must be a data frame, a matrix or a CanvasXpress data object (a list with `y`)", call. = FALSE)
    payload$dataJson <- to_json(cx)
  } else {
    payload$specJson <- to_json(cxd_read_spec(spec))
  }
  htmlwidgets::createWidget(
    name = "cxdashboard", x = payload, width = width, height = height, package = "canvasXpressDashboards",
    elementId = elementId, dependencies = engine_dependency(engine),
    sizingPolicy = htmlwidgets::sizingPolicy(defaultWidth = "100%", defaultHeight = "auto", padding = 0,
                                             viewer.fill = FALSE, browser.fill = FALSE,
                                             knitr.figure = FALSE, knitr.defaultWidth = "100%", knitr.defaultHeight = "auto")
  )
}

engine_dependency <- function(engine) {
  if (identical(engine, "canvasXpress")) {
    if (!requireNamespace("canvasXpress", quietly = TRUE)) {
      stop("engine = \"canvasXpress\" needs the canvasXpress package installed", call. = FALSE)
    }
    deps <- htmlwidgets::getDependency("canvasXpress", "canvasXpress")
    return(Filter(function(d) identical(d$name, "canvasXpress"), deps))
  }
  # Same name as the engine the canvasXpress package bundles, with a version that always sorts above
  # it ("the current release"): a page that holds both a canvasXpress chart and a dashboard then loads
  # ONE engine - the current one - instead of two fighting over the global.
  list(htmltools::htmlDependency(
    "canvasXpress", "9999.0", src = c(href = "https://www.canvasxpress.org/dist"),
    script = "canvasXpress.min.js", stylesheet = "canvasXpress.css"))
}
