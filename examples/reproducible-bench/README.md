# The Reproducible Bench — as a dashboard

The [reproducible-bench](narrative.html) demo re-hosted on
**canvasxpress-dashboards**: three linked genomics figures (clustered heatmap,
oncoprint, Kaplan–Meier) driven by one declarative spec.

The upstream **distillation** (20k genes → 50, variant ranking, cluster
derivation) is out of scope here — this example starts at its output, the
distilled figure tables in [`figures/`](figures/).

## Data flow

```
 (upstream R/Python distillation — see narrative.html; not part of this example)
        │
        ▼
 figures/heatmap.csv     50 genes × 41 samples          ┐
 figures/oncoprint.csv   20 genes × 41 samples          │  the hand-off boundary:
 figures/survival.csv    41 rows (time, event, group)   │  figure-scale tables only
 figures/clinical.csv    per-sample covariates + derived cluster ┘
        │
        ▼
 make_spec.py  + recipe.json (seed, methods, palette — the reproducibility record)
        │            stdlib-only; packages each table into a CanvasXpress data
        │            object and each figure's options into a panel config
        ▼
 bench.spec.json     ONE dashboard spec: 3 inline data sources, 3 panels,
        │            1 table control, a 12-col grid layout
        ▼
 renderDashboard()   bench.html — CanvasXpress computes the clustering,
                     dendrograms, and KM curve in the browser
```

Key boundaries:

- **CSV → spec** is pure packaging (`make_spec.py`); no statistics happen there.
  It also asserts chain consistency (same samples across all tables).
- **recipe.json** carries everything variable (palette, methods, titles), so the
  spec is fully described by `figures/*.csv + recipe.json`.
- **Statistics at render time** (hierarchical clustering, KM math) run inside
  CanvasXpress on the already-reduced tables — never on raw data.
- All three panels share `broadcastGroup: "reproducible-bench"` and the same 41
  sample names, so sample selections can coordinate across panels.

## Run it

```bash
python3 make_spec.py                        # figures/*.csv + recipe.json → bench.spec.json
python3 ../serve.py                         # or any static server at the repo root
open http://localhost:8000/examples/reproducible-bench/bench.html
```

To edit interactively, load `bench.spec.json` in the builder
(`examples/builder.html` → Import) — the ⚙ icon on each panel opens the native
CanvasXpress customizer.

## Files

```
reproducible-bench/
├── README.md            ← you are here
├── narrative.html       ← the product story (from the original bench repo)
├── recipe.json          ← the reproducibility record (seed, methods, palette)
├── figures/             ← INPUT: distilled tables (produced upstream)
├── make_spec.py         ← packaging: figures + recipe → dashboard spec
├── bench.spec.json      ← GENERATED — regenerate with make_spec.py, don't hand-edit
└── bench.html           ← renders the spec via renderDashboard()
```

## Figure formats (verified against the CanvasXpress source)

The original bench's oncoprint/KM configs were illustrative; this example uses
the real contracts, cross-checked against the CanvasXpress gallery examples:

- **Oncoprint** is a layered `Heatmap`: `vars` = samples, `smps` = genes,
  numeric `data` plus string layers `data2` (CNA levels: `Amplification`,
  `Deep Deletion`) and `data3` (mutations: `Missense`, `Fusion`), wired via
  `oncoprintCNA`/`oncoprintMUT`. Sample tracks live in `z` + `varOverlays`.
- **Kaplan–Meier** is `graphType: "KaplanMeier"` (an alias for Scatter2D in km
  mode): `vars` = samples, `smps` = `["time", "event"]`, the split variable in
  `z.group`, selected with `xAxis`/`yAxis`/`colorBy`.

## Caveats (inherited from the bench)

- The data is **synthetic** (simulated cohort), not real patient data.
