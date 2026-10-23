#' Shiny bindings for cxdashboard
#'
#' Output and render functions, plus a proxy to drive a rendered dashboard from the server.
#'
#' Besides the usual widget behaviour, a dashboard reports back to the app through two inputs named
#' after its output id: `input$<id>_params` (a named list of the dashboard's current parameters;
#' it updates whenever a click action, control or [cxd_set_param()] changes one - for the case-card
#' dashboards, `input$<id>_params$case` is the patient or sample last clicked) and, for a dashboard
#' suggested from `data`, `input$<id>_template` (`"cohort"` or `"ngs-qc"`).
#'
#' @param outputId Output variable to read from.
#' @param width,height CSS sizes; the height defaults to `"auto"`.
#' @param expr An expression that returns a [cxdashboard()].
#' @param env The environment in which to evaluate `expr`.
#' @param quoted Is `expr` a quoted expression?
#' @return `cxdashboardOutput()` an output element; `renderCxdashboard()` a render function.
#' @name cxdashboard-shiny
NULL

#' @rdname cxdashboard-shiny
#' @export
cxdashboardOutput <- function(outputId, width = "100%", height = "auto") {
  htmlwidgets::shinyWidgetOutput(outputId, "cxdashboard", width, height, package = "canvasXpressDashboards")
}

#' @rdname cxdashboard-shiny
#' @export
renderCxdashboard <- function(expr, env = parent.frame(), quoted = FALSE) {
  if (!quoted) expr <- substitute(expr)
  htmlwidgets::shinyRenderWidget(expr, cxdashboardOutput, env, quoted = TRUE)
}

#' Drive a rendered dashboard from the Shiny server
#'
#' @param outputId The output id the dashboard is rendered in.
#' @param session The Shiny session (default: the current one).
#' @return `cxdashboardProxy()` a proxy object; the `cxd_*` functions return it invisibly.
#' @examples
#' \dontrun{
#' observeEvent(input$load_p018, cxd_set_param(cxdashboardProxy("dash"), "case", "P018"))
#' }
#' @name cxdashboard-proxy
NULL

#' @rdname cxdashboard-proxy
#' @export
cxdashboardProxy <- function(outputId, session = shiny::getDefaultReactiveDomain()) {
  if (is.null(session)) stop("cxdashboardProxy() must be called from a Shiny server function", call. = FALSE)
  structure(list(id = session$ns(outputId), session = session), class = "cxdashboard_proxy")
}

#' @rdname cxdashboard-proxy
#' @param proxy A [cxdashboardProxy()].
#' @param name The dashboard parameter (a key of the spec's `params`).
#' @param value Its new value (`NULL` clears it).
#' @export
cxd_set_param <- function(proxy, name, value) {
  if (!is.character(name) || length(name) != 1L) stop("`name` must be a single string", call. = FALSE)
  cxd_message(proxy, "setParam", list(name = name, value = value))
}

#' @rdname cxdashboard-proxy
#' @param panel A panel id of the spec.
#' @export
cxd_focus_panel <- function(proxy, panel) {
  if (!is.character(panel) || length(panel) != 1L) stop("`panel` must be a single string", call. = FALSE)
  cxd_message(proxy, "focusPanel", list(panel = panel))
}

cxd_message <- function(proxy, method, args) {
  if (!inherits(proxy, "cxdashboard_proxy")) stop("`proxy` must come from cxdashboardProxy()", call. = FALSE)
  proxy$session$sendCustomMessage("cxdashboard-proxy", list(id = proxy$id, method = method, args = args))
  invisible(proxy)
}
