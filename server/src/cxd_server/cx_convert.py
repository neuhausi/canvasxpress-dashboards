"""Convert pasted R `canvasXpress` or Python `canvasxpress` code into a native
CanvasXpress dashboard panel spec, sandboxed.

This is the "paste CanvasXpress library code, get a dashboard panel" path — the
sibling of :mod:`cxd_server.ggplot_convert`. Where that path runs ggplot2 and
extracts an ``isGGPlot`` spec, this one runs the author's own
``canvasXpress(...)`` call and extracts the widget's native spec
(``{data, config, events, afterRender}``), which the dashboard renderer draws as
an ordinary CanvasXpress panel — no ``isGGPlot``, no special panel type.

Running pasted code is arbitrary code execution, so — exactly like
``ggplot_convert`` — it does NOT get a weaker execution path: it reuses the
data-function runtime's OS sandbox and resource limits verbatim
(:func:`cxd_server.functions._launch`). Every conversion therefore runs:

* in a fresh throwaway temp directory with a minimal environment (no server
  secrets, no inherited variables),
* with the network denied and filesystem writes confined to that temp dir
  (macOS ``sandbox-exec`` / Linux ``bwrap``; see ``functions._resolve_wrapper``),
* under CPU / memory / output rlimits and a wall-clock timeout,
* behind the same concurrency cap.

It is gated by the same ``CXD_FUNCTIONS`` mode as data functions and is
authorized only for users who may author functions (administrators by default):
the caller controls the whole program, which the sandbox contains but cannot
make safe by inspection. When a STANDALONE function runtime is configured
(``CXD_FUNCTIONS_RUNTIME_URL``) the operator has deliberately moved code
execution off this host; this local path then refuses rather than betray that.

The R harness loads the installed ``canvasXpress`` package, evaluates the
snippet — which must assign its widget to ``g`` — and writes the widget's ``g$x``
list, serialized with htmlwidgets' own JSON serializer (so the spec is
byte-for-byte what the browser would have received), to ``result.json``. The
result is the ``spec`` for a native CanvasXpress dashboard panel.

The Python harness is the mirror image: it loads the installed ``canvasxpress``
package, evaluates the snippet — which must assign its ``CanvasXpress`` object to
``g`` — and writes ``{data, config, events, afterRender}`` (from the object's
``render_to_dict`` accessors) to ``result.json``. (Note: the Python
``canvasxpress`` distribution on PyPI is a third-party package, not part of this
project; it must be installed in the function runtime's interpreter for the
Python path to be offered — ``available_languages`` reflects that.)
"""
import json
import os
import subprocess
import tempfile

from . import functions

# Languages this converter can run: the R `canvasXpress` package and the Python
# `canvasxpress` package. Each is filtered at runtime by `available_languages`
# to those whose interpreter + package actually import here.
LANGUAGES = ("r", "python")


class CxConvertError(Exception):
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
  suppressWarnings(suppressMessages(library(canvasXpress)))
  TRUE
}, error = function(e) FALSE)
if (!ok) {
  writeErr("The server's R install is missing the canvasXpress package.")
}
# htmlwidgets' own serializer is what the browser normally receives; use it so
# the extracted spec matches a live widget byte-for-byte. Fall back to jsonlite.
serialize <- tryCatch(get("toJSON", envir = asNamespace("htmlwidgets")),
                      error = function(e) NULL)
if (is.null(serialize)) {
  okJ <- tryCatch({ suppressWarnings(suppressMessages(library(jsonlite))); TRUE },
                  error = function(e) FALSE)
  if (!okJ) writeErr("The server's R install is missing htmlwidgets and jsonlite.")
  serialize <- function(x) jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", na = "null")
}
env <- new.env(parent = globalenv())
srcErr <- tryCatch({ source("snippet.R", local = env); NULL },
                   error = function(e) conditionMessage(e))
if (!is.null(srcErr)) writeErr(paste("Error running your R code:", srcErr))
if (!exists("g", envir = env)) {
  writeErr("Your code must assign the canvasXpress chart to a variable named `g`.")
}
widget <- get("g", envir = env)
if (!inherits(widget, "canvasXpress") || is.null(widget$x)) {
  writeErr("`g` is not a canvasXpress chart. Assign the result of canvasXpress(...) to `g`.")
}
spec <- tryCatch(as.character(serialize(widget$x)),
                 error = function(e) NULL)
if (is.null(spec) || !nzchar(spec)) {
  writeErr("Could not serialize the chart. Is `g` a canvasXpress widget?")
}
# serialize() returns a JSON string; splice it in as the spec value.
writeLines(paste0('{"spec":', spec, '}'), res)
'''


# Python harness. Same contract as the R one: writes exactly one JSON object to
# result.json — {"spec": {...}} on success or {"error": "..."} otherwise — and
# never raises past this file, so a broken snippet becomes a clean 400. Runs
# under ``python -I`` (isolated), so only the interpreter's own site-packages are
# importable; the snippet must assign its CanvasXpress object to ``g``.
_PY_HARNESS = r'''
import json, sys, traceback

RES = "result.json"

def write_err(msg):
    try:
        with open(RES, "w") as fh:
            json.dump({"error": str(msg)[:2000]}, fh)
    finally:
        sys.exit(0)

try:
    from canvasxpress.canvas import CanvasXpress
except Exception:
    write_err("The server's Python is missing the canvasxpress package.")

namespace = {}
try:
    with open("snippet.py") as fh:
        source = fh.read()
    exec(compile(source, "snippet.py", "exec"), namespace, namespace)
except Exception as exc:
    write_err("Error running your Python code: "
              + "".join(traceback.format_exception_only(type(exc), exc)).strip())

chart = namespace.get("g")
if chart is None:
    write_err("Your code must assign the CanvasXpress chart to a variable named `g`.")
if not isinstance(chart, CanvasXpress):
    write_err("`g` is not a CanvasXpress chart. Assign a CanvasXpress(...) object to `g`.")

try:
    data = chart.data.render_to_dict() if chart.data is not None else None
    config = chart.config.render_to_dict() if chart.config is not None else {}
    try:
        events = chart.events.render_to_dict()
    except Exception:
        events = None
    after_render = chart.after_render if getattr(chart, "after_render", None) else None
    spec = {
        "data": data,
        "config": config,
        "events": events or None,
        "afterRender": after_render or None,
    }
except Exception as exc:
    write_err("Could not serialize the chart: " + str(exc))

with open(RES, "w") as fh:
    json.dump({"spec": spec}, fh)
'''


# Per-language harness + how to invoke the interpreter, keyed by language.
_RUNTIME = {
    "r": {"snippet": "snippet.R", "harness": "run.R", "harness_src": _R_HARNESS},
    "python": {"snippet": "snippet.py", "harness": "run.py", "harness_src": _PY_HARNESS},
}


# Cache of which languages actually import here, keyed by (python, rscript), so a
# status call does not spawn a probe every time.
_LANG_CACHE = {}


def available_languages(config: "functions.FunctionsConfig") -> list:
    """The subset of :data:`LANGUAGES` whose interpreter + CanvasXpress package
    actually import on this host. Cached per (python, rscript)."""
    key = (config.python, config.rscript)
    if key not in _LANG_CACHE:
        langs = []
        if functions._works([config.rscript, "-e",
                             "suppressMessages(library(canvasXpress))"]):
            langs.append("r")
        if functions._works([config.python, "-I", "-c", "import canvasxpress"]):
            langs.append("python")
        _LANG_CACHE[key] = langs
    return list(_LANG_CACHE[key])


def available(config: "functions.FunctionsConfig") -> bool:
    """Whether paste-to-panel can run here: the runtime is enabled AND executes
    locally (a standalone runtime means code must not run on this host)."""
    return config.mode != "off" and not config.runtime_url


def convert(code: str, config: "functions.FunctionsConfig", language: str = "r") -> dict:
    """Convert pasted CanvasXpress library ``code`` (assigning ``g``) to a spec.

    :param code: The snippet; must assign its chart to ``g``.
    :param config: The shared :class:`functions.FunctionsConfig` (gating, sandbox
        wrapper, rlimits, concurrency).
    :param language: ``"r"`` (the R ``canvasXpress`` package) or ``"python"``
        (the Python ``canvasxpress`` package).
    :returns: The native CanvasXpress ``spec`` (``{data, config, events,
        afterRender}``), ready to drop into a dashboard panel.
    :raises CxConvertError: disabled/off-host (403), unsupported/unavailable
        language (400), bad or failing code (400), timeout (504), oversize
        input/output (413), or busy (429).
    """
    if config.mode == "off":
        raise CxConvertError(
            "CanvasXpress code conversion is disabled on this server "
            "(set CXD_FUNCTIONS).", 403)
    if config.runtime_url:
        raise CxConvertError(
            "CanvasXpress code conversion runs on the embedded runtime and is not "
            "available while a standalone function runtime is configured.", 403)
    if language not in LANGUAGES:
        raise CxConvertError(
            'language must be one of: %s' % ", ".join(LANGUAGES))
    if language not in available_languages(config):
        raise CxConvertError(
            'the "%s" runtime is not available on this server (its interpreter '
            'or CanvasXpress package is not installed).' % language)
    if not isinstance(code, str) or not code.strip():
        raise CxConvertError("code must be a non-empty string")
    if len(code.encode("utf-8")) > config.max_input:
        raise CxConvertError(
            "code is too large (> %d bytes)" % config.max_input, 413)
    if not config._slots.acquire(blocking=False):
        raise CxConvertError("The runtime is busy; try again shortly.", 429)
    try:
        return _run(code, config, language)
    finally:
        config._slots.release()


def _run(code: str, config: "functions.FunctionsConfig", language: str) -> dict:
    runtime = _RUNTIME[language]
    with tempfile.TemporaryDirectory(prefix="cxd-cx-") as workdir:
        with open(os.path.join(workdir, runtime["snippet"]), "w") as fh:
            fh.write(code)
        harness = os.path.join(workdir, runtime["harness"])
        with open(harness, "w") as fh:
            fh.write(runtime["harness_src"])
        if language == "python":
            command = [config.python, "-I", harness]
        else:
            command = [config.rscript or "Rscript", "--vanilla", harness]
        try:
            proc = functions._launch(command, workdir, config, config.timeout)
        except subprocess.TimeoutExpired:
            raise CxConvertError(
                "CanvasXpress code conversion timed out after %gs" % config.timeout, 504)
        except OSError as exc:
            raise CxConvertError(
                "Could not start the %s runtime: %s" % (language, exc), 500)
        result_path = os.path.join(workdir, "result.json")
        if proc.returncode != 0 or not os.path.exists(result_path):
            raise CxConvertError(functions._failure_message(proc))
        if os.path.getsize(result_path) > config.max_output:
            raise CxConvertError(
                "Result is too large (> %d bytes)" % config.max_output, 413)
        with open(result_path) as fh:
            result = json.load(fh)
        if "error" in result:
            raise CxConvertError(str(result["error"]))
        spec = result.get("spec")
        if not isinstance(spec, dict) or not isinstance(spec.get("config"), dict):
            raise CxConvertError(
                "The snippet did not produce a canvasXpress chart (assign your "
                "canvasXpress(...) result to `g`).")
        return spec
