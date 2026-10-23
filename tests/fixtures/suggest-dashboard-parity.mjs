// Regenerate tests/fixtures/suggest-dashboard-parity.json: run each dataset through the
// REAL suggestDashboard and record its output, so the Python twin in canvasxpress-mcp
// (src/cx_dashboard_suggest.py) can be held to the same answer. The JS is the reference;
// tests/suggestDashboard.test.js fails when this fixture is stale.
//   node tests/fixtures/suggest-dashboard-parity.mjs
// then copy the JSON to canvasxpress-mcp/tests/fixtures/.
import { writeFileSync } from 'node:fs';
import { suggestDashboard } from '../../src/suggestDashboard.js';

/** Rows are samples; `measures` numeric columns, `factors` text annotations (x). */
function table(rows, measures, factors, ids) {
  var smps = [];
  for (var i = 0; i < rows; i++) smps.push(ids ? ids(i) : 'S' + (i + 1));
  var vars = Object.keys(measures);
  var x = {};
  Object.keys(factors || {}).forEach(function (name) {
    x[name] = smps.map(function (s, i) { return factors[name](i); });
  });
  var data = { y: { vars: vars, smps: smps, data: vars.map(function (v) { return smps.map(function (s, i) { return measures[v](i); }); }) } };
  if (Object.keys(x).length) data.x = x;
  return data;
}

/** The same table with vars and smps swapped: more variables than samples. */
function transposed(data) {
  var y = data.y;
  var matrix = y.smps.map(function (s, r) { return y.vars.map(function (v, c) { return y.data[c][r]; }); });
  var out = { y: { vars: y.smps.slice(), smps: y.vars.slice(), data: matrix } };
  if (data.x) out.z = JSON.parse(JSON.stringify(data.x));
  return out;
}

function cohort(timeName, eventName, extra) {
  var measures = {};
  measures[timeName] = function (i) { return 3 + (i * 7) % 40; };
  measures[eventName] = function (i) { return i % 3 === 0 ? 0 : 1; };
  measures.age = function (i) { return 40 + (i * 5) % 35; };
  measures.CD274 = function (i) { return 2 + (i * 3) % 9; };
  var factors = {
    arm: function (i) { return i % 2 ? 'Drug' : 'Placebo'; },
    stage: function (i) { return ['I', 'II', 'III'][i % 3]; }
  };
  return table(extra && extra.rows || 60, measures, factors);
}

function qc(withBatch, names) {
  var factors = withBatch ? {
    lane: function (i) { return 'L' + (1 + i % 4); },
    flowcell: function (i) { return i < 24 ? 'FC1' : 'FC2'; }
  } : {};
  var n = names || ['total_reads', 'pct_mapped', 'pct_duplication', 'q30', 'gc_content'];
  var fns = [function (i) { return 20e6 + (i * 391) % 9e6; }, function (i) { return 90 + (i * 7) % 9; },
    function (i) { return 8 + (i * 5) % 20; }, function (i) { return 88 + (i * 3) % 9; }, function (i) { return 40 + (i * 11) % 6; }];
  var measures = {};
  n.forEach(function (name, k) { measures[name] = fns[k % fns.length]; });
  return table(48, measures, factors);
}

var CASES = {};
CASES['cohort: time/status'] = cohort('time', 'status');
CASES['cohort: os_months/os_event'] = cohort('os_months', 'os_event');
CASES['cohort: OS.time prefix form'] = cohort('OS.time', 'os_event');
CASES['cohort: overall_survival_days'] = cohort('overall_survival_days', 'death');

(function () {
  var d = cohort('os_months', 'os_event');
  d.x.event_label = d.x.arm.map(function (a) { return a === 'Drug' ? 'Dead' : 'Alive'; });
  CASES['cohort: extra text columns'] = d;
})();

CASES['cohort: variables outnumber samples is refused (needs a declared source axis)'] = transposed(cohort('os_months', 'os_event'));
CASES['cohort: text event labels are refused (the engine KM needs a numeric event)'] = (function () {
  var d = table(40, { os_months: function (i) { return 2 + (i * 5) % 30; }, age: function (i) { return 30 + i; }, bmi: function (i) { return 20 + i % 9; } },
    { vital: function (i) { return i % 2 ? 'Dead' : 'Alive'; }, arm: function (i) { return i % 2 ? 'A' : 'B'; } });
  return d;
})();
CASES['cohort: no grouping factor'] = table(40, {
  time: function (i) { return 1 + i; }, status: function (i) { return i % 2; },
  age: function (i) { return 40 + i; }, marker: function (i) { return i % 7; } }, {});
CASES['cohort: NA tokens and numeric strings'] = (function () {
  var d = cohort('time', 'status');
  d.y.data[2][0] = 'NA'; d.y.data[2][1] = ''; d.y.data[3][2] = '7.5'; d.y.data[3][3] = 'n/a';
  return d;
})();
CASES['cohort: only time + event (too few panels)'] = table(30, {
  time: function (i) { return 1 + i; }, status: function (i) { return i % 2; } }, {});
CASES['cohort: group column with seven levels is skipped'] = (function () {
  var d = cohort('time', 'status');
  d.x.arm = d.y.smps.map(function (s, i) { return 'G' + (i % 7); });
  return d;
})();
CASES['cohort: preferred group name wins over earlier column'] = (function () {
  var d = table(40, { time: function (i) { return 1 + i; }, status: function (i) { return i % 2; }, age: function (i) { return 40 + i; } },
    { site: function (i) { return ['A', 'B'][i % 2]; }, treatment: function (i) { return ['X', 'Y', 'Z'][i % 3]; } });
  return d;
})();
CASES['cohort: many filter fields are capped'] = (function () {
  var factors = {};
  ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'].forEach(function (n, k) { factors[n] = function (i) { return 'v' + ((i + k) % 3); }; });
  return table(40, { time: function (i) { return 1 + i; }, status: function (i) { return i % 2; }, age: function (i) { return 40 + i; }, m: function (i) { return i % 5; } }, factors);
})();

CASES['qc: lane + flowcell'] = qc(true);
CASES['qc: no batch column'] = qc(false);
CASES['qc: three families only'] = qc(true, ['reads', 'pct_aligned', 'q30']);
CASES['qc: coverage instead of reads'] = qc(true, ['mean_coverage', 'pct_mapped', 'q30', 'adapter_content']);
CASES['qc: variables outnumber samples is refused'] = (function () {
  var d = table(48, { total_reads: function (i) { return 1e7 + i; }, pct_mapped: function (i) { return 90 + i % 9; }, q30: function (i) { return 90 + i % 7; },
    pct_duplication: function (i) { return 10 + i % 11; } }, { lane: function (i) { return 'L' + (i % 2); } });
  return transposed(d);
})();

CASES['none: sales table'] = table(30, { revenue: function (i) { return i * 100; }, units: function (i) { return i; } },
  { region: function (i) { return ['N', 'S', 'E'][i % 3]; } });
CASES['none: two QC-like columns'] = table(30, { total_reads: function (i) { return i * 1e6; }, q30: function () { return 90; } }, {});
CASES['none: wide numeric matrix (heatmap shape only)'] = table(8, {
  g1: function (i) { return i; }, g2: function (i) { return i * 2; }, g3: function (i) { return i % 3; }, g4: function (i) { return i + 1; } }, {});
CASES['none: empty'] = { y: { vars: [], smps: [], data: [] } };

var out = { generated: 'node tests/fixtures/suggest-dashboard-parity.mjs', cases: [] };
Object.keys(CASES).forEach(function (name) {
  out.cases.push({ name: name, data: CASES[name], expected: suggestDashboard(CASES[name]) });
});
writeFileSync(new URL('./suggest-dashboard-parity.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log('wrote ' + out.cases.length + ' cases: ' + out.cases.map(function (c) { return c.expected ? c.expected.template : 'null'; }).join(', '));
