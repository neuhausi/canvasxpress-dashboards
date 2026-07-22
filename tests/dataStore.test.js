/**
 * Unit tests for the data store: connector fetch (cookie auth), shared-request
 * de-duplication, TTL caching, forced refetch, and the error/empty contract.
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataStore, DataError, isEmptyData, clearSharedCache } from '../src/dataStore.js';

var CX_DATA = { y: { vars: ['R'], smps: ['A', 'B'], data: [[1, 2]] } };

/**
 * Build a fake fetch that records calls and returns a canned response.
 * @param {object} [opts] - { ok, status, body }.
 * @returns {function} A fetch stub with a `.calls` array.
 */
function fakeFetch(opts) {
  opts = opts || {};
  var ok = opts.ok !== false;
  var status = opts.status || 200;
  var body = opts.body != null ? opts.body : JSON.stringify(CX_DATA);
  var fn = function (url, init) {
    fn.calls.push({ url: url, init: init });
    return Promise.resolve({
      ok: ok,
      status: status,
      text: function () { return Promise.resolve(body); }
    });
  };
  fn.calls = [];
  return fn;
}

test('resolves inline sources without fetching', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  var data = await store.resolve('inline', { kind: 'inline', value: CX_DATA });
  assert.equal(data, CX_DATA);
  assert.equal(fetchStub.calls.length, 0);
});

test('fetches a connector source with cookie credentials', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  var data = await store.resolve('sales', { kind: 'connector', url: '/api/data?source=sales' });
  assert.deepEqual(data, CX_DATA);
  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].init.credentials, 'include');
});

test('de-duplicates concurrent requests for the same source (single request)', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  var src = { kind: 'connector', url: '/api/data?source=sales' };
  var results = await Promise.all([
    store.resolve('a', src),
    store.resolve('b', src)  // different ref, same url -> shared fetch
  ]);
  assert.equal(fetchStub.calls.length, 1);
  assert.deepEqual(results[0], results[1]);
});

test('a cache hit within ttl avoids re-querying the backend', async function () {
  var clock = { t: 1000 };
  var fetchStub = fakeFetch();
  var store = createDataStore({
    fetch: fetchStub, cache: new Map(), ttl: 5000, now: function () { return clock.t; }
  });
  var src = { kind: 'connector', url: '/api/data?source=sales' };

  await store.resolve('sales', src);
  assert.equal(fetchStub.calls.length, 1);

  clock.t = 3000; // still within ttl
  await store.resolve('sales', src);
  assert.equal(fetchStub.calls.length, 1, 'served from cache');

  clock.t = 7000; // ttl expired
  await store.resolve('sales', src);
  assert.equal(fetchStub.calls.length, 2, 'refetched after expiry');
});

test('force bypasses a fresh cache entry', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map(), ttl: 100000, now: function () { return 0; } });
  var src = { kind: 'connector', url: '/api/data?source=sales' };
  await store.resolve('sales', src);
  await store.resolve('sales', src, { force: true });
  assert.equal(fetchStub.calls.length, 2);
});

test('surfaces the connector error detail and status', async function () {
  var fetchStub = fakeFetch({ ok: false, status: 422, body: JSON.stringify({ detail: 'Query returned no rows' }) });
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  await assert.rejects(
    store.resolve('sales', { kind: 'connector', url: '/api/data?source=sales' }),
    function (err) {
      assert.ok(err instanceof DataError);
      assert.equal(err.status, 422);
      assert.match(err.message, /no rows/);
      return true;
    }
  );
});

test('a per-source ttl overrides the store default', async function () {
  var clock = { t: 0 };
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map(), ttl: 0, now: function () { return clock.t; } });
  var src = { kind: 'connector', url: '/api/data?source=sales', ttl: 10000 };
  await store.resolve('sales', src);
  clock.t = 5000;
  await store.resolve('sales', src);
  assert.equal(fetchStub.calls.length, 1, 'per-source ttl kept it cached');
});

test('isEmptyData detects rows vs. no rows', function () {
  assert.equal(isEmptyData(null), true);
  assert.equal(isEmptyData({ y: { vars: [], smps: [], data: [] } }), true);
  assert.equal(isEmptyData({ y: { vars: ['R'], smps: ['A'], data: [[1]] } }), false);
});

test('clearSharedCache empties the process-wide cache', function () {
  clearSharedCache(); // smoke: should not throw
  assert.ok(true);
});
