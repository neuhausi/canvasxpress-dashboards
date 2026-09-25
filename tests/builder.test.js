/**
 * Builder tests: pointer→grid geometry (pure), live-render wiring, the ⚙
 * customizer handoff (config folded back via getConfig), and an end-to-end
 * 4-panel no-code build. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DASHBOARD_SCHEMA_VERSION } from '../src/spec.js';
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

test('csvToCx is null-tolerant: blanks in a numeric column become null, column stays a measure', function () {
  var cx = csvToCx('id,score,note\nA,10,ok\nB,,missing\nC,30,ok');
  assert.deepEqual(cx.y.vars, ['score']);
  assert.deepEqual(cx.y.data, [[10, null, 30]]);
  assert.deepEqual(cx.x.note, ['ok', 'missing', 'ok']);
});

test('csvToCx: one non-numeric value makes the column an annotation; all-blank column too', function () {
  var mixed = csvToCx('id,val\nA,10\nB,oops\nC,30');
  assert.deepEqual(mixed.y.vars, []);
  assert.deepEqual(mixed.x.val, ['10', 'oops', '30']);
  var blank = csvToCx('id,empty\nA,\nB,');
  assert.deepEqual(blank.y.vars, []);
  assert.deepEqual(blank.x.empty, ['', '']);
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

test('adding an image element renders a placeholder cell (no ⚙) and image props', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX(calls)
  });

  builder.addPanel({ id: 'im1', type: 'image', src: '', fit: 'contain' });
  await builder.whenReady();

  var panel = builder.getSpec().panels.im1;
  assert.equal(panel.type, 'image', 'image panel in spec');
  assert.equal(calls.length, 0, 'no CanvasXpress instance for an image');
  assert.ok(container.querySelector('.cxd-image-cell'), 'image cell rendered');
  assert.ok(container.querySelector('.cxd-image-ph'), 'empty src shows a placeholder');
  var tools = [].map.call(container.querySelectorAll('.cxb-tool'), function (t) { return t.textContent; });
  assert.ok(tools.indexOf('⚙') === -1, 'no customize icon on an image');
  assert.ok(tools.indexOf('×') !== -1, 'delete icon present');
  assert.ok(container.querySelector('.cxb-resize'), 'resize handle present (image is resizable)');
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

test('+ Control is disabled until the dashboard has data and a graph panel', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, { spec: blankSpec('d1'), CanvasXpress: makeCX(calls) });
  function controlBtn() {
    return [].filter.call(container.querySelectorAll('button'), function (b) {
      return b.textContent === '+ Control';
    })[0];
  }
  assert.equal(controlBtn().disabled, true, 'disabled on a blank dashboard');

  builder.setSpec(setDataSource(blankSpec('d1'), 'sample', DATA));
  assert.equal(controlBtn().disabled, true, 'still disabled with data but no panel');

  builder.addPanel({ id: 'p1', dataRef: 'sample', config: { graphType: 'Bar' } });
  await builder.whenReady();
  assert.equal(controlBtn().disabled, false, 'enabled once a graph panel exists');
});

test('param-control props render without error and expose the mode selector', async function () {
  installDom();
  var container = document.createElement('div');
  var spec = setDataSource(blankSpec('d1'), 'sales',
    { kind: 'connector', url: '/api/data', query: { region: '$region' } });
  spec.params = { region: { value: null } };
  spec.panels = {}; spec.layout.items = [];
  var builder = createBuilder(container, { spec: spec, CanvasXpress: makeCX([]) });
  builder.addPanel({ id: 'pick', type: 'control', mode: 'param', param: 'region',
    options: ['EMEA', 'APAC'] });
  await builder.whenReady();
  builder.selectPanel('pick');
  // The Action (mode) select and the Param field should be present.
  var selects = container.querySelectorAll('select');
  var hasModeOption = [].some.call(selects, function (s) {
    return [].some.call(s.options || [], function (o) { return o.textContent === 'Query source'; });
  });
  assert.ok(hasModeOption, 'mode selector offers "Query source"');
  assert.equal(builder.getSpec().panels.pick.mode, 'param');
});

test('+ Filters adds a Filters panel over the first source once a graph exists', async function () {
  installDom();
  var container = document.createElement('div');
  var builder = createBuilder(container, { spec: setDataSource(blankSpec('d1'), 'sample', DATA), CanvasXpress: makeCX([]) });
  function filtersBtn() {
    return [].filter.call(container.querySelectorAll('button'), function (b) {
      return b.textContent === '+ Filters';
    })[0];
  }
  assert.equal(filtersBtn().disabled, true, 'disabled before a graph panel exists');
  builder.addPanel({ id: 'p1', dataRef: 'sample', config: { graphType: 'Bar' } });
  await builder.whenReady();
  assert.equal(filtersBtn().disabled, false);
  filtersBtn().dispatchEvent('click');
  await builder.whenReady();
  var panels = builder.getSpec().panels;
  var added = Object.keys(panels).filter(function (id) { return panels[id].type === 'filters'; });
  assert.equal(added.length, 1);
  assert.deepEqual(panels[added[0]], { type: 'filters', title: 'Filters', dataRef: 'sample' });
});

// --- save capture: round-trip guarantee (a load + save with no edits is a no-op) ---

/**
 * A CX stub like the real engine: getConfig() attaches a tick AFTER
 * construction and reports the authored config plus render-derived keys.
 * @param {object[]} made - Collects instances.
 * @returns {function} Constructor.
 */
function lateConfigCX(made) {
  function CX(id, data, config) {
    var self = this;
    self.id = id;
    self.live = Object.assign({}, config, {
      broadcastFilter: false, theme: 'auto', schemaVersion: '1.0', toolbarSize: 'small',
      decorations: config.decorations ? { line: [{ value: 1, id: id + '-decoration-line-0' }] } : undefined
    });
    self.setDimensions = function () {};
    self.destroy = function () {};
    self.updateConfig = function (c) { Object.assign(self.live, c); };
    setTimeout(function () { self.getConfig = function () { return JSON.parse(JSON.stringify(self.live)); }; }, 20);
    made.push(self);
  }
  return CX;
}

/**
 * A one-panel spec with an authored transient key, authored decorations, and
 * a stale serialized filter an older save left behind.
 * @returns {object} Spec.
 */
function captureSpec() {
  var spec = setDataSource(blankSpec('cap'), 'sample', DATA);
  spec.panels = { p1: { dataRef: 'sample', config: {
    graphType: 'Bar', smpTextScaleFontFactor: 0.8, decorations: { line: [{ value: 1 }] },
    filterSmpBy: { Region: ['N'] }
  } } };
  spec.layout.items = [{ panel: 'p1', x: 0, y: 0, w: 6, h: 3 }];
  return spec;
}

test('saving with no edits returns the spec (derived keys never captured, authored kept)', async function () {
  installDom();
  var made = [];
  var container = document.createElement('div');
  var builder = createBuilder(container, { spec: captureSpec(), CanvasXpress: lateConfigCX(made) });
  await builder.whenReady();   // waits for the late getConfig() baseline
  var config = builder.getSpec().panels.p1.config;
  assert.deepEqual(config, { graphType: 'Bar', smpTextScaleFontFactor: 0.8, decorations: { line: [{ value: 1 }] } },
    'no broadcastFilter/theme/schemaVersion/toolbarSize, no stamped decoration ids; the stale filterSmpBy self-heals');
  assert.equal(builder.getSpec().schemaVersion, DASHBOARD_SCHEMA_VERSION, 'saved specs are stamped');
});

test('a real edit (changed since render) is captured, including an authored transient key', async function () {
  installDom();
  var made = [];
  var container = document.createElement('div');
  var builder = createBuilder(container, { spec: captureSpec(), CanvasXpress: lateConfigCX(made) });
  await builder.whenReady();
  made[made.length - 1].updateConfig({ graphType: 'Line', smpTextScaleFontFactor: 1.2, toolbarSize: 'large' });
  var config = builder.getSpec().panels.p1.config;
  assert.equal(config.graphType, 'Line');
  assert.equal(config.smpTextScaleFontFactor, 1.2);
  assert.equal('toolbarSize' in config, false, 'a transient key the author never wrote stays out');
});
