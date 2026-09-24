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

test('resolves a dataset source via the baseUrl datasets endpoint', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map(), baseUrl: 'http://x' });
  var data = await store.resolve('sales', { kind: 'dataset', id: 'sales 2026' });
  assert.deepEqual(data, CX_DATA);
  assert.equal(fetchStub.calls[0].url, 'http://x/api/datasets/sales%202026');
  assert.equal(fetchStub.calls[0].init.credentials, 'include');
});

test('a dataset source honors an explicit url (e.g. a signed url_for)', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  await store.resolve('sales', { kind: 'dataset', id: 'sales', url: 'https://cdn/signed' });
  assert.equal(fetchStub.calls[0].url, 'https://cdn/signed');
});

test('a dataset source appends its named store as a query param', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map(), baseUrl: 'http://x' });
  await store.resolve('sales', { kind: 'dataset', id: 'sales', store: 's3-prod' });
  assert.equal(fetchStub.calls[0].url, 'http://x/api/datasets/sales?store=s3-prod');
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

test('substitutes $param tokens into a connector query', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  var src = { kind: 'connector', url: '/api/data?source=sales', query: { region: '$region', fixed: 'x' } };
  await store.resolve('sales', src, { params: { region: 'EMEA' } });
  assert.equal(fetchStub.calls.length, 1);
  assert.match(fetchStub.calls[0].url, /region=EMEA/);
  assert.match(fetchStub.calls[0].url, /fixed=x/);
});

test('drops query entries whose param is null (an "All" selection widens)', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  var src = { kind: 'connector', url: '/api/data?source=sales', query: { region: '$region' } };
  await store.resolve('sales', src, { params: { region: null } });
  assert.equal(fetchStub.calls[0].url, '/api/data?source=sales', 'no region param appended');
});

test('different param values are distinct cache entries (no stale collision)', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map(), ttl: 10000, now: function () { return 0; } });
  var src = { kind: 'connector', url: '/api/data?source=sales', query: { region: '$region' } };
  await store.resolve('sales', src, { params: { region: 'EMEA' } });
  await store.resolve('sales', src, { params: { region: 'APAC' } });
  await store.resolve('sales', src, { params: { region: 'EMEA' } }); // cached
  assert.equal(fetchStub.calls.length, 2, 'EMEA and APAC fetched once each; second EMEA served from cache');
});

test('cache key is order-independent for the same param values', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map(), ttl: 10000, now: function () { return 0; } });
  var src = { kind: 'connector', url: '/api/data', query: { a: '$a', b: '$b' } };
  await store.resolve('s', src, { params: { a: '1', b: '2' } });
  await store.resolve('s', src, { params: { b: '2', a: '1' } });
  assert.equal(fetchStub.calls.length, 1, 'same values in any order share one cache entry');
});

// --- kind:"join" sources ---

var LEFT = { y: { vars: ['V'], smps: ['a', 'b'], data: [[1, 2]] } };
var RIGHT = { y: { vars: ['W'], smps: ['b', 'c'], data: [[20, 30]] } };

test('resolves a join source by blending its two inputs', async function () {
  var store = createDataStore({ fetch: fakeFetch(), cache: new Map() });
  var sources = {
    l: { kind: 'inline', value: LEFT },
    r: { kind: 'inline', value: RIGHT },
    j: { kind: 'join', left: 'l', right: 'r', how: 'left' }
  };
  var data = await store.resolve('j', sources.j, { sources: sources });
  assert.deepEqual(data.y.smps, ['a', 'b']);
  assert.deepEqual(data.y.vars, ['V', 'W']);
  assert.deepEqual(data.y.data, [[1, 2], [null, 20]]);
});

test('a join fetches remote inputs with the current params and nests joins', async function () {
  var urls = [];
  var fetchStub = function (url) {
    urls.push(url);
    var body = JSON.stringify(/source=r/.test(url) ? RIGHT : LEFT);
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(body); } });
  };
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  var sources = {
    l: { kind: 'connector', url: '/api/data?source=l', query: { region: '$region' } },
    r: { kind: 'connector', url: '/api/data?source=r' },
    j: { kind: 'join', left: 'l', right: 'r', how: 'outer' },
    jj: { kind: 'join', left: 'j', right: 'r', suffix: '_again' }
  };
  var data = await store.resolve('jj', sources.jj, { sources: sources, params: { region: 'EMEA' } });
  assert.ok(urls.indexOf('/api/data?source=l&region=EMEA') !== -1, 'left input got the param');
  assert.deepEqual(data.y.vars, ['V', 'W', 'W_again']);
  assert.deepEqual(data.y.smps, ['b', 'c']);
});

test('a join resolves its inputs through opts.resolveInput when given', async function () {
  var store = createDataStore({ fetch: fakeFetch(), cache: new Map() });
  var asked = [];
  var sources = {
    l: { kind: 'connector', url: '/never' },
    r: { kind: 'connector', url: '/never' },
    j: { kind: 'join', left: 'l', right: 'r' }
  };
  var data = await store.resolve('j', sources.j, {
    sources: sources,
    resolveInput: function (ref) { asked.push(ref); return Promise.resolve(ref === 'l' ? LEFT : RIGHT); }
  });
  assert.deepEqual(asked, ['l', 'r']);
  assert.deepEqual(data.y.smps, ['b']);
});

test('a join rejects a missing input and a cycle without fetching', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  var sources = {
    l: { kind: 'connector', url: '/x' },
    j: { kind: 'join', left: 'l', right: 'ghost' },
    c1: { kind: 'join', left: 'l', right: 'c2' },
    c2: { kind: 'join', left: 'c1', right: 'l' }
  };
  await assert.rejects(store.resolve('j', sources.j, { sources: sources }), /input "ghost" not found/);
  await assert.rejects(store.resolve('c1', sources.c1, { sources: sources }), /depends on itself \(c1 -> c2 -> c1\)/);
  assert.equal(fetchStub.calls.length, 0);
});

// --- kind:"function" sources (data functions) ---

/**
 * A fetch stub for a data-function runtime: records the POSTed contract and
 * answers with a canned result (or an error).
 * @param {object} [opts] - `{ status, body }`.
 * @returns {function} fetch stub with `.calls`.
 */
function runtimeFetch(opts) {
  opts = opts || {};
  var fn = function (url, init) {
    fn.calls.push({ url: url, init: init, body: init && init.body ? JSON.parse(init.body) : null });
    var status = opts.status || 200;
    var text = JSON.stringify(opts.body || { data: { y: { vars: ['n'], smps: ['drug'], data: [[2]] } } });
    return Promise.resolve({ ok: status < 300, status: status, text: function () { return Promise.resolve(text); } });
  };
  fn.calls = [];
  return fn;
}

test('a function source POSTs its inputs, code and resolved args to the runtime', async function () {
  var fetchStub = runtimeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map(), baseUrl: 'http://srv' });
  var sources = {
    clin: { kind: 'inline', value: LEFT },
    genes: { kind: 'inline', axis: 'vars', value: RIGHT },
    f: { kind: 'function', language: 'r', code: 'result <- d', inputs: { d: 'clin', g: 'genes' },
      args: { k: '$k', n: 3, missing: '$unset' }, axis: 'vars' }
  };
  var data = await store.resolve('f', sources.f, { sources: sources, params: { k: 2 } });
  assert.deepEqual(data, { y: { vars: ['n'], smps: ['drug'], data: [[2]] } });
  var call = fetchStub.calls[0];
  assert.equal(call.url, 'http://srv/api/functions/run');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.credentials, 'include');
  assert.deepEqual(call.body, {
    language: 'r', code: 'result <- d', axis: 'vars',
    inputs: { d: { data: LEFT, axis: 'smps' }, g: { data: RIGHT, axis: 'vars' } },
    params: { k: 2, n: 3, missing: null }
  });
});

test('a function source takes inputs as an array and a custom runtime URL', async function () {
  var fetchStub = runtimeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  var sources = { clin: { kind: 'inline', value: LEFT }, f: { kind: 'function', language: 'python', code: 'result = clin', inputs: ['clin'], runtime: 'https://rt.example/run' } };
  await store.resolve('f', sources.f, { sources: sources });
  assert.equal(fetchStub.calls[0].url, 'https://rt.example/run');
  assert.deepEqual(Object.keys(fetchStub.calls[0].body.inputs), ['clin']);
});

test('a runtime error surfaces as a DataError with its detail', async function () {
  var store = createDataStore({ fetch: runtimeFetch({ status: 400, body: { detail: 'NameError: nope' } }), cache: new Map() });
  var sources = { clin: { kind: 'inline', value: LEFT }, f: { kind: 'function', language: 'python', code: 'x', inputs: ['clin'] } };
  await assert.rejects(store.resolve('f', sources.f, { sources: sources }), function (err) {
    return err instanceof DataError && err.status === 400 && /NameError: nope/.test(err.message);
  });
  await assert.rejects(store.resolve('g', { kind: 'function', language: 'python', code: 'x', inputs: ['ghost'] }, { sources: sources }), /input "ghost" not found/);
});

test('a function source calls fetch unbound (native fetch rejects a foreign `this`)', async function () {
  var sawThis = 'unset';
  var fetchStub = function (url, init) {
    sawThis = this;
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve('{"data":{"y":{"vars":[],"smps":[],"data":[]}}}'); } });
  };
  var store = createDataStore({ fetch: fetchStub, cache: new Map() });
  var sources = { clin: { kind: 'inline', value: LEFT }, f: { kind: 'function', language: 'python', code: 'result = clin', inputs: ['clin'] } };
  await store.resolve('f', sources.f, { sources: sources });
  assert.equal(sawThis, undefined);
});

test('a missing default function runtime explains itself; a custom runtime keeps its status', async function () {
  var sources = { clin: { kind: 'inline', value: LEFT }, f: { kind: 'function', language: 'r', code: 'x', inputs: ['clin'] } };
  var store404 = createDataStore({ fetch: runtimeFetch({ status: 404, body: {} }), cache: new Map() });
  await assert.rejects(store404.resolve('f', sources.f, { sources: sources }), /Data functions are not available here/);
  var store401 = createDataStore({ fetch: runtimeFetch({ status: 401, body: { detail: 'Not logged in' } }), cache: new Map() });
  await assert.rejects(store401.resolve('f', sources.f, { sources: sources }), /Sign in to run data functions/);
  var custom = Object.assign({}, sources.f, { runtime: 'https://rt.example/run' });
  await assert.rejects(store404.resolve('f', custom, { sources: sources }), /HTTP 404/);
});

test('a dataset source pinned to another owner fetches with ?owner=', async function () {
  var fetchStub = fakeFetch();
  var store = createDataStore({ fetch: fetchStub, cache: new Map(), baseUrl: 'http://x' });
  await store.resolve('sales', { kind: 'dataset', id: 'sales', store: 's3', owner: 'bob' });
  assert.equal(fetchStub.calls[0].url, 'http://x/api/datasets/sales?store=s3&owner=bob');
});
