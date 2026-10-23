spec_list <- function() list(id = "demo", title = "Demo", layout = list(cols = 12, items = list()), data = list(), panels = list())

test_that("a spec can be a list, a JSON string or a file", {
  expect_equal(cxd_read_spec(spec_list())$id, "demo")
  json <- '{"id":"j","layout":{"cols":12,"items":[]},"data":{},"panels":{}}'
  expect_equal(cxd_read_spec(json)$id, "j")
  path <- tempfile(fileext = ".json"); writeLines(json, path)
  expect_equal(cxd_read_spec(path)$id, "j")
})

test_that("a JSON spec keeps its arrays, numbers and empty objects through a round trip", {
  json <- '{"id":"j","insights":{},"panels":{"p":{"config":{"xAxis":["age"],"showLegend":false,"n":3}}}}'
  out <- jsonlite::fromJSON(canonicalJson(cxd_read_spec(json)), simplifyVector = FALSE)
  expect_equal(out$panels$p$config$xAxis, list("age"))
  expect_identical(out$panels$p$config$showLegend, FALSE)
  expect_equal(out$insights, structure(list(), names = character(0)))
  expect_match(canonicalJson(cxd_read_spec(json)), '"insights":\\{\\}', fixed = FALSE)
})

test_that("a hand-built list needs I() for one-element arrays, and I() works", {
  plain <- canonicalJson(list(xAxis = "age"))
  wrapped <- canonicalJson(list(xAxis = I("age")))
  expect_match(plain, '"xAxis":"age"', fixed = TRUE)
  expect_match(wrapped, '"xAxis":["age"]', fixed = TRUE)
})

test_that("bad specs are refused", {
  expect_error(cxd_read_spec(42), "list, a JSON string or a file path")
  expect_error(cxd_read_spec("not json and not a file"), "no such file")
  expect_error(cxd_read_spec("{broken"), "not valid JSON")
  expect_error(cxd_read_spec("[1,2]"), "JSON object")
})
