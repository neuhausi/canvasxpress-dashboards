"""Convert pasted R / ggplot2 code into a CanvasXpress ``ggplot`` panel, sandboxed.

This is the "paste R code, get a dashboard panel" path. Running pasted R is
arbitrary code execution, so it does NOT get its own weaker execution path: it
reuses the data-function runtime's OS sandbox and resource limits verbatim
(:func:`cxd_server.functions._launch`). Every conversion therefore runs:

* in a fresh throwaway temp directory with a minimal environment (no server
  secrets, no inherited variables),
* with the network denied and filesystem writes confined to that temp dir
  (macOS ``sandbox-exec`` / Linux ``bwrap``; see ``functions._resolve_wrapper``),
* under CPU / memory / output rlimits and a wall-clock timeout,
* behind the same concurrency cap.

It is gated by the same ``CXD_FUNCTIONS`` mode as data functions and is
authorized only for users who may author functions (administrators by default):
the caller controls the whole R program, which the sandbox contains but cannot
make safe by inspection. When a STANDALONE function runtime is configured
(``CXD_FUNCTIONS_RUNTIME_URL``) the operator has deliberately moved code
execution off this host; this local path then refuses rather than betray that.

The R harness loads the installed ``canvasXpress`` package (which exports
``ggplot.as.list``) plus ``ggplot2``, evaluates the snippet — which must assign
its plot to ``g`` — and writes ``ggplot.as.list(g)`` (a self-contained isGGPlot
spec) to ``result.json``. The result is the ``spec`` for a ``type:"ggplot"``
dashboard panel.
"""
import json
import os
import subprocess
import tempfile

from . import functions


class GgplotConvertError(Exception):
    """A bad request, a failing snippet, a timeout, or a busy/misconfigured runtime."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# R harness. Writes exactly one JSON object to result.json: {"spec": {...}} on
# success, or {"error": "..."} otherwise. It never raises past this file, so a
# broken snippet becomes a clean 400 rather than a stack trace.
_R_HARNESS = r'''
res <- "result.json"
writeErr <- function(msg) {
  # Minimal, dependency-free JSON string escaping for the error message.
  s <- as.character(msg)[1]
  if (is.na(s)) s <- "unknown error"
  s <- gsub("\\", "\\\\", s, fixed = TRUE)
  s <- gsub('"', '\\"', s, fixed = TRUE)
  s <- gsub("[[:cntrl:]]", " ", s)
  writeLines(paste0('{"error":"', s, '"}'), res)
  quit(save = "no", status = 0)
}
ok <- tryCatch({
  suppressWarnings(suppressMessages(library(ggplot2)))
  suppressWarnings(suppressMessages(library(canvasXpress)))
  TRUE
}, error = function(e) FALSE)
if (!ok || !exists("ggplot.as.list")) {
  writeErr("The server's R install is missing ggplot2 or the canvasXpress package (ggplot.as.list).")
}
env <- new.env(parent = globalenv())
srcErr <- tryCatch({ source("snippet.R", local = env); NULL },
                   error = function(e) conditionMessage(e))
if (!is.null(srcErr)) writeErr(paste("Error running your R code:", srcErr))
if (!exists("g", envir = env)) {
  writeErr("Your code must assign the ggplot to a variable named `g`.")
}
plot <- get("g", envir = env)
spec <- tryCatch(as.character(ggplot.as.list(plot)),
                 error = function(e) NULL)
if (is.null(spec) || !nzchar(spec)) {
  writeErr("Could not convert the plot. Is `g` a ggplot object?")
}
# ggplot.as.list() already returns a JSON string; splice it in as the spec value.
writeLines(paste0('{"spec":', spec, '}'), res)
'''


def available(config: "functions.FunctionsConfig") -> bool:
    """Whether paste-to-ggplot can run here: the runtime is enabled AND executes
    locally (a standalone runtime means code must not run on this host)."""
    return config.mode != "off" and not config.runtime_url


def convert(code: str, config: "functions.FunctionsConfig") -> dict:
    """Convert pasted R/ggplot2 ``code`` (assigning ``g``) to an isGGPlot spec.

    :param code: The R snippet; must assign its plot to ``g``.
    :param config: The shared :class:`functions.FunctionsConfig` (gating, sandbox
        wrapper, rlimits, concurrency).
    :returns: The isGGPlot ``spec`` (a self-contained CanvasXpress object).
    :raises GgplotConvertError: disabled/off-host (403), bad or failing code
        (400), timeout (504), oversize input/output (413), or busy (429).
    """
    if config.mode == "off":
        raise GgplotConvertError(
            "ggplot conversion is disabled on this server (set CXD_FUNCTIONS).", 403)
    if config.runtime_url:
        raise GgplotConvertError(
            "ggplot conversion runs on the embedded runtime and is not available "
            "while a standalone function runtime is configured.", 403)
    if not isinstance(code, str) or not code.strip():
        raise GgplotConvertError("code must be a non-empty string")
    if len(code.encode("utf-8")) > config.max_input:
        raise GgplotConvertError(
            "code is too large (> %d bytes)" % config.max_input, 413)
    if not config._slots.acquire(blocking=False):
        raise GgplotConvertError("The runtime is busy; try again shortly.", 429)
    try:
        return _run(code, config)
    finally:
        config._slots.release()


def _run(code: str, config: "functions.FunctionsConfig") -> dict:
    with tempfile.TemporaryDirectory(prefix="cxd-gg-") as workdir:
        with open(os.path.join(workdir, "snippet.R"), "w") as fh:
            fh.write(code)
        harness = os.path.join(workdir, "run.R")
        with open(harness, "w") as fh:
            fh.write(_R_HARNESS)
        command = [config.rscript or "Rscript", "--vanilla", harness]
        try:
            proc = functions._launch(command, workdir, config, config.timeout)
        except subprocess.TimeoutExpired:
            raise GgplotConvertError(
                "ggplot conversion timed out after %gs" % config.timeout, 504)
        except OSError as exc:
            raise GgplotConvertError("Could not start the R runtime: %s" % exc, 500)
        result_path = os.path.join(workdir, "result.json")
        if proc.returncode != 0 or not os.path.exists(result_path):
            raise GgplotConvertError(functions._failure_message(proc))
        if os.path.getsize(result_path) > config.max_output:
            raise GgplotConvertError(
                "Result is too large (> %d bytes)" % config.max_output, 413)
        with open(result_path) as fh:
            result = json.load(fh)
        if "error" in result:
            raise GgplotConvertError(str(result["error"]))
        spec = result.get("spec")
        if not isinstance(spec, dict) or spec.get("isGGPlot") is not True:
            raise GgplotConvertError(
                "The snippet did not produce a ggplot (assign your plot to `g`).")
        return spec
