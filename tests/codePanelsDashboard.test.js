/**
 * Unit tests for the R-canvasXpress-code → dashboard assembler
 * (buildCodePanelsDashboardSpec) and its validator rules. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodePanelsDashboardSpec } from '../src/codePanelsDashboard.js';
import { validateSpec } from '../src/validateSpec.js';

/** A minimal stand-in for a native canvasXpress widget spec (its `$x`). */
function cxSpec(graphType) {
  return {
    data: { y: { vars: ['A'], smps: ['s1'], data: [[1]] } },
    config: { graphType: graphType || 'Bar' },
    events: null, afterRender: null
  };
}

var CONVERSIONS = [
  { key: 'bar', title: 'Bar', spec: cxSpec('Bar'), code: 'g <- canvasXpress(data=y, graphType="Bar")' },
  { key: 'scatter', title: 'Scatter', spec: cxSpec('Scatter2D') },
  { key: 'line', spec: cxSpec('Line') }   // no title → falls back to key
];

test('assembles one cxcode panel per conversion', function () {
  var spec = buildCodePanelsDashboardSpec(CONVERSIONS);
  assert.deepEqual(Object.keys(spec.panels), ['bar', 'scatter', 'line']);
  assert.equal(spec.panels.bar.type, 'cxcode');
  assert.equal(spec.panels.bar.title, 'Bar');
  assert.equal(spec.panels.line.title, 'line');      // key fallback
  assert.equal(spec.panels.bar.spec.config.graphType, 'Bar');
  assert.ok(spec.panels.bar.spec.config.isGGPlot !== true);
});

test('carries the R source onto the panel when present (for the Code recipe)', function () {
  var spec = buildCodePanelsDashboardSpec(CONVERSIONS);
  assert.equal(spec.panels.bar.code, 'g <- canvasXpress(data=y, graphType="Bar")');
  assert.ok(!('code' in spec.panels.scatter));   // omitted when the snippet has none
});

test('lays out a grid with the requested columns per row', function () {
  var spec = buildCodePanelsDashboardSpec(CONVERSIONS, { perRow: 2, panelHeight: 7 });
  var at = {};
  spec.layout.items.forEach(function (it) { at[it.panel] = it; });
  // perRow 2 over a 12-col grid → 6 wide; row 0 holds bar+scatter, row 1 line.
  assert.deepEqual([at.bar.x, at.bar.y, at.bar.w], [0, 0, 6]);
  assert.deepEqual([at.scatter.x, at.scatter.y], [6, 0]);
  assert.deepEqual([at.line.x, at.line.y], [0, 7]);
});

test('an intro adds a full-width text banner and offsets the grid', function () {
  var spec = buildCodePanelsDashboardSpec(CONVERSIONS, { intro: '<b>hi</b>' });
  assert.equal(spec.panels.intro.type, 'text');
  assert.equal(spec.panels.intro.html, '<b>hi</b>');
  var intro = spec.layout.items[0];
  assert.deepEqual([intro.x, intro.y, intro.w, intro.h], [0, 0, 12, 2]);
  var bar = spec.layout.items.find(function (it) { return it.panel === 'bar'; });
  assert.equal(bar.y, 2);   // charts start below the banner
});

test('the assembled spec passes the validator', function () {
  var spec = buildCodePanelsDashboardSpec(CONVERSIONS, { intro: 'x' });
  var result = validateSpec(spec);
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('rejects a conversion missing its key or a spec config', function () {
  assert.throws(function () {
    buildCodePanelsDashboardSpec([{ title: 'no key', spec: cxSpec() }]);
  }, /needs a string "key"/);
  assert.throws(function () {
    buildCodePanelsDashboardSpec([{ key: 'bad', spec: { data: {} } }]);
  }, /config object/);
});
