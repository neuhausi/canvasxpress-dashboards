fake_session <- function() {
  sent <- list()
  list(ns = function(id) paste0("mod-", id),
       sendCustomMessage = function(type, message) sent[[length(sent) + 1L]] <<- list(type = type, message = message),
       sent = function() sent)
}

test_that("proxy calls send a namespaced message for the dashboard", {
  skip_if_not_installed("shiny")
  s <- fake_session()
  p <- cxdashboardProxy("dash", session = s)
  expect_s3_class(p, "cxdashboard_proxy")
  expect_identical(cxd_set_param(p, "case", "P018"), p)
  cxd_focus_panel(p, "case")
  msgs <- s$sent()
  expect_equal(msgs[[1]]$type, "cxdashboard-proxy")
  expect_equal(msgs[[1]]$message, list(id = "mod-dash", method = "setParam", args = list(name = "case", value = "P018")))
  expect_equal(msgs[[2]]$message$method, "focusPanel")
  expect_equal(msgs[[2]]$message$args$panel, "case")
})

test_that("proxy arguments are validated", {
  skip_if_not_installed("shiny")
  p <- cxdashboardProxy("dash", session = fake_session())
  expect_error(cxd_set_param(p, c("a", "b"), 1), "single string")
  expect_error(cxd_focus_panel(p, 3), "single string")
  expect_error(cxd_set_param(list(), "case", "x"), "from cxdashboardProxy")
  expect_error(cxdashboardProxy("dash", session = NULL), "Shiny server function")
})
