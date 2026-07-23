/**
 * Builder tests: pointer→grid geometry (pure), live-render wiring, the ⚙
 * customizer handoff (config folded back via getConfig), and an end-to-end
 * 4-panel no-code build. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuilder, pointerToCell, csvToCx, buildDataSource } from '../src/builder.js';
import { blankSpec, setDataSource } from '../src/builderModel.js';
import { validateSpec } from '../src/validateSpec.js';
import { renderDashboard } from '../src/renderDashboard.js';
import { installDom } from './helpers/dom-stub.js';

/**
 * A CanvasXpress stub: records instances, exposes the customizer + getConfig
 * surface the builder relies on.
 * @param {object[]} calls - Array to record each constructed instance in.
 * @returns {function} The stub constructor.
 */
function makeCX(calls) {
  function CX(id, data, config) {
    this.id = id;
    this.data = data;
    this.config = config || {};
    calls.push(this);
  }
  CX.prototype.getConfig = function () { return this.config; };
  CX.prototype.showCustomizer = function () { this.customizerOpened = true; };
  CX.prototype.setDimensions = function () {};
  CX.prototype.destroy = function () { this.destroyed = true; };
  return CX;
}

var DATA = { kind: 'inline', value: { y: { vars: ['Metric_1', 'Metric_2'], smps: ['A', 'B'], data: [[1, 2], [3, 4]] }, x: { Region: ['N', 'S'] } } };

test('pointerToCell maps viewport coordinates to grid cells', function () {
  var rect = { left: 0, top: 0, width: 1200 };
  assert.deepEqual(pointerToCell(5, 5, rect, 12, 130, 12), { x: 0, y: 0 });
  assert.deepEqual(pointerToCell(650, 160, rect, 12, 130, 12), { x: 6, y: 1 });
  assert.equal(pointerToCell(100000, 0, rect, 12, 130, 12).x, 11);
});

test('csvToCx reshapes CSV: first col = samples, numeric = vars, strings = annotations', function () {
  var csv = 'id,revenue,cost,region\nA,100,40,North\nB,220,90,South';
  var cx = csvToCx(csv);
  assert.deepEqual(cx.y.smps, ['A', 'B']);
  assert.deepEqual(cx.y.vars, ['revenue', 'cost']);
  assert.deepEqual(cx.y.data, [[100, 220], [40, 90]]);
  assert.deepEqual(cx.x.region, ['North', 'South']);
});

test('csvToCx handles quoted fields and rejects empty input', function () {
  var cx = csvToCx('id,label,val\n"x,1","a ""q""",5');
  assert.deepEqual(cx.y.smps, ['x,1']);
  assert.deepEqual(cx.x.label, ['a "q"']);
  assert.deepEqual(cx.y.vars, ['val']);
  assert.throws(function () { return csvToCx('id,val'); }, /no data rows/);
});

test('buildDataSource makes inline/connector sources and reports bad JSON', function () {
  assert.deepEqual(buildDataSource('json', '{"y":{"vars":[],"smps":[],"data":[]}}'),
    { kind: 'inline', value: { y: { vars: [], smps: [], data: [] } } });
  assert.deepEqual(buildDataSource('connector', ' /api/data?source=s '),
    { kind: 'connector', url: '/api/data?source=s' });
  assert.equal(buildDataSource('csv', 'id,v\nA,1').kind, 'inline');
  assert.throws(function () { return buildDataSource('json', '{bad'); }, /Invalid JSON/);
  assert.throws(function () { return buildDataSource('connector', '  '); }, /URL is required/);
});

test('createBuilder renders a toolbar (blank spec needs no CanvasXpress)', function () {
  installDom();
  var container = document.createElement('div');
  var builder = createBuilder(container, { spec: blankSpec('d1', 'Demo') });
  assert.equal(builder.getSpec().id, 'd1');
  assert.ok(container.querySelector('.cxb-topbar'), 'toolbar rendered');
});

test('an external toolbar host receives the builder actions', function () {
  installDom();
  var container = document.createElement('div');
  var toolbar = document.createElement('div');
  createBuilder(container, { spec: blankSpec('d1'), toolbar: toolbar });
  assert.ok(toolbar.classList.contains('cxb-topbar'), 'external toolbar populated');
  assert.equal(container.querySelector('.cxb-topbar'), null, 'no toolbar created inside the container');
  assert.ok(container.querySelector('.cxb-stage'), 'stage rendered in the container');
});

test('adding a panel renders a live cell with a ⚙ customize icon', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX(calls)
  });

  builder.addPanel({ id: 'p1', title: 'Bar', dataRef: 'sample', config: { graphType: 'Bar' } });
  await builder.whenReady();

  assert.ok(builder.getSpec().panels.p1, 'panel in spec');
  assert.equal(calls.length, 1, 'one live instance created');
  assert.ok(container.querySelector('.cxb-cell'), 'live cell decorated with chrome');
  var tools = [].map.call(container.querySelectorAll('.cxb-tool'), function (t) { return t.textContent; });
  assert.ok(tools.indexOf('⚙') !== -1, 'customize icon present');
  assert.ok(tools.indexOf('×') !== -1, 'delete icon present');
});

test('adding a panel is incremental — existing instances are not recreated or destroyed', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX(calls)
  });

  builder.addPanel({ id: 'p1', dataRef: 'sample', config: { graphType: 'Bar' } });
  await builder.whenReady();
  var firstInstance = calls[0];

  builder.addPanel({ id: 'p2', dataRef: 'sample', config: { graphType: 'Pie' } });
  await builder.whenReady();

  // Only one new instance was created (p2); p1 was neither recreated nor destroyed.
  assert.equal(calls.length, 2, 'p1 was not re-instantiated when p2 was added');
  assert.equal(firstInstance.destroyed, undefined, 'p1 instance was not destroyed');
  assert.equal(firstInstance.config.graphType, 'Bar', 'p1 keeps its graph type');
  assert.equal(container.querySelectorAll('.cxb-cell').length, 2);
});

test('getSpec folds the live CanvasXpress config back into the panel', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX(calls)
  });
  builder.addPanel({ id: 'p1', dataRef: 'sample', config: { graphType: 'Bar' } });
  await builder.whenReady();

  // Simulate the user customizing the graph: mutate the live instance's config.
  calls[0].config = { graphType: 'Line', colorBy: 'Region', broadcastGroup: 'd1' };

  var spec = builder.getSpec();
  assert.equal(spec.panels.p1.config.graphType, 'Line', 'customizer edit persisted');
  assert.equal(spec.panels.p1.config.colorBy, 'Region');
});

test('getSpec strips CanvasXpress derived __FACTOR__ state but keeps real config', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX(calls)
  });
  builder.addPanel({ id: 'p1', dataRef: 'sample', config: { graphType: 'Boxplot' } });
  await builder.whenReady();

  // Mimic getConfig() returning derived render-state alongside real config.
  calls[0].config = {
    graphType: 'Boxplot',
    groupingFactors: ['__FACTOR__'],   // internal sentinel — must be dropped
    xAxis: ['M1', 'M2'],               // kept (harmless, may be user-set)
    colorBy: 'Region'                  // real user config — kept
  };

  var cfg = builder.getSpec().panels.p1.config;
  assert.equal(cfg.graphType, 'Boxplot');
  assert.equal(cfg.colorBy, 'Region');
  assert.equal('groupingFactors' in cfg, false, 'derived __FACTOR__ grouping is stripped');
});

test('getSpec keeps real (non-sentinel) groupingFactors', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX(calls)
  });
  builder.addPanel({ id: 'p1', dataRef: 'sample', config: { graphType: 'Boxplot' } });
  await builder.whenReady();
  calls[0].config = { graphType: 'Boxplot', groupingFactors: ['Region'] };
  var cfg = builder.getSpec().panels.p1.config;
  assert.deepEqual(cfg.groupingFactors, ['Region'], 'real grouping is preserved');
});

test('getSpec preserves the panel graphType when getConfig returns it undefined', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX(calls)
  });
  builder.addPanel({ id: 'p1', dataRef: 'sample', config: { graphType: 'Boxplot' } });
  await builder.whenReady();

  // Mimic a CanvasXpress build whose getConfig() omits/undefines graphType.
  calls[0].config = { graphType: undefined, colorBy: 'Region', broadcastGroup: 'd1' };

  var spec = builder.getSpec();
  assert.equal(spec.panels.p1.config.graphType, 'Boxplot', 'original graphType is not wiped');
  assert.equal(spec.panels.p1.config.colorBy, 'Region', 'defined live keys still apply');
});

test('ACCEPTANCE: build a 4-panel dashboard with no code; the spec validates and renders', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('sales-overview', 'Sales'), 'sales', DATA),
    CanvasXpress: makeCX(calls)
  });

  builder.addPanel({ id: 'p1', title: 'Bar', dataRef: 'sales', config: { graphType: 'Bar' } });
  builder.addPanel({ id: 'p2', title: 'Pie', dataRef: 'sales', config: { graphType: 'Pie' } });
  builder.addPanel({ id: 'p3', title: 'Line', dataRef: 'sales', config: { graphType: 'Line' } });
  builder.addPanel({ id: 'p4', title: 'Dotplot', dataRef: 'sales', config: { graphType: 'Dotplot' } });
  await builder.whenReady();

  var spec = builder.getSpec();
  assert.equal(Object.keys(spec.panels).length, 4);
  assert.equal(spec.layout.items.length, 4);
  assert.equal(validateSpec(spec).valid, true);

  // The produced spec re-renders as four coordinated instances.
  var created = [];
  function CXStub(id, data, config) { created.push({ id: id, config: config }); }
  var host = document.createElement('div');
  var handle = await renderDashboard(spec, host, { CanvasXpress: CXStub });
  await handle.ready;
  assert.equal(created.length, 4);
  created.forEach(function (c) { assert.equal(c.config.broadcastGroup, 'sales-overview'); });
});
