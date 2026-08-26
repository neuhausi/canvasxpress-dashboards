// Deterministic generator for the biomarker-cohort dashboard spec.
// Index-derived pseudo-noise only (no Math.random / Date.now) so regeneration
// is stable. Run: node gen-biomarker.cjs
const fs = require('fs');

function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const round = (x, d) => Number(x.toFixed(d));

// ---- 60-sample cohort: treatment arm, response, sex ------------------------
const N = 60;
const samples = Array.from({ length: N }, (_, i) => 'P' + String(i + 1).padStart(2, '0'));
// Categorical annotation values used by the two filter controls. Since the
// renderer now filters with the EXACT operator, values no longer need to be
// prefix-free (Female/Male, below, is fine).
const GROUP = ['Treated', 'Placebo'];
const RESP = ['Responder', 'Refractory'];
// Female/Male is safe now: the dashboards renderer filters control picks with
// the EXACT operator, so "Male" no longer over-matches "Female" (which the old
// substring 'like' operator did — "female" contains "male"). Kept as readable
// full labels to exercise that fix.
const SEX = ['Female', 'Male'];
const TIME = ['Baseline', 'Week12'];
const group = samples.map((_, i) => GROUP[i % 2]);
// Treated patients respond more often; response is deterministic per index.
const responder = samples.map((_, i) => {
  const pResp = group[i] === 'Treated' ? 0.68 : 0.34;
  return rng(400 + i)() < pResp ? RESP[0] : RESP[1];
});
// Sex and Timepoint are the CONTROL-filter annotations. They are kept
// orthogonal to the boxplot groupingFactors (Group / Responder): filtering a
// boxplot by its OWN grouping annotation collapses it, so the controls filter
// on these independent dimensions instead — narrowing the samples inside each
// box rather than emptying it.
const sex = samples.map((_, i) => (rng(800 + i)() < 0.5 ? SEX[0] : SEX[1]));
const timepoint = samples.map((_, i) => (rng(1200 + i)() < 0.5 ? TIME[0] : TIME[1]));

// ---- per-sample serum biomarkers (pg/mL) -----------------------------------
// Inflammatory markers are HIGHER in Placebo and in Refractory patients, so the
// boxplots and the scatter all tell the same biological story.
const BIOMARKERS = ['IL6', 'TNFa', 'CRP', 'IFNg'];
const baseLevel = { IL6: 12, TNFa: 9, CRP: 18, IFNg: 7 };
function marker(name, i) {
  const groupLift = group[i] === 'Placebo' ? 1.0 : 0.0;
  const respLift = responder[i] === 'Refractory' ? 1.0 : 0.0;
  const timeDrop = timepoint[i] === 'Week12' ? 0.20 : 0.0;   // inflammation falls by Week 12
  const sexLift = sex[i] === 'Male' ? 0.14 : 0.0;               // mild sex effect so F/M subsets differ
  const b = baseLevel[name];
  const val = b * (1 + 0.55 * groupLift + 0.45 * respLift + sexLift - timeDrop)
    + gauss(rng(i * 53 + name.length * 17 + 3)) * b * 0.18;
  return round(Math.max(0.1, val), 2);
}
// Per-boxplot datasets, each with a SINGLE measured variable. CanvasXpress's
// resetDataFilter() (fired when a control returns to "All") rebuilds a boxplot's
// default xAxis from ALL variables in the dataset — so a shared 4-marker "assay"
// dataset collapses both boxplots onto all four markers (8 boxes, identical) on
// reset. Giving each boxplot its own one-variable dataset makes the reset
// default (xAxis = that lone variable) the intended measure. The sample
// annotations are replicated so the Sex/Timepoint controls still filter them.
const annotations = { Group: group, Responder: responder, Sex: sex, Timepoint: timepoint };
const assayIL6 = {
  y: { vars: ['IL6'], smps: samples, data: [samples.map((_, i) => marker('IL6', i))] },
  x: annotations
};
const assayTNF = {
  y: { vars: ['TNFa'], smps: samples, data: [samples.map((_, i) => marker('TNFa', i))] },
  x: annotations
};

// scatter: vars = samples (points), smps = [IL6, TNFa]; z = point annotations.
const il6 = samples.map((_, i) => marker('IL6', i));
const tnf = samples.map((_, i) => marker('TNFa', i));
const scatter = {
  y: { vars: samples, smps: ['IL6', 'TNFa'], data: samples.map((_, i) => [il6[i], tnf[i]]) },
  z: { Group: group, Responder: responder, Sex: sex, Timepoint: timepoint }
};

// heatmap: 24-gene inflammation panel x 60 samples; genes split into an
// up-in-refractory block and a down-in-refractory block so clusters are real.
const G = 24;
const genes = Array.from({ length: G }, (_, g) => 'GENE' + String(g + 1).padStart(2, '0'));
const heatData = genes.map((_, g) => {
  const upInRefractory = g < G / 2;                       // first half up, second half down
  return samples.map((_, i) => {
    const refr = responder[i] === 'Refractory' ? 1 : -1;
    const signal = (upInRefractory ? refr : -refr) * 1.3;
    return round(signal + gauss(rng(g * 131 + i * 17 + 11)) * 0.7, 3);
  });
});
const heatmap = {
  y: { vars: genes, smps: samples, data: heatData },
  x: { Group: group, Responder: responder, Sex: sex, Timepoint: timepoint }
};

// ---- assemble spec ---------------------------------------------------------
const inline = v => ({ kind: 'inline', value: v });
const spec = {
  id: 'biomarker-cohort',
  title: 'Immuno-Oncology Biomarker Cohort',
  version: 1,
  broadcastGroup: 'biomarker-cohort',
  theme: 'auto',
  layout: {
    cols: 12,
    rowHeight: 40,
    gap: 12,
    items: [
      { panel: 'sex-control', x: 0, y: 0, w: 6, h: 1 },
      { panel: 'timepoint-control', x: 6, y: 0, w: 6, h: 1 },
      { panel: 'box-il6', x: 0, y: 1, w: 6, h: 8 },
      { panel: 'box-tnf', x: 6, y: 1, w: 6, h: 8 },
      { panel: 'scatter', x: 0, y: 9, w: 6, h: 9 },
      { panel: 'heatmap', x: 6, y: 9, w: 6, h: 9 }
    ]
  },
  data: {
    assayIL6: inline(assayIL6),
    assayTNF: inline(assayTNF),
    scatter: inline(scatter),
    heatmap: inline(heatmap)
  },
  panels: {
    'sex-control': {
      type: 'control', title: 'Sex', dataRef: 'assayIL6',
      annotation: 'Sex', style: 'buttons'
    },
    'timepoint-control': {
      type: 'control', title: 'Timepoint', dataRef: 'assayIL6',
      annotation: 'Timepoint', style: 'buttons'
    },
    'box-il6': {
      title: 'Serum IL-6 by Treatment Group',
      dataRef: 'assayIL6',
      config: {
        graphType: 'Boxplot',
        graphOrientation: 'vertical',
        xAxis: ['IL6'],
        groupingFactors: ['Group'],
        colorBy: 'Group',
        showBoxplotOriginalData: true,   // overlay individual samples
        jitter: true,
        showLegend: false,
        xAxisTitle: 'IL-6 (pg/mL)',
        title: false
      }
    },
    'box-tnf': {
      title: 'Serum TNF-α by Response',
      dataRef: 'assayTNF',
      config: {
        graphType: 'Boxplot',
        graphOrientation: 'vertical',
        xAxis: ['TNFa'],
        groupingFactors: ['Responder'],
        colorBy: 'Responder',
        showBoxplotOriginalData: true,
        jitter: true,
        showLegend: false,
        xAxisTitle: 'TNF-α (pg/mL)',
        title: false
      }
    },
    scatter: {
      title: 'IL-6 vs TNF-α (60 samples)',
      dataRef: 'scatter',
      config: {
        graphType: 'Scatter2D',
        xAxis: ['IL6'],
        yAxis: ['TNFa'],
        colorBy: 'Group',
        xAxisTitle: 'IL-6 (pg/mL)',
        yAxisTitle: 'TNF-α (pg/mL)',
        hoverTemplate: 'Sample : {vars}<br/>IL6 : {IL6}<br/>TNFa : {TNFa}<br/>Group : {Group}<br/>Responder : {Responder}<br/>',
        title: false
      }
    },
    heatmap: {
      title: 'Inflammation Gene Panel · 24 genes × 60 samples',
      dataRef: 'heatmap',
      config: {
        graphType: 'Heatmap',
        samplesClustered: true,
        variablesClustered: true,
        showSmpDendrogram: false,
        showVarDendrogram: false,
        smpOverlays: ['Group', 'Responder'],
        heatmapIndicatorPosition: 'right',
        title: false
      }
    }
  }
};

fs.writeFileSync('biomarker-cohort.spec.json', JSON.stringify(spec, null, 2));
console.log('wrote biomarker-cohort.spec.json | samples:', N,
  '| groups', group.filter(g => g === 'Treated').length + 'T/' + group.filter(g => g === 'Placebo').length + 'P',
  '| responders', responder.filter(r => r === 'Responder').length);
