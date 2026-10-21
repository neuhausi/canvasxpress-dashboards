#!/usr/bin/env Rscript
# cxd-ggplot-convert — convert a directory of ggplot snippets into an array of
# self-contained CanvasXpress "isGGPlot" specs (one per snippet), printed as
# JSON to stdout. The node CLI (cxd-ggplot.mjs) consumes this and assembles the
# dashboard spec; this script does conversion ONLY.
#
# Each snippet is an .R file that assigns its ggplot object to `g`. A panel key
# comes from the filename (sans extension); a title comes from a leading
# "# title: ..." comment, else the key humanized.
#
# Usage:
#   cxd-ggplot-convert.R --dir <snippets/> [--pkg <R/canvasXpress>] [--seed 1]
# Env:
#   CX_PKG_ROOT  default path to the local canvasXpress R package source.
#
# Emits: [ { "key": "...", "title": "...", "spec": { isGGPlot:true, ... } }, ... ]

suppressMessages({
  library(ggplot2)
  library(pkgload)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = TRUE)
get_opt <- function(flag, default = NULL) {
  i <- match(flag, args)
  if (is.na(i) || i == length(args)) return(default)
  args[i + 1]
}

dir_path <- get_opt("--dir")
seed     <- as.integer(get_opt("--seed", "1"))
pkg_root <- get_opt("--pkg", Sys.getenv("CX_PKG_ROOT",
             "/Users/isaac/git/canvas-ai/R/canvasXpress"))

if (is.null(dir_path) || !dir.exists(dir_path)) {
  stop("--dir <snippets/> is required and must be an existing directory")
}
if (!dir.exists(pkg_root)) {
  stop(paste0("canvasXpress R package not found at '", pkg_root,
              "'. Pass --pkg or set CX_PKG_ROOT."))
}

suppressMessages(pkgload::load_all(pkg_root, quiet = TRUE))

files <- sort(list.files(dir_path, pattern = "[.][Rr]$", full.names = TRUE))
if (!length(files)) stop(paste0("no .R snippets found in '", dir_path, "'"))

# Derive a human title from a leading "# title:" comment, else humanize the key.
title_from <- function(path, key) {
  lines <- readLines(path, warn = FALSE)
  hit <- grep("^\\s*#\\s*title\\s*:", lines, value = TRUE, ignore.case = TRUE)[1]
  if (!is.na(hit)) {
    return(trimws(sub("^\\s*#\\s*title\\s*:\\s*", "", hit, ignore.case = TRUE)))
  }
  words <- strsplit(gsub("[-_]+", " ", key), "\\s+")[[1]]
  paste(toupper(substring(words, 1, 1)), substring(words, 2), sep = "",
        collapse = " ")
}

out <- vector("list", length(files))
for (i in seq_along(files)) {
  path <- files[i]
  key  <- tools::file_path_sans_ext(basename(path))
  set.seed(seed)                         # reproducible sample()-based snippets
  env <- new.env(parent = globalenv())
  source(path, local = env)
  if (!exists("g", envir = env)) {
    stop(paste0("snippet '", basename(path), "' must assign its plot to `g`"))
  }
  spec_json <- ggplot.as.list(get("g", envir = env))
  spec <- fromJSON(as.character(spec_json), simplifyVector = FALSE)
  # Keep the original R source so the dashboard can show how the plot was made
  # (the "</> Code" recipe) — a dashboard is a reproducible recipe, not a picture.
  code <- paste(readLines(path, warn = FALSE), collapse = "\n")
  out[[i]] <- list(key = key, title = title_from(path, key), spec = spec, code = code)
}

cat(toJSON(out, auto_unbox = TRUE, digits = NA, null = "null"))
