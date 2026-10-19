# Science panels (domain-native scientific charts)

Drop a scientific data file onto a dashboard and get the *right* scientific
panel — Kaplan–Meier survival, oncoprint, clustered heatmap, Manhattan, volcano —
without hand-authoring CanvasXpress config. The CanvasXpress engine already
renders these first-class; the dashboards layer recognises the data shape and
suggests the matching panel with sane defaults.

Two pieces work together:

1. **Auto-detection** — given a bound source, recognise the common scientific
   data shapes and *suggest* the matching panel (a suggestion, never a silent
   rewrite).
2. **Panel presets** — build a config for the suggested (or chosen) panel with
   defaults grounded in the shipping engine parameters.

## Auto-detection

`detectDataShapes(data)` inspects a CanvasXpress data object and returns the
scientific panels that fit, most-confident first; `suggestPanelType(data)`
returns just the top one (or `null`). It recognises, by column name **and** value
shape:

| Shape | Recognised from | Suggests |
|---|---|---|
| Survival table | a time column + a binary/status event column | `KaplanMeier` |
| GWAS summary | chromosome + position + p-value columns | `Manhattan` |
| Differential expression | a log-fold-change column + a p-value column | `Volcano` |
| Alteration matrix | cells are mutation/CNA tokens (MUT, AMP, HOMDEL, …) | `Oncoprint` |
| Numeric gene×sample matrix | a wide, mostly-numeric matrix | `Heatmap` |

```js
import { detectDataShapes, suggestPanelType } from 'canvasxpress-dashboards';

suggestPanelType(data);
// → { graphType: 'KaplanMeier', confidence: 0.9,
//     reason: 'Survival table: time column "os_months" + event column "os_event".' }
```

Detection pairs a column-name hint with a value-shape check (e.g. an event
column must actually read as 0/1 or a small alive/dead vocabulary), so an
ordinary business table returns `[]`.

## Panel presets

`WIZARD_SCIENCE_TYPES` lists the presets; `scientificFieldsFor(graphType)` says
which fields each collects; `buildScientificConfig(graphType, fields, extra, data)`
builds the config. Defaults are grounded in the shipping engine parameters:

| Preset | Fields | Sane defaults |
|---|---|---|
| `KaplanMeier` | time, event, group | `xAxis:[time]`, `yAxis:[event]`, `colorBy:group`; CI bands, log-rank p (`kmPvalue`), at-risk table, censor rug |
| `Oncoprint` | — (matrix as-is) | `graphType:'Oncoprint'` |
| `Heatmap` | — (matrix as-is) | both axes clustered (dendrograms) + diverging spectrum |
| `Manhattan` | chr, pos, p | `manhattanMarkerChromosomeNumber`/`Position`/`LogPValue` pointed at the columns |
| `Volcano` | fold-change, p, label | native alias (Scatter2D), `xAxis:[fc]`, `yAxis:[p]` |

```js
import { buildScientificConfig } from 'canvasxpress-dashboards';

buildScientificConfig('KaplanMeier',
  { time: 'os_months', event: 'os_event', group: 'arm' }, null, data);
// → { graphType: 'KaplanMeier', xAxis: ['os_months'], yAxis: ['os_event'],
//     colorBy: 'arm', showKMConfidenceIntervals: true, kmPvalue: true,
//     kmRiskTable: true, kmCensoredRug: true }
```

The engine Kaplan–Meier reads **time from `xAxis` and the event from `yAxis`**,
so the time/event mapping above is not interchangeable.

> **Volcano thresholds.** The Volcano preset renders the scatter of fold-change
> vs p-value. Automatic significance thresholds (the ±fold-change and p-value
> cut-off lines) are computed as part of the statistical-inference work, not
> fabricated here.

## Selection-linked gene/sample sets

Selecting genes (or samples) in one panel can mark the same set in a companion
panel, even across differently-keyed sources — the input a downstream enrichment
panel consumes. This reuses the shipped [cross-source marking](cross-filter.md):
declare a `relationship` keyed on the shared identifier and pick a `markingMode`.

Genes live on the *variable* axis of an expression heatmap and on the *variable*
axis of a per-gene differential table, so link them gene-to-gene across those
axes — no `on` key is needed when the axis labels are the shared id:

```jsonc
{
  "relationships": [
    { "left": "expression", "right": "geneStats", "leftAxis": "vars", "rightAxis": "vars" }
  ],
  "markingMode": "highlight"
}
```

Select gene rows in the heatmap and the same genes highlight in the stats
scatter (and back — relationships are bidirectional). See the **Gene-Set
Linkage** example. The marked set is exactly what the enrichment panel will
consume.

## Examples

- **[Survival Cohort](../examples/survival-cohort.html)** — a synthetic
  immuno-oncology trial (n=160): a survival table renders as a Kaplan–Meier panel
  (CI bands, censor rug, log-rank p, at-risk table) split by treatment arm,
  beside a PD-L1 expression box plot.
- **[Mutation Landscape](../examples/mutation-oncoprint.html)** — a synthetic
  gene × sample alteration matrix (mutation + copy-number tokens) renders as a
  cBioPortal-style oncoprint above a per-gene alteration-frequency bar chart.
- **[Gene-Set Linkage](../examples/gene-set-linkage.html)** — selecting genes in
  an expression heatmap highlights the same genes in a differential-expression
  scatter, a cross-source gene set keyed gene-to-gene.
- **[Enrichment Analysis](../examples/enrichment-analysis.html)** — a gene set
  scored for over-representation against pathways (hypergeometric + BH FDR), the
  −log10 FDR per pathway.
- **[VCF Variants](../examples/vcf-variants.html)** — a VCF parsed to per-chromosome
  counts and a quality-by-position scatter.

## Enrichment (over-representation)

Score a query set — e.g. the genes selected in a panel — for over-representation
against annotated gene sets (pathways) with the **hypergeometric test** and
**Benjamini–Hochberg FDR**. Dependency-free and validated against R
(`phyper` / `p.adjust`).

```js
import { enrich, enrichmentToData } from 'canvasxpress-dashboards';

var results = enrich(selectedGenes, [
  { id: 'P1', name: 'Immune response', genes: [/* … */] },
  { id: 'P2', name: 'Cell cycle',      genes: [/* … */] }
], { universe: backgroundGenes });
// results: [{ id, name, setSize, overlap, genes, pValue, fdr, oddsRatio, enrichment }, …]
// FDR-ascending. Bind enrichmentToData(results) to a Bar panel of −log10 FDR.
```

`hypergeometricPValue(overlap, querySize, setSize, universeSize)` and
`benjaminiHochberg(pValues)` are exported individually. When no `universe` is
given, the union of every set plus the query is used as a self-contained
background. See the **Enrichment Analysis** example. (When the engine's shared
multiple-testing correction lands, the BH step can delegate to it; the
hypergeometric core stays.)

## VCF ingestion

`parseVcf(text)` reads VCF 4.x text — the eight fixed columns, INFO key/values,
and optional FORMAT + per-sample genotypes — into records; `vcfToData(parsed,
{ info })` and `variantsPerChromosome(parsed)` shape those into CanvasXpress data
objects for a variant table, a per-chromosome summary, or (with positions and a
score) a Manhattan / genome panel.

```js
import { parseVcf, vcfToData, variantsPerChromosome } from 'canvasxpress-dashboards';

var parsed = parseVcf(await (await fetch('cohort.vcf')).text());
variantsPerChromosome(parsed);              // Bar: variants per chromosome
vcfToData(parsed, { info: ['GENE', 'DP'] }); // table / scatter, INFO lifted to annotations
```

This is a pragmatic reader for the common case (SNVs and small indels); it does
not implement the full structural-variant / breakend grammar. See the **VCF
Variants** example.

## FCS ingestion — deferred (go/no-go: NO-GO for now)

Flow-cytometry **FCS** ingestion is **not** implemented. FCS is a binary format
(HEADER + TEXT + DATA segments, big/little-endian floats or integers, FCS
3.0/3.1 variants) whose correct reader is substantial and hard to test without a
corpus of real instrument files, and whose audience on a dashboard is narrow
relative to that cost. It is deferred until a concrete need appears; the right
first step then is a `function`-source (R `flowCore` / Python `fcsparser`)
rather than a hand-written binary parser in this package.

## Data shapes

**Survival** (Kaplan–Meier): the engine reads time and event as *samples*, so a
patient-per-row table transposes — patients become variables, `time`/`status`
become the two samples, with `arm`/`stage` as variable annotations (`z`).

**Alteration matrix** (oncoprint): a gene × sample matrix whose cells are
standard tokens — `MUT`, `TRUNC`, `MISSENSE`, `INFRAME` (mutations); `AMP`,
`GAIN`, `HOMDEL` and GISTIC integers `-2..2` (copy number); `;`-joined for
combined events (e.g. `MUT;AMP`). Bind it as inline data with
`config.graphType = 'Oncoprint'`.
