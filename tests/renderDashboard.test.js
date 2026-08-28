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
  assert.equal(container.style.padding, '16px', 'gap becomes an even background margin around the grid');
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
  created.forEach(function (c) { assert.deepEqual(c.data, CONNECTOR_DATA); });
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
