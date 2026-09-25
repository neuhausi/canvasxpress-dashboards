/**
 * Live (streaming) sources: `kind:"live"` sources
 * subscribe to a canvasxpress-connectors SSE endpoint and push each tick into
 * the bound panels via the engine's `pushData` (fallback `updateData`), with
 * bursts coalesced to one redraw per frame. No browser: a fake EventSource and
 * a manual frame scheduler drive everything deterministically.
 *
 * Run with `node --test`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard } from '../src/renderDashboard.js';
import { createBuilder } from '../src/builder.js';
import { blankSpec, setDataSource } from '../src/builderModel.js';
import { createDataStore } from '../src/dataStore.js';
import { validateSpec } from '../src/validateSpec.js';
import { installDom } from './helpers/dom-stub.js';

var streams;

/**
 * A fake EventSource recording each connection; `emit(obj)` delivers a `tick`.
 * @param {string} url - Stream URL.
 * @param {object} init - EventSource init (withCredentials).
 * @returns {void}
 */
function FakeEventSource(url, init) {
  this.url = url;
  this.init = init;
  this.closed = false;
  this.listeners = {};
  streams.push(this);
}
FakeEventSource.prototype.addEventListener = function (type, fn) {
  (this.listeners[type] || (this.listeners[type] = [])).push(fn);
};
FakeEventSource.prototype.close = function () { this.closed = true; };
FakeEventSource.prototype.emit = function (tick) {
  var data = JSON.stringify(tick);
  (this.listeners.tick || []).forEach(function (fn) { fn({ data: data }); });
};

/**
 * A manual frame scheduler: `schedule(fn)` queues; `flush()` runs the queue.
 * @returns {{schedule: function, flush: function, queued: function}} Scheduler.
 */
function manualFrames() {
  var queue = [];
  return {
    schedule: function (fn) { queue.push(fn); },
    flush: function () { var q = queue; queue = []; q.forEach(function (fn) { fn(); }); },
    queued: function () { return queue.length; }
  };
}

/**
 * A one-sample tick for series `cpu`.
 * @param {string} smp - Sample name.
 * @param {number} value - Value.
 * @returns {object} Tick.
 */
function tick(smp, value) {
  return { y: { vars: ['cpu'], smps: [smp], data: [[value]] }, x: { time: [smp + '-t'] } };
}

var LIVE_SPEC = {
  id: 'live-demo',
  layout: { cols: 12, items: [{ panel: 'p', x: 0, y: 0, w: 12, h: 3 }] },
  data: { feed: { kind: 'live', url: '/api/stream/demo', window: 4, variables: ['cpu'] } },
  panels: { p: { title: 'CPU', dataRef: 'feed', config: { graphType: 'Line' } } }
};

var created;

/**
 * CanvasXpress stub with the engine's streaming seam (`pushData`) plus `updateData`.
 * @param {string} id - Canvas id.
 * @param {object} data - Initial data.
 * @returns {void}
 */
function StreamingStub(id, data) {
  this.initial = data;
  this.pushes = [];
  this.updates = [];
  this.streamWindow = null;
  this.pushData = function (t) { this.pushes.push(t); };
  this.updateData = function (d) { this.updates.push(d); };
  created.push(this);
}

/**
 * An older-engine stub WITHOUT `pushData` (exercises the updateData fallback).
 * @param {string} id - Canvas id.
 * @param {object} data - Initial data.
 * @returns {void}
 */
function LegacyStub(id, data) {
  this.initial = data;
  this.updates = [];
  this.updateData = function (d) { this.updates.push(d); };
  created.push(this);
}

beforeEach(function () {
  installDom();
  streams = [];
  created = [];
});

/**
 * Render the live spec with a fake EventSource + manual frames.
 * @param {function} CX - CanvasXpress stub.
 * @param {object} [spec] - Spec override.
 * @returns {Promise<{handle: object, frames: object}>} The handle and frames.
 */
async function renderLive(CX, spec) {
  var frames = manualFrames();
  var container = document.createElement('div');
  var handle = await renderDashboard(spec || LIVE_SPEC, container, {
    CanvasXpress: CX, EventSource: FakeEventSource,
    requestAnimationFrame: frames.schedule, baseUrl: 'https://cx.example'
  });
  await handle.ready;
  return { handle: handle, frames: frames };
}

// ------------------------------------------------------------------ dataStore
test('store.subscribe opens an SSE stream and delivers parsed ticks', function () {
  var store = createDataStore({ EventSource: FakeEventSource, baseUrl: 'https://cx.example' });
  var got = [];
  var sub = store.subscribe('feed', { kind: 'live', url: '/api/stream/demo' }, {
    onTick: function (t, ref) { got.push([ref, t]); }
  });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cx.example/api/stream/demo');
  assert.deepEqual(streams[0].init, { withCredentials: true }); // cookie auth, no secret
  streams[0].emit(tick('t1', 5));
  assert.equal(got.length, 1);
  assert.equal(got[0][0], 'feed');
  assert.deepEqual(got[0][1].y.smps, ['t1']);
  sub.close();
  assert.equal(streams[0].closed, true);
  streams[0].emit(tick('t2', 6));
  assert.equal(got.length, 1, 'no ticks after close');
});

test('store.subscribe is a no-op without EventSource or for non-live sources', function () {
  var store = createDataStore({ EventSource: null });
  var saved = globalThis.EventSource;
  delete globalThis.EventSource;
  try {
    var sub = store.subscribe('feed', { kind: 'live', url: '/x' }, { onTick: function () {} });
    assert.equal(typeof sub.close, 'function');
    sub.close();
  } finally {
    if (saved) globalThis.EventSource = saved;
  }
  var store2 = createDataStore({ EventSource: FakeEventSource });
  store2.subscribe('s', { kind: 'connector', url: '/api/data' }, {});
  assert.equal(streams.length, 0);
});

test('store.resolve on a live source yields its seed or an empty-but-valid object', async function () {
  var store = createDataStore({});
  var empty = await store.resolve('feed', { kind: 'live', url: '/x', variables: ['a', 'b'] });
  assert.deepEqual(empty, { y: { vars: ['a', 'b'], smps: [], data: [[], []] } });
  var seed = { y: { vars: ['a'], smps: ['s0'], data: [[1]] } };
  assert.equal(await store.resolve('feed', { kind: 'live', url: '/x', initial: seed }), seed);
});

// --------------------------------------------------------------- validateSpec
test('validateSpec accepts a live source and checks url / window / variables', function () {
  assert.equal(validateSpec(LIVE_SPEC).valid, true);
  var bad = JSON.parse(JSON.stringify(LIVE_SPEC));
  bad.data.feed = { kind: 'live', window: 0, variables: [1] };
  var result = validateSpec(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(function (e) { return e.includes('requires a url string'); }));
  assert.ok(result.errors.some(function (e) { return e.includes('.window must be a positive integer'); }));
  assert.ok(result.errors.some(function (e) { return e.includes('.variables must be an array of strings'); }));
});

// ------------------------------------------------------------ renderDashboard
test('a live panel waits (loading) and builds on its first tick', async function () {
  var r = await renderLive(StreamingStub);
  assert.equal(created.length, 0, 'no instance before any sample arrives');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cx.example/api/stream/demo');

  streams[0].emit(tick('t1', 10));
  assert.equal(created.length, 0, 'nothing applied until the frame flushes');
  r.frames.flush();

  assert.equal(created.length, 1, 'built from the first tick');
  assert.deepEqual(created[0].initial.y.smps, ['t1']);
  assert.equal(created[0].streamWindow, 4, 'engine window set from the source window');
  assert.equal(created[0].pushes.length, 0, 'the build already holds the first tick');
  r.handle.destroy();
});

test('later ticks go through pushData, coalesced to one call per frame', async function () {
  var r = await renderLive(StreamingStub);
  streams[0].emit(tick('t1', 10));
  r.frames.flush();
  var inst = created[0];

  streams[0].emit(tick('t2', 11));
  streams[0].emit(tick('t3', 12));
  streams[0].emit(tick('t4', 13));
  assert.equal(r.frames.queued(), 1, 'a burst schedules a single frame');
  r.frames.flush();

  assert.equal(inst.pushes.length, 1, 'three ticks -> one pushData (one redraw)');
  var merged = inst.pushes[0];
  assert.deepEqual(merged.y.smps, ['t2', 't3', 't4']);
  assert.deepEqual(merged.y.data, [[11, 12, 13]]);
  assert.deepEqual(merged.x.time, ['t2-t', 't3-t', 't4-t']);
  r.handle.destroy();
});

test('an engine without pushData falls back to updateData over the bounded window', async function () {
  var r = await renderLive(LegacyStub);
  ['t1', 't2', 't3', 't4', 't5', 't6'].forEach(function (s, i) {
    streams[0].emit(tick(s, i));
    r.frames.flush();
  });
  var inst = created[0];
  var last = inst.updates[inst.updates.length - 1];
  assert.deepEqual(last.y.smps, ['t3', 't4', 't5', 't6'], 'window=4 keeps the newest four');
  assert.deepEqual(last.y.data, [[2, 3, 4, 5]]);
  assert.deepEqual(last.x.time, ['t3-t', 't4-t', 't5-t', 't6-t']);
  r.handle.destroy();
});

test('an unset window still bounds the stream (default window)', async function () {
  var spec = JSON.parse(JSON.stringify(LIVE_SPEC));
  delete spec.data.feed.window;
  var r = await renderLive(StreamingStub, spec);
  streams[0].emit(tick('t1', 1));
  r.frames.flush();
  assert.equal(created[0].streamWindow, 1000);
  r.handle.destroy();
});

test('destroy closes the stream and drops buffered ticks', async function () {
  var r = await renderLive(StreamingStub);
  streams[0].emit(tick('t1', 10));
  r.frames.flush();
  var inst = created[0];
  streams[0].emit(tick('t2', 11)); // buffered, frame pending
  r.handle.destroy();
  assert.equal(streams[0].closed, true);
  r.frames.flush();                 // the pending frame fires after destroy
  assert.equal(inst.pushes.length, 0, 'nothing applied after destroy');
});

test('a live source seeded with initial data renders immediately', async function () {
  var spec = JSON.parse(JSON.stringify(LIVE_SPEC));
  spec.data.feed.initial = { y: { vars: ['cpu'], smps: ['s0'], data: [[1]] } };
  var r = await renderLive(StreamingStub, spec);
  assert.equal(created.length, 1, 'built from the seed, no wait');
  streams[0].emit(tick('t1', 2));
  r.frames.flush();
  assert.equal(created[0].pushes.length, 1);
  r.handle.destroy();
});

// ------------------------------------------------------- prepareLive (session)
/**
 * Let pending promise callbacks run.
 * @returns {Promise<void>} Resolves after the microtask queue drains.
 */
function settle() { return new Promise(function (r) { setTimeout(r, 0); }); }

test('prepareLive runs once before streams open, only for a spec with a live source', async function () {
  var order = [];
  var release;
  var gate = new Promise(function (r) { release = r; });
  var frames = manualFrames();
  var handle = await renderDashboard(LIVE_SPEC, document.createElement('div'), {
    CanvasXpress: StreamingStub, EventSource: FakeEventSource, requestAnimationFrame: frames.schedule,
    prepareLive: function () { order.push('prepare'); return gate; }
  });
  assert.deepEqual(order, ['prepare']);
  assert.equal(streams.length, 0, 'no stream until the session is ready');
  release();
  await settle();
  assert.equal(streams.length, 1, 'stream opened once prepareLive settled');
  handle.destroy();

  var calls = 0;
  var plain = { id: 'plain', layout: { cols: 12, items: [{ panel: 'p', x: 0, y: 0, w: 12, h: 3 }] },
    data: { d: { kind: 'inline', value: { y: { vars: ['a'], smps: ['s'], data: [[1]] } } } },
    panels: { p: { title: 'P', dataRef: 'd', config: { graphType: 'Bar' } } } };
  var h2 = await renderDashboard(plain, document.createElement('div'), {
    CanvasXpress: StreamingStub, EventSource: FakeEventSource,
    prepareLive: function () { calls++; }
  });
  assert.equal(calls, 0, 'not called without a live source');
  h2.destroy();
});

test('a dashboard destroyed before prepareLive settles never opens a stream', async function () {
  var release;
  var handle = await renderDashboard(LIVE_SPEC, document.createElement('div'), {
    CanvasXpress: StreamingStub, EventSource: FakeEventSource, requestAnimationFrame: manualFrames().schedule,
    prepareLive: function () { return new Promise(function (r) { release = r; }); }
  });
  handle.destroy();
  release();
  await settle();
  assert.equal(streams.length, 0);
});

test('a failing prepareLive still opens the stream (which reports its own refusal)', async function () {
  var handle = await renderDashboard(LIVE_SPEC, document.createElement('div'), {
    CanvasXpress: StreamingStub, EventSource: FakeEventSource, requestAnimationFrame: manualFrames().schedule,
    prepareLive: function () { return Promise.reject(new Error('bridge down')); }
  });
  await settle();
  assert.equal(streams.length, 1);
  handle.destroy();
});

// ------------------------------------------------------------ builder (no code)
/**
 * A builder-friendly CanvasXpress stub (getConfig resolves the builder's
 * post-render baseline immediately) with the streaming seam.
 * @returns {function} Constructor.
 */
function builderCX() {
  function CX(id, data, config) {
    this.data = data;
    this.config = config || {};
    this.pushes = [];
    created.push(this);
  }
  CX.prototype.getConfig = function () { return this.config; };
  CX.prototype.setDimensions = function () {};
  CX.prototype.destroy = function () { this.destroyed = true; };
  CX.prototype.pushData = function (t) { this.pushes.push(t); };
  CX.prototype.updateData = function () {};
  return CX;
}

/**
 * The first <select> offering an option value.
 * @param {object} root - Container.
 * @param {string} value - Option value.
 * @returns {object|null} The select.
 */
function selectOffering(root, value) {
  var selects = root.querySelectorAll('select');
  for (var i = 0; i < selects.length; i++) {
    if (selects[i].options.some(function (o) { return o.value === value; })) return selects[i];
  }
  return null;
}

/**
 * The number input carrying a placeholder.
 * @param {object} root - Container.
 * @param {string} placeholder - Placeholder text.
 * @returns {object|undefined} The input.
 */
function numberInput(root, placeholder) {
  return root.querySelectorAll('input').filter(function (i) {
    return i.type === 'number' && i.attributes.placeholder === placeholder;
  })[0];
}

test('builder: pick a live stream, then set its window and interval — no code', async function () {
  var prepared = 0;
  var container = document.createElement('div');
  var builder = createBuilder(container, {
    spec: setDataSource(blankSpec('d1'), 'sample', { kind: 'inline', value: { y: { vars: ['m'], smps: ['a'], data: [[1]] } } }),
    CanvasXpress: builderCX(),
    EventSource: FakeEventSource,
    requestAnimationFrame: manualFrames().schedule,
    prepareLive: function () { prepared++; return Promise.resolve(); },
    listLiveSources: function () {
      return Promise.resolve([{ name: 'demo', title: 'Simulated metrics (demo)',
        url: '/connectors/api/stream/demo?vars=cpu,mem', variables: ['cpu', 'mem'] }]);
    }
  });
  builder.addPanel({ id: 'p1', title: 'P', dataRef: 'sample', config: { graphType: 'Bar' } });
  await builder.whenReady();
  await settle();

  var select = selectOffering(container, ' cx-live:0');
  assert.ok(select, 'the stream is offered in the Data dropdown');
  var option = select.options.filter(function (o) { return o.value === ' cx-live:0'; })[0];
  assert.match(option.textContent, /Simulated metrics \(demo\)/);

  select.value = ' cx-live:0';
  select.dispatchEvent('change');
  await builder.whenReady();
  await settle();

  var spec = builder.getSpec();
  assert.deepEqual(spec.data.demo, { kind: 'live', url: '/connectors/api/stream/demo?vars=cpu,mem',
    variables: ['cpu', 'mem'] });
  assert.equal(spec.panels.p1.dataRef, 'demo');
  assert.equal(spec.panels.p1.config.graphType, 'Line', 'the default Bar becomes a Line');
  assert.equal(spec.panels.p1.config.graphOrientation, 'vertical');
  assert.equal(validateSpec(spec).valid, true);
  assert.ok(prepared >= 1, 'the host session hook ran');
  var open = streams.filter(function (s) { return !s.closed; });
  assert.equal(open.length, 1);
  assert.equal(open[0].url, '/connectors/api/stream/demo?vars=cpu,mem');
  assert.equal(selectOffering(container, ' cx-live:0').value, ' cx-live:0', 'the dropdown reflects the binding');

  var windowField = numberInput(container, '1000');
  assert.ok(windowField, 'Window field shown for a live source');
  windowField.value = '120';
  windowField.dispatchEvent('change');
  await builder.whenReady();
  await settle();
  assert.equal(builder.getSpec().data.demo.window, 120);

  var everyField = numberInput(container, '1');
  assert.ok(everyField, 'Every field shown for a live source');
  everyField.value = '0.5';
  everyField.dispatchEvent('change');
  await builder.whenReady();
  await settle();
  var url = builder.getSpec().data.demo.url;
  assert.equal(url, '/connectors/api/stream/demo?vars=cpu,mem&interval=0.5', 'other params kept');
  var live = streams.filter(function (s) { return !s.closed; });
  assert.equal(live.length, 1, 'the old stream closed; one open with the new settings');
  assert.equal(live[0].url, url);
  assert.equal(selectOffering(container, ' cx-live:0').value, ' cx-live:0',
    'still recognised as the listed stream after the interval changed');
  builder.destroy();
});

// ------------------------------------------------ async init / failure resync
test('a tick that arrives before the chart initialised is not lost (full-window resync)', async function () {
  // CanvasXpress attaches its methods asynchronously after the constructor: model
  // an instance whose pushData/updateData appear only later.
  var late = [];
  function LateStub(id, data) {
    this.initial = data;
    this.pushes = [];
    this.updates = [];
    late.push(this);
  }
  function ready(inst) {
    inst.pushData = function (t) { this.pushes.push(t); };
    inst.updateData = function (d) { this.updates.push(d); };
  }
  var spec = JSON.parse(JSON.stringify(LIVE_SPEC));
  spec.data.feed.initial = { y: { vars: ['cpu'], smps: ['s0'], data: [[1]] } };
  var r = await renderLive(LateStub, spec);
  var inst = late[0];

  streams[0].emit(tick('t1', 2));
  r.frames.flush();                   // not initialised yet: nothing can be applied
  ready(inst);
  streams[0].emit(tick('t2', 3));
  r.frames.flush();
  assert.equal(inst.pushes.length, 0, 'no increment while stale');
  assert.deepEqual(inst.updates[0].y.smps, ['s0', 't1', 't2'], 'resynced with the full window: t1 not lost');

  streams[0].emit(tick('t3', 4));
  r.frames.flush();
  assert.deepEqual(inst.pushes.map(function (t) { return t.y.smps[0]; }), ['t3'], 'back to increments');
  r.handle.destroy();
});

test('a pushData that throws is followed by a full-window resync', async function () {
  var spec = JSON.parse(JSON.stringify(LIVE_SPEC));
  spec.data.feed.initial = { y: { vars: ['cpu'], smps: ['s0'], data: [[1]] } };
  var r = await renderLive(StreamingStub, spec);
  var inst = created[0];
  var fail = true;
  inst.pushData = function (t) { if (fail) { fail = false; throw new Error('boom'); } this.pushes.push(t); };
  streams[0].emit(tick('t1', 2));
  r.frames.flush();
  streams[0].emit(tick('t2', 3));
  r.frames.flush();
  assert.deepEqual(inst.updates[inst.updates.length - 1].y.smps, ['s0', 't1', 't2']);
  streams[0].emit(tick('t3', 4));
  r.frames.flush();
  assert.deepEqual(inst.pushes.map(function (t) { return t.y.smps[0]; }), ['t3']);
  r.handle.destroy();
});

test('a stream that fails for good marks waiting panels as errored, not "Loading…" forever', async function () {
  var r = await renderLive(StreamingStub);
  streams[0].readyState = 2;                 // CLOSED: e.g. the server answered 404
  streams[0].onerror({ type: 'error' });
  var overlay = r.handle.container.querySelector('.cxd-error');
  assert.ok(overlay, 'the panel shows an error');
  assert.match(overlay.textContent, /Live stream unavailable/);
  r.handle.destroy();
});

test('a transient stream error (browser reconnecting) leaves the panel waiting', async function () {
  var r = await renderLive(StreamingStub);
  streams[0].readyState = 0;                 // CONNECTING: EventSource is retrying
  streams[0].onerror({ type: 'error' });
  assert.equal(r.handle.container.querySelector('.cxd-error'), null);
  r.handle.destroy();
});
