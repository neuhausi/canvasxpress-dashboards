/**
 * Builder tests: pointer→grid geometry (pure) and an end-to-end acceptance test
 * that builds a 4-panel dashboard with no code, then renders the produced spec.
 * Run with `node --test`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBuilder, pointerToCell } from '../src/builder.js';
import { blankSpec, setDataSource } from '../src/builderModel.js';
import { validateSpec } from '../src/validateSpec.js';
import { renderDashboard } from '../src/renderDashboard.js';
import { installDom } from './helpers/dom-stub.js';

test('pointerToCell maps viewport coordinates to grid cells', function () {
  var rect = { left: 0, top: 0, width: 1200 };
  var cols = 12, rowHeight = 130, gap = 12;
  // colWidth = (1200 + 12) / 12 = 101; near-origin -> (0,0)
  assert.deepEqual(pointerToCell(5, 5, rect, cols, rowHeight, gap), { x: 0, y: 0 });
  // x ~ 6th column, y ~ 2nd row
  assert.deepEqual(pointerToCell(650, 160, rect, cols, rowHeight, gap), { x: 6, y: 1 });
  // clamps past the right edge to the last column
  assert.equal(pointerToCell(100000, 0, rect, cols, rowHeight, gap).x, 11);
});

test('createBuilder returns a handle and renders a toolbar', function () {
  installDom();
  var container = document.createElement('div');
  var builder = createBuilder(container, { spec: blankSpec('d1', 'Demo') });
  assert.equal(typeof builder.getSpec, 'function');
  assert.equal(builder.getSpec().id, 'd1');
  assert.ok(container.querySelector('.cxb-toolbar'), 'toolbar rendered');
});

test('handle.addPanel renders an editable cell and updates the spec', function () {
  installDom();
  var container = document.createElement('div');
  var start = setDataSource(blankSpec('d1'), 'sales', { kind: 'inline', value: { y: { vars: ['R'], smps: ['A'], data: [[1]] } } });
  var builder = createBuilder(container, { spec: start });

  builder.addPanel({ id: 'p1', title: 'Bar', dataRef: 'sales', config: { graphType: 'Bar' } });

  assert.ok(builder.getSpec().panels.p1, 'panel in spec');
  assert.equal(container.querySelectorAll('.cxb-cell').length, 1, 'one editable cell rendered');
});

test('ACCEPTANCE: build a 4-panel dashboard with no code; the spec validates and renders', async function () {
  installDom();
  var container = document.createElement('div');
  var start = setDataSource(blankSpec('sales-overview', 'Sales'), 'sales', {
    kind: 'inline', value: { y: { vars: ['R'], smps: ['A', 'B'], data: [[1, 2]] } }
  });
  var builder = createBuilder(container, { spec: start });

  // No-code assembly: four panels via the builder API (same path as the +Panel button).
  builder.addPanel({ id: 'p1', title: 'Bar',    dataRef: 'sales', config: { graphType: 'Bar' } });
  builder.addPanel({ id: 'p2', title: 'Pie',    dataRef: 'sales', config: { graphType: 'Pie' } });
  builder.addPanel({ id: 'p3', title: 'Line',   dataRef: 'sales', config: { graphType: 'Line' } });
  builder.addPanel({ id: 'p4', title: 'Dotplot', dataRef: 'sales', config: { graphType: 'Dotplot' } });

  var spec = builder.getSpec();
  assert.equal(Object.keys(spec.panels).length, 4);
  assert.equal(spec.layout.items.length, 4);

  // The produced spec is valid...
  assert.equal(validateSpec(spec).valid, true);

  // ...and re-renders as four coordinated instances (builder output == renderable spec).
  var created = [];
  function CXStub(id, data, config) { created.push({ id: id, config: config }); }
  var host = document.createElement('div');
  var handle = await renderDashboard(spec, host, { CanvasXpress: CXStub });
  await handle.ready;
  assert.equal(created.length, 4, 'four panels rendered');
  created.forEach(function (c) { assert.equal(c.config.broadcastGroup, 'sales-overview'); });
});
