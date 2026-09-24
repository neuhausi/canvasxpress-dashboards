// Deterministic generator for the Cohort Explorer dashboard spec (a showcase of
// blending: join + relationships + Filters panel with schemes + an R data
// function + one-point-per-patient scatter / Kaplan-Meier on table data).
// Seeded PRNG only (no Math.random / Date.now). Run: node gen-cohort-explorer.cjs
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
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pad = (n, w) => String(n).padStart(w, '0');
const r = rng(20260924);

// ---- 60 patients: arm, stage, sex, age, a latent PD-L1 (CD274) level --------
// Story: the drug works mainly in PD-L1-high patients; stage IV does worst.
const N = 60;
const STAGES = ['I', 'II', 'III', 'IV'];
const patients = [];
for (let i = 0; i < N; i++) {
  const arm = i % 2 === 0 ? 'Drug' : 'Placebo';
  const stage = STAGES[Math.floor(r() * 4)];
  const sex = r() < 0.5 ? 'F' : 'M';
  const age = Math.round(clamp(62 + 9 * gauss(r), 38, 84));
  const pdl1 = clamp(7 + 1.6 * gauss(r), 3.5, 11.5);          // log2 expression
  const stageRisk = { I: 0.55, II: 0.8, III: 1.2, IV: 1.8 }[stage];
  // Drug: a clear overall benefit, a strong one when PD-L1 is high.
  const benefit = arm === 'Drug' ? (pdl1 > 8 ? 0.18 : 0.55) : 1.15;
  const hazard = 0.045 * stageRisk * benefit * (1 + (age - 62) / 120);
  const eventTime = -Math.log(Math.max(1e-6, r())) / hazard;  // months
  const followUp = 18 + r() * 24;                              // censoring
  const osMonths = round(Math.min(eventTime, followUp), 1);
  const osEvent = eventTime <= followUp ? 1 : 0;
  patients.push({ id: 'P' + pad(i + 1, 3), arm, stage, sex, age, pdl1, osMonths, osEvent });
}

const clinical = {
  y: {
    vars: ['age', 'os_months', 'os_event'],
    smps: patients.map(p => p.id),
    data: [patients.map(p => p.age), patients.map(p => p.osMonths), patients.map(p => p.osEvent)]
  },
  x: {
    arm: patients.map(p => p.arm),
    stage: patients.map(p => p.stage),
    sex: patients.map(p => p.sex)
  }
};

// ---- tumour expression: 60 samples with their OWN ids + a patient_id column --
// (so blending with clinical needs a join on patient_id, not on the row ids)
const GENES = ['TP53', 'EGFR', 'KRAS', 'MYC', 'CD274', 'ERBB2', 'CDKN2A', 'PTEN'];
const order = patients.map((p, i) => i).sort((a, b) => ((a * 37) % N) - ((b * 37) % N));
const samples = order.map((pi, k) => ({ id: 'S' + pad(101 + k, 3), patient: patients[pi] }));
const expr = GENES.map(gene => samples.map(s => {
  const p = s.patient;
  const stageIdx = STAGES.indexOf(p.stage);
  let base = { TP53: 8, EGFR: 7.5, KRAS: 6.8, MYC: 7 + 0.7 * stageIdx, CD274: p.pdl1, ERBB2: 6.2, CDKN2A: 7.4 - 0.4 * stageIdx, PTEN: 8.2 - 0.3 * stageIdx }[gene];
  if (gene === 'CD274') return round(base + 0.25 * gauss(r), 2);
  return round(base + 0.6 * gauss(r), 2);
}));
const expression = {
  y: { vars: GENES, smps: samples.map(s => s.id), data: expr },
  x: { patient_id: samples.map(s => s.patient.id), batch: samples.map((s, k) => 'B' + (1 + (k % 3))) }
};

// ---- labs: 3 visits per patient (180 rows) ------------------------------------
// CRP tracks stage and falls on the drug for PD-L1-high patients; ALT spikes at
// week 6 on the drug (a liver-toxicity signal).
const VISITS = ['Baseline', 'Week 06', 'Week 12'];
const labRows = [];
patients.forEach(p => VISITS.forEach((visit, v) => {
  const stageIdx = STAGES.indexOf(p.stage);
  let crp = 5 + 3 * stageIdx + 1.5 * gauss(r);
  // Inflammation falls on the drug (most for PD-L1-high) and creeps up on placebo.
  if (p.arm === 'Drug') crp -= v * (p.pdl1 > 8 ? 3.4 : 1.8);
  else crp += v * 0.9;
  let alt = 24 + 6 * gauss(r);
  if (p.arm === 'Drug' && v === 1) alt += 28 + 10 * r();
  labRows.push({ id: 'L' + pad(labRows.length + 1, 4), patient: p.id, visit, crp: round(clamp(crp, 0.5, 30), 1), alt: round(clamp(alt, 8, 120), 0) });
}));
const labs = {
  y: { vars: ['CRP', 'ALT'], smps: labRows.map(l => l.id), data: [labRows.map(l => l.crp), labRows.map(l => l.alt)] },
  x: { patient: labRows.map(l => l.patient), visit: labRows.map(l => l.visit) }
};

// ---- the dashboard -------------------------------------------------------------
const R_CODE = [
  '# Which genes track survival? Spearman correlation of each gene with OS (months).',
  'genes <- c(' + GENES.map(g => '"' + g + '"').join(', ') + ')',
  'rho <- sapply(genes, function(g) cor(cohort[[g]], cohort$os_months, method = "spearman"))',
  'result <- data.frame(gene = genes, spearman_rho = round(rho, 3))'
].join('\n');

const spec = {
  $schema: 'https://canvasxpress.org/schema/dashboard.schema.json',
  schemaVersion: '1.1',
  id: 'cohort-explorer',
  title: 'Cohort Explorer',
  version: 1,
  broadcastGroup: 'cohort-explorer',
  theme: 'auto',
  layout: {
    cols: 12, rowHeight: 40, gap: 12,
    items: [
      { panel: 'filters', x: 0, y: 0, w: 3, h: 14 },
      { panel: 'km', x: 3, y: 0, w: 5, h: 7 },
      { panel: 'pdl1', x: 8, y: 0, w: 4, h: 7 },
      { panel: 'myc', x: 3, y: 7, w: 5, h: 7 },
      { panel: 'crp', x: 8, y: 7, w: 4, h: 7 },
      { panel: 'genes-r', x: 0, y: 14, w: 7, h: 7 },
      { panel: 'about', x: 7, y: 14, w: 5, h: 7 }
    ]
  },
  data: {
    clinical: { kind: 'inline', value: clinical },
    expression: { kind: 'inline', value: expression },
    labs: { kind: 'inline', value: labs },
    cohort: { kind: 'join', left: 'expression', right: 'clinical', on: { left: 'patient_id', right: 'smps' }, how: 'inner' },
    geneSurvival: { kind: 'function', language: 'r', inputs: ['cohort'], code: R_CODE }
  },
  relationships: [
    { left: 'clinical', right: 'labs', on: { left: 'smps', right: 'patient' } }
  ],
  markingMode: 'focus',
  panels: {
    filters: { type: 'filters', title: 'Filters', dataRef: 'cohort', fields: ['arm', 'stage', 'sex', 'age', 'CD274'] },
    km: {
      title: 'Overall survival by arm (Kaplan–Meier)', dataRef: 'cohort',
      config: { graphType: 'KaplanMeier', xAxis: ['os_months'], yAxis: ['os_event'], colorBy: 'arm', title: false,
        xAxisTitle: 'Months', yAxisTitle: 'Survival' }
    },
    pdl1: {
      title: 'PD-L1 (CD274) vs survival', dataRef: 'cohort',
      config: { graphType: 'Scatter2D', xAxis: ['CD274'], yAxis: ['os_months'], colorBy: 'arm', title: false,
        xAxisTitle: 'CD274 (log2)', yAxisTitle: 'OS (months)' }
    },
    myc: {
      title: 'MYC expression by stage', dataRef: 'cohort',
      config: { graphType: 'Boxplot', xAxis: ['MYC'], groupingFactors: ['stage'], colorBy: 'stage', title: false,
        graphOrientation: 'vertical', showBoxplotOriginalData: true }
    },
    crp: {
      title: 'Labs per visit: CRP vs ALT (linked by patient)', dataRef: 'labs',
      config: { graphType: 'Scatter2D', xAxis: ['CRP'], yAxis: ['ALT'], colorBy: 'visit', title: false,
        xAxisTitle: 'CRP (mg/L)', yAxisTitle: 'ALT (U/L)' }
    },
    'genes-r': {
      title: 'Genes vs survival — computed in R (Spearman ρ)', dataRef: 'geneSurvival',
      config: { graphType: 'Bar', xAxis: ['spearman_rho'], title: false, graphOrientation: 'vertical',
        showLegend: false, smpLabelRotate: 45 }
    },
    about: {
      type: 'text',
      text: 'How this dashboard is built\n\n' +
        '• Join: tumour samples carry their own ids; the cohort source joins expression to clinical on patient_id.\n' +
        '• Relationships: labs relate to patients, so selecting patients in any chart marks their lab visits (and vice versa).\n' +
        '• Filters panel: filters the cohort and, through the relationship, the labs. Try the saved schemes.\n' +
        '• R function: the gene chart is computed by R on the joined cohort (needs a server with data functions enabled).\n' +
        '• One point per patient: the survival curve and the PD-L1 scatter plot the table rows directly.'
    }
  },
  filterSchemes: {
    'Drug arm, PD-L1 high': [
      { dataRef: 'cohort', field: 'arm', values: ['Drug'] },
      { dataRef: 'cohort', field: 'CD274', min: 8 }
    ],
    'Advanced (III–IV)': [
      { dataRef: 'cohort', field: 'stage', values: ['III', 'IV'] }
    ]
  }
};

fs.writeFileSync(__dirname + '/cohort-explorer.spec.json', JSON.stringify(spec, null, 2) + '\n');
const drug = patients.filter(p => p.arm === 'Drug');
console.log('wrote cohort-explorer.spec.json:', N, 'patients,', samples.length, 'samples,', labRows.length, 'lab rows;',
  'events drug/placebo', drug.filter(p => p.osEvent).length + '/' + patients.filter(p => p.arm === 'Placebo' && p.osEvent).length);
