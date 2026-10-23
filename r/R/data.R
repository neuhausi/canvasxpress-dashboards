#' Turn a data frame into a CanvasXpress data object
#'
#' Dashboards bind their panels to data shaped as a CanvasXpress object: the numeric
#' columns are the *measures* (`y`, one row per column of the frame) and every other
#' column is an *annotation* of the records (`x`). Rows are the records. This is the
#' orientation the dashboard templates expect (more rows than numeric columns).
#'
#' @param df A data frame (or matrix).
#' @param id The column holding the record names (default: the row names). The names
#'   must be unique; the column is not also used as an annotation.
#' @return A list with `y` (`vars`, `smps`, `data`) and, when there are annotation
#'   columns, `x`. Missing values are kept as `NA` and become JSON `null`.
#' @examples
#' cxd_data(data.frame(id = c("a", "b"), age = c(40, 50), arm = c("Drug", "Placebo")), id = "id")
#' @export
cxd_data <- function(df, id = NULL) {
  if (is.matrix(df)) df <- as.data.frame(df, stringsAsFactors = FALSE)
  if (!is.data.frame(df)) stop("`df` must be a data frame or matrix", call. = FALSE)
  if (nrow(df) == 0L) stop("`df` has no rows", call. = FALSE)
  if (!is.null(id)) {
    if (!is.character(id) || length(id) != 1L || !id %in% names(df)) {
      stop("`id` must name a column of `df`", call. = FALSE)
    }
    smps <- as.character(df[[id]])
    df <- df[, setdiff(names(df), id), drop = FALSE]
  } else {
    smps <- if (is.character(attr(df, "row.names"))) rownames(df) else as.character(seq_len(nrow(df)))
  }
  if (anyNA(smps) || any(smps == "")) stop("record names must not be missing or empty", call. = FALSE)
  if (anyDuplicated(smps)) {
    stop("record names must be unique (duplicated: ",
         paste(utils::head(unique(smps[duplicated(smps)]), 3L), collapse = ", "), ")", call. = FALSE)
  }
  is_measure <- vapply(df, function(col) is.numeric(col) && !inherits(col, c("Date", "POSIXt", "difftime")), logical(1))
  measures <- names(df)[is_measure]
  if (!length(measures)) stop("`df` has no numeric columns to use as measures", call. = FALSE)
  # I() keeps one-element vectors as JSON arrays; NA becomes null at serialization.
  y <- list(vars = I(measures), smps = I(smps),
            data = lapply(measures, function(m) I(as.numeric(df[[m]]))))
  out <- list(y = y)
  notes <- setdiff(names(df), measures)
  if (length(notes)) {
    out$x <- stats::setNames(lapply(notes, function(n) I(as.character(df[[n]]))), notes)
  }
  out
}

#' Read a dashboard spec
#'
#' Accepts what is convenient: a list, a JSON string, or the path of a `.json` file (for
#' example one saved from the dashboards builder or returned by the
#' `suggest_canvasxpress_dashboard` MCP tool).
#'
#' @param spec A list, a JSON string, or a file path.
#' @return The spec as a list.
#' @export
cxd_read_spec <- function(spec) {
  if (is.list(spec)) return(spec)
  if (is.character(spec) && length(spec) == 1L && !is.na(spec)) {
    text <- if (grepl("^\\s*[\\[{]", spec)) spec else if (file.exists(spec)) paste(readLines(spec, warn = FALSE), collapse = "\n") else
      stop("`spec` is not JSON and no such file: ", spec, call. = FALSE)
    parsed <- tryCatch(jsonlite::fromJSON(text, simplifyVector = FALSE),
                       error = function(e) stop("`spec` is not valid JSON: ", conditionMessage(e), call. = FALSE))
    if (!is.list(parsed) || is.null(names(parsed))) stop("a dashboard spec is a JSON object", call. = FALSE)
    return(parsed)
  }
  stop("`spec` must be a list, a JSON string or a file path", call. = FALSE)
}

# One serializer for everything sent to the browser: arrays stay arrays (use I()), NA is null,
# full double precision, and an empty named list is {} (not []).
to_json <- function(x) {
  as.character(jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", na = "null", digits = NA, force = TRUE))
}
