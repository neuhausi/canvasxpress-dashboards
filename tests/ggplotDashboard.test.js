/**
 * Unit tests for the ggplot → dashboard assembler and the validator's ggplot
 * panel rules. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGgplotDashboardSpec } from '../src/ggplotDashboard.js';
import { validateSpec } from '../src/validateSpec.js';

/** A minimal stand-in for a ggplot.as.list() isGGPlot spec. */
function ggSpec(x) {
  return { isGGPlot: true, data: [['Id', 'x'], ['a', x || 1]], geoms: 'GeomPoint' };
}

var CONVERSIONS = [
  { key: 'scatter', title: 'Scatter', spec: ggSpec(1), code: 'ggplot(df, aes(x,y)) + geom_point()' },
  { key: 'bars', title: 'Bars', spec: ggSpec(2) },
  { key: 'line', spec: ggSpec(3) }   // no title → falls back to key
];

test('assembles one ggplot panel per conversion', function () {
  var spec = buildGgplotDashboardSpec(CONVERSIONS);
  assert.deepEqual(Object.keys(spec.panels), ['scatter', 'bars', 'line']);
  assert.equal(spec.panels.scatter.type, 'ggplot');
  assert.equal(spec.panels.scatter.title, 'Scatter');
  assert.equal(spec.panels.line.title, 'line');      // key fallback
  assert.equal(spec.panels.scatter.spec.isGGPlot, true);
});

test('carries the R source onto the panel when present (for the Code recipe)', function () {
  var spec = buildGgplotDashboardSpec(CONVERSIONS);
  assert.equal(spec.panels.scatter.code, 'ggplot(df, aes(x,y)) + geom_point()');
  assert.ok(!('code' in spec.panels.bars));   // omitted when the snippet has none
});

test('lays out a grid with the requested columns per row', function () {
  var spec = buildGgplotDashboardSpec(CONVERSIONS, { perRow: 2, panelHeight: 7 });
  var at = {};
  spec.layout.items.forEach(function (it) { at[it.panel] = it; });
  // perRow 2 over a 12-col grid → 6 wide; row 0 holds scatter+bars, row 1 line.
  assert.deepEqual([at.scatter.x, at.scatter.y, at.scatter.w], [0, 0, 6]);
  assert.deepEqual([at.bars.x, at.bars.y], [6, 0]);
  assert.deepEqual([at.line.x, at.line.y], [0, 7]);
});

test('an intro adds a full-width text banner and offsets the grid', function () {
  var spec = buildGgplotDashboardSpec(CONVERSIONS, { intro: '<b>hi</b>' });
  assert.equal(spec.panels.intro.type, 'text');
  assert.equal(spec.panels.intro.html, '<b>hi</b>');
  var intro = spec.layout.items[0];
  assert.deepEqual([intro.x, intro.y, intro.w, intro.h], [0, 0, 12, 2]);
  var scatter = spec.layout.items.find(function (it) { return it.panel === 'scatter'; });
  assert.equal(scatter.y, 2);   // charts start below the banner
});

test('the assembled spec passes the validator', function () {
  var spec = buildGgplotDashboardSpec(CONVERSIONS, { intro: 'x' });
  var result = validateSpec(spec);
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('rejects a conversion missing its key or isGGPlot spec', function () {
  assert.throws(function () {
    buildGgplotDashboardSpec([{ title: 'no key', spec: ggSpec() }]);
  }, /needs a string "key"/);
  assert.throws(function () {
    buildGgplotDashboardSpec([{ key: 'bad', spec: { isGGPlot: false } }]);
  }, /isGGPlot:true/);
});

test('validator accepts a self-contained ggplot panel (no dataRef)', function () {
  var spec = {
    id: 'gg', layout: { cols: 12, items: [{ panel: 'p', x: 0, y: 0, w: 6, h: 7 }] },
    data: {}, panels: { p: { type: 'ggplot', spec: ggSpec() } }
  };
  assert.equal(validateSpec(spec).valid, true);
});

test('validator rejects a ggplot panel without an isGGPlot spec', function () {
  var spec = {
    id: 'gg', layout: { cols: 12, items: [{ panel: 'p', x: 0, y: 0, w: 6, h: 7 }] },
    data: {}, panels: { p: { type: 'ggplot' } }
  };
  var result = validateSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(function (e) { return e.includes('isGGPlot:true'); }));
});
