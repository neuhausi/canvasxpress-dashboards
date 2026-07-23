/**
 * Renderer smoke tests using a minimal DOM + CanvasXpress stub — no browser.
 * Verifies the grid scaffold, one canvas per layout item + control, and that
 * every instance receives the dashboard's broadcastGroup.
 *
 * Run with `node --test`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard } from '../src/renderDashboard.js';
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

  // Every instance got the dashboard broadcastGroup.
  created.forEach(function (c) {
    assert.equal(c.config.broadcastGroup, 'grp-sales');
  });

  // Grid has 12 content columns (interleaved with gap tracks).
  var colTpl = container.querySelector('.cxd-grid').style.gridTemplateColumns;
  assert.equal((colTpl.match(/minmax\(0, 1fr\)/g) || []).length, 12);

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
