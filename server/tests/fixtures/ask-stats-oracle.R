# Regenerate fixtures/ask-stats-oracle.json: random datasets with the answers R gives for the
# statistics behind the deterministic checks in cxd_server/ask_tools.py, so test_ask_tools.py can hold
# the Python (stdlib-only) implementation to R without needing R at test time.
#   Rscript server/tests/fixtures/ask-stats-oracle.R
suppressMessages(library(jsonlite))
set.seed(20261023)
cases <- list()
for (i in 1:60) {
  k <- sample(2:5, 1)
  sizes <- sample(3:20, k, replace = TRUE)
  ties <- runif(1) < 0.5
  shifts <- runif(k, -1, 1) * sample(c(0, 0.5, 2), 1)
  vals <- unlist(lapply(seq_len(k), function(g) rnorm(sizes[g], shifts[g], 1)))
  vals <- if (ties) round(vals) else round(vals, 4)
  if (runif(1) < 0.4) vals[sample(length(vals), 1)] <- vals[sample(length(vals), 1)] + sample(c(-1, 1), 1) * runif(1, 8, 20)  # an outlier
  grp <- factor(rep(paste0("g", seq_len(k)), sizes))
  ids <- paste0("r", seq_along(vals))
  q <- quantile(vals, c(0.25, 0.75), type = 7); iqr <- q[[2]] - q[[1]]
  lo <- q[[1]] - 1.5 * iqr; hi <- q[[2]] + 1.5 * iqr
  kt <- tryCatch(kruskal.test(vals, grp), error = function(e) NULL)
  ps <- runif(sample(1:30, 1))^sample(c(1, 3), 1)
  cases[[i]] <- list(
    data = list(y = list(vars = list("m"), smps = as.list(ids), data = list(as.list(vals))), x = list(g = as.list(as.character(grp)))),
    r = list(
      q1 = q[[1]], q3 = q[[2]], low_fence = lo, high_fence = hi,
      flagged = as.list(ids[vals < lo | vals > hi]),
      kw = if (is.null(kt)) NULL else list(H = unname(kt$statistic), df = unname(kt$parameter), p = kt$p.value),
      ps = as.list(ps), bh = as.list(p.adjust(ps, "BH"))
    )
  )
}
out <- file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE)[1])), "ask-stats-oracle.json")
write(toJSON(list(generator = "Rscript server/tests/fixtures/ask-stats-oracle.R", r_version = R.version.string, cases = cases),
             auto_unbox = TRUE, digits = NA, null = "null"), out)
cat("wrote", length(cases), "cases to", out, "\n")
