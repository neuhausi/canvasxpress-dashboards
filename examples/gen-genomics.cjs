// Deterministic generator for the genomics-oncology dashboard spec.
// All pseudo-noise is derived from indices so regeneration is stable
// (no Math.random / Date.now). Run: node gen-genomics.js
const fs = require('fs');

// --- tiny deterministic PRNG (mulberry32) seeded per-call by an integer -----
function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// standard normal via Box-Muller from two deterministic uniforms
function gauss(r) {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const round = (x, d) => Number(x.toFixed(d));

// ============================================================ 1. EXPRESSION
// Heatmap: 60 genes x 48 samples = 2880 values, samples annotated by Subtype
// and Response. Genes get a "block" personality per subtype so clusters show.
const HM_GENES = 60, HM_SAMPLES = 48;
const SUBTYPES = ['Basal', 'LumA', 'LumB', 'Her2'];
const RESPONSE = ['CR', 'PR', 'SD', 'PD'];
const STAGES = ['I', 'II', 'III', 'IV'];               // display labels for the bar chart
// Prefix-free stage labels for annotations the Stage control filters on: the
// substring "like" match needs values where none contains another (Roman
// numerals fail — "I" is inside "II"/"III"/"IV"), so use "Stage 1".."Stage 4".
const stageLabel = roman => 'Stage ' + (STAGES.indexOf(roman) + 1);
// Gene ids are shared with the DEG datasets below (same 'GENExxxx' namespace),
// so every gene shown in the heatmap is an identifiable point in the volcano,
// MA and contrast scatter plots.
const geneId = i => 'GENE' + String(i + 1).padStart(4, '0');
const hmGenes = Array.from({ length: HM_GENES }, (_, i) => geneId(i));
const hmSamples = Array.from({ length: HM_SAMPLES }, (_, j) => 'S' + String(j + 1).padStart(3, '0'));
const hmSubtype = hmSamples.map((_, j) => SUBTYPES[j % SUBTYPES.length]);
const hmResponse = hmSamples.map((_, j) => {
  const r = rng(9000 + j)();
  return RESPONSE[Math.min(3, Math.floor(r * 4))];
});
const hmStage = hmSamples.map((_, j) => stageLabel(STAGES[Math.min(3, Math.floor(Math.pow(rng(7100 + j)(), 0.9) * 4))]));
const hmData = hmGenes.map((_, i) => {
  const geneBlock = i % SUBTYPES.length;          // which subtype this gene marks
  return hmSamples.map((_, j) => {
    const r = rng(i * 131 + j * 17 + 3)();
    const on = (j % SUBTYPES.length) === geneBlock ? 2.2 : -0.4;
    return round(on + gauss(rng(i * 977 + j * 31 + 7)) * 0.8, 3);
  });
});
const expression = {
  y: { vars: hmGenes, smps: hmSamples, data: hmData },
  x: { Subtype: hmSubtype, Stage: hmStage, Response: hmResponse }
};

// ============================================================ 2. DEG (volcano/MA/contrast)
// 1500 genes. Columns: logFC (contrast A: Tumor vs Normal), negLog10P,
// AvgExpr, logFC_B (contrast B: Responder vs Non-responder). Regulation is a
// per-gene (variable-level) annotation used for colorBy.
const N_DEG = 1500;
const degGenes = Array.from({ length: N_DEG }, (_, i) => geneId(i)); // shared 'GENExxxx' ids; first 60 are the heatmap genes
const degData = [], regulation = [];
for (let i = 0; i < N_DEG; i++) {
  const r = rng(i * 7 + 1);
  const logFC = round(gauss(r) * 1.6, 3);
  // p-value smaller (more significant) for larger |logFC|, plus noise
  const strength = Math.abs(logFC) * 1.4 + gauss(rng(i * 13 + 5)) * 0.6;
  const negLog10P = round(Math.max(0, strength + Math.abs(gauss(rng(i * 29 + 2))) * 0.8), 3);
  const avgExpr = round(4 + r() * 8 + Math.abs(logFC) * 0.3, 3);
  // contrast B correlated with A but with its own signal
  const logFCb = round(logFC * 0.55 + gauss(rng(i * 19 + 4)) * 1.1, 3);
  degData.push([logFC, negLog10P, avgExpr, logFCb]);
  let reg = 'NS';
  if (negLog10P >= 1.301 && logFC >= 0.585) reg = 'Up';        // p<=0.05 & FC>=1.5
  else if (negLog10P >= 1.301 && logFC <= -0.585) reg = 'Down';
  regulation.push(reg);
}
// Independent per-plot datasets. Each carries only the two columns it plots,
// AS THE FIRST TWO COLUMNS. CanvasXpress's resetDataFilter() (fired when a
// control is set back to "All") rebuilds a graph's default axes from the first
// two data columns; keeping each plot's axes first means "All" reverts to the
// SAME axes instead of collapsing every scatter onto the shared first columns
// (which made MA/contrast redraw as volcanoes). Regulation is replicated on
// each so the single Regulation control filters all three.
const degVolcano = {
  y: { vars: degGenes, smps: ['logFC', 'negLog10P'], data: degData.map(d => [d[0], d[1]]) },
  z: { Regulation: regulation }
};
const degMA = {
  y: { vars: degGenes, smps: ['AvgExpr', 'logFC'], data: degData.map(d => [d[2], d[0]]) },
  z: { Regulation: regulation }
};
const degContrast = {
  y: { vars: degGenes, smps: ['logFC', 'logFC_B'], data: degData.map(d => [d[0], d[3]]) },
  z: { Regulation: regulation }
};

// ============================================================ 3. UMAP (single-cell scatter)
// 1600 cells embedded in 2D, coloured by inferred cell type. Each cell type
// is a gaussian blob at a fixed centre so the clusters are visually distinct.
const N_CELLS = 1600;
const CELLTYPES = ['T cell', 'B cell', 'Myeloid', 'Epithelial', 'Fibroblast', 'Endothelial'];
const CENTERS = [[-5, 4], [5, 5], [6, -4], [-6, -5], [0, 8], [1, -8]];
const cellIds = Array.from({ length: N_CELLS }, (_, i) => 'C' + String(i + 1).padStart(4, '0'));
const umapData = [], cellType = [];
for (let i = 0; i < N_CELLS; i++) {
  const c = i % CELLTYPES.length;
  const cx = CENTERS[c][0], cy = CENTERS[c][1];
  const x = round(cx + gauss(rng(i * 11 + 100)) * 1.4, 3);
  const y = round(cy + gauss(rng(i * 23 + 200)) * 1.4, 3);
  umapData.push([x, y]);
  cellType.push(CELLTYPES[c]);
}
const umap = {
  y: { vars: cellIds, smps: ['UMAP1', 'UMAP2'], data: umapData },
  z: { CellType: cellType }
};

// ============================================================ 4. CLINICAL BAR (stacked)
// Counts of patients by tumor Stage (x) and best Response (series). Built from
// the 1200-patient cohort below so the numbers are consistent.
const N_PT = 1200;
const ARMS = ['Treatment', 'Control'];
// cohort rows first (shared by bar, meter, KM)
const cohort = [];
for (let i = 0; i < N_PT; i++) {
  const r = rng(i * 3 + 50);
  const stage = STAGES[Math.min(3, Math.floor(Math.pow(r(), 0.9) * 4))];
  const arm = ARMS[i % 2];
  // response depends on stage & arm (treatment does better, early stage better)
  const stageIdx = STAGES.indexOf(stage);
  const bias = (arm === 'Treatment' ? 1.2 : 0) - stageIdx * 0.6 + gauss(rng(i * 5 + 9)) * 1.0;
  let resp;
  if (bias > 1.2) resp = 'CR'; else if (bias > 0.2) resp = 'PR';
  else if (bias > -0.8) resp = 'SD'; else resp = 'PD';
  // survival: months + censor, treatment & response improve survival
  const base = 8 + (arm === 'Treatment' ? 7 : 0) - stageIdx * 2.5
    + (RESPONSE.indexOf(resp) === 0 ? 12 : RESPONSE.indexOf(resp) === 1 ? 6 : 0);
  const time = round(Math.max(0.5, base + Math.abs(gauss(rng(i * 7 + 11))) * 6), 1);
  const status = rng(i * 13 + 17)() < (0.35 + stageIdx * 0.12) ? 1 : 0; // 1 = event
  cohort.push({ stage, arm, resp, time, status });
}
// bar: rows = Response, cols = Stage, cell = count
const barCounts = RESPONSE.map(rp => STAGES.map(st =>
  cohort.filter(p => p.resp === rp && p.stage === st).length));
const clinicalBar = {
  y: { vars: RESPONSE, smps: STAGES, data: barCounts }
};

// ============================================================ 5. METER (total samples)
// One row per patient with Enrolled = 1; summaryType:sum => total cohort size.
const cohortMeter = {
  y: {
    vars: ['Enrolled', 'Event'],
    smps: cohort.map((_, i) => 'P' + String(i + 1).padStart(4, '0')),
    // one row per variable: Enrolled = 1 each, Event = 1 when the patient had
    // a survival event (status === 1). summaryType:sum gives totals per metric.
    data: [cohort.map(() => 1), cohort.map(p => p.status)]
  },
  // Arm as a sample annotation so the Treatment-Arm control can filter both
  // meters (selecting one arm re-sums to that arm's enrolment / events).
  x: { Arm: cohort.map(p => p.arm) }
};

// ============================================================ 6. SURVIVAL (KM)
// vars = patients (rows), smps = [time, status], z.Arm = treatment arm.
const survival = {
  y: {
    vars: cohort.map((_, i) => 'PT' + String(i + 1).padStart(4, '0')),
    smps: ['time', 'status'],
    data: cohort.map(p => [p.time, p.status])
  },
  // two variable-level groupings: treatment arm and tumor stage, each drives
  // a separate Kaplan-Meier stratification.
  z: { Arm: cohort.map(p => p.arm), Stage: cohort.map(p => stageLabel(p.stage)) }
};

// ============================================================ assemble spec
const inline = v => ({ kind: 'inline', value: v });
const spec = {
  id: 'genomics-oncology',
  title: 'Genomics — Oncology RNA-seq Cohort',
  version: 1,
  broadcastGroup: 'genomics-oncology',
  theme: 'auto',
  layout: {
    cols: 12,
    rowHeight: 40,
    gap: 12,
    items: [
      // top control — filter samples by tumor stage (drives heatmap + both KMs)
      { panel: 'stage-control', x: 0, y: 0, w: 12, h: 1 },
      // row 1 — two meters + stacked clinical bar
      { panel: 'samples-meter', x: 0, y: 1, w: 3, h: 6 },
      { panel: 'events-meter', x: 3, y: 1, w: 3, h: 6 },
      { panel: 'clinical-bar', x: 6, y: 1, w: 6, h: 6 },
      // row 2 — heatmap + UMAP
      { panel: 'heatmap', x: 0, y: 7, w: 7, h: 9 },
      { panel: 'umap', x: 7, y: 7, w: 5, h: 9 },
      // regulation control sits on top of the scatter row (full width so its
      // label + 4 buttons never wrap onto the volcano plot below)
      { panel: 'regulation-control', x: 0, y: 16, w: 12, h: 1 },
      // row 3 — volcano + MA + contrast
      { panel: 'volcano', x: 0, y: 17, w: 4, h: 8 },
      { panel: 'ma', x: 4, y: 17, w: 4, h: 8 },
      { panel: 'contrast', x: 8, y: 17, w: 4, h: 8 },
      // arm control sits above the two Kaplan-Meier plots
      { panel: 'arm-control', x: 0, y: 25, w: 12, h: 1 },
      // row 4 — two Kaplan-Meier plots
      { panel: 'km', x: 0, y: 26, w: 6, h: 8 },
      { panel: 'km-stage', x: 6, y: 26, w: 6, h: 8 }
    ]
  },
  data: {
    expression: inline(expression),
    degVolcano: inline(degVolcano),
    degMA: inline(degMA),
    degContrast: inline(degContrast),
    umap: inline(umap),
    clinicalBar: inline(clinicalBar),
    cohortMeter: inline(cohortMeter),
    survival: inline(survival)
  },
  panels: {
    'regulation-control': {
      type: 'control',
      title: 'Regulation (volcano · MA · contrast)',
      dataRef: 'degVolcano',
      annotation: 'Regulation',
      style: 'buttons'
    },
    'arm-control': {
      type: 'control',
      title: 'Treatment Arm (survival · samples)',
      dataRef: 'survival',
      annotation: 'Arm',
      style: 'dropdown'
    },
    'stage-control': {
      type: 'control',
      title: 'Tumor Stage (survival)',
      dataRef: 'expression',
      annotation: 'Stage',
      style: 'buttons'
    },
    heatmap: {
      title: 'Gene Expression Heatmap · 60 genes × 48 samples',
      dataRef: 'expression',
      config: {
        graphType: 'Heatmap',
        samplesClustered: true,
        variablesClustered: true,
        showSmpDendrogram: false,
        showVarDendrogram: false,
        smpOverlays: ['Subtype', 'Stage', 'Response'],
        heatmapIndicatorPosition: 'right',
        title: false
      }
    },
    volcano: {
      title: 'Volcano · Tumor vs Normal (1500 genes)',
      dataRef: 'degVolcano',
      config: {
        graphType: 'Scatter2D',
        xAxis: ['logFC'],
        yAxis: ['negLog10P'],
        colorBy: 'Regulation',
        colorKey: { Regulation: { Up: 'rgba(205,0,0,0.6)', Down: 'rgba(0,104,139,0.6)', NS: 'rgba(160,160,160,0.35)' } },
        xAxisTitle: 'log2 Fold Change',
        yAxisTitle: '-log10 P-value',
        hoverTemplate: 'Gene : {vars}<br/>logFC : {logFC}<br/>-log10P : {negLog10P}<br/>Regulation : {Regulation}<br/>',
        showDecorations: true,
        decorations: {
          line: [
            { color: 'rgba(120,120,120,0.7)', width: 1, x: 0.585 },
            { color: 'rgba(120,120,120,0.7)', width: 1, x: -0.585 },
            { color: 'rgba(120,120,120,0.7)', width: 1, y: 1.301 }
          ]
        },
        title: false
      }
    },
    ma: {
      title: 'MA Plot · Expression vs Fold Change',
      dataRef: 'degMA',
      config: {
        graphType: 'Scatter2D',
        xAxis: ['AvgExpr'],
        yAxis: ['logFC'],
        colorBy: 'Regulation',
        colorKey: { Regulation: { Up: 'rgba(205,0,0,0.6)', Down: 'rgba(0,104,139,0.6)', NS: 'rgba(160,160,160,0.35)' } },
        xAxisTitle: 'Average Expression',
        yAxisTitle: 'log2 Fold Change',
        hoverTemplate: 'Gene : {vars}<br/>AvgExpr : {AvgExpr}<br/>logFC : {logFC}<br/>Regulation : {Regulation}<br/>',
        showDecorations: true,
        decorations: { line: [{ color: 'rgba(120,120,120,0.7)', width: 1, y: 0 }] },
        title: false
      }
    },
    umap: {
      title: 'Single-cell UMAP · 1600 cells',
      dataRef: 'umap',
      config: {
        graphType: 'Scatter2D',
        xAxis: ['UMAP1'],
        yAxis: ['UMAP2'],
        colorBy: 'CellType',
        xAxisTitle: 'UMAP-1',
        yAxisTitle: 'UMAP-2',
        title: false
      }
    },
    contrast: {
      title: 'Contrast · logFC (T/N) vs logFC (R/NR)',
      dataRef: 'degContrast',
      config: {
        graphType: 'Scatter2D',
        xAxis: ['logFC'],
        yAxis: ['logFC_B'],
        colorBy: 'Regulation',
        colorKey: { Regulation: { Up: 'rgba(205,0,0,0.6)', Down: 'rgba(0,104,139,0.6)', NS: 'rgba(160,160,160,0.35)' } },
        xAxisTitle: 'log2 FC · Tumor vs Normal',
        yAxisTitle: 'log2 FC · Responder vs Non-responder',
        hoverTemplate: 'Gene : {vars}<br/>logFC T/N : {logFC}<br/>logFC R/NR : {logFC_B}<br/>Regulation : {Regulation}<br/>',
        showDecorations: true,
        decorations: {
          line: [
            { color: 'rgba(120,120,120,0.7)', width: 1, x: 0 },
            { color: 'rgba(120,120,120,0.7)', width: 1, y: 0 }
          ]
        },
        title: false
      }
    },
    'samples-meter': {
      title: 'Total Samples Enrolled',
      dataRef: 'cohortMeter',
      config: {
        graphType: 'Meter',
        meterType: 'ring',
        meterCard: true,
        summaryType: 'sum',
        xAxis: ['Enrolled'],
        setMin: 0,
        setMax: 1500,
        rangeColors: ['rgb(124,77,255)'],
        title: false
      }
    },
    'events-meter': {
      title: 'Survival Events (Deaths)',
      dataRef: 'cohortMeter',
      config: {
        graphType: 'Meter',
        meterType: 'ring',
        meterCard: true,
        summaryType: 'sum',
        xAxis: ['Event'],
        setMin: 0,
        setMax: 1000,
        rangeColors: ['rgb(229,57,53)'],
        title: false
      }
    },
    'clinical-bar': {
      title: 'Best Response by Tumor Stage',
      dataRef: 'clinicalBar',
      config: {
        graphType: 'Stacked',
        graphOrientation: 'vertical',
        xAxisTitle: 'Patients',
        yAxisTitle: 'Tumor Stage',
        colorScheme: 'CanvasXpress',
        title: false
      }
    },
    km: {
      title: 'Kaplan-Meier · Overall Survival by Arm',
      dataRef: 'survival',
      config: {
        graphType: 'KaplanMeier',
        xAxis: ['time'],
        yAxis: ['status'],
        colorBy: 'Arm',
        colors: ['#2E9FDF', '#E7B800'],
        kmRiskTable: true,
        showKMConfidenceIntervals: true,
        showKMMedianSurvivalTime: true,
        xAxisTitle: 'Time (months)',
        yAxisTitle: 'Survival Probability',
        title: false
      }
    },
    'km-stage': {
      title: 'Kaplan-Meier · Survival by Tumor Stage',
      dataRef: 'survival',
      config: {
        graphType: 'KaplanMeier',
        xAxis: ['time'],
        yAxis: ['status'],
        colorBy: 'Stage',
        colors: ['#43A047', '#FB8C00', '#E53935', '#8E24AA'],
        kmRiskTable: true,
        showKMConfidenceIntervals: false,
        showKMMedianSurvivalTime: true,
        xAxisTitle: 'Time (months)',
        yAxisTitle: 'Survival Probability',
        title: false
      }
    }
  }
};

fs.writeFileSync('genomics-oncology.spec.json', JSON.stringify(spec, null, 2));
const recs = {
  expression: HM_GENES * HM_SAMPLES, deg: N_DEG, umap: N_CELLS,
  cohort: N_PT
};
console.log('wrote genomics-oncology.spec.json; record counts:', recs);
console.log('regulation tally', regulation.reduce((a, r) => (a[r] = (a[r] || 0) + 1, a), {}));
