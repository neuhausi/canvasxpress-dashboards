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

test('client surfaces the server error detail + status on failure', async function () {
  var fetchStub = routedFetch({ 'GET /api/dashboards/ghost': { status: 404, body: { detail: 'No such dashboard' } } });
  var client = createDashboardClient({ fetch: fetchStub, baseUrl: 'http://x' });
  await assert.rejects(client.load('ghost'), function (err) {
    assert.equal(err.status, 404);
    assert.match(err.message, /No such dashboard/);
    return true;
  });
});
