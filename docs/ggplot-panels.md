# ggplot panels (author charts in R, present them in a dashboard)

Build a dashboard from a folder of R/ggplot2 code. Each ggplot is converted once
— in R, via the canvasXpress package's `ggplot.as.list()` — into a self-contained
CanvasXpress chart, and laid out as a grid of panels. The result is **native,
interactive CanvasXpress** (hover, selection, the customizer), not a static image.

This is build-time authoring, not a live R runtime: ggplot runs once to produce
the chart; from then on the dashboard renders and interacts on the CanvasXpress
side. It fits "I have a collection of ggplot analyses and want to present them
together, interactively." It does **not** re-run R per interaction — for that you
want a Shiny/Plumber-style app, a different architecture.

## The tool

```
bin/cxd-ggplot <snippets-dir> [options]
```

Each `*.R` file in `<snippets-dir>` assigns its ggplot object to `g`; an optional
leading `# title: ...` comment titles the panel (otherwise the filename is used).
Every snippet is converted and the charts are arranged into a dashboard spec.

```r
# examples/ggplot-snippets/mpg-scatter.R
# title: Fuel efficiency vs. weight
g <- ggplot(mtcars, aes(x = wt, y = mpg, color = factor(cyl))) +
  geom_point(size = 2) +
  labs(x = "Weight (1000 lbs)", y = "MPG", color = "Cylinders")
```

```
bin/cxd-ggplot examples/ggplot-snippets \
  --id ggplot-gallery --title "ggplot Gallery" \
  --intro "<b>Authored in R with ggplot2</b> — converted once, rendered as native panels." \
  --html
```

Options: `-o/--out <file>`, `--id`, `--title`, `--theme light|dark|auto`,
`--per-row <n>` (default 2), `--height <rows>` (default 7), `--intro <html>`,
`--html` (also write a runnable page), `--pkg <path>` / env `CX_PKG_ROOT` (the
local canvasXpress R package source), `--seed <n>`.

Requirements: `Rscript` with `ggplot2`, `pkgload`, `jsonlite`, and the local
canvasXpress R package source (for the uncommitted converter). The node CLI does
the layout + spec assembly and **validates** before writing — it never emits a
spec the renderer would reject.

## How it renders

Each converted chart becomes a `type:"ggplot"` panel carrying a self-contained
CanvasXpress `isGGPlot` spec (its data frame is embedded, so no `dataRef` is
needed). The renderer uses the single-object constructor form, the only path that
routes to the engine's `cxplot` (ggplot) renderer. The assembler
(`src/ggplotDashboard.js`) is shared with the test suite.

## Seeing how a plot was made (the recipe)

A dashboard is a reproducible recipe, not a picture — so every ggplot panel keeps
its original R source. Each panel's title bar (and its Builder inspector) has a
**`</> Code`** button, the same recipe view the data-function panels use: it opens
a dialog showing **1. the ggplot2 code (R)** and **2. the data** (the data frame
as converted from R), each with a Copy button. The `cxd-ggplot` tool records each
snippet's source into `panel.code`; the data rides inside `panel.spec`.

## In the Builder

A ggplot dashboard opens in the Builder like any other: the charts render in the
editable grid, and you can move, resize, retitle and delete panels, add other
panels, and save. Because a ggplot panel's data and styling are **baked in** from
R, its inspector shows a short note instead of the graph data/config editor —
re-author the chart in R and re-run `cxd-ggplot` to change it.

## Caveats

The ggplot → CanvasXpress conversion is faithful for common geoms/scales/themes
but lossy in places (the ongoing ggplot-parity work). Exotic scales, themes, or
facets may need a touch-up. Check the rendered dashboard and adjust the snippet.
