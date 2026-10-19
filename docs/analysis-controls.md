# Analysis controls

Dashboard-level **analysis** controls, not display filters. A scientist toggles a transform or
slides one FDR threshold and the whole dashboard *re-runs the analysis*. BI tools filter rows for
display; CanvasXpress dashboards recompute. Everything here is renderer-first: light transforms and
multiple-testing correction run client-side (instant, offline); heavy batch correction stays a
server-side `function` source.

## Transform control

Re-expresses a target panel's data (log/z-score/normalize) by calling `updateData` on its live
instance — no re-query. Each transform matches its R reference (validated against `scale()`,
`log2`, `median`, `preprocessCore::normalize.quantiles`).

```js
import { buildTransformControl } from 'canvasxpress-dashboards';
spec.panels.tf = buildTransformControl({ target: 'heatmap', value: 'none' });
// methods: none | log2 | log10 | zscore | medianCenter | quantileNormalize
```

In the builder: **∿ Transform** adds one bound to the selected (or first) graph panel.
`transformData(cxData, method)` is exported for direct use.

## FDR threshold slider

One numeric slider that recorrects **dashboard-scope** (pools every comparison across panels and
corrects once — the honest FDR unit) and re-filters every significance panel: non-significant
brackets drop out and a bound volcano's cut-off line moves. Built on `applyDashboardCorrection`
(statInference) and the shipped param → recompute path.

```js
import { buildFdrSliderControl } from 'canvasxpress-dashboards';
spec.params.fdr = 0.05;
spec.panels.fdr = buildFdrSliderControl({ param: 'fdr', value: 0.05, method: 'BH' });
```

In the builder: **FDR slider** declares the `fdr` param and adds the slider. On change the renderer
calls `applyFdrThreshold(panels, {threshold, method})`, which sets `padj` + `hidden` on each
comparison; the engine draws only the surviving brackets (`statInference` skips `hidden`).

## Batch correction (opt-in hook)

Heavy correction (ComBat / limma `removeBatchEffect`) is a server-side `function` source, **off by
default**, gated on a param and recorded in provenance. The body is a documented stub for the host's
functions runtime to implement.

```js
import { batchCorrectionSource } from 'canvasxpress-dashboards';
spec.data.corrected = batchCorrectionSource({ input: 'counts', batch: 'lane', method: 'combat' });
// enabled only when the `batchCorrect` param is truthy
```

## Provenance

Every applied transform / threshold / correction is recordable so a silently transformed panel is
never a reproducibility hazard: `describeAnalysisControls(spec)` returns the clauses (e.g. *"values
log2-transformed"*, *"filtered at FDR ≤ 0.05 (BH correction, dashboard-scope)"*).

## Example

See [`examples/analysis-controls.spec.json`](../examples/analysis-controls.spec.json): a boxplot
with significance brackets, a transform control, and an FDR slider that re-filters the brackets.
