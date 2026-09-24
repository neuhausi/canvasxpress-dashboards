/**
 * Renderer smoke tests using a minimal DOM + CanvasXpress stub — no browser.
 * Verifies the grid scaffold, one canvas per layout item + control, and that
 * every instance receives the dashboard's broadcastGroup.
 *
 * Run with `node --test`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard, annotationValues, annotationNames } from '../src/renderDashboard.js';
import { installDom } from './helpers/dom-stub.js';

var SPEC = {
  id: 'sales-overview',
  broadcastGroup: 'grp-sales',
  layout: {
    cols: 12,
    items: [
      { panel: 'bar', x: 0, y: 0, w: 6, h: 3 },
      { panel: 'pie', x: 6, y: 0, w: 6, h: 3 }
    ]
  },
  data: { sales: { kind: 'inline', value: { y: { vars: ['R'], smps: ['A'], data: [[1]] } } } },
  panels: {
    bar: { title: 'Bar', dataRef: 'sales', config: { graphType: 'Bar' } },
    pie: { title: 'Pie', dataRef: 'sales', config: { graphType: 'Pie' } }
  },
  controls: [{ kind: 'table', dataRef: 'sales' }]
};

var created;

/**
 * A CanvasXpress stub recording each instantiation.
 * @param {string} id - Target canvas id.
 * @param {object} data - Resolved data.
 * @param {object} config - Merged config.
 * @returns {void}
 */
function CanvasXpressStub(id, data, config) {
  created.push({ id: id, data: data, config: config });
}

beforeEach(function () {
  installDom();
  created = [];
});

test('renders one canvas per layout item and control, all in the broadcast group', async function () {
  var container = document.createElement('div');
  document.body.appendChild(container);

  var handle = await renderDashboard(SPEC, container, { CanvasXpress: CanvasXpressStub });

  // 2 panels + 1 control = 3 instances.
  assert.equal(created.length, 3);
  assert.equal(handle.instances.length, 3);

  // Every instance got the dashboard broadcastGroup, and the engine's own
  // DataFilter-UI filter broadcast is disabled so it never double-applies with
  // the dashboard's annotation "+ Control" (broadcastFilter defaults true engine-side).
  created.forEach(function (c) {
    assert.equal(c.config.broadcastGroup, 'grp-sales');
    assert.equal(c.config.broadcastFilter, false);
  });

  // Grid is a uniform repeat of 12 equal columns.
  var colTpl = container.querySelector('.cxd-grid').style.gridTemplateColumns;
  assert.equal(colTpl, 'repeat(12, minmax(0, 1fr))');

  // One canvas element per instance exists in the DOM.
  assert.equal(container.querySelectorAll('canvas').length, 3);
});

test('shares a single resolved data object across panels with the same dataRef', async function () {
  var container = document.createElement('div');
  await renderDashboard(SPEC, container, { CanvasXpress: CanvasXpressStub });
  var datas = created.map(function (c) { return c.data; });
  // All three reference the identical inline object (shared fetch/object).
  assert.ok(datas[0] === datas[1] && datas[1] === datas[2]);
});

test('control table defaults to view:"table"', async function () {
  var container = document.createElement('div');
  await renderDashboard(SPEC, container, { CanvasXpress: CanvasXpressStub });
  var control = created[created.length - 1];
  assert.equal(control.config.view, 'table');
});

test('throws on an invalid spec', async function () {
  var container = document.createElement('div');
  await assert.rejects(
    Promise.resolve().then(function () {
      return renderDashboard({ id: 'x' }, container, { CanvasXpress: CanvasXpressStub });
    }),
    /Invalid dashboard spec/
  );
});

test('honors per-panel broadcast:false opt-out', async function () {
  var container = document.createElement('div');
  var spec = JSON.parse(JSON.stringify(SPEC));
  spec.panels.bar.broadcast = false;
  await renderDashboard(spec, container, { CanvasXpress: CanvasXpressStub });
  var bar = created.find(function (c) { return c.config.graphType === 'Bar'; });
  assert.equal(bar.config.broadcast, false);
});

test('background + image + gap padding are applied to the whole container', async function () {
  var container = document.createElement('div');
  var spec = {
    id: 'bg',
    background: '#123456',
    backgroundImage: 'https://x/i.png',
    layout: { gap: 16, items: [{ panel: 'p', x: 0, y: 0, w: 6, h: 3 }] },
    data: { s: { kind: 'inline', value: { y: { vars: ['A'], smps: ['a'], data: [[1]] } } } },
    panels: { p: { dataRef: 's', config: { graphType: 'Bar' } } }
  };
  var handle = await renderDashboard(spec, container, { CanvasXpress: CanvasXpressStub });
  await handle.ready;
  assert.equal(container.style.backgroundColor, '#123456');
  assert.match(container.style.backgroundImage, /url\("https:\/\/x\/i\.png"\)/);
  assert.equal(container.style.backgroundSize, 'cover', 'image covers (fills) without changing aspect ratio');
  assert.equal(container.style.padding, '16px', 'gap becomes an even background margin around the grid');
  // The backdrop fills the available vertical space instead of collapsing to the
  // panels' height (no explicit height set).
  assert.match(container.style.minHeight, /^calc\(100vh - \d+px\)$/, 'background stretches to the viewport bottom');
});

test('a background image without an explicit height stretches to fill; an explicit height wins', async function () {
  var base = {
    id: 'bgh',
    backgroundImage: 'https://x/i.png',
    layout: { items: [{ panel: 'p', x: 0, y: 0, w: 6, h: 3 }] },
    data: { s: { kind: 'inline', value: { y: { vars: ['A'], smps: ['a'], data: [[1]] } } } },
    panels: { p: { dataRef: 's', config: { graphType: 'Bar' } } }
  };
  var auto = document.createElement('div');
  var h1 = await renderDashboard(base, auto, { CanvasXpress: CanvasXpressStub });
  await h1.ready;
  assert.match(auto.style.minHeight, /^calc\(100vh - \d+px\)$/, 'auto height → fill vertical space');

  var fixed = document.createElement('div');
  var h2 = await renderDashboard(Object.assign({ height: 500 }, base), fixed, { CanvasXpress: CanvasXpressStub });
  await h2.ready;
  assert.equal(fixed.style.height, '500px');
  assert.equal(fixed.style.minHeight, '', 'an explicit height suppresses the fill min-height');
});

test('explicit width/height are applied (px) and enable scroll; unset fills', async function () {
  var base = {
    id: 'sz',
    layout: { items: [{ panel: 'p', x: 0, y: 0, w: 6, h: 3 }] },
    data: { s: { kind: 'inline', value: { y: { vars: ['A'], smps: ['a'], data: [[1]] } } } },
    panels: { p: { dataRef: 's', config: { graphType: 'Bar' } } }
  };
  var sized = document.createElement('div');
  var h1 = await renderDashboard(Object.assign({ width: 800, height: 600 }, base), sized, { CanvasXpress: CanvasXpressStub });
  await h1.ready;
  assert.equal(sized.style.width, '800px');
  assert.equal(sized.style.height, '600px');
  assert.equal(sized.style.overflow, 'auto');

  var unsized = document.createElement('div');
  var h2 = await renderDashboard(base, unsized, { CanvasXpress: CanvasXpressStub });
  await h2.ready;
  assert.equal(unsized.style.width, '');
  assert.equal(unsized.style.height, '');
});

test('panel.measures projects the data to the selected numeric columns', async function () {
  var container = document.createElement('div');
  var spec = {
    id: 'proj',
    layout: { items: [{ panel: 'p', x: 0, y: 0, w: 6, h: 3 }] },
    data: { s: { kind: 'inline', value: {
      y: { vars: ['A', 'B', 'C'], smps: ['s1', 's2'], data: [[1, 2], [3, 4], [5, 6]] },
      x: { Region: ['N', 'S'] }
    } } },
    panels: { p: { dataRef: 's', measures: ['C', 'A'], config: { graphType: 'Bar' } } }
  };
  var handle = await renderDashboard(spec, container, { CanvasXpress: CanvasXpressStub });
  await handle.ready;
  assert.equal(created.length, 1);
  // Only C and A survive, in the requested order; rows follow; x preserved.
  assert.deepEqual(created[0].data.y.vars, ['C', 'A']);
  assert.deepEqual(created[0].data.y.data, [[5, 6], [1, 2]]);
  assert.deepEqual(created[0].data.x.Region, ['N', 'S']);
});

// ---- Phase 2: connector data binding ----

var CONNECTOR_DATA = { y: { vars: ['R'], smps: ['A', 'B'], data: [[1, 2]] } };

/**
 * Fake fetch returning the connector payload and counting calls.
 * @param {object} [body] - Payload to return (defaults to CONNECTOR_DATA).
 * @returns {function} fetch stub with a `.calls` array.
 */
function connectorFetch(body) {
  var payload = JSON.stringify(body != null ? body : CONNECTOR_DATA);
  var fn = function () {
    fn.calls++;
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(payload); } });
  };
  fn.calls = 0;
  return fn;
}

var CONNECTOR_SPEC = {
  id: 'live',
  layout: { items: [
    { panel: 'a', x: 0, y: 0, w: 6, h: 3 },
    { panel: 'b', x: 6, y: 0, w: 6, h: 3 }
  ] },
  data: { sales: { kind: 'connector', url: '/api/data?source=sales' } },
  panels: {
    a: { dataRef: 'sales', config: { graphType: 'Bar' } },
    b: { dataRef: 'sales', config: { graphType: 'Pie' } }
  }
};

test('binds panels to connector data and issues one shared request', async function () {
  var container = document.createElement('div');
  var fetchStub = connectorFetch();
  var handle = await renderDashboard(CONNECTOR_SPEC, container, {
    CanvasXpress: CanvasXpressStub, fetch: fetchStub, cache: new Map()
  });
  await handle.ready;
  assert.equal(fetchStub.calls, 1, 'panels sharing a dataRef share one fetch');
  assert.equal(created.length, 2);
  // Panel a (Bar) gets the connector data as is; panel b is a one-column Pie,
  // so its rows become the slices (transposed).
  var bar = created.filter(function (c) { return c.config.graphType === 'Bar'; })[0];
  var pie = created.filter(function (c) { return c.config.graphType === 'Pie'; })[0];
  assert.deepEqual(bar.data, CONNECTOR_DATA);
  assert.deepEqual(pie.data.y, { vars: ['A', 'B'], smps: ['R'], data: [[1], [2]] });
});

test('shows the empty state when a connector returns no rows', async function () {
  var container = document.createElement('div');
  var fetchStub = connectorFetch({ y: { vars: [], smps: [], data: [] } });
  var handle = await renderDashboard(CONNECTOR_SPEC, container, {
    CanvasXpress: CanvasXpressStub, fetch: fetchStub, cache: new Map()
  });
  await handle.ready;
  // No instances created for empty data; cells report the empty state.
  assert.equal(created.length, 0);
  var panels = container.querySelectorAll('.cxd-panel');
  panels.forEach(function (p) { assert.equal(p.attributes['data-state'], 'empty'); });
});

test('shows an error overlay when a connector fetch fails', async function () {
  var container = document.createElement('div');
  var failing = function () {
    return Promise.resolve({ ok: false, status: 500, text: function () {
      return Promise.resolve(JSON.stringify({ detail: 'Database error' }));
    } });
  };
  var handle = await renderDashboard(CONNECTOR_SPEC, container, {
    CanvasXpress: CanvasXpressStub, fetch: failing, cache: new Map()
  });
  await handle.ready;
  assert.equal(created.length, 0);
  var overlay = container.querySelector('.cxd-error');
  assert.ok(overlay);
  assert.match(overlay.textContent, /Database error/);
});

test('scheduled refresh re-fetches and live-updates bound instances', async function () {
  var container = document.createElement('div');
  var fetchStub = connectorFetch();
  var updates = [];
  /**
   * Instance stub recording updateData calls.
   * @param {string} id - Canvas id.
   * @param {object} data - Data.
   * @returns {void}
   */
  function UpdatingStub(id, data) {
    var self = this;
    self.updateData = function (d) { updates.push(d); };
  }
  var spec = JSON.parse(JSON.stringify(CONNECTOR_SPEC));
  spec.data.sales.refresh = 0.02; // 20ms
  var handle = await renderDashboard(spec, container, {
    CanvasXpress: UpdatingStub, fetch: fetchStub, cache: new Map()
  });
  await delay(70); // allow a couple of ticks
  handle.destroy();
  assert.ok(fetchStub.calls >= 2, 'polled the source at least once after initial load');
  assert.ok(updates.length >= 1, 'live-updated bound instances');
});

/**
 * Await a timeout.
 * @param {number} ms - Milliseconds.
 * @returns {Promise<void>} Resolves after ms.
 */
function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

test('annotationValues returns unique values in first-appearance order', function () {
  var data = { y: {}, x: { Tissue: ['Liver', 'Kidney', 'Liver', null, 'Lung'] } };
  assert.deepEqual(annotationValues(data, 'x', 'Tissue'), ['Liver', 'Kidney', 'Lung']);
  assert.deepEqual(annotationValues(data, 'x', 'Missing'), []);
  assert.deepEqual(annotationValues(data, 'z', 'Tissue'), []);
});

test('renders an annotation-filter control panel as a widget, not a graph', async function () {
  var spec = {
    id: 'ann-dash',
    layout: { cols: 12, items: [
      { panel: 'bar', x: 0, y: 0, w: 6, h: 3 },
      { panel: 'ctl', x: 0, y: 0, w: 4, h: 1 }
    ] },
    data: { d: { kind: 'inline', value: {
      y: { vars: ['V1'], smps: ['A', 'B', 'C'], data: [[1, 2, 3]] },
      x: { Tissue: ['Liver', 'Kidney', 'Liver'] }
    } } },
    panels: {
      bar: { title: 'Bar', dataRef: 'd', config: { graphType: 'Bar' } },
      ctl: { type: 'control', title: 'Tissue', dataRef: 'd',
        compartment: 'x', annotation: 'Tissue', style: 'buttons' }
    }
  };
  var container = document.createElement('div');
  var handle = await renderDashboard(spec, container, { CanvasXpress: CanvasXpressStub });
  await handle.ready;

  // Only the graph panel instantiated CanvasXpress.
  assert.equal(created.length, 1);
  // The widget rendered: label + "All" + one button per unique value.
  var widget = container.querySelector('.cxd-annctl');
  assert.ok(widget, 'widget rendered');
  assert.equal(widget.querySelector('.cxd-annctl-label').textContent, 'Tissue');
  var buttons = container.querySelectorAll('.cxd-annctl-segbtn');
  assert.deepEqual(buttons.map(function (b) { return b.textContent; }), ['All', 'Liver', 'Kidney']);
});

test('an unconfigured control shows a hint instead of inputs', async function () {
  var spec = {
    id: 'ann-dash-2',
    layout: { cols: 12, items: [{ panel: 'ctl', x: 0, y: 0, w: 4, h: 1 }] },
    data: { d: { kind: 'inline', value: { y: { vars: ['V1'], smps: ['A'], data: [[1]] } } } },
    panels: { ctl: { type: 'control', dataRef: 'd', compartment: 'x', annotation: '' } }
  };
  var container = document.createElement('div');
  var handle = await renderDashboard(spec, container, { CanvasXpress: CanvasXpressStub });
  await handle.ready;
  assert.ok(container.querySelector('.cxd-annctl-hint'));
  assert.equal(created.length, 0);
});

test('annotationValues/annotationNames understand tabular 2D-array datasets', function () {
  var tab = [
    ['id', 'bill_len', 'species', 'island'],
    ['s1', 39.1, 'Adelie', 'Torgersen'],
    ['s2', 46.5, 'Gentoo', 'Biscoe'],
    ['s3', '', 'Adelie', 'Torgersen']
  ];
  assert.deepEqual(annotationNames(tab, 'x'), ['species', 'island']);
  assert.deepEqual(annotationNames(tab, 'z'), []);
  assert.deepEqual(annotationValues(tab, 'x', 'species'), ['Adelie', 'Gentoo']);
  assert.deepEqual(annotationValues(tab, 'x', 'bill_len'), [39.1, 46.5]);
  assert.deepEqual(annotationValues(tab, 'x', 'missing'), []);
  assert.deepEqual(annotationValues(tab, 'z', 'species'), []);
});

test('a control bound to a tabular dataset renders its value buttons', async function () {
  var spec = {
    id: 'tab-dash',
    layout: { cols: 12, items: [{ panel: 'ctl', x: 0, y: 0, w: 4, h: 1 }] },
    data: { d: { kind: 'inline', value: null } },
    panels: { ctl: { type: 'control', title: 'Species', dataRef: 'd',
      compartment: 'x', annotation: 'species', style: 'buttons' } }
  };
  // Inline sources must be objects per the validator; bypass it and hand the
  // tabular array straight through (as a dataset fetch would).
  spec.data.d.value = [['id', 'species'], ['s1', 'Adelie'], ['s2', 'Gentoo']];
  var container = document.createElement('div');
  var handle = await renderDashboard(spec, container, { CanvasXpress: CanvasXpressStub, validate: false });
  await handle.ready;
  var buttons = container.querySelectorAll('.cxd-annctl-segbtn');
  assert.deepEqual(buttons.map(function (b) { return b.textContent; }), ['All', 'Adelie', 'Gentoo']);
});

test('control label is hidden when hideTitle is set', async function () {
  var spec = {
    id: 'lbl-dash',
    layout: { cols: 12, items: [{ panel: 'ctl', x: 0, y: 0, w: 4, h: 1 }] },
    data: { d: { kind: 'inline', value: {
      y: { vars: ['V'], smps: ['a', 'b'], data: [[1, 2]] }, x: { T: ['p', 'q'] }
    } } },
    panels: { ctl: { type: 'control', title: 'T', hideTitle: true, dataRef: 'd',
      compartment: 'x', annotation: 'T', style: 'buttons' } }
  };
  var container = document.createElement('div');
  var handle = await renderDashboard(spec, container, { CanvasXpress: CanvasXpressStub });
  await handle.ready;
  assert.equal(container.querySelector('.cxd-annctl-label'), null);
  assert.equal(container.querySelectorAll('.cxd-annctl-segbtn').length, 3);
});

test('control auto-detects a variable annotation stored with the wrong compartment', async function () {
  var spec = {
    id: 'comp-dash',
    layout: { cols: 12, items: [{ panel: 'ctl', x: 0, y: 0, w: 4, h: 1 }] },
    data: { d: { kind: 'inline', value: {
      y: { vars: ['V1', 'V2'], smps: ['a'], data: [[1], [2]] },
      z: { Pathway: ['P1', 'P2'] }
    } } },
    panels: { ctl: { type: 'control', dataRef: 'd',
      compartment: 'x', annotation: 'Pathway', style: 'buttons' } }
  };
  var container = document.createElement('div');
  var handle = await renderDashboard(spec, container, { CanvasXpress: CanvasXpressStub });
  await handle.ready;
  var buttons = container.querySelectorAll('.cxd-annctl-segbtn');
  assert.deepEqual(buttons.map(function (b) { return b.textContent; }), ['All', 'P1', 'P2']);
});

test('text and control panels honor align/valign within their cells', async function () {
  var spec = {
    id: 'align-dash',
    layout: { cols: 12, items: [
      { panel: 't', x: 0, y: 0, w: 4, h: 2 },
      { panel: 'c', x: 4, y: 0, w: 4, h: 2 }
    ] },
    data: { d: { kind: 'inline', value: {
      y: { vars: ['V'], smps: ['a', 'b'], data: [[1, 2]] }, x: { T: ['p', 'q'] }
    } } },
    panels: {
      t: { type: 'text', text: 'Hi', align: 'center', valign: 'bottom' },
      c: { type: 'control', dataRef: 'd', annotation: 'T', style: 'buttons',
           align: 'right', valign: 'middle' }
    }
  };
  var container = document.createElement('div');
  var handle = await renderDashboard(spec, container, { CanvasXpress: CanvasXpressStub });
  await handle.ready;

  var textBody = container.querySelector('.cxd-text').parentNode;
  assert.equal(textBody.style.alignItems, 'center');
  assert.equal(textBody.style.justifyContent, 'flex-end');
  assert.equal(container.querySelector('.cxd-text').style.textAlign, 'center');

  var ctlBody = container.querySelector('.cxd-annctl').parentNode;
  assert.equal(ctlBody.style.alignItems, 'flex-end');
  assert.equal(ctlBody.style.justifyContent, 'center');
});

test('a param control re-queries the source and live-updates bound panels', async function () {
  // A CX stub whose instances record updateData(...) calls.
  var live = [];
  function LiveCX(id, data, config) {
    var inst = { id: id, data: data, config: config, updates: [] };
    inst.updateData = function (d) { inst.updates.push(d); };
    live.push(inst);
    return inst;
  }

  // fetch returns data tagged with the region query param so we can prove the
  // bound panel received the re-queried data.
  function paramFetch(url) {
    var m = /region=([^&]+)/.exec(url);
    var region = m ? decodeURIComponent(m[1]) : 'none';
    var body = JSON.stringify({ y: { vars: ['R'], smps: [region], data: [[1]] } });
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(body); } });
  }

  var spec = {
    id: 'live',
    params: { region: { value: null, type: 'string' } },
    layout: { cols: 12, items: [
      { panel: 'pick', x: 0, y: 0, w: 3, h: 1 },
      { panel: 'bar', x: 0, y: 1, w: 6, h: 3 }
    ] },
    data: { sales: { kind: 'connector', url: '/api/data', query: { region: '$region' }, ttl: 0 } },
    panels: {
      pick: { type: 'control', mode: 'param', param: 'region', style: 'dropdown', options: ['EMEA', 'APAC'] },
      bar: { dataRef: 'sales', config: { graphType: 'Bar' } }
    }
  };

  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(spec, container, { CanvasXpress: LiveCX, fetch: paramFetch });
  await handle.ready;

  assert.equal(live.length, 1, 'one bound bar instance');
  var bar = live[0];
  assert.equal(bar.updates.length, 0, 'no update before a selection');

  // Pick EMEA (option index 1: [All, EMEA, APAC]) and fire change.
  var select = container.querySelector('.cxd-annctl-select');
  assert.ok(select, 'param control renders a dropdown');
  select.value = '1';
  select.dispatchEvent('change');
  await new Promise(function (r) { setTimeout(r, 0); });

  assert.equal(bar.updates.length, 1, 'bound panel live-updated once');
  assert.equal(bar.updates[0].y.smps[0], 'EMEA', 'panel got EMEA-scoped data');
});

test('a param control sources its choices from optionsFrom (a distinct-values query)', async function () {
  var live = [];
  function LiveCX(id, data, config) {
    var inst = { id: id, data: data, config: config, updates: [] };
    inst.updateData = function (d) { inst.updates.push(d); };
    live.push(inst);
    return inst;
  }
  // regions source lists the choices; sales source is what the param queries.
  function routeFetch(url) {
    var body;
    if (/source=regions/.test(url)) {
      body = JSON.stringify({ y: { vars: ['V'], smps: ['s1', 's2'], data: [[1, 2]] },
        x: { region: ['EMEA', 'APAC'] } });
    } else {
      var m = /region=([^&]+)/.exec(url);
      body = JSON.stringify({ y: { vars: ['R'], smps: [m ? m[1] : 'none'], data: [[1]] } });
    }
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(body); } });
  }
  var spec = {
    id: 'live2',
    params: { region: { value: null } },
    layout: { cols: 12, items: [
      { panel: 'pick', x: 0, y: 0, w: 3, h: 1 },
      { panel: 'bar', x: 0, y: 1, w: 6, h: 3 }
    ] },
    data: {
      regions: { kind: 'connector', url: '/api/data?source=regions' },
      sales: { kind: 'connector', url: '/api/data?source=sales', query: { region: '$region' }, ttl: 0 }
    },
    panels: {
      pick: { type: 'control', mode: 'param', param: 'region', style: 'dropdown',
              optionsFrom: { dataRef: 'regions', annotation: 'region', compartment: 'x' } },
      bar: { dataRef: 'sales', config: { graphType: 'Bar' } }
    }
  };
  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(spec, container, { CanvasXpress: LiveCX, fetch: routeFetch });
  await handle.ready;

  var select = container.querySelector('.cxd-annctl-select');
  assert.ok(select, 'dropdown rendered from optionsFrom');
  // Options: All, EMEA, APAC (3 <option> children).
  assert.equal(select.children.length, 3, 'All + two region choices');
});

test('a search param control applies typed text to the parameter (debounced)', async function () {
  var live = [];
  function LiveCX(id, data, config) {
    var inst = { id: id, data: data, config: config, updates: [] };
    inst.updateData = function (d) { inst.updates.push(d); };
    live.push(inst);
    return inst;
  }
  function q(url) {
    var m = /q=([^&]+)/.exec(url);
    var body = JSON.stringify({ y: { vars: ['R'], smps: [m ? decodeURIComponent(m[1]) : 'all'], data: [[1]] } });
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(body); } });
  }
  var spec = {
    id: 'search',
    params: { term: { value: null } },
    layout: { cols: 12, items: [
      { panel: 'box', x: 0, y: 0, w: 3, h: 1 },
      { panel: 'bar', x: 0, y: 1, w: 6, h: 3 }
    ] },
    data: { rows: { kind: 'connector', url: '/api/data', query: { q: '$term' }, ttl: 0 } },
    panels: {
      box: { type: 'control', mode: 'param', param: 'term', style: 'search', debounce: 0 },
      bar: { dataRef: 'rows', config: { graphType: 'Bar' } }
    }
  };
  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(spec, container, { CanvasXpress: LiveCX, fetch: q });
  await handle.ready;

  var input = container.querySelector('.cxd-annctl-search');
  assert.ok(input, 'search box rendered');
  input.value = 'acme';
  input.dispatchEvent('input');
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(live[0].updates.length, 1, 'bound panel updated once');
  assert.equal(live[0].updates[0].y.smps[0], 'acme');
});

test('clicking a mark sets a dashboard param (cross-filter) and refreshes bound panels', async function () {
  var made = [];
  function ClickCX(id, data, config, events) {
    var inst = { id: id, data: data, config: config, events: events, updates: [] };
    inst.updateData = function (d) { inst.updates.push(d); };
    made.push(inst);
    return inst;
  }
  function q(url) {
    var m = /region=([^&]+)/.exec(url);
    var body = JSON.stringify({ y: { vars: ['R'], smps: [m ? decodeURIComponent(m[1]) : 'all'], data: [[1]] } });
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(body); } });
  }
  var spec = {
    id: 'xfilter',
    params: { region: { value: null } },
    layout: { cols: 12, items: [
      { panel: 'src', x: 0, y: 0, w: 6, h: 3 },
      { panel: 'dst', x: 6, y: 0, w: 6, h: 3 }
    ] },
    data: {
      all: { kind: 'inline', value: { y: { vars: ['R'], smps: ['EMEA', 'APAC'], data: [[1, 2]] } } },
      detail: { kind: 'connector', url: '/api/data', query: { region: '$region' }, ttl: 0 }
    },
    panels: {
      src: { dataRef: 'all', clickParam: 'region', config: { graphType: 'Bar' } },
      dst: { dataRef: 'detail', config: { graphType: 'Bar' } }
    }
  };
  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(spec, container, { CanvasXpress: ClickCX, fetch: q });
  await handle.ready;

  var src = made.find(function (m) { return m.config.graphType === 'Bar' && m.events && typeof m.events.click === 'function'; });
  assert.ok(src, 'source panel got a click handler');
  var dst = made.find(function (m) { return m.id !== src.id; });
  assert.equal(dst.updates.length, 0);

  // Simulate a CanvasXpress click on the "EMEA" sample.
  src.events.click({ y: { smps: ['EMEA'] } }, {}, null);
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(dst.updates.length, 1, 'the other panel re-queried on click');
  assert.equal(dst.updates[0].y.smps[0], 'EMEA');
});

// --- kind:"join" sources ---

/**
 * A fetch stub serving a region-scoped "sales" source and a static "clin"
 * source, counting calls per source.
 * @returns {function} fetch stub with `.calls` = { sales, clin }.
 */
function blendFetch() {
  var fn = function (url) {
    var body;
    if (/source=clin/.test(url)) {
      fn.calls.clin++;
      body = { y: { vars: ['Dose'], smps: ['EMEA', 'APAC', 'none'], data: [[1, 2, 3]] }, x: { Arm: ['drug', 'placebo', 'drug'] } };
    } else {
      fn.calls.sales++;
      var m = /region=([^&]+)/.exec(url);
      body = { y: { vars: ['R'], smps: [m ? decodeURIComponent(m[1]) : 'none'], data: [[fn.calls.sales]] } };
    }
    var text = JSON.stringify(body);
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(text); } });
  };
  fn.calls = { sales: 0, clin: 0 };
  return fn;
}

var BLEND_SPEC = {
  id: 'blend',
  params: { region: { value: null, type: 'string' } },
  layout: { cols: 12, items: [
    { panel: 'pick', x: 0, y: 0, w: 3, h: 1 },
    { panel: 'raw', x: 0, y: 1, w: 6, h: 3 },
    { panel: 'joined', x: 6, y: 1, w: 6, h: 3 }
  ] },
  data: {
    sales: { kind: 'connector', url: '/api/data?source=sales', query: { region: '$region' } },
    clin: { kind: 'connector', url: '/api/data?source=clin' },
    blend: { kind: 'join', left: 'sales', right: 'clin', how: 'left' }
  },
  panels: {
    pick: { type: 'control', mode: 'param', param: 'region', style: 'dropdown', options: ['EMEA', 'APAC'] },
    raw: { dataRef: 'sales', config: { graphType: 'Bar' } },
    joined: { dataRef: 'blend', config: { graphType: 'Bar' } }
  }
};

/**
 * CX stub whose instances record `updateData` calls.
 * @param {object[]} live - Array collecting the instances.
 * @returns {function} Constructor.
 */
function recordingCX(live) {
  return function (id, data, config) {
    var inst = { id: id, data: data, config: config, updates: [] };
    inst.updateData = function (d) { inst.updates.push(d); };
    live.push(inst);
    return inst;
  };
}

test('a join panel renders the blended data and shares its inputs\' fetches', async function () {
  var live = [];
  var fetchStub = blendFetch();
  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(BLEND_SPEC, container, {
    CanvasXpress: recordingCX(live), fetch: fetchStub, cache: new Map()
  });
  await handle.ready;
  assert.deepEqual(fetchStub.calls, { sales: 1, clin: 1 }, 'the join reused the raw panel\'s sales fetch');
  var joined = live.filter(function (i) { return i.data.y.vars.length === 2; })[0];
  assert.ok(joined, 'join panel rendered');
  assert.deepEqual(joined.data.y.vars, ['R', 'Dose']);
  assert.deepEqual(joined.data.x, { Arm: ['drug'] });
  handle.destroy();
});

test('a param change re-queries the input and live-updates the join panel too', async function () {
  var live = [];
  var fetchStub = blendFetch();
  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(BLEND_SPEC, container, {
    CanvasXpress: recordingCX(live), fetch: fetchStub, cache: new Map()
  });
  await handle.ready;

  var select = container.querySelector('.cxd-annctl-select');
  select.value = '2';   // [All, EMEA, APAC] -> APAC
  select.dispatchEvent('change');
  await delay(0);
  await delay(0);

  assert.equal(fetchStub.calls.sales, 2, 'sales re-queried once (shared by raw + join)');
  var raw = live[0];
  var joined = live[1];
  assert.equal(raw.updates.length, 1);
  assert.equal(raw.updates[0].y.smps[0], 'APAC');
  assert.equal(joined.updates.length, 1, 'join panel live-updated');
  assert.deepEqual(joined.updates[0].y.smps, ['APAC']);
  assert.deepEqual(joined.updates[0].y.data, [[2], [2]]);
  assert.deepEqual(joined.updates[0].x, { Arm: ['placebo'] });
  handle.destroy();
});

test('a scheduled refresh of an input recomputes the join panel', async function () {
  var live = [];
  var fetchStub = blendFetch();
  var spec = JSON.parse(JSON.stringify(BLEND_SPEC));
  spec.data.sales.refresh = 0.02; // 20ms
  var container = document.createElement('div');
  var handle = await renderDashboard(spec, container, {
    CanvasXpress: recordingCX(live), fetch: fetchStub, cache: new Map()
  });
  await handle.ready;
  await delay(70);
  handle.destroy();
  var joined = live[1];
  assert.ok(joined.updates.length >= 1, 'join panel updated after the input refreshed');
  var last = joined.updates[joined.updates.length - 1];
  assert.deepEqual(last.y.vars, ['R', 'Dose']);
  assert.ok(last.y.data[0][0] >= 2, 'join carries the refreshed sales value');
  assert.equal(fetchStub.calls.clin, 1, 'the unrefreshed input is not refetched');
});

// --- cross-source marking & filtering (spec.relationships) ---

var REL_SPEC = {
  id: 'rel',
  layout: { cols: 12, items: [
    { panel: 'expr', x: 0, y: 0, w: 4, h: 3 },
    { panel: 'clin', x: 4, y: 0, w: 4, h: 3 },
    { panel: 'genes', x: 8, y: 0, w: 4, h: 3 },
    { panel: 'arm', x: 0, y: 3, w: 3, h: 1 }
  ] },
  relationships: [
    { left: 'expr', right: 'clin', on: { left: 'smps', right: 'patient_id' } },
    { left: 'expr', right: 'genes', on: { left: 'Top', right: 'vars' } }
  ],
  data: {
    expr: { kind: 'inline', value: { y: { vars: ['GeneA'], smps: ['p1', 'p2', 'p3'], data: [[1, 2, 3]] }, x: { Top: ['TP53', 'EGFR', 'MYC'] } } },
    clin: { kind: 'inline', value: { y: { vars: ['Age'], smps: ['c1', 'c2', 'c3', 'c4'], data: [[61, 55, 70, 48]] },
      x: { patient_id: ['p3', 'p1', 'p2', 'p2'], Arm: ['drug', 'placebo', 'drug', 'placebo'] } } },
    genes: { kind: 'inline', axis: 'vars', value: { y: { vars: ['TP53', 'EGFR', 'MYC'], smps: ['logFC', 'P'], data: [[1, 2], [3, 4], [5, 6]] } } }
  },
  panels: {
    expr: { dataRef: 'expr', config: { graphType: 'Bar' } },
    clin: { dataRef: 'clin', config: { graphType: 'Bar', highlightSmp: ['c1'] } },
    genes: { dataRef: 'genes', config: { graphType: 'Scatter2D' } },
    arm: { type: 'control', mode: 'filter', dataRef: 'clin', compartment: 'x', annotation: 'Arm', style: 'dropdown' }
  }
};

/**
 * CX stub exposing what marking/filtering touch: data, events, highlight
 * config, draw(), and the filter API — all recorded.
 * @param {object[]} live - Array collecting the instances.
 * @returns {function} Constructor (with a static `selector`).
 */
function markingCX(live) {
  function MarkCX(id, data, config, events) {
    var inst = {
      id: id, data: data, config: config, events: events || {}, draws: 0, filters: [],
      highlightSmp: config.highlightSmp || [], highlightVar: config.highlightVar || [], highlightMode: 'highlight'
    };
    inst.draw = function () { inst.draws++; };
    inst.resetDataFilter = function () { inst.filters.push(['reset']); };
    inst.modifyFilter = function (type, annotation, op, value) { inst.filters.push(['annotation', annotation, value]); };
    inst.filterUserData = function (target, ns, op, values) { inst.filters.push([target, values]); };
    live.push(inst);
    return inst;
  }
  MarkCX.selector = { smps: {}, vars: {} };
  return MarkCX;
}

/**
 * Find the stub instance bound to a panel id.
 * @param {object[]} live - Instances.
 * @param {string} panel - Panel id.
 * @returns {object} The instance.
 */
function panelInst(live, panel) {
  return live.filter(function (i) { return i.id.indexOf('-panel-' + panel + '-') !== -1; })[0];
}

test('a selection marks the related rows of panels on related sources', async function () {
  var live = [];
  var CX = markingCX(live);
  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(REL_SPEC, container, { CanvasXpress: CX });
  await handle.ready;
  var expr = panelInst(live, 'expr');
  var clin = panelInst(live, 'clin');
  var genes = panelInst(live, 'genes');
  assert.equal(typeof expr.events.select, 'function', 'bound panels get a select hook');

  // The engine's selector holds p2 (a Bar click); the engine then fires select.
  CX.selector = { smps: { p2: true }, vars: { GeneA: true } };
  expr.events.select.call(expr, {});
  await delay(0);
  assert.deepEqual(clin.highlightSmp, ['c3', 'c4']);
  assert.equal(clin.highlightMode, 'focus');
  assert.deepEqual(genes.highlightVar, ['EGFR']);
  assert.deepEqual(genes.highlightSmp, []);
  assert.ok(clin.draws >= 1 && genes.draws >= 1, 'marked panels redrawn');
  assert.deepEqual(expr.highlightSmp, [], 'the origin keeps its native selection');

  // An empty selection (Esc / click on empty space) restores every panel.
  CX.selector = { smps: {}, vars: {} };
  expr.events.select.call(expr, {});
  await delay(0);
  assert.deepEqual(clin.highlightSmp, ['c1'], 'author highlight restored');
  assert.equal(clin.highlightMode, 'highlight');
  assert.deepEqual(genes.highlightVar, []);
  handle.destroy();
});

test('a selection with no related rows dims the related panel entirely', async function () {
  var live = [];
  var CX = markingCX(live);
  var container = document.createElement('div');
  var spec = JSON.parse(JSON.stringify(REL_SPEC));
  spec.markingMode = 'ghost';
  // No clinical row points at p1 any more.
  spec.data.clin.value.x.patient_id = ['p3', 'p9', 'p2', 'p2'];
  var handle = await renderDashboard(spec, container, { CanvasXpress: CX });
  await handle.ready;
  var clin = panelInst(live, 'clin');
  var genes = panelInst(live, 'genes');
  var expr = panelInst(live, 'expr');
  // Mark TP53 (KRAS is not a row of genes and is ignored): TP53 -> p1 -> no clin row.
  CX.selector = { smps: {}, vars: { KRAS: true, TP53: true } };
  genes.events.select.call(genes, {});
  await delay(0);
  assert.deepEqual(expr.highlightSmp, ['p1']);
  assert.equal(expr.highlightMode, 'ghost', 'spec.markingMode applies');
  assert.equal(clin.highlightSmp.length, 1);
  assert.ok(clin.data.y.smps.indexOf(clin.highlightSmp[0]) === -1, 'a name no row carries: everything dimmed');
  handle.destroy();
});

test('a filter pick narrows panels on related sources that lack the annotation', async function () {
  var live = [];
  var CX = markingCX(live);
  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(REL_SPEC, container, { CanvasXpress: CX });
  await handle.ready;
  var expr = panelInst(live, 'expr');
  var clin = panelInst(live, 'clin');
  var genes = panelInst(live, 'genes');
  [expr, clin, genes].forEach(function (i) { i.filters = []; });

  var select = container.querySelector('.cxd-annctl-select');
  select.value = '1';   // [All, drug, placebo] -> drug (c1 -> p3, c3 -> p2)
  select.dispatchEvent('change');
  await delay(0);

  assert.deepEqual(clin.filters.slice(1), [['annotation', 'Arm', 'drug']], 'native annotation filter');
  assert.deepEqual(expr.filters.slice(1), [['filterSmpBy', ['p2', 'p3']]], 'related samples kept');
  assert.deepEqual(genes.filters.slice(1), [['filterVarBy', ['EGFR', 'MYC']]], 'two hops, variables axis');

  select.value = '0';   // All
  select.dispatchEvent('change');
  await delay(0);
  assert.deepEqual(expr.filters[expr.filters.length - 1], ['reset'], 'All clears the related filter');
  handle.destroy();
});

// --- Filters panel (type:"filters") + filter schemes ---

/**
 * REL_SPEC plus a Filters panel over clin and a declared scheme.
 * @returns {object} Spec.
 */
function filtersSpec() {
  var spec = JSON.parse(JSON.stringify(REL_SPEC));
  delete spec.panels.arm;
  spec.layout.items = spec.layout.items.filter(function (it) { return it.panel !== 'arm'; });
  spec.layout.items.push({ panel: 'filters', x: 0, y: 3, w: 3, h: 4 });
  spec.panels.filters = { type: 'filters', dataRef: 'clin', fields: ['Arm', 'Age'] };
  spec.filterSchemes = { 'Drug arm': [{ dataRef: 'clin', field: 'Arm', values: ['drug'] }] };
  return spec;
}

/**
 * The checkbox for one value in a Filters panel.
 * @param {HTMLElement} container - Dashboard container.
 * @param {string} value - Value.
 * @returns {object} The checkbox element.
 */
function valueBox(container, value) {
  return container.querySelectorAll('.cxd-filters-cb').filter(function (b) { return b.value === value; })[0];
}

test('a Filters panel filters its source and, through relationships, the others', async function () {
  var live = [];
  var CX = markingCX(live);
  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(filtersSpec(), container, { CanvasXpress: CX });
  await handle.ready;
  var expr = panelInst(live, 'expr');
  var clin = panelInst(live, 'clin');
  var genes = panelInst(live, 'genes');
  assert.deepEqual(container.querySelectorAll('.cxd-filters-label').map(function (l) { return l.textContent; }), ['Arm', 'Age']);
  assert.equal(container.querySelector('.cxd-panel-title').textContent, 'Filters', 'default title');
  [expr, clin, genes].forEach(function (i) { i.filters = []; });

  var placebo = valueBox(container, 'placebo');
  placebo.checked = false;
  placebo.dispatchEvent('change');
  assert.deepEqual(handle.getFilterState(), [{ dataRef: 'clin', field: 'Arm', values: ['drug'] }]);
  assert.deepEqual(clin.filters.slice(1), [['filterSmpBy', ['c1', 'c3']]], 'own source: row filter');
  assert.deepEqual(expr.filters.slice(1), [['filterSmpBy', ['p2', 'p3']]], 'related source, in its row order');
  assert.deepEqual(genes.filters.slice(1), [['filterVarBy', ['EGFR', 'MYC']]], 'two hops');

  // Narrow further with a range: Age >= 65 keeps c3 (70) only.
  var min = container.querySelector('.cxd-filters-min');
  min.value = '65';
  min.dispatchEvent('change');
  assert.deepEqual(clin.filters[clin.filters.length - 1], ['filterSmpBy', ['c3']]);
  assert.deepEqual(expr.filters[expr.filters.length - 1], ['filterSmpBy', ['p2']]);

  // Reset clears the state and every panel's filter.
  container.querySelector('.cxd-filters-reset').dispatchEvent('click');
  assert.deepEqual(handle.getFilterState(), []);
  assert.deepEqual(expr.filters[expr.filters.length - 1], ['reset']);
  assert.equal(valueBox(container, 'placebo').checked, true, 'panel repainted');
  handle.destroy();
});

test('filter schemes: pick a declared scheme, save the current state as a new one', async function () {
  var live = [];
  var CX = markingCX(live);
  var saved = null;
  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(filtersSpec(), container, {
    CanvasXpress: CX, onFilterSchemesChange: function (s) { saved = s; }
  });
  await handle.ready;

  var scheme = container.querySelector('.cxd-filters-scheme');
  scheme.value = 'Drug arm';
  scheme.dispatchEvent('change');
  assert.deepEqual(handle.getFilterState(), [{ dataRef: 'clin', field: 'Arm', values: ['drug'] }]);
  assert.equal(valueBox(container, 'placebo').checked, false, 'scheme shown in the panel');

  container.querySelector('.cxd-filters-scheme-name').value = 'Old drug';
  var min = container.querySelector('.cxd-filters-min');
  min.value = '65';
  min.dispatchEvent('change');
  container.querySelector('.cxd-filters-save').dispatchEvent('click');
  assert.deepEqual(saved['Old drug'], [
    { dataRef: 'clin', field: 'Arm', values: ['drug'] },
    { dataRef: 'clin', field: 'Age', min: 65 }
  ]);
  assert.deepEqual(Object.keys(handle.getFilterSchemes()), ['Drug arm', 'Old drug']);
  assert.equal(container.querySelector('.cxd-filters-scheme').value, 'Old drug');

  // setFilterState restores a view programmatically and repaints the panel.
  handle.setFilterState([{ dataRef: 'clin', field: 'Arm', values: ['placebo'] }]);
  assert.equal(valueBox(container, 'drug').checked, false);
  assert.equal(container.querySelector('.cxd-filters-min').value, '');
  handle.destroy();
});

// --- kind:"function" sources ---

test('a function panel re-runs when its $param arg or an input changes', async function () {
  var live = [];
  var runs = [];
  function fetchStub(url, init) {
    var text;
    if (/functions\/run/.test(url)) {
      var body = JSON.parse(init.body);
      runs.push(body);
      text = JSON.stringify({ data: { y: { vars: ['k'], smps: [String(body.params.k)], data: [[body.inputs.sales.data.y.data[0][0]]] } } });
    } else {
      var m = /region=([^&]+)/.exec(url);
      text = JSON.stringify({ y: { vars: ['R'], smps: ['s'], data: [[m ? m[1].length : 0]] } });
    }
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(text); } });
  }
  var spec = {
    id: 'fn',
    params: { k: { value: 1 }, region: { value: null } },
    layout: { cols: 12, items: [{ panel: 'out', x: 0, y: 0, w: 6, h: 3 }] },
    data: {
      sales: { kind: 'connector', url: '/api/data?source=sales', query: { region: '$region' } },
      scored: { kind: 'function', language: 'python', code: 'result = sales', inputs: ['sales'], args: { k: '$k' } }
    },
    panels: { out: { dataRef: 'scored', config: { graphType: 'Bar' } } }
  };
  var container = document.createElement('div');
  var handle = await renderDashboard(spec, container, { CanvasXpress: recordingCX(live), fetch: fetchStub, cache: new Map() });
  await handle.ready;
  assert.equal(runs.length, 1);
  assert.deepEqual(live[0].data.y.smps, ['1']);

  await handle.setParam('k', 5);            // an arg of the function
  assert.equal(runs.length, 2);
  assert.deepEqual(live[0].updates[0].y.smps, ['5']);

  await handle.setParam('region', 'EMEA');  // re-queries its input, then re-runs it
  assert.equal(runs.length, 3);
  assert.deepEqual(live[0].updates[1].y.data, [[4]]);
  handle.destroy();
});

// --- transpose: one point per table row for scatter / KaplanMeier ---

import { shouldTranspose } from '../src/renderDashboard.js';

var TABLE = { y: { vars: ['time', 'event', 'biomarker'], smps: ['p1', 'p2', 'p3'], data: [[5, 9, 3], [1, 0, 1], [2.4, 3.1, 1.8]] }, x: { arm: ['a', 'b', 'a'] } };

test('shouldTranspose: automatic for scatter-type axes naming only variables; explicit wins', function () {
  var scatter = { config: { graphType: 'Scatter2D', xAxis: ['time'], yAxis: ['biomarker'] } };
  assert.equal(shouldTranspose(scatter, TABLE), true);
  assert.equal(shouldTranspose({ config: { graphType: 'KaplanMeier', xAxis: ['time'], yAxis: ['event'] } }, TABLE), true);
  assert.equal(shouldTranspose({ config: { graphType: 'Scatter2D', xAxis: ['p1'], yAxis: ['p2'] } }, TABLE), false, 'CX-native: axes are samples');
  assert.equal(shouldTranspose({ config: { graphType: 'Bar', xAxis: ['time'] } }, TABLE), false, 'not a scatter type');
  assert.equal(shouldTranspose({ config: { graphType: 'Scatter2D' } }, TABLE), false, 'no axes named');
  assert.equal(shouldTranspose(Object.assign({ transpose: false }, scatter), TABLE), false);
  assert.equal(shouldTranspose({ transpose: true, config: { graphType: 'Bar' } }, TABLE), true);
  assert.equal(shouldTranspose({ config: { graphType: 'Pie', xAxis: ['biomarker'] } }, TABLE), true, 'a pie of one column: one slice per row');
  assert.equal(shouldTranspose({ config: { graphType: 'Pie' } }, TABLE), false, 'a multi-column pie with no axis keeps its native form');
  var oneColumn = { y: { vars: ['Revenue'], smps: ['North', 'South'], data: [[820, 640]] } };
  assert.equal(shouldTranspose({ config: { graphType: 'Pie' } }, oneColumn), true, 'one column, several rows: slices per row');
  assert.equal(shouldTranspose({ config: { graphType: 'Pie' } }, { y: { vars: ['R'], smps: ['a'], data: [[1]] } }), false);
});

test('a transposed panel gets transposed data at render and on live updates, and marks along the flipped axis', async function () {
  var live = [];
  var CX = markingCX(live);
  var spec = {
    id: 'tr',
    params: { k: { value: 1 } },
    layout: { cols: 12, items: [{ panel: 'sc', x: 0, y: 0, w: 6, h: 3 }, { panel: 'bar', x: 6, y: 0, w: 6, h: 3 }] },
    relationships: [{ left: 'labs', right: 'trial', on: { left: 'patient', right: 'smps' } }],
    data: {
      trial: { kind: 'inline', value: TABLE },
      labs: { kind: 'inline', value: { y: { vars: ['ALT'], smps: ['L1', 'L2'], data: [[30, 40]] }, x: { patient: ['p2', 'p3'] } } }
    },
    panels: {
      sc: { dataRef: 'trial', config: { graphType: 'Scatter2D', xAxis: ['time'], yAxis: ['biomarker'] } },
      bar: { dataRef: 'labs', config: { graphType: 'Bar' } }
    }
  };
  var container = document.createElement('div');
  document.body.appendChild(container);
  var handle = await renderDashboard(spec, container, { CanvasXpress: CX });
  await handle.ready;
  var sc = panelInst(live, 'sc');
  var bar = panelInst(live, 'bar');
  assert.deepEqual(sc.data.y.vars, ['p1', 'p2', 'p3'], 'patients became the points');
  assert.deepEqual(sc.data.y.smps, ['time', 'event', 'biomarker']);
  assert.deepEqual(sc.data.z, { arm: ['a', 'b', 'a'] });

  // Marking from the labs bar marks the trial patients as VARIABLES of the transposed scatter.
  CX.selector = { smps: { L1: true }, vars: { ALT: true } };
  bar.events.select.call(bar, {});
  await delay(0);
  assert.deepEqual(sc.highlightVar, ['p2']);
  assert.deepEqual(sc.highlightSmp, []);

  // Selecting points in the transposed scatter (names in selector.vars) marks the related lab rows.
  CX.selector = { smps: {}, vars: { p3: true } };
  sc.events.select.call(sc, {});
  await delay(0);
  assert.deepEqual(bar.highlightSmp, ['L2']);
  handle.destroy();
});
