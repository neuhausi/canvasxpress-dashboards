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

  // Grid columns reflect the spec.
  assert.match(container.querySelector('.cxd-grid').style.gridTemplateColumns, /repeat\(12/);

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
