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

test('the panel "Method" toggle sets provenance.show and renders the footer', async function () {
  installDom();
  var container = document.createElement('div');
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX([])
  });
  builder.addPanel({ id: 'p1', title: 'Bar', dataRef: 'sample', config: { graphType: 'Bar' } });
  await builder.whenReady();

  // Find the "Method" checkbox in the selected panel's props and toggle it on
  // (match on the toggle's own label span — the stub doesn't aggregate text).
  var methodCheck = [].filter.call(container.querySelectorAll('.cxb-check'), function (lab) {
    return [].some.call(lab.querySelectorAll('span'), function (s) { return s.textContent === 'Method'; });
  })[0];
  assert.ok(methodCheck, 'Method toggle present for a graph panel');
  var box = methodCheck.querySelector('input');
  box.checked = true;
  box.dispatchEvent('change');
  await builder.whenReady();

  assert.equal(builder.getSpec().panels.p1.provenance.show, true, 'provenance.show set');
  assert.ok(container.querySelector('.cxd-panel-footer'), 'footer rendered after toggle');
});

// ggplot and CanvasXpress-code panels are self-contained, but their props strip carries
// the same Title and Method controls as every other panel (plus the PANEL name).
['ggplot', 'cxcode'].forEach(function (kind) {
  test('a ' + kind + ' panel has the PANEL name, Title and Method controls', async function () {
    installDom();
    var container = document.createElement('div');
    var builder = createBuilder(container, { spec: blankSpec('d1'), CanvasXpress: makeCX([]) });
    var inner = kind === 'ggplot'
      ? { isGGPlot: true, data: [['Id', 'x'], ['a', 1]], geoms: ['GeomPoint'] }
      : { data: { y: { vars: ['a'], smps: ['s'], data: [[1]] } }, config: { graphType: 'Bar' } };
    builder.addPanel({ id: 'p1', type: kind, title: 'Code chart', spec: inner });
    await builder.whenReady();

    function labelled(text) {
      return [].filter.call(container.querySelectorAll('.cxb-check'), function (lab) {
        return [].some.call(lab.querySelectorAll('span'), function (s) { return s.textContent === text; });
      })[0];
    }
    assert.ok(labelled('Title'), 'Title toggle present for a ' + kind + ' panel');
    assert.ok(labelled('Method'), 'Method toggle present for a ' + kind + ' panel');
    assert.ok(container.querySelector('.cxb-tinput'), 'PANEL name field present');

    var box = labelled('Method').querySelector('input');
    box.checked = true;
    box.dispatchEvent('change');
    assert.equal(builder.getSpec().panels.p1.provenance.show, true, 'Method sets provenance.show');
    var title = labelled('Title').querySelector('input');
    title.checked = false;
    title.dispatchEvent('change');
    assert.equal(builder.getSpec().panels.p1.hideTitle, true, 'unticking Title sets hideTitle');
  });
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

// --- toolbar items are enabled only when adding them can succeed ---

/** A builder over `panels` ({id: panel def}) with one data source; returns {builder, container}. */
async function builderWithPanels(panels, extraOptions) {
  installDom();
  var container = document.createElement('div');
  var builder = createBuilder(container, Object.assign({
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX([])
  }, extraOptions || {}));
  Object.keys(panels).forEach(function (id) {
    builder.addPanel(Object.assign({ id: id, title: id }, panels[id]));
  });
  await builder.whenReady();
  return { builder: builder, container: container };
}

var GG_PANEL = { type: 'ggplot', spec: { isGGPlot: true, data: [['Id', 'x'], ['a', 1]], geoms: ['GeomPoint'] } };
var CX_PANEL = { type: 'cxcode', spec: { data: { y: { vars: ['a'], smps: ['s'], data: [[1]] } }, config: { graphType: 'Bar' } } };

test('Transform and Significance are disabled when only ggplot / code panels exist', async function () {
  var ctx = await builderWithPanels({ g1: GG_PANEL, c1: CX_PANEL });
  assert.equal(buttonNamed(ctx.container, 'Transform').disabled, true, 'nothing to transform');
  assert.equal(buttonNamed(ctx.container, 'Significance').disabled, true, 'nothing to bracket (a code panel is not a graph panel)');
  assert.match(buttonNamed(ctx.container, 'Transform').title, /ggplot and code panels/);
  assert.match(buttonNamed(ctx.container, 'Significance').title, /Boxplot, Violin or Bar/);
});

test('Transform needs a data-bound graph panel; Significance needs a Boxplot / Violin / Bar one', async function () {
  var scatter = await builderWithPanels({ p1: { dataRef: 'sample', config: { graphType: 'Scatter2D' } } });
  assert.equal(buttonNamed(scatter.container, 'Transform').disabled, false, 'a scatter panel can be transformed');
  assert.equal(buttonNamed(scatter.container, 'Significance').disabled, true, 'but brackets render only on group charts');

  var box = await builderWithPanels({ p1: { dataRef: 'sample', config: { graphType: 'Boxplot' } } });
  assert.equal(buttonNamed(box.container, 'Transform').disabled, false);
  assert.equal(buttonNamed(box.container, 'Significance').disabled, false, 'a boxplot takes brackets');
});

test('a ggplot panel next to a graph panel does not change the enabled state, and removing the graph panel disables both', async function () {
  var ctx = await builderWithPanels({ p1: { dataRef: 'sample', config: { graphType: 'Bar' } }, g1: GG_PANEL });
  assert.equal(buttonNamed(ctx.container, 'Transform').disabled, false);
  assert.equal(buttonNamed(ctx.container, 'Significance').disabled, false);
  var spec = ctx.builder.getSpec();
  delete spec.panels.p1;
  spec.layout.items = spec.layout.items.filter(function (it) { return it.panel !== 'p1'; });
  ctx.builder.setSpec(spec);
  await ctx.builder.whenReady();
  assert.equal(buttonNamed(ctx.container, 'Transform').disabled, true, 'the last graph panel is gone');
  assert.equal(buttonNamed(ctx.container, 'Significance').disabled, true);
});

// A user's database sources let a query Control start before any graph panel exists; that
// must not leak into a dashboard of ggplot / code panels, which has nothing to drive.
var WITH_DB = { listConnectorSources: function () { return [{ name: 'warehouse', url: '/c/warehouse' }]; } };

test('Control and the FDR slider are disabled in a dashboard of ggplot / code panels, even with database sources', async function () {
  var ctx = await builderWithPanels({ g1: GG_PANEL, c1: CX_PANEL }, WITH_DB);
  await new Promise(function (r) { setTimeout(r, 0); });   // connector list resolves async
  assert.equal(buttonNamed(ctx.container, 'Control').disabled, true, 'nothing for a control to drive');
  assert.match(buttonNamed(ctx.container, 'Control').title, /ggplot and code panels carry their own data/);
  assert.equal(buttonNamed(ctx.container, 'FDR slider').disabled, true, 'no panel can carry brackets to re-filter');
  assert.match(buttonNamed(ctx.container, 'FDR slider').title, /Boxplot, Violin or Bar/);
});

test('Control keeps its database-source start on an empty dashboard; the FDR slider follows Significance', async function () {
  var empty = await builderWithPanels({}, WITH_DB);
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(buttonNamed(empty.container, 'Control').disabled, false, 'a query control can still start from a database source');
  assert.equal(buttonNamed(empty.container, 'FDR slider').disabled, true, 'but there is nothing to re-filter yet');

  var scatter = await builderWithPanels({ p1: { dataRef: 'sample', config: { graphType: 'Scatter2D' } } });
  assert.equal(buttonNamed(scatter.container, 'FDR slider').disabled, true, 'no bracket-able panel');
  var box = await builderWithPanels({ p1: { dataRef: 'sample', config: { graphType: 'Boxplot' } } });
  assert.equal(buttonNamed(box.container, 'FDR slider').disabled, false, 'a boxplot can carry brackets');
  assert.equal(buttonNamed(box.container, 'Control').disabled, false, 'and a control can drive it');
});

test('a code panel next to a data-bound graph panel leaves Control and the FDR slider enabled', async function () {
  var ctx = await builderWithPanels({ p1: { dataRef: 'sample', config: { graphType: 'Bar' } }, g1: GG_PANEL }, WITH_DB);
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(buttonNamed(ctx.container, 'Control').disabled, false, 'the bar panel can be driven');
  assert.equal(buttonNamed(ctx.container, 'FDR slider').disabled, false);
});

test('Code is disabled once the server reports it cannot convert code, enabled when it can', async function () {
  var realFetch = globalThis.fetch;
  try {
    // A server that runs ggplot conversion.
    globalThis.fetch = function (url) {
      var ok = /\/api\/ggplot\/status/.test(url) ? { available: true, canRun: true } : {};
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(ok); } });
    };
    var yes = await builderWithPanels({});
    await new Promise(function (r) { setTimeout(r, 0); });
    assert.equal(buttonNamed(yes.container, 'Code').disabled, false, 'ggplot conversion available');

    // A server with code conversion off (or an old one with no status endpoint).
    globalThis.fetch = function () { return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}); } }); };
    var no = await builderWithPanels({});
    await new Promise(function (r) { setTimeout(r, 0); });
    assert.equal(buttonNamed(no.container, 'Code').disabled, true, 'nothing available → disabled');
    assert.match(buttonNamed(no.container, 'Code').title, /disabled on this server/);
  } finally {
    globalThis.fetch = realFetch;
  }
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
      return b.textContent === 'Control';
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
      return b.textContent === 'Filters';
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

// --- Links dialog + "Join two sources": the no-code path to cross-source marking ---

var CLINICAL_SRC = { kind: 'inline', value: { y: { vars: ['Age'], smps: ['p1', 'p2', 'p3'], data: [[50, 61, 47]] }, x: { Arm: ['A', 'B', 'A'] } } };
var LABS_SRC = { kind: 'inline', value: { y: { vars: ['ALT'], smps: ['d1', 'd2', 'd3', 'd4'], data: [[30, 42, 28, 55]] }, x: { patient: ['p1', 'p1', 'p2', 'p3'] } } };

/**
 * A two-source spec with one graph panel on each source.
 * @returns {object} The spec.
 */
function twoSourceSpec() {
  var s = setDataSource(setDataSource(blankSpec('d1'), 'clinical', CLINICAL_SRC), 'labs', LABS_SRC);
  s.panels = {
    a: { title: 'Clinical', dataRef: 'clinical', config: { graphType: 'Bar' } },
    b: { title: 'Labs', dataRef: 'labs', config: { graphType: 'Bar' } }
  };
  s.layout.items = [{ panel: 'a', x: 0, y: 0, w: 6, h: 4 }, { panel: 'b', x: 6, y: 0, w: 6, h: 4 }];
  return s;
}

/** @returns {Promise<void>} Resolves after pending promise callbacks run. */
function settle() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }

/**
 * The first button under a root with this exact label.
 * @param {object} root - Element to search.
 * @param {string} label - Button text.
 * @returns {object} The button (undefined when absent).
 */
function buttonNamed(root, label) {
  return [].filter.call(root.querySelectorAll('button'), function (b) { return b.textContent === label; })[0];
}

/**
 * Set a select's value and fire its change handler, as a user pick would.
 * @param {object} select - The select.
 * @param {string} value - The value to pick.
 * @returns {void}
 */
function pick(select, value) {
  select.value = value;
  select.dispatchEvent('change');
}

test('🔗 Links is disabled until there are two data sources', async function () {
  installDom();
  var container = document.createElement('div');
  var builder = createBuilder(container, { spec: setDataSource(blankSpec('d1'), 'clinical', CLINICAL_SRC), CanvasXpress: makeCX([]) });
  assert.equal(buttonNamed(container, 'Links').disabled, true, 'one source: nothing to link');
  builder.setSpec(twoSourceSpec());
  await builder.whenReady();
  assert.equal(buttonNamed(container, 'Links').disabled, false, 'two sources: enabled');
});

test('Links dialog: link two sources on a key and pick a marking mode, without JSON', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, { spec: twoSourceSpec(), CanvasXpress: makeCX(calls) });
  await builder.whenReady();
  var before = calls.length;

  buttonNamed(container, 'Links').dispatchEvent('click');
  await settle();
  var modal = document.body.querySelector('.cxb-modal');
  assert.ok(modal, 'the Links dialog opened');
  assert.equal(modal.querySelector('.cxb-links-none').textContent, 'No links yet.');

  // Selects: marking mode, then [source, key] for each side.
  var selects = modal.querySelectorAll('select');
  var modeSel = selects[0], leftKey = selects[2], rightSrc = selects[3], rightKey = selects[4];
  assert.equal(selects[1].value, 'clinical');
  assert.equal(rightSrc.value, 'labs');
  // The right key list offers the row id plus labs' annotation and column.
  var rightKeys = [].map.call(rightKey.options, function (o) { return o.value; });
  assert.deepEqual(rightKeys, ['', 'patient', 'ALT']);

  pick(leftKey, '');           // clinical: row id
  pick(rightKey, 'patient');   // labs: the patient annotation
  buttonNamed(modal, '+ Link').dispatchEvent('click');
  var rows = modal.querySelectorAll('.cxb-links-row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('span').textContent, 'clinical (row id) ↔ labs.patient');

  // Adding the same link again is refused with a readable message.
  buttonNamed(modal, '+ Link').dispatchEvent('click');
  assert.match(modal.querySelector('.cxb-modal-err').textContent, /already linked/);

  pick(modeSel, 'ghost');
  buttonNamed(modal, 'Apply').dispatchEvent('click');
  await builder.whenReady();

  var spec = builder.getSpec();
  assert.deepEqual(spec.relationships, [{ left: 'clinical', right: 'labs', on: { left: 'smps', right: 'patient' } }]);
  assert.equal(spec.markingMode, 'ghost');
  assert.deepEqual(validateSpec(spec).errors, []);
  assert.equal(document.body.querySelector('.cxb-modal'), null, 'dialog closed');
  assert.ok(calls.length > before, 'dashboard rebuilt so the new links take effect');
});

test('Links dialog: removing a link and Cancel leave the spec as it was', async function () {
  installDom();
  var container = document.createElement('div');
  var start = twoSourceSpec();
  start.relationships = [{ left: 'clinical', right: 'labs', on: { left: 'smps', right: 'patient' } }];
  var builder = createBuilder(container, { spec: start, CanvasXpress: makeCX([]) });
  await builder.whenReady();

  buttonNamed(container, 'Links').dispatchEvent('click');
  var modal = document.body.querySelector('.cxb-modal');
  assert.equal(modal.querySelectorAll('.cxb-links-row').length, 1, 'existing link listed');
  buttonNamed(modal.querySelector('.cxb-links-row'), '×').dispatchEvent('click');
  assert.equal(modal.querySelectorAll('.cxb-links-row').length, 0, 'removed from the working copy');
  buttonNamed(modal, 'Cancel').dispatchEvent('click');
  assert.deepEqual(builder.getSpec().relationships, start.relationships, 'Cancel discards the edit');

  buttonNamed(container, 'Links').dispatchEvent('click');
  modal = document.body.querySelector('.cxb-modal');
  buttonNamed(modal.querySelector('.cxb-links-row'), '×').dispatchEvent('click');
  buttonNamed(modal, 'Apply').dispatchEvent('click');
  await builder.whenReady();
  assert.equal(Object.prototype.hasOwnProperty.call(builder.getSpec(), 'relationships'), false, 'Apply removes it');
});

test('+ Data → Join two sources adds a valid join source from pickers', async function () {
  installDom();
  var container = document.createElement('div');
  var builder = createBuilder(container, { spec: twoSourceSpec(), CanvasXpress: makeCX([]) });
  await builder.whenReady();

  buttonNamed(container, 'Data source').dispatchEvent('click');
  await settle();
  var modal = document.body.querySelector('.cxb-modal');
  var typeSel = modal.querySelectorAll('select')[0];
  assert.ok([].some.call(typeSel.options, function (o) { return o.value === 'join'; }), 'join offered');
  pick(typeSel, 'join');

  var joinSelects = modal.querySelector('.cxb-modal-join').querySelectorAll('select');
  pick(joinSelects[0], 'labs');        // left source
  await settle();                       // its key list refills asynchronously
  pick(joinSelects[1], 'patient');     // left key
  pick(joinSelects[2], 'clinical');    // right source (key: row id)
  await settle();
  pick(joinSelects[4], 'left');        // keep every lab draw
  buttonNamed(modal, 'Add').dispatchEvent('click');
  await builder.whenReady();

  var spec = builder.getSpec();
  var added = Object.keys(spec.data).filter(function (ref) { return spec.data[ref].kind === 'join'; });
  assert.equal(added.length, 1);
  assert.deepEqual(spec.data[added[0]], { kind: 'join', left: 'labs', right: 'clinical', on: { left: 'patient', right: 'smps' }, how: 'left' });
  assert.deepEqual(validateSpec(spec).errors, []);
});

// --- ƒx Fields: calculated fields on a source, without JSON ---

/**
 * A CX stub with the engine's static calculated-field API: a formula is valid
 * when every identifier is a known field; applying appends a column of 1s.
 * @param {object[]} calls - Collects constructed instances.
 * @returns {function} The stub constructor.
 */
function makeCalcCX(calls) {
  var CX = makeCX(calls);
  CX.validateCalculatedField = function (formula, names) {
    var ids = (formula.match(/[A-Za-z_]\w*/g) || []);
    var bad = ids.filter(function (id) { return names.indexOf(id) === -1; })[0];
    return bad ? { ok: false, error: 'Unknown field: ' + bad } : { ok: true, references: ids };
  };
  CX.applyCalculatedFields = function (data, defs) {
    var out = { y: { vars: data.y.vars.slice(), smps: data.y.smps, data: data.y.data.slice() }, x: Object.assign({}, data.x || {}) };
    defs.forEach(function (d) {
      var ones = data.y.smps.map(function () { return 1; });
      if (d.target === 'sampleAnnotation' || d.bin) out.x[d.name] = ones;
      else { out.y.vars.push(d.name); out.y.data.push(ones); }
    });
    return { data: out, errors: [] };
  };
  return CX;
}

test('ƒx Fields: add a formula field to a source with live validation, then Apply', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, { spec: twoSourceSpec(), CanvasXpress: makeCalcCX(calls) });
  await builder.whenReady();
  var before = calls.length;

  buttonNamed(container, 'Fields').dispatchEvent('click');
  await settle();
  var modal = document.body.querySelector('.cxb-modal');
  var sourceSel = modal.querySelectorAll('select')[0];
  pick(sourceSel, 'labs');
  await settle();
  var inputs = modal.querySelectorAll('input');
  var name = inputs[0];
  var formula = modal.querySelector('textarea');
  var status = modal.querySelectorAll('.cxb-links-none');

  name.value = 'Double';
  formula.value = 'ALT * Nope';
  formula.dispatchEvent('input');
  assert.match(modal.textContent + [].map.call(status, function (s) { return s.textContent; }).join(' '), /Unknown field: Nope/);
  assert.equal(buttonNamed(modal, '+ Add field').disabled, true, 'invalid formula cannot be added');

  formula.value = 'ALT * 2';
  formula.dispatchEvent('input');
  assert.equal(buttonNamed(modal, '+ Add field').disabled, false);
  buttonNamed(modal, '+ Add field').dispatchEvent('click');
  await settle();
  assert.equal(modal.querySelector('.cxb-links-row').querySelector('span').textContent, 'Double = ALT * 2');

  buttonNamed(modal, 'Apply').dispatchEvent('click');
  await builder.whenReady();
  var spec = builder.getSpec();
  assert.deepEqual(spec.data.labs.calculatedFields, [{ name: 'Double', formula: 'ALT * 2' }]);
  assert.equal(spec.data.clinical.calculatedFields, undefined, 'other sources untouched');
  assert.deepEqual(validateSpec(spec).errors, []);
  assert.ok(calls.length > before, 'rebuilt so panels resolve the new column');
});

test('ƒx Fields: an engine without the static API explains why fields cannot be added', async function () {
  installDom();
  var container = document.createElement('div');
  var builder = createBuilder(container, { spec: twoSourceSpec(), CanvasXpress: makeCX([]) });
  await builder.whenReady();
  buttonNamed(container, 'Fields').dispatchEvent('click');
  await settle();
  var modal = document.body.querySelector('.cxb-modal');
  var texts = [].map.call(modal.querySelectorAll('.cxb-links-none'), function (s) { return s.textContent; }).join(' ');
  assert.match(texts, /needs CanvasXpress\.applyCalculatedFields/);
  assert.equal(buttonNamed(modal, '+ Add field').disabled, true);
  buttonNamed(modal, 'Cancel').dispatchEvent('click');
  assert.equal(builder.getSpec().data.labs.calculatedFields, undefined);
});

// --- ▦ Shape data: a source's pushdown query without JSON ---

test('Shape data: filter, summarize, sort, preview, then Apply writes the pushdown query', async function () {
  installDom();
  var container = document.createElement('div');
  var spec = setDataSource(blankSpec('d1'), 'sales', { kind: 'inline', value: {
    y: { vars: ['amount'], smps: ['r1', 'r2', 'r3', 'r4'], data: [[10, 20, 30, 40]] },
    x: { region: ['EMEA', 'APAC', 'EMEA', 'AMER'] } } });
  spec.panels = { p: { title: 'Sales', dataRef: 'sales', config: { graphType: 'Bar' } } };
  spec.layout.items = [{ panel: 'p', x: 0, y: 0, w: 6, h: 4 }];
  var calls = [];
  var builder = createBuilder(container, { spec: spec, CanvasXpress: makeCX(calls) });
  await builder.whenReady();

  buttonNamed(container, 'Shape data').dispatchEvent('click');
  await settle();
  var modal = document.body.querySelector('.cxb-modal');
  // Selects in order: source, filter column, filter op, result mode, measure fn, measure column, sort.
  var sel = function () { return modal.querySelectorAll('select'); };
  pick(sel()[1], 'region');
  pick(sel()[2], 'in');
  var textInputs = [].filter.call(modal.querySelectorAll('input'), function (i) { return i.type === 'text'; });
  textInputs[0].value = 'EMEA, APAC';
  buttonNamed(modal, '+ Filter').dispatchEvent('click');
  assert.equal(modal.querySelector('.cxb-links-row').querySelector('span').textContent, 'region is one of EMEA, APAC');

  pick(sel()[3], 'summary');
  var groupBox = modal.querySelectorAll('.cxb-modal-fn-inputs')[1];
  var regionBox = [].filter.call(groupBox.querySelectorAll('input'), function (i) { return i.value === 'region'; })[0];
  regionBox.checked = true;
  regionBox.dispatchEvent('change');
  pick(sel()[4], 'sum');
  pick(sel()[5], 'amount');
  textInputs = [].filter.call(modal.querySelectorAll('input'), function (i) { return i.type === 'text'; });
  textInputs[1].value = 'total';
  buttonNamed(modal, '+ Measure').dispatchEvent('click');
  pick(sel()[6], 'total');
  var descBox = [].filter.call(modal.querySelectorAll('input'), function (i) { return i.type === 'checkbox' && !i.value; })[0];
  descBox.checked = true;
  descBox.dispatchEvent('change');

  var statusText = [].map.call(modal.querySelectorAll('.cxb-links-none'), function (s) { return s.textContent; }).join(' | ');
  assert.match(statusText, /✓ 2 rows · total · first: EMEA, APAC/);

  buttonNamed(modal, 'Apply').dispatchEvent('click');
  await builder.whenReady();
  var out = builder.getSpec().data.sales.pushdown;
  assert.deepEqual(out, {
    where: [{ column: 'region', op: 'in', value: ['EMEA', 'APAC'] }],
    groupBy: ['region'],
    measures: [{ fn: 'sum', column: 'amount', as: 'total' }],
    orderBy: [{ column: 'total', desc: true }]
  });
  assert.deepEqual(validateSpec(builder.getSpec()).errors, []);
});

test('undo/redo: a committed edit reverts and reapplies; buttons track the stacks', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX(calls)
  });

  builder.addPanel({ id: 'p1', title: 'Bar', dataRef: 'sample', config: { graphType: 'Bar' } });
  await builder.whenReady();
  // Past the coalescing window, so the second edit is its own history entry.
  await new Promise(function (ok) { setTimeout(ok, 1100); });
  builder.addPanel({ id: 'p2', title: 'Pie', dataRef: 'sample', config: { graphType: 'Pie' } });
  await builder.whenReady();
  assert.ok(builder.getSpec().panels.p2, 'second panel added');

  builder.undo();
  assert.ok(builder.getSpec().panels.p1, 'first panel survives undo');
  assert.equal(builder.getSpec().panels.p2, undefined, 'second panel undone');

  builder.redo();
  assert.ok(builder.getSpec().panels.p2, 'second panel redone');

  builder.undo();
  builder.undo();
  assert.equal(Object.keys(builder.getSpec().panels || {}).length, 0, 'both adds undone');
  builder.undo();   // empty stack: a no-op, never a throw
  var buttons = [].filter.call(container.querySelectorAll('button'), function (b) {
    return b.attributes && (b.attributes['aria-label'] === 'Undo' || b.attributes['aria-label'] === 'Redo');
  });
  assert.equal(buttons.length, 2, 'undo/redo buttons in the toolbar');
  assert.equal(buttons[0].disabled, true, 'undo disabled on an empty stack');
  assert.equal(buttons[1].disabled, false, 'redo enabled after undos');
});

test('rapid commits coalesce into one undo entry (drag/typing bursts)', async function () {
  installDom();
  var container = document.createElement('div');
  var calls = [];
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', DATA),
    CanvasXpress: makeCX(calls)
  });
  // Two commits inside the window = one interaction; undo removes both.
  builder.addPanel({ id: 'p1', dataRef: 'sample', config: { graphType: 'Bar' } });
  builder.addPanel({ id: 'p2', dataRef: 'sample', config: { graphType: 'Pie' } });
  await builder.whenReady();
  builder.undo();
  assert.equal(Object.keys(builder.getSpec().panels || {}).length, 0, 'burst undone as one step');
});

test('data-flow card: a param control shows what it sets, the source it fills and the panels it feeds', async function () {
  installDom();
  var container = document.createElement('div');
  var spec = blankSpec('flow', 'Flow');
  spec.params = { gene: { value: 'TP53', type: 'string' } };
  spec.data = {
    genes: { kind: 'connector', url: '/connectors/api/data?source=gtex-genes' },
    expr: { kind: 'connector', url: '/connectors/api/data?source=gtex-expression', query: { gene: '$gene' } },
    other: { kind: 'inline', value: { y: { vars: ['v'], smps: ['a'], data: [[1]] } } }
  };
  spec.panels = {
    ctl: { type: 'control', mode: 'param', param: 'gene', title: 'Gene', optionsFrom: { dataRef: 'genes', annotation: 'gene' } },
    plot: { title: 'Expression', dataRef: 'expr', config: { graphType: 'Boxplot' } },
    plain: { title: 'Plain', dataRef: 'other', config: { graphType: 'Bar' } }
  };
  spec.layout.items = [{ panel: 'ctl', x: 0, y: 0, w: 4, h: 1 }, { panel: 'plot', x: 0, y: 1, w: 6, h: 3 }, { panel: 'plain', x: 6, y: 1, w: 6, h: 3 }];
  var sqlAsked = [];
  var builder = createBuilder(container, { spec: spec, CanvasXpress: makeCX([]),
    describeConnectorSource: function (n) { sqlAsked.push(n); return Promise.resolve({ sql: 'SELECT 1 WHERE g = :gene' }); } });
  await builder.whenReady();
  function card() { return container.querySelector('.cxb-flow'); }
  // The DOM stub's textContent is the node's own text only; gather descendants'.
  function allText(node) { return (node.textContent || '') + (node.children || []).map(allText).join(' '); }

  builder.selectPanel('ctl');
  var text = allText(card());
  assert.notEqual(card().style.display, 'none', 'card shown for a param control');
  assert.ok(text.indexOf('choices from 🗄 gtex-genes') !== -1, text);
  assert.ok(text.indexOf('$gene = TP53') !== -1, 'current value (spec default before any pick)');
  assert.ok(text.indexOf('🗄 gtex-expression') !== -1 && text.indexOf('database query') !== -1, text);
  assert.ok(text.indexOf('📊 Expression') !== -1, 'the fed panel');
  assert.equal(text.indexOf('Plain'), -1, 'an unrelated panel is not listed');

  builder.selectPanel('plot');
  text = allText(card());
  assert.ok(text.indexOf('🎛 Gene') !== -1 && text.indexOf('$gene') !== -1, 'a fed panel shows the control upstream');

  builder.selectPanel('plain');
  assert.equal(card().style.display, 'none', 'plain inline data: no card');

  builder.selectPanel('ctl');
  card().querySelector('.cxb-flow-close').dispatchEvent('click');
  assert.equal(card().style.display, 'none', 'closed');
  builder.selectPanel('plot');
  builder.selectPanel('ctl');
  assert.notEqual(card().style.display, 'none', 'a close lasts only while that element stays selected');
});


test('Storyboard dialog: steps are snapshotted, edited, reordered and written to the spec; Cancel and an empty list behave', async function () {
  installDom();
  var container = document.createElement('div');
  var start = twoSourceSpec();
  start.params = { 'case': { value: 'p1' } };
  var builder = createBuilder(container, { spec: start, CanvasXpress: makeCX([]) });
  await builder.whenReady();

  buttonNamed(container, 'Storyboard').dispatchEvent('click');
  var modal = document.body.querySelector('.cxb-modal');
  assert.ok(modal, 'the Storyboard dialog opened');
  assert.equal(modal.querySelector('.cxb-links-none').textContent, 'No steps yet.');
  buttonNamed(modal, '+ Step from the current view').dispatchEvent('click');
  buttonNamed(modal, '+ Step from the current view').dispatchEvent('click');
  var rows = modal.querySelectorAll('.cxb-story-row');
  assert.equal(rows.length, 2);
  var first = rows[0].querySelector('input');
  first.value = 'The cohort';
  first.dispatchEvent('input');
  var narration = rows[0].querySelector('textarea');
  narration.value = 'Everyone, before filtering.';
  narration.dispatchEvent('input');
  buttonNamed(rows[1], '↑').dispatchEvent('click');
  buttonNamed(modal, 'Apply').dispatchEvent('click');
  await builder.whenReady();

  var spec = builder.getSpec();
  assert.deepEqual(spec.storyboard.steps.map(function (s) { return s.title; }), ['Step 2', 'The cohort'], 'second step moved up');
  assert.equal(spec.storyboard.steps[1].narration, 'Everyone, before filtering.');
  assert.deepEqual(validateSpec(spec).errors, []);

  buttonNamed(container, 'Storyboard').dispatchEvent('click');
  modal = document.body.querySelector('.cxb-modal');
  assert.equal(modal.querySelectorAll('.cxb-story-row').length, 2, 'the saved steps come back');
  buttonNamed(modal.querySelector('.cxb-story-row'), '×').dispatchEvent('click');
  buttonNamed(modal, 'Cancel').dispatchEvent('click');
  assert.equal(builder.getSpec().storyboard.steps.length, 2, 'Cancel discards the edit');

  buttonNamed(container, 'Storyboard').dispatchEvent('click');
  modal = document.body.querySelector('.cxb-modal');
  buttonNamed(modal.querySelector('.cxb-story-row'), '×').dispatchEvent('click');
  buttonNamed(modal.querySelector('.cxb-story-row'), '×').dispatchEvent('click');
  buttonNamed(modal, 'Apply').dispatchEvent('click');
  await builder.whenReady();
  assert.equal(Object.prototype.hasOwnProperty.call(builder.getSpec(), 'storyboard'), false, 'no steps removes the block');
});

test('Insights dialog: switch on, set a limit in plain words, Apply writes spec.insights; it reloads, validates and switches off', async function () {
  installDom();
  var container = document.createElement('div');
  var builder = createBuilder(container, { spec: twoSourceSpec(), CanvasXpress: makeCX([]) });
  await builder.whenReady();
  assert.equal(builder.getSpec().insights, undefined, 'a new dashboard has no insights');

  buttonNamed(container, 'Insights').dispatchEvent('click');
  await settle(); await settle();
  var modal = document.body.querySelector('.cxb-ins-modal');
  assert.ok(modal, 'the Insights dialog opened');
  var box = modal.querySelector('.cxb-ins-switch').querySelector('input');
  assert.equal(box.checked, false, 'off until switched on');

  box.checked = true;
  box.dispatchEvent('change');
  buttonNamed(modal, '+ Add a limit').dispatchEvent('click');
  var selects = modal.querySelector('.cxb-ins-limit').querySelectorAll('select');
  var measures = [].map.call(selects[0].options, function (o) { return o.textContent; });
  assert.deepEqual(measures.slice(0, 2), ['Age — clinical', 'ALT — labs'], 'the measures of both sources, named by source');
  assert.equal(measures.indexOf('Arm — clinical'), -1, 'a text annotation is not offered as a measure');
  assert.deepEqual([].map.call(selects[1].options, function (o) { return o.textContent; }),
    ['is below', 'is at most', 'is above', 'is at least'], 'the comparison is in plain words');

  // Applying with no number asks for one and stays open.
  buttonNamed(modal, 'Apply').dispatchEvent('click');
  assert.match(modal.querySelector('.cxb-modal-err').textContent, /Type a number/);
  assert.ok(document.body.querySelector('.cxb-ins-modal'), 'still open');

  pick(selects[0], '1');                         // ALT — labs
  pick(selects[1], 'gt');                        // is above
  var inputs = modal.querySelector('.cxb-ins-limit').querySelectorAll('input');
  inputs[0].value = '30'; inputs[0].dispatchEvent('input');
  inputs[1].value = 'ALT too high'; inputs[1].dispatchEvent('input');
  buttonNamed(modal, 'Apply').dispatchEvent('click');
  await builder.whenReady();
  assert.deepEqual(builder.getSpec().insights, { thresholds: [{ field: 'ALT', op: 'gt', value: 30, source: 'labs', label: 'ALT too high' }] });
  assert.deepEqual(validateSpec(builder.getSpec()).errors, []);
  assert.equal(document.body.querySelector('.cxb-ins-modal'), null, 'dialog closed');

  // Reopened, it shows what was saved.
  buttonNamed(container, 'Insights').dispatchEvent('click');
  await settle(); await settle();
  modal = document.body.querySelector('.cxb-ins-modal');
  assert.equal(modal.querySelector('.cxb-ins-switch').querySelector('input').checked, true);
  assert.equal(modal.querySelectorAll('.cxb-ins-limit').length, 1);
  var again = modal.querySelector('.cxb-ins-limit').querySelectorAll('select');
  assert.equal(again[0].value, '1');
  assert.equal(again[1].value, 'gt');
  assert.equal(modal.querySelector('.cxb-ins-limit').querySelectorAll('input')[0].value, '30');

  // Cancel changes nothing; switching off and applying removes the block.
  buttonNamed(modal, 'Cancel').dispatchEvent('click');
  assert.equal(builder.getSpec().insights.thresholds.length, 1, 'Cancel discards');
  buttonNamed(container, 'Insights').dispatchEvent('click');
  await settle(); await settle();
  modal = document.body.querySelector('.cxb-ins-modal');
  var off = modal.querySelector('.cxb-ins-switch').querySelector('input');
  off.checked = false; off.dispatchEvent('change');
  buttonNamed(modal, 'Apply').dispatchEvent('click');
  await builder.whenReady();
  assert.equal(Object.prototype.hasOwnProperty.call(builder.getSpec(), 'insights'), false, 'off removes insights');
});

test('Insights dialog: "how many" and "which data" are written only when they differ from the defaults', async function () {
  installDom();
  var container = document.createElement('div');
  var builder = createBuilder(container, { spec: twoSourceSpec(), CanvasXpress: makeCX([]) });
  await builder.whenReady();
  buttonNamed(container, 'Insights').dispatchEvent('click');
  await settle(); await settle();
  var modal = document.body.querySelector('.cxb-ins-modal');
  var box = modal.querySelector('.cxb-ins-switch').querySelector('input');
  box.checked = true; box.dispatchEvent('change');
  buttonNamed(modal, 'Apply').dispatchEvent('click');
  await builder.whenReady();
  assert.deepEqual(builder.getSpec().insights, {}, 'just on: the automatic checks, nothing else');

  buttonNamed(container, 'Insights').dispatchEvent('click');
  await settle(); await settle();
  modal = document.body.querySelector('.cxb-ins-modal');
  var count = modal.querySelector('.cxb-ins-max').querySelector('input');
  count.value = '3'; count.dispatchEvent('input');
  var sources = modal.querySelectorAll('.cxb-ins-source').map(function (row) { return row.querySelector('input'); });
  assert.equal(sources.length, 2, 'two data sets to choose from');
  sources[1].checked = false; sources[1].dispatchEvent('change');
  buttonNamed(modal, 'Apply').dispatchEvent('click');
  await builder.whenReady();
  assert.deepEqual(builder.getSpec().insights, { sources: ['clinical'], max: 3 });
  assert.deepEqual(validateSpec(builder.getSpec()).errors, []);
});
