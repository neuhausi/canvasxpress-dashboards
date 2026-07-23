/**
 * Unit tests for the persistence client + import/export helpers.
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndValidate, createDashboardClient } from '../src/persistence.js';

var SPEC = {
  id: 'd1',
  layout: { items: [{ panel: 'p', x: 0, y: 0, w: 6, h: 3 }] },
  data: { s: { kind: 'inline', value: { y: {} } } },
  panels: { p: { dataRef: 's', config: { graphType: 'Bar' } } }
};

test('parseAndValidate accepts a valid spec and rejects bad JSON / bad spec', function () {
  assert.deepEqual(parseAndValidate(JSON.stringify(SPEC)), SPEC);
  assert.throws(function () { return parseAndValidate('{not json'); }, /Not valid JSON/);
  assert.throws(function () { return parseAndValidate('{"id":"x"}'); }, /Invalid dashboard spec/);
});

/**
 * Build a fake fetch driven by a route table, recording requests.
 * @param {object} routes - `"METHOD /path"` -> `{ status, body }`.
 * @returns {function} fetch stub with a `.calls` array.
 */
function routedFetch(routes) {
  var fn = function (url, init) {
    var path = url.replace(/^https?:\/\/[^/]+/, '');
    var key = (init && init.method ? init.method : 'GET') + ' ' + path;
    fn.calls.push({ key: key, init: init });
    var route = routes[key] || { status: 404, body: { detail: 'not found' } };
    return Promise.resolve({
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      text: function () { return Promise.resolve(JSON.stringify(route.body)); }
    });
  };
  fn.calls = [];
  return fn;
}

test('client.save posts the spec with credentials and returns the summary', async function () {
  var fetchStub = routedFetch({ 'POST /api/dashboards': { status: 200, body: { dashboard: { id: 'd1', visibility: 'private' } } } });
  var client = createDashboardClient({ fetch: fetchStub, baseUrl: 'http://x' });
  var summary = await client.save(SPEC);
  assert.equal(summary.id, 'd1');
  var call = fetchStub.calls[0];
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.credentials, 'include');
  assert.deepEqual(JSON.parse(call.init.body), SPEC);
});

test('client.load / list / share / loadShared unwrap the payloads', async function () {
  var fetchStub = routedFetch({
    'GET /api/dashboards': { status: 200, body: { dashboards: [{ id: 'd1' }] } },
    'GET /api/dashboards/d1': { status: 200, body: SPEC },
    'POST /api/dashboards/d1/share': { status: 200, body: { dashboard: { id: 'd1', share_token: 'tok', share_url: 'http://x/shared.html?token=tok' } } },
    'GET /api/shared/tok': { status: 200, body: { spec: SPEC, readOnly: true, owner: 'alice' } }
  });
  var client = createDashboardClient({ fetch: fetchStub, baseUrl: 'http://x' });

  assert.deepEqual(await client.list(), [{ id: 'd1' }]);
  assert.deepEqual(await client.load('d1'), SPEC);
  var shared = await client.share('d1', 'public');
  assert.equal(shared.share_token, 'tok');
  var viewer = await client.loadShared('tok');
  assert.equal(viewer.readOnly, true);
  assert.equal(viewer.owner, 'alice');
});

test('client.listDatasets / deleteDataset unwrap the payloads', async function () {
  var fetchStub = routedFetch({
    'GET /api/datasets': { status: 200, body: { datasets: [{ id: 'sales-abc', rows: 2, cols: 1 }] } },
    'DELETE /api/datasets/sales-abc': { status: 200, body: { datasets: [] } }
  });
  var client = createDashboardClient({ fetch: fetchStub, baseUrl: 'http://x' });
  assert.deepEqual(await client.listDatasets(), [{ id: 'sales-abc', rows: 2, cols: 1 }]);
  assert.deepEqual(await client.deleteDataset('sales-abc'), []);
});

test('client.uploadDataset infers csv format from a File and posts text', async function () {
  var fetchStub = routedFetch({ 'POST /api/datasets': { status: 200, body: { dataset: { id: 'sales-abc', rows: 2, cols: 1, url: null } } } });
  var client = createDashboardClient({ fetch: fetchStub, baseUrl: 'http://x' });
  var file = { name: 'sales.csv', type: 'text/csv', text: function () { return Promise.resolve('id,sales\nA,10\nB,20\n'); } };
  var summary = await client.uploadDataset(file, { title: 'Sales' });
  assert.equal(summary.id, 'sales-abc');
  var body = JSON.parse(fetchStub.calls[0].init.body);
  assert.equal(body.format, 'csv');
  assert.equal(body.title, 'Sales');
  assert.match(body.data, /id,sales/);
});

test('client.listStores lists named stores (optionally by capability)', async function () {
  var fetchStub = routedFetch({
    'GET /api/stores?capability=dataset': { status: 200, body: { stores: [{ name: 'local', capability: 'dataset', default: true }] } }
  });
  var client = createDashboardClient({ fetch: fetchStub, baseUrl: 'http://x' });
  var stores = await client.listStores('dataset');
  assert.equal(stores[0].name, 'local');
  assert.equal(fetchStub.calls[0].key, 'GET /api/stores?capability=dataset');
});

test('client.uploadDataset forwards a target store; deleteDataset scopes by store', async function () {
  var fetchStub = routedFetch({
    'POST /api/datasets': { status: 200, body: { dataset: { id: 'd', store: 's3-prod' } } },
    'DELETE /api/datasets/d?store=s3-prod': { status: 200, body: { datasets: [] } }
  });
  var client = createDashboardClient({ fetch: fetchStub, baseUrl: 'http://x' });
  await client.uploadDataset('id,v\nA,1\n', { format: 'csv', store: 's3-prod' });
  assert.equal(JSON.parse(fetchStub.calls[0].init.body).store, 's3-prod');
  assert.deepEqual(await client.deleteDataset('d', { store: 's3-prod' }), []);
});

test('client.uploadDataset sends a plain object as cx data', async function () {
  var fetchStub = routedFetch({ 'POST /api/datasets': { status: 200, body: { dataset: { id: 'd', rows: 1, cols: 1 } } } });
  var client = createDashboardClient({ fetch: fetchStub, baseUrl: 'http://x' });
  var cx = { y: { vars: ['v'], smps: ['s'], data: [[1]] } };
  await client.uploadDataset(cx);
  var body = JSON.parse(fetchStub.calls[0].init.body);
  assert.equal(body.format, 'cx');
  assert.deepEqual(body.data, cx);
});

test('client surfaces the server error detail + status on failure', async function () {
  var fetchStub = routedFetch({ 'GET /api/dashboards/ghost': { status: 404, body: { detail: 'No such dashboard' } } });
  var client = createDashboardClient({ fetch: fetchStub, baseUrl: 'http://x' });
  await assert.rejects(client.load('ghost'), function (err) {
    assert.equal(err.status, 404);
    assert.match(err.message, /No such dashboard/);
    return true;
  });
});
