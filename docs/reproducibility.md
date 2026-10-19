# Reproducibility (provenance + reproducible bundle)

A CanvasXpress dashboard can state **how every panel was computed** and export a
self-contained bundle that **reproduces the figures offline** — the spec, a data
snapshot, per-panel R *and* Python regeneration code, a methods note, and a
content-hash manifest. This is the difference between a figure a reviewer has to
take on trust and one they can re-run.

Two pieces work together:

1. **Provenance method lines** — each panel can show a one-line, auto-derived
   description of what it actually did, as a figure-legend footer.
2. **The reproducible bundle** — a one-click `.zip` export with everything needed
   to regenerate the figures.

## Method lines (the figure footer)

Turn on a panel's method footer by setting `provenance.show` on the panel (in the
Builder: select the panel, tick **Method**):

```jsonc
{
  "panels": {
    "byRegion": {
      "dataRef": "sales",
      "config": { "graphType": "Bar" },
      "provenance": { "show": true, "notes": "excludes intra-company sales" }
    }
  }
}
```

The line is **derived from the operations the panel performs**, never free text
that can drift from the chart:

- the data source origin (inline / dataset / connector / live);
- a `kind:"join"` (how + inputs + key), recursively through nested joins;
- a `kind:"function"` source's language (R / Python);
- the source's `pushdown` (aggregate `fn`+`groupBy`, filter, sort, limit);
- the source's `calculatedFields` (formula, binning);
- the chart's statistical overlays (loess / regression / forecast, with
  confidence intervals).

So the bar panel above renders a footer like:

> inline data; aggregated (sum of Revenue) grouped by Region; plotted as Bar — excludes intra-company sales

### Pinning an author-written method

To write the line yourself instead of deriving it, set `auto: false` and a
`method`:

```jsonc
"provenance": { "show": true, "auto": false, "method": "Age-adjusted incidence per 100k (model v3)" }
```

## The reproducible bundle

From a rendered dashboard — the viewer toolbar's **Download → Reproducible
bundle**, or programmatically:

```js
import { renderDashboard, exportReproducibleBundle } from 'canvasxpress-dashboards';

const handle = await renderDashboard(spec, 'dashboard');
await exportReproducibleBundle(handle, { engineVersion: '71.8' });   // downloads <id>-bundle.zip
```

`exportReproducibleBundle(handle, opts)` needs a **live** handle (it reads each
panel's rendered instance to emit regeneration code). Related entry points:
`buildReproducibleBundle(handle, opts)` returns the `.zip` bytes, and
`buildBundleFiles(handle, opts)` returns the file list.

### What's in the zip

```
spec.json          self-contained dashboard spec (every source inlined)
data/<ref>.json    a snapshot of each data source's resolved data
code/<panel>.R     per-panel R  code that regenerates the chart
code/<panel>.py    per-panel Python code that regenerates the chart
code/source-<ref>.R|.py   an R/Python data-function source's own snippet
methods.md         a human methods note: method line per panel + source provenance
manifest.json      generated time, schema/engine version, params, a content hash
```

The per-panel R / Python come from the engine's own `dataToR` / `dataToPython`
emitters, so they match what the chart drew. A `kind:"function"` source's code is
taken from the original spec (inlining bakes it to data), so that transform is
reproducible too.

### Versioning and the content hash

Every export stamps the capture time (`asOf`), the dashboard `version`, the
engine version (when passed as `opts.engineVersion`), and a **content hash** in
`manifest.json`:

```jsonc
{
  "generated": "2026-10-16T12:00:00Z",
  "dashboard": { "id": "sales", "title": "Sales", "version": 4 },
  "contentHash": "sha256:…",
  "files": { "spec.json": "sha256:…", "data/sales.json": "sha256:…", … }
}
```

The `contentHash` is a **figure fingerprint** over the reproducible inputs (spec
+ data + code), excluding the timestamp — so re-exporting the *same* figure later
gives the *same* hash, while different data or config gives a different one. A
reviewer can cite it to tell two figures apart, and the per-file hashes let them
verify any single file.

## Scope

The bundle targets the reader's own R / Python. It is not a lab notebook, it does
not sign figures cryptographically, and it does not re-run itself inside the
dashboard. See the live [Reproducible Provenance example](../examples/reproducible-provenance.html).
