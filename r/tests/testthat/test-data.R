test_that("numeric columns become measures and the rest annotations, one record per row", {
  df <- data.frame(id = c("P1", "P2", "P3"), age = c(40, 50, 60), os = c(3L, 9L, 5L),
                   arm = c("Drug", "Placebo", "Drug"), stringsAsFactors = FALSE)
  d <- cxd_data(df, id = "id")
  expect_equal(unclass(d$y$vars), c("age", "os"))
  expect_equal(unclass(d$y$smps), c("P1", "P2", "P3"))
  expect_equal(lapply(d$y$data, unclass), list(c(40, 50, 60), c(3, 9, 5)))
  expect_equal(names(d$x), "arm")
  expect_equal(unclass(d$x$arm), c("Drug", "Placebo", "Drug"))
})

test_that("factors, logicals and dates are annotations; row names are the default record names", {
  df <- data.frame(n = c(1, 2), f = factor(c("a", "b")), l = c(TRUE, FALSE),
                   when = as.Date(c("2026-01-01", "2026-02-01")), row.names = c("r1", "r2"))
  d <- cxd_data(df)
  expect_equal(unclass(d$y$smps), c("r1", "r2"))
  expect_equal(unclass(d$y$vars), "n")
  expect_equal(unclass(d$x$f), c("a", "b"))
  expect_equal(unclass(d$x$l), c("TRUE", "FALSE"))
  expect_equal(unclass(d$x$when), c("2026-01-01", "2026-02-01"))
  expect_equal(unclass(cxd_data(data.frame(n = 1:2))$y$smps), c("1", "2"))   # automatic row names
})

test_that("a matrix is accepted and missing values become JSON null", {
  m <- matrix(c(1, NA, 3, 4), 2, dimnames = list(c("a", "b"), c("x", "y")))
  d <- cxd_data(m)
  expect_equal(unclass(d$y$smps), c("a", "b"))
  json <- jsonlite::fromJSON(canonicalJson(d), simplifyVector = FALSE)
  expect_null(json$y$data[[1]][[2]])
  expect_equal(json$y$data[[2]], list(3, 4))
})

test_that("a single record and a single measure still serialize as arrays", {
  json <- jsonlite::fromJSON(canonicalJson(cxd_data(data.frame(only = 5, name = "z"))), simplifyVector = FALSE)
  expect_equal(json$y$vars, list("only"))
  expect_equal(json$y$smps, list("1"))
  expect_equal(json$y$data, list(list(5)))
  expect_equal(json$x$name, list("z"))
})

test_that("bad input is refused with a clear message", {
  expect_error(cxd_data(list(a = 1)), "data frame or matrix")
  expect_error(cxd_data(data.frame()), "no rows")
  expect_error(cxd_data(data.frame(a = c("x", "y"))), "no numeric columns")
  expect_error(cxd_data(data.frame(id = c("a", "a"), n = 1:2), id = "id"), "must be unique")
  expect_error(cxd_data(data.frame(id = c("a", NA), n = 1:2), id = "id"), "missing or empty")
  expect_error(cxd_data(data.frame(n = 1:2), id = "nope"), "must name a column")
})

test_that("the id column is not also an annotation", {
  d <- cxd_data(data.frame(id = c("a", "b"), n = 1:2, g = c("u", "v")), id = "id")
  expect_equal(names(d$x), "g")
})
