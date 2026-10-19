# Publication figures

Turn a dashboard into a **submission-ready, multi-panel figure**: pick the panels,
auto-label them **A / B / C …**, size to a journal column, and export **one true-vector
SVG** (plus a flattened PDF) at publication DPI. This replaces the manual "export each
chart, then assemble in Illustrator" step — the figure is composed from each chart's own
vector output, so text stays text and lines stay lines (no rasterization).

## Quick start

From a live dashboard handle (what `renderDashboard` returns):

```js
import { renderDashboard, exportFigureSvg } from 'canvasxpress-dashboards';

const handle = await renderDashboard(spec, 'dashboard').ready.then(() => handle);

// All graph panels, in dashboard reading order, A/B/C labels,
// Nature two-column (183 mm) at 300 DPI — downloads figure.svg.
exportFigureSvg(handle, { preset: 'nature', columns: 'two', dpi: 300 });
```

In the **viewer** (`view.html`), the same thing is one click: the **Download ▾** menu has a
**Publication figure** item that composes every graph panel with those defaults.

## Choosing panels, order and labels

By default the composer takes **every graph panel** (control / text / image / filter panels
are skipped) in the dashboard's own **reading order** (top-to-bottom, then left-to-right),
and reuses the dashboard grid for placement. Override any of that:

```js
exportFigureSvg(handle, {
  panels: ['km-curve', 'volcano', 'heatmap'],  // explicit order (also selects a subset)
  labelStyle: 'A',          // 'A' | 'a' | '1' | 'none'
  cols: 2,                  // grid columns (default: the dashboard's layout.cols)
  caption: 'Figure 1. Cohort response.',
  filename: 'figure-1.svg'
});
```

`composeFigureModel(handle, opts)` returns the plan (panels, labels, grid units) without
rendering, if you want to inspect or tweak it first.

## Journal size and DPI

`preset` + `columns` resolve to a physical width; `dpi` sets the pixel size. Width presets
(millimetres) follow each publisher's author guidelines:

| Preset    | One column | Two column |
|-----------|-----------:|-----------:|
| `nature`  | 89 mm      | 183 mm     |
| `cell`    | 85 mm      | 174 mm     |
| `science` | 55 mm      | 120 mm     |
| `plos`    | 83 mm      | 173 mm     |
| `generic` | 90 mm      | 180 mm     |

```js
import { figureDimensions } from 'canvasxpress-dashboards';
figureDimensions({ preset: 'nature', columns: 'two', dpi: 300 });
// → { widthPx: 2161, heightPx: 1621, widthMm: 183, heightMm: 137.25, dpi: 300 }
```

Or bypass the presets with explicit `widthMm` / `heightMm` (and `aspect` for height from
width). `mmToPx(mm, dpi)` is exported for your own sizing.

## PDF

```js
import { exportFigurePdf } from 'canvasxpress-dashboards';
exportFigurePdf(handle, { preset: 'nature', columns: 'two', dpi: 300, jsPDF, svg2pdf });
```

Pass a `jsPDF` constructor (and, for a **true-vector** PDF, an `svg2pdf` function); both
default to the globals `window.jspdf.jsPDF` / `window.svg2pdf` when present. Without
`svg2pdf` the PDF falls back to a high-DPI raster of the composite. The SVG path needs no
extra library and is the recommended artifact for journal submission.

## How it works (and what it does not do)

Each panel is the engine's own `getSVGString()` output — a complete, standalone `<svg>`
with the chart's text, paths and a11y description. The composer re-roots each into the
figure canvas with a `viewBox` (so it scales, never clips), lays them out on the grid with
a uniform gutter, draws the subplot labels, and adds the optional shared caption. The result
is **one** SVG document; nothing is flattened to a bitmap.

It does **not** add a `figure` chart type to the engine, and it is not a general vector
illustration editor — for fine typographic tweaks, open the exported SVG in Inkscape or
Illustrator.

## API

| Export | Returns | Notes |
|---|---|---|
| `composeFigureModel(handle, opts)` | `{ panels, cols, labelStyle }` | Plan only — panels (id, label, grid x/y/w/h), no render. |
| `composeFigureSvg(handle, opts)` | `{ svg, model, size }` | The composite SVG string. |
| `exportFigureSvg(handle, opts, doc?)` | `{ svg, model, size }` | Composes **and** downloads `figure.svg`. |
| `composeFigurePdf(handle, opts)` | `Promise<{ blob, model, size }>` | Needs `jsPDF`; vector with `svg2pdf`, else raster. |
| `exportFigurePdf(handle, opts, doc?)` | `Promise<{…}>` | Composes **and** downloads `figure.pdf`. |
| `figureDimensions(opts)` / `mmToPx(mm, dpi)` | sizing | Journal presets → pixels. |
| `JOURNAL_PRESETS` | object | The width table above. |
