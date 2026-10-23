/**
 * The boot routine every language wrapper shares (R widget, Python package): payload in, dashboard or
 * a readable message out. Stubbed API + DOM — no browser. Run with `node --test`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderPayload } from '../src/renderPayload.js';
import { installDom } from './helpers/dom-stub.js';

var SPEC = { id: 'demo', title: 'Demo', layout: { cols: 12, items: [] }, data: {}, panels: {} };
var DATA = { y: { vars: ['a'], smps: ['r1', 'r2'], data: [[1, 2]] } };

function stubApi(overrides) {
  var calls = { render: [], suggest: [], spec: [] };
  var api = {
    calls: calls,
    suggestDashboard: function (data) { calls.suggest.push(data); return { template: 'cohort', label: 'Cohort overview', panels: [] }; },
    dashboardSpec: function (suggestion, opts) { calls.spec.push(opts); return { id: opts.id, title: opts.title, source: opts.source }; },
    renderDashboard: function (spec, el, options) {
      calls.render.push({ spec: spec, el: el, options: options });
      var handle = { destroyed: false, getParams: function () { return { case: 'P1' }; }, destroy: function () { handle.destroyed = true; } };
      api.handle = handle;
      return Promise.resolve(handle);
    }
  };
  for (var k in (overrides || {})) api[k] = overrides[k];
  return api;
}
function container() { var el = document.createElement('div'); el.id = 'w1'; document.body.appendChild(el); return el; }
function message(el) { var n = el.querySelector('.cxdashboard-message'); return n ? n.textContent : null; }

beforeEach(function () { installDom(); });

test('a spec payload is rendered as written, with title and theme overrides', async function () {
  var el = container(), api = stubApi();
  var handle = await renderPayload(el, { suggest: false, specJson: JSON.stringify(SPEC), title: 'Mine', theme: 'dark' },
    { api: api, isEngineReady: function () { return true; } });
  assert.equal(handle, api.handle);
  assert.equal(api.calls.render.length, 1);
  assert.equal(api.calls.render[0].el, el);
  assert.equal(api.calls.render[0].spec.title, 'Mine');
  assert.equal(api.calls.render[0].spec.theme, 'dark');
  assert.equal(api.calls.render[0].spec.id, 'demo');
  assert.equal(message(el), null);
});

test('a data payload is turned into a suggested dashboard over its inline data', async function () {
  var el = container(), api = stubApi(), templates = [];
  var handle = await renderPayload(el, { suggest: true, dataJson: JSON.stringify(DATA) },
    { api: api, isEngineReady: function () { return true; }, onTemplate: function (t) { templates.push(t); }, idPrefix: 'dash-1' });
  assert.ok(handle);
  assert.deepEqual(api.calls.suggest, [DATA]);
  assert.equal(api.calls.spec[0].id, 'dash-1');
  assert.equal(api.calls.spec[0].title, 'Cohort overview');                  // the template's name by default
  assert.deepEqual(api.calls.spec[0].source, { kind: 'inline', value: DATA });
  assert.deepEqual(templates, ['cohort']);
  var titled = await renderPayload(container(), { suggest: true, dataJson: JSON.stringify(DATA), title: 'My trial' },
    { api: stubApi(), isEngineReady: function () { return true; } });
  assert.ok(titled);
});

test('data no template fits is said plainly, nothing is rendered', async function () {
  var el = container(), api = stubApi({ suggestDashboard: function () { return null; } });
  var handle = await renderPayload(el, { suggest: true, dataJson: JSON.stringify(DATA) }, { api: api, isEngineReady: function () { return true; } });
  assert.equal(handle, null);
  assert.match(message(el), /No dashboard template matched/);
  assert.equal(api.calls.render.length, 0);
});

test('unreadable JSON is reported, not thrown', async function () {
  var el = container();
  assert.equal(await renderPayload(el, { suggest: false, specJson: '{broken' }, { api: stubApi(), isEngineReady: function () { return true; } }), null);
  assert.match(message(el), /^Could not read the dashboard: /);
});

test('an invalid spec (renderDashboard throws synchronously) and a data failure (it rejects) are both reported', async function () {
  var el = container();
  var throws = stubApi({ renderDashboard: function () { throw new Error('Invalid dashboard spec:\n  - spec.layout is required'); } });
  assert.equal(await renderPayload(el, { suggest: false, specJson: '{}' }, { api: throws, isEngineReady: function () { return true; } }), null);
  assert.match(message(el), /^Could not render the dashboard: Invalid dashboard spec/);
  var rejects = stubApi({ renderDashboard: function () { return Promise.reject(new Error('HTTP 500')); } });
  assert.equal(await renderPayload(el, { suggest: false, specJson: '{}' }, { api: rejects, isEngineReady: function () { return true; } }), null);
  assert.match(message(el), /Could not render the dashboard: HTTP 500/);
});

test('a missing bundle or engine is reported after a bounded wait', async function () {
  var el = container();
  assert.equal(await renderPayload(el, { suggest: false, specJson: '{}' }, { api: null, isEngineReady: function () { return true; }, timeoutMs: 60 }), null);
  assert.match(message(el), /canvasxpress-dashboards did not load/);
  assert.equal(await renderPayload(el, { suggest: false, specJson: '{}' }, { api: stubApi(), isEngineReady: function () { return false; }, timeoutMs: 60 }), null);
  assert.match(message(el), /CanvasXpress engine did not load/);
});

test('an engine that arrives late is waited for (Shiny injects its dependencies dynamically)', async function () {
  var el = container(), api = stubApi(), ready = false;
  setTimeout(function () { ready = true; }, 130);
  var handle = await renderPayload(el, { suggest: false, specJson: JSON.stringify(SPEC) }, { api: api, isEngineReady: function () { return ready; }, timeoutMs: 2000 });
  assert.ok(handle);
  assert.equal(api.calls.render.length, 1);
});

test('a render superseded by a newer one is discarded and cleaned up', async function () {
  var el = container(), api = stubApi(), current = true;
  var pending = renderPayload(el, { suggest: false, specJson: JSON.stringify(SPEC) },
    { api: api, isEngineReady: function () { return true; }, isCurrent: function () { return current; } });
  current = false;                                  // a newer renderValue() arrived while it was in flight
  assert.equal(await pending, null);
  assert.ok(api.handle === undefined || api.handle.destroyed === true, 'a dashboard that did get built is destroyed');
});

test('parameter changes reach the wrapper with the dashboard handle', async function () {
  var el = container(), api = stubApi(), seen = [];
  var handle = await renderPayload(el, { suggest: false, specJson: JSON.stringify(SPEC) },
    { api: api, isEngineReady: function () { return true; }, onParamChange: function (n, v, done, h) { seen.push([n, v, typeof done, h === handle]); } });
  api.calls.render[0].options.onParamChange('case', 'P2', Promise.resolve());
  assert.deepEqual(seen, [['case', 'P2', 'object', true]]);
});

test('renderOptions are passed through to renderDashboard', async function () {
  var el = container(), api = stubApi();
  await renderPayload(el, { suggest: false, specJson: JSON.stringify(SPEC) },
    { api: api, isEngineReady: function () { return true; }, renderOptions: { baseUrl: '/app' } });
  assert.equal(api.calls.render[0].options.baseUrl, '/app');
});

test('a spec with a storyboard gets its player inside the container', async function () {
  var mounted = [];
  var api = stubApi({ mountStoryboard: function (opts) { mounted.push(opts); } });
  var withBoard = Object.assign({}, SPEC, { storyboard: { steps: [{ title: 'a' }] } });
  var el = container();
  await renderPayload(el, { suggest: false, specJson: JSON.stringify(withBoard) }, { api: api, isEngineReady: function () { return true; } });
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].container, el);
  assert.equal(mounted[0].handle, api.handle);
  assert.equal(mounted[0].spec.storyboard.steps[0].title, 'a');
});
