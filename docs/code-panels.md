# CanvasXpress code panels (author with the canvasXpress library, present in a dashboard)

Already write charts with the **R `canvasXpress` package** or the **Python
`canvasxpress` package**? Drop that code straight into a dashboard. Each snippet is
run **once, on the server, in a sandbox**, and its native CanvasXpress spec becomes
a panel — rendered as **native, interactive CanvasXpress** (hover, selection, the
customizer), not a static image. It is the sibling of [ggplot panels](ggplot-panels.md):
where that path runs ggplot2 and converts via `ggplot.as.list()`, this one runs your
own `canvasXpress(...)` / `CanvasXpress(...)` call and extracts its native spec.

This is author-once, not a live code runtime: your code runs once to produce the
chart; from then on the dashboard renders and interacts on the CanvasXpress side. It
does **not** re-run R/Python per interaction — for that you want a Shiny/Plumber or
Dash-style app, a different architecture.

## Two ways to use it

### 1. Paste in the Builder

Choose **+ Add → Code** in the Builder, pick a **Source** — ggplot2, R `canvasXpress`, or
Python `canvasxpress` (whichever the server offers) — and paste a snippet that
assigns its chart to `g`:

```r
library(canvasXpress)
y <- matrix(c(10, 20, 30, 40, 50, 60), nrow = 2, byrow = TRUE,
            dimnames = list(c("A", "B"), c("c1", "c2", "c3")))
g <- canvasXpress(data = y, graphType = "Bar")
```

```python
from canvasxpress.canvas import CanvasXpress
from canvasxpress.data.keypair import CXDictData
g = CanvasXpress(
    data=CXDictData({'y': {'vars': ['A', 'B'], 'smps': ['c1', 'c2', 'c3'],
                           'data': [[10, 20, 30], [40, 50, 60]]}}),
    config={'graphType': 'Bar'})
```

**Convert & add** posts the code to `POST /api/cx/convert`, which runs it in the
sandboxed runtime and returns the native spec; a new `type:"cxcode"` panel is added.
Open **`</> Code`** on the panel to edit the code and re-convert it.

### 2. Build from a folder with `cxd-cx`

```
bin/cxd-cx <snippets-dir> [options]
```

Each `*.R` file in `<snippets-dir>` assigns its chart to `g`; an optional leading
`# title: ...` comment titles the panel (otherwise the filename is used). Every
snippet is converted and the charts are arranged into a dashboard spec.

```r
# examples/cx-code-snippets/01-bar-sales.R
# title: Quarterly revenue by region
library(canvasXpress)
y <- matrix(c(42, 55, 61, 70, 38, 47, 52, 63), nrow = 2, byrow = TRUE,
            dimnames = list(c("West", "East"), c("Q1", "Q2", "Q3", "Q4")))
g <- canvasXpress(data = y, graphType = "Bar")
```

```
bin/cxd-cx examples/cx-code-snippets \
  --id code-panels-gallery --title "CanvasXpress Code Gallery" \
  --intro "<b>Authored with the canvasXpress library</b> — converted once, rendered as native panels." \
  --html
```

Options: `-o/--out <file>`, `--id`, `--title`, `--theme light|dark|auto`,
`--per-row <n>` (default 2), `--height <rows>` (default 7), `--intro <html>`,
`--html` (also write a runnable page), `--pkg <path>` / env `CX_PKG_ROOT` (the
local canvasXpress R package source), `--seed <n>`. The CLI converts **R** snippets
today; paste the Builder path above for Python.

## Who can run it, and how it is sandboxed

Running pasted code is arbitrary code execution, so it has the **same trust boundary
as authoring a data function**: it is gated to function authors (administrators by
default) via `CXD_FUNCTIONS`, and runs **only on the embedded runtime** — never when
a standalone function runtime (`CXD_FUNCTIONS_RUNTIME_URL`) is configured. Each
conversion runs in a throwaway temp directory with the **network denied**, filesystem
writes confined to that directory, CPU/memory/output rlimits and a wall-clock
timeout — the same OS sandbox the data functions use.

`GET /api/cx/status` reports whether the feature is available, whether the caller may
run it, and which `languages` actually have a CanvasXpress package installed — so a
server with only the R package simply offers R.

## How it renders

Each converted chart becomes a `type:"cxcode"` panel carrying a self-contained native
CanvasXpress spec (`{data, config, events, afterRender}` — its data is embedded, so
no `dataRef` is needed; unlike a ggplot panel it is **not** `isGGPlot`). The renderer
draws it with the single-object constructor, exactly as an ordinary CanvasXpress chart
— no special panel type. The spec is extracted with the library's own serializer (the
R widget's `$x` via htmlwidgets, or the Python object's `render_to_dict`), so it
matches a live widget. The assembler (`src/codePanelsDashboard.js`) is shared with the
test suite.

## Seeing how a chart was made (the recipe)

A dashboard is a reproducible recipe, not a picture — so every code panel keeps its
original source. Each panel's title bar (and its Builder inspector) has a **`</> Code`**
button that opens a dialog showing **the CanvasXpress code (R or Python)**, with a Copy
button; for function authors in the Builder it is editable and **Apply** re-converts it.

## In the Builder

A code-panels dashboard opens in the Builder like any other: the charts render in the
editable grid, and you can move, resize, retitle and delete panels, add other panels,
and save. Because a code panel's data and styling are **baked in** from your snippet,
its inspector shows a short note instead of the graph data/config editor — edit the
code via **`</> Code`** (re-converted on the server) to change it.

## Caveats

The Python `canvasxpress` package on PyPI is a third-party distribution (not part of
this project); it must be installed in the function runtime's interpreter for the
Python path to be offered. The feature never hard-depends on it — `available_languages`
degrades to R only where it is absent.
