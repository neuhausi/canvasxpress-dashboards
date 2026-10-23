// Deterministic generator for the Cohort Tour dashboard spec: the cohort template (filters,
// Kaplan-Meier by arm, boxplot, scatter, click-to-load case card) over a 60-patient trial, with a
// storyboard and an insights block. The narration quotes numbers computed from the same data, so
// it cannot drift from it. Seeded PRNG only (no Math.random / Date.now).
// Run from the repo root: node examples/gen-cohort-tour.cjs
const fs = require('fs');
const path = require('path');

function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(20261023);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pad = (n, w) => String(n).padStart(w, '0');
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// 60 patients. Story: the drug helps (a longer follow-up on the drug arm, more so with high CD274);
// stage III-IV and older patients do worse.
const STAGES = ['I', 'II', 'III', 'IV'];
const rows = [];
for (let i = 0; i < 60; i++) {
  const arm = i % 2 === 0 ? 'Drug' : 'Placebo';
  const stage = STAGES[Math.floor(r() * 4)];
  const age = Math.round(clamp(62 + (r() + r() + r() - 1.5) * 22, 38, 84));
  const cd274 = Math.round(clamp(5 + (r() + r() - 1) * 6 + (arm === 'Drug' ? 1.2 : 0), 0.5, 10) * 10) / 10;
  const risk = STAGES.indexOf(stage) * 0.55 + (age - 60) * 0.03 - (arm === 'Drug' ? 0.7 + 0.08 * cd274 : 0);
  const months = Math.round(clamp(38 * Math.exp(-risk * 0.55) * (0.6 + r() * 0.8), 2, 60));
  // Anyone followed for under a year had the event (a patient lost this early would be censored; the
  // engine's log-rank test throws when the two earliest distinct times are both censored, so the
  // example keeps a leading event).
  const event = months <= 12 || r() < clamp(0.35 + risk * 0.18, 0.1, 0.95) ? 1 : 0;
  rows.push({ id: 'P' + pad(i + 1, 3), months, event, age, cd274, arm, stage });
}
const data = {
  y: { vars: ['os_months', 'os_event', 'age', 'CD274'], smps: rows.map(p => p.id),
    data: [rows.map(p => p.months), rows.map(p => p.event), rows.map(p => p.age), rows.map(p => p.cd274)] },
  x: { arm: rows.map(p => p.arm), stage: rows.map(p => p.stage) }
};

const drug = rows.filter(p => p.arm === 'Drug'), placebo = rows.filter(p => p.arm === 'Placebo');
const highRisk = rows.filter(p => (p.stage === 'III' || p.stage === 'IV') && p.age >= 65);
const hrPlacebo = highRisk.filter(p => p.arm === 'Placebo' && p.event === 1).sort((a, b) => a.months - b.months);
const pick = hrPlacebo[0] || highRisk[0];
const med = (g) => median(g.map(p => p.months));
const events = (g) => g.filter(p => p.event === 1).length;

(async function main() {
  const root = path.resolve(__dirname, '..');
  const { suggestDashboard, dashboardSpec } = await import(path.join(root, 'src', 'suggestDashboard.js'));
  const suggestion = suggestDashboard(data);
  if (!suggestion || suggestion.template !== 'cohort') throw new Error('the cohort template did not match');
  const spec = dashboardSpec(suggestion, {
    id: 'cohort-tour', title: 'Cohort Tour: a trial in four steps', source: { kind: 'inline', value: data },
    thresholds: [{ field: 'age', op: 'ge', value: 75, label: 'Age 75 or older' }]
  });
  spec.filterSchemes = { 'Drug arm': [{ dataRef: 'data', field: 'arm', values: ['Drug'] }] };
  const hrFilters = [
    { dataRef: 'data', field: 'stage', values: ['III', 'IV'] },
    { dataRef: 'data', field: 'age', min: 65, max: 84 }
  ];
  spec.storyboard = {
    title: 'The trial in four steps',
    seconds: 9,
    steps: [
      { title: 'The whole cohort',
        narration: rows.length + ' patients, ' + drug.length + ' on the drug and ' + placebo.length + ' on placebo. The curves show survival by arm; the boxplot and scatter show age against follow-up.' },
      { title: 'The drug arm',
        narration: 'Filtered to the drug arm (a saved filter scheme): median follow-up is ' + med(drug) + ' months against ' + med(placebo) + ' on placebo, with ' + events(drug) + ' events against ' + events(placebo) + '.',
        scheme: 'Drug arm' },
      { title: 'The high-risk subgroup',
        narration: 'Stage III or IV and aged 65 or over: ' + highRisk.length + ' patients, ' + highRisk.filter(p => p.arm === 'Drug').length + ' on the drug and ' + highRisk.filter(p => p.arm === 'Placebo').length + ' on placebo. These are explicit filters, so the step also shows how a view is built from predicates.',
        filters: hrFilters },
      { title: 'One patient',
        narration: pick.id + ' (' + pick.arm + ', stage ' + pick.stage + ', age ' + pick.age + ') is the earliest event in the high-risk placebo group, at ' + pick.months + ' months. The record is on the case card below.',
        params: { 'case': pick.id }, focus: 'case', seconds: 12 }
    ]
  };
  spec.theme = 'auto';
  fs.writeFileSync(path.join(__dirname, 'cohort-tour.spec.json'), JSON.stringify(spec, null, 2) + '\n');
  console.log('cohort-tour.spec.json:', rows.length, 'patients; high-risk', highRisk.length, '; case', pick.id);
})().catch(function (e) { console.error(e); process.exit(1); });
