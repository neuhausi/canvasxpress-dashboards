/**
 * Unit tests for dashboard-from-one-dataset assembly. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suggestDashboard, dashboardSpec } from '../src/suggestDashboard.js';
import { detectDataShapes, wizardSpec, panelConfigFor, orientConfig } from '../src/wizard.js';
import { validateSpec } from '../src/validateSpec.js';
import { updatePanel, movePanel, resizePanel, resolveCollisions, addPanel, removePanel } from '../src/builderModel.js';
import { canonicalSpec, migrateSpec } from '../src/spec.js';

/**
 * A CanvasXpress data object: rows are samples, `measures` are the numeric columns
 * (name -> value function of the row index), `factors` the text annotations.
 */
function table(rows, measures, factors) {
  var smps = [];
  for (var i = 0; i < rows; i++) smps.push('S' + (i + 1));
  var vars = Object.keys(measures);
  var x = {};
  Object.keys(factors || {}).forEach(function (name) {
    x[name] = smps.map(function (s, i) { return factors[name](i); });
  });
  return {
    y: { vars: vars, smps: smps, data: vars.map(function (v) { return smps.map(function (s, i) { return measures[v](i); }); }) },
    x: x
  };
}

function cohort(timeName, eventName) {
  var measures = {};
  measures[timeName] = function (i) { return 3 + (i * 7) % 40; };
  measures[eventName] = function (i) { return i % 3 === 0 ? 0 : 1; };
  measures.age = function (i) { return 40 + (i * 5) % 35; };
  measures.CD274 = function (i) { return 2 + (i * 3) % 9; };
  return table(60, measures, {
    arm: function (i) { return i % 2 ? 'Drug' : 'Placebo'; },
    stage: function (i) { return ['I', 'II', 'III'][i % 3]; }
  });
}

function qcRun(withBatch) {
  var factors = withBatch ? {
    lane: function (i) { return 'L' + (1 + i % 4); },
    flowcell: function (i) { return i < 24 ? 'FC1' : 'FC2'; }
  } : {};
  return table(48, {
    total_reads: function (i) { return 20e6 + (i * 391) % 9e6; },
    pct_mapped: function (i) { return 90 + (i * 7) % 9; },
    pct_duplication: function (i) { return 8 + (i * 5) % 20; },
    q30: function (i) { return 88 + (i * 3) % 9; },
    gc_content: function (i) { return 40 + (i * 11) % 6; }
  }, factors);
}

test('a survival cohort gets filters + Kaplan–Meier + measure panels', function () {
  var suggestion = suggestDashboard(cohort('time', 'status'));
  assert.equal(suggestion.template, 'cohort');
  var ids = suggestion.panels.map(function (p) { return p.id; });
  assert.deepEqual(ids, ['filters', 'km', 'compare', 'vs-time', 'case']);
  var km = suggestion.panels[1].config;
  assert.equal(km.graphType, 'KaplanMeier');
  assert.deepEqual(km.xAxis, ['time']);
  assert.deepEqual(km.yAxis, ['status']);
  assert.equal(km.colorBy, 'arm');
  assert.equal(km.title, false);
  var filters = suggestion.panels[0];
  assert.equal(filters.type, 'filters');
  assert.ok(filters.fields.indexOf('arm') !== -1 && filters.fields.indexOf('stage') !== -1);
  // The time and event columns are the analysis, not something to filter on.
  assert.equal(filters.fields.indexOf('time'), -1);
  assert.equal(filters.fields.indexOf('status'), -1);
});

test('prefixed survival headers (os_months / os_event) are recognised', function () {
  ['os_months', 'OS.time', 'pfs_days', 'overall_survival_days'].forEach(function (name) {
    var shapes = detectDataShapes(cohort(name, 'os_event'));
    assert.ok(shapes.some(function (s) { return s.graphType === 'KaplanMeier'; }), name);
    assert.equal(suggestDashboard(cohort(name, 'os_event')).template, 'cohort', name);
  });
});

test('the cohort measure panels use a measure that is not time / event', function () {
  var suggestion = suggestDashboard(cohort('os_months', 'os_event'));
  var compare = suggestion.panels[2].config;
  assert.equal(compare.graphType, 'Boxplot');
  assert.deepEqual(compare.xAxis, ['age']);
  assert.deepEqual(compare.groupingFactors, ['arm']);
  var vsTime = suggestion.panels[3].config;
  assert.equal(vsTime.graphType, 'Scatter2D');
  assert.deepEqual(vsTime.xAxis, ['age']);
  assert.deepEqual(vsTime.yAxis, ['os_months']);
});

test('the cohort dashboard spec is valid and links every panel to the one dataset', function () {
  var suggestion = suggestDashboard(cohort('os_months', 'os_event'));
  var spec = dashboardSpec(suggestion, { id: 'trial', title: 'Trial', datasetId: 'ds-1', store: 'me' });
  assert.deepEqual(validateSpec(spec).errors, []);
  assert.deepEqual(spec.data.data, { kind: 'dataset', id: 'ds-1', store: 'me' });
  assert.equal(spec.broadcastGroup, 'trial');
  Object.keys(spec.panels).forEach(function (id) {
    // The case card reads a second source of the same data, narrowed to the clicked case.
    assert.equal(spec.panels[id].dataRef, id === 'case' ? 'case' : 'data', id);
  });
  assert.equal(spec.layout.items.length, 5);
  // Nothing overlaps on the grid.
  var items = spec.layout.items;
  items.forEach(function (a, i) {
    items.slice(i + 1).forEach(function (b) {
      var apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, a.panel + ' overlaps ' + b.panel);
    });
  });
});

test('an inline source can stand in for a stored dataset', function () {
  var data = cohort('time', 'status');
  var spec = dashboardSpec(suggestDashboard(data), { id: 'x', source: { kind: 'inline', value: data } });
  assert.equal(spec.data.data.kind, 'inline');
  assert.deepEqual(validateSpec(spec).errors, []);
});

test('an NGS run QC table gets filters + depth + mapping/duplication + quality by batch', function () {
  var suggestion = suggestDashboard(qcRun(true));
  assert.equal(suggestion.template, 'ngs-qc');
  assert.deepEqual(suggestion.panels.map(function (p) { return p.id; }),
    ['filters', 'depth', 'quality-scatter', 'quality-spread', 'case']);
  var depth = suggestion.panels[1].config;
  assert.equal(depth.graphType, 'Bar');
  assert.deepEqual(depth.xAxis, ['total_reads']);
  assert.equal(depth.colorBy, 'lane');
  var scatter = suggestion.panels[2].config;
  assert.deepEqual(scatter.xAxis, ['pct_mapped']);
  assert.deepEqual(scatter.yAxis, ['pct_duplication']);
  var spread = suggestion.panels[3].config;
  assert.equal(spread.graphType, 'Boxplot');
  assert.deepEqual(spread.xAxis, ['q30']);
  assert.deepEqual(spread.groupingFactors, ['lane']);
  var spec = dashboardSpec(suggestion, { id: 'run-42', datasetId: 'ds-9' });
  assert.deepEqual(validateSpec(spec).errors, []);
  assert.equal(spec.title, 'Sequencing run QC');
});

test('a QC table with no lane / batch column still gets an ungrouped quality-spread boxplot', function () {
  var suggestion = suggestDashboard(qcRun(false));
  assert.equal(suggestion.template, 'ngs-qc');
  var spread = suggestion.panels.filter(function (p) { return p.id === 'quality-spread'; })[0];
  assert.equal(spread.config.graphType, 'Boxplot');
  assert.deepEqual(spread.config.xAxis, ['q30']);
  assert.equal(spread.config.groupingFactors, undefined);
});

test('tables that match no template are not offered one', function () {
  var sales = table(30, { revenue: function (i) { return i * 100; }, units: function (i) { return i; } },
    { region: function (i) { return ['N', 'S', 'E'][i % 3]; } });
  assert.equal(suggestDashboard(sales), null);
  // Two QC-like columns are not a QC run.
  var thin = table(30, { total_reads: function (i) { return i * 1e6; }, q30: function () { return 90; } }, {});
  assert.equal(suggestDashboard(thin), null);
  assert.equal(suggestDashboard(null), null);
  assert.equal(suggestDashboard({}), null);
  assert.equal(suggestDashboard({ y: { vars: [], smps: [], data: [] } }), null);
});

test('a template that would have fewer than three panels is not offered', function () {
  // Time + event only: filters + KM is two panels — not worth a dashboard.
  var bare = table(30, {
    time: function (i) { return 1 + i; }, status: function (i) { return i % 2; }
  }, {});
  assert.ok(detectDataShapes(bare).some(function (s) { return s.graphType === 'KaplanMeier'; }));
  assert.equal(suggestDashboard(bare), null);
});

test('a table stored with more variables than samples is not offered a dashboard', function () {
  // Rows-as-variables needs a declared source axis and per-panel transposes; the Boxplot and the
  // Filters panel draw wrong without them (a field of bars; "No fields to filter"), so decline.
  var flipped = JSON.parse(readFileSync(new URL('./fixtures/suggest-dashboard-parity.json', import.meta.url), 'utf8'))
    .cases.filter(function (c) { return /outnumber/.test(c.name); });
  assert.equal(flipped.length, 2);
  flipped.forEach(function (c) {
    assert.ok(c.data.y.vars.length > c.data.y.smps.length, c.name);
    assert.equal(suggestDashboard(c.data), null, c.name);
  });
});

test('a text-labelled event (Dead / Alive) is not offered a cohort dashboard', function () {
  // The engine's Kaplan–Meier reads the event from a numeric column; a text one draws a wrong
  // curve with no error (flat steps, p = 1), so neither the wizard's detection nor the template
  // may go near it.
  var data = table(40, { os_months: function (i) { return 2 + (i * 5) % 30; }, age: function (i) { return 30 + i; }, bmi: function (i) { return 20 + i % 9; } },
    { vital: function (i) { return i % 2 ? 'Dead' : 'Alive'; }, arm: function (i) { return i % 2 ? 'A' : 'B'; } });
  assert.equal(detectDataShapes(data).filter(function (s) { return s.graphType === 'KaplanMeier'; }).length, 0);
  assert.equal(suggestDashboard(data), null);
});

test('suggesting never mutates the data', function () {
  var data = cohort('os_months', 'os_event');
  var before = JSON.stringify(data);
  suggestDashboard(data);
  assert.equal(JSON.stringify(data), before);
});

test('scatter-type panels publish without the engine transposeData (the renderer transposes them)', function () {
  var data = cohort('os_months', 'os_event');
  var suggestion = suggestDashboard(data);
  var km = suggestion.panels[1];
  var scatter = suggestion.panels[3];
  // Standalone (the wizard's previews) the engine needs the flag...
  assert.equal(km.config.transposeData, true);
  assert.equal(scatter.config.transposeData, true);
  // ...but a dashboard panel must not carry it: the renderer already transposes, and a second
  // transpose flips the data back (KaplanMeier fails, Scatter2D plots the wrong axes).
  assert.equal(km.dashboardConfig.transposeData, undefined);
  assert.equal(scatter.dashboardConfig.transposeData, undefined);
  var spec = dashboardSpec(suggestion, { id: 't', datasetId: 'd' });
  assert.equal(spec.panels.km.config.transposeData, undefined);
  assert.equal(spec.panels['vs-time'].config.transposeData, undefined);
  assert.equal(spec.panels.km.config.graphType, 'KaplanMeier');
  assert.equal(spec.panels.km.dashboardConfig, undefined);
  // A Boxplot never needed it.
  assert.equal(suggestion.panels[2].dashboardConfig, undefined);
});

test('no published panel of any template carries the engine transposeData', function () {
  // The engine transposes the dataset in place, and every panel of a dashboard shares one data
  // object: a panel with the flag flips its siblings (a Bar drawn with metrics on x and samples
  // in the legend). Check every recorded case, both orientations.
  var fixture = JSON.parse(readFileSync(new URL('./fixtures/suggest-dashboard-parity.json', import.meta.url), 'utf8'));
  var checked = 0;
  fixture.cases.forEach(function (c) {
    var suggestion = suggestDashboard(c.data);
    if (!suggestion) return;
    var spec = dashboardSpec(suggestion, { id: 'x', datasetId: 'd' });
    Object.keys(spec.panels).forEach(function (id) {
      if (!spec.panels[id].config) return;
      checked++;
      assert.equal(spec.panels[id].config.transposeData, undefined, c.name + ' / ' + id);
    });
  });
  assert.ok(checked >= 40, 'checked ' + checked + ' chart panels');
});

test('wizardSpec drops the engine transposeData for scatter-type charts when given the data', function () {
  var data = cohort('os_months', 'os_event');
  var config = orientConfig({ graphType: 'Scatter2D', xAxis: ['age'], yAxis: ['os_months'] }, data);
  assert.equal(config.transposeData, true);
  var withData = wizardSpec({ id: 'w', title: 'W', datasetId: 'd', config: config, data: data });
  assert.equal(withData.panels.chart.config.transposeData, undefined);
  assert.deepEqual(withData.panels.chart.config.xAxis, ['age']);
  // No data: published as given (back-compatible).
  var without = wizardSpec({ id: 'w', title: 'W', datasetId: 'd', config: config });
  assert.equal(without.panels.chart.config.transposeData, true);
  // panelConfigFor never mutates its input.
  var before = JSON.stringify(config);
  panelConfigFor(config, data);
  assert.equal(JSON.stringify(config), before);
});

test('the parity fixture is current (the Python twin in canvasxpress-mcp is held to it)', function () {
  // Regenerate with `node tests/fixtures/suggest-dashboard-parity.mjs`, then copy the JSON
  // to canvasxpress-mcp/tests/fixtures/ so its src/cx_dashboard_suggest.py is re-checked.
  var fixture = JSON.parse(readFileSync(new URL('./fixtures/suggest-dashboard-parity.json', import.meta.url), 'utf8'));
  assert.ok(fixture.cases.length >= 20);
  fixture.cases.forEach(function (c) {
    assert.deepEqual(JSON.parse(JSON.stringify(suggestDashboard(c.data))), c.expected, c.name);
  });
});

// --- the case drill ---

function panelById(suggestion, id) {
  return suggestion.panels.filter(function (p) { return p.id === id; })[0];
}

test('the drill wires a click only where a click names exactly one row', function () {
  var cohortSuggestion = suggestDashboard(cohort('os_months', 'os_event'));
  var wired = function (suggestion) {
    return suggestion.panels.filter(function (p) { return p.actions; }).map(function (p) { return p.id; });
  };
  // A scatter point is a patient. A box, a curve and the filters are not one row.
  assert.deepEqual(wired(cohortSuggestion), ['vs-time']);
  assert.deepEqual(panelById(cohortSuggestion, 'vs-time').actions, [{ on: 'click', setParam: { name: 'case' } }]);
  // QC: a sample bar and a sample point, not the by-lane boxplot.
  assert.deepEqual(wired(suggestDashboard(qcRun(true))), ['depth', 'quality-scatter']);
});

test('the drill description names the param, the second source and the row the card starts on', function () {
  var suggestion = suggestDashboard(cohort('time', 'status'));
  assert.deepEqual(suggestion.drill, { param: 'case', source: 'case', initial: 'S1' });
  var card = panelById(suggestion, 'case');
  assert.equal(card.card, true);
  assert.equal(card.config.view, 'table');
  assert.equal(card.config.dataTableBannerShow, false);
  assert.match(card.title, /^Patient record/);
  assert.match(panelById(suggestDashboard(qcRun(true)), 'case').title, /^Sample record/);
  assert.match(suggestion.reason, /click a point to load that patient/);
});

test('the spec carries a case param, a pushdown source narrowed to it, and the click actions', function () {
  var data = cohort('os_months', 'os_event');
  var spec = dashboardSpec(suggestDashboard(data), { id: 'trial', datasetId: 'ds-1', store: 'me' });
  assert.deepEqual(validateSpec(spec).errors, []);
  assert.deepEqual(spec.params, { 'case': { value: 'S1' } });
  assert.deepEqual(spec.data['case'], { kind: 'dataset', id: 'ds-1', store: 'me',
    pushdown: { where: [{ column: 'smps', op: '=', value: '$case' }] } });
  // The main source is left whole: the charts keep the cohort.
  assert.deepEqual(spec.data.data, { kind: 'dataset', id: 'ds-1', store: 'me' });
  assert.equal(spec.panels['case'].dataRef, 'case');
  assert.equal(spec.panels['case'].config.view, 'table');
  assert.deepEqual(spec.panels['vs-time'].actions, [{ on: 'click', setParam: { name: 'case' } }]);
  assert.equal(spec.panels.km.actions, undefined);
  assert.equal(spec.panels['case'].actions, undefined);
  // Descriptor-only fields never leak into the spec.
  Object.keys(spec.panels).forEach(function (id) {
    assert.equal(spec.panels[id].card, undefined, id);
    assert.equal(spec.panels[id].dashboardConfig, undefined, id);
  });
});

test('an inline source is copied for the case card (its own pushdown, the main source untouched)', function () {
  var data = qcRun(true);
  var spec = dashboardSpec(suggestDashboard(data), { id: 'q', source: { kind: 'inline', value: data } });
  assert.deepEqual(validateSpec(spec).errors, []);
  assert.equal(spec.data.data.pushdown, undefined);
  assert.deepEqual(spec.data['case'].value, data);
  assert.equal(spec.data['case'].pushdown.where[0].value, '$case');
  assert.equal(spec.params['case'].value, 'S1');
});

test('the case card does not count toward the three-panel minimum', function () {
  // Filters + Kaplan–Meier is two panels; the card must not make it three.
  var bare = table(30, { time: function (i) { return 1 + i; }, status: function (i) { return i % 2; } }, {});
  assert.equal(suggestDashboard(bare), null);
});

test('the drill source uses the first row id of the data as its starting case', function () {
  var data = qcRun(false);
  data.y.smps = data.y.smps.map(function (s) { return 'run7-' + s; });
  assert.equal(suggestDashboard(data).drill.initial, 'run7-S1');
});

test('opening a drill dashboard in the builder and editing it keeps the drill wiring', function () {
  // The builder has no UI to author click actions, so they live only in the spec JSON — what
  // matters is that ordinary builder edits (retitle, move, resize, add, save/load) never drop them.
  var spec = dashboardSpec(suggestDashboard(cohort('os_months', 'os_event')), { id: 'trial', datasetId: 'd' });
  var edited = updatePanel(spec, 'vs-time', { title: 'Age vs survival' });
  edited = updatePanel(edited, 'case', { title: 'Who is this?' });
  edited = movePanel(edited, 'vs-time', 6, 12);
  edited = resizePanel(edited, 'vs-time', 6, 10);
  edited = resolveCollisions(edited, 'vs-time');
  edited = addPanel(edited, { id: 'note', type: 'text', title: 'Note', text: 'hello', x: 0, y: 40, w: 4, h: 2 });
  var saved = migrateSpec(JSON.parse(JSON.stringify(canonicalSpec(edited)))).spec;   // a save + reload
  assert.deepEqual(validateSpec(saved).errors, []);
  assert.deepEqual(saved.panels['vs-time'].actions, [{ on: 'click', setParam: { name: 'case' } }]);
  assert.equal(saved.panels['vs-time'].title, 'Age vs survival');
  assert.deepEqual(saved.params, { 'case': { value: 'S1' } });
  assert.equal(saved.data['case'].pushdown.where[0].value, '$case');
  assert.equal(saved.panels['case'].dataRef, 'case');
  assert.equal(saved.panels['case'].config.view, 'table');
  // Removing the card leaves a valid dashboard (the click then just sets an unused param).
  assert.deepEqual(validateSpec(removePanel(saved, 'case')).errors, []);
});

test('the generated dashboard opts in to insights and passes declared thresholds through', function () {
  var data = qcRun(true);
  var plain = dashboardSpec(suggestDashboard(data), { id: 'q', datasetId: 'd' });
  assert.deepEqual(plain.insights, {});                                    // data-derived checks only
  var declared = [{ field: 'q30', op: 'lt', value: 85, label: 'Q30 below 85%' }];
  var spec = dashboardSpec(suggestDashboard(data), { id: 'q', datasetId: 'd', thresholds: declared });
  assert.deepEqual(validateSpec(spec).errors, []);
  assert.deepEqual(spec.insights, { thresholds: declared });
  declared[0].value = 1;                                                   // the spec holds its own copy
  assert.equal(spec.insights.thresholds[0].value, 85);
  // An invalid threshold is caught by validation, not silently dropped.
  var bad = dashboardSpec(suggestDashboard(data), { id: 'q', datasetId: 'd', thresholds: [{ field: 'q30', op: 'near', value: 1 }] });
  assert.ok(validateSpec(bad).errors.indexOf('spec.insights.thresholds[0].op must be one of: lt, le, gt, ge') !== -1);
});
