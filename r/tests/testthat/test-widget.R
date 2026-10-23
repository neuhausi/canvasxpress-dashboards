cohort <- function(n = 40) {
  data.frame(patient = sprintf("P%03d", seq_len(n)), os_months = 3 + ((seq_len(n) - 1) * 7) %% 40,
             os_event = ifelse((seq_len(n) - 1) %% 3 == 0, 0, 1), age = 40 + ((seq_len(n) - 1) * 5) %% 35,
             arm = ifelse(seq_len(n) %% 2 == 0, "Drug", "Placebo"))
}
spec <- function() list(id = "demo", title = "Demo", layout = list(cols = 12, items = list()), data = list(), panels = list())

test_that("a spec widget carries the spec as JSON and the engine from the CDN by default", {
  w <- cxdashboard(spec(), title = "Mine", theme = "dark")
  expect_s3_class(w, c("cxdashboard", "htmlwidget"))
  expect_false(w$x$suggest)
  expect_equal(jsonlite::fromJSON(w$x$specJson)$id, "demo")
  expect_equal(w$x$title, "Mine"); expect_equal(w$x$theme, "dark")
  expect_null(w$x$dataJson)
  engine <- w$dependencies[[1]]
  expect_equal(engine$name, "canvasXpress")
  expect_match(engine$src$href, "canvasxpress.org/dist")
  # It must sort above the engine the canvasXpress package bundles, so a page with both loads one engine.
  expect_gt(as.numeric_version(engine$version), as.numeric_version("100.0"))
})

test_that("a data frame becomes a suggest widget carrying CanvasXpress data", {
  w <- cxdashboard(data = cohort(), id = "patient")
  expect_true(w$x$suggest)
  expect_null(w$x$specJson)
  d <- jsonlite::fromJSON(w$x$dataJson, simplifyVector = FALSE)
  expect_equal(length(d$y$smps), 40L)
  expect_equal(unlist(d$y$vars), c("os_months", "os_event", "age"))
  expect_equal(names(d$x), "arm")
})

test_that("a CanvasXpress data object is accepted as data", {
  w <- cxdashboard(data = cxd_data(cohort(), id = "patient"))
  expect_true(w$x$suggest)
})

test_that("arguments are validated", {
  expect_error(cxdashboard(), "give a `spec`")
  expect_error(cxdashboard(spec(), data = cohort()), "not both")
  expect_error(cxdashboard(data = 1:3), "data frame, a matrix or a CanvasXpress data object")
  expect_error(cxdashboard(data = list(a = 1)), "data frame, a matrix or a CanvasXpress data object")
  expect_error(cxdashboard(spec(), engine = "nope"), "should be one of")
})

test_that("engine = 'canvasXpress' uses the installed package's bundled engine, offline", {
  skip_if_not_installed("canvasXpress")
  w <- cxdashboard(spec(), engine = "canvasXpress")
  engine <- w$dependencies[[1]]
  expect_equal(engine$name, "canvasXpress")
  expect_null(engine$src$href)                       # a local copy, not the CDN
  expect_true(nzchar(engine$src$file))
})

test_that("the dashboards bundle ships with the package and is the widget's dependency", {
  js <- system.file("htmlwidgets", "lib", "canvasxpress-dashboards", "canvasxpress-dashboards.umd.js",
                    package = "canvasXpressDashboards")
  expect_true(nzchar(js) && file.exists(js))
  expect_match(paste(readLines(js, n = 200, warn = FALSE), collapse = "\n"), "CanvasXpressDashboards")
  yaml <- paste(readLines(system.file("htmlwidgets", "cxdashboard.yaml", package = "canvasXpressDashboards")), collapse = "\n")
  expect_match(yaml, "canvasxpress-dashboards.umd.js", fixed = TRUE)
})

test_that("the widget can be saved as a standalone page", {
  out <- tempfile(fileext = ".html")
  htmlwidgets::saveWidget(cxdashboard(spec()), out, selfcontained = FALSE)
  html <- paste(readLines(out, warn = FALSE), collapse = "\n")
  expect_match(html, "canvasxpress-dashboards.umd.js", fixed = TRUE)
  expect_match(html, "canvasxpress.org/dist/canvasXpress.min.js", fixed = TRUE)
  expect_match(html, "cxdashboard", fixed = TRUE)
})
