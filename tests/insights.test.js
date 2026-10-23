/**
 * Proactive insights, client side: the `insights` spec block (validated) and, below, the strip that
 * shows the server's insights. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '../src/validateSpec.js';
import { canonicalSpec } from '../src/spec.js';
import { mountInsights, insightsDrill } from '../src/insights.js';
import { installDom } from './helpers/dom-stub.js';

function spec(insights) {
  return {
    id: 'qc',
    layout: { cols: 12, items: [{ panel: 'bar', x: 0, y: 0, w: 6, h: 3 }] },
    data: { d: { kind: 'inline', value: { y: {} } } },
    panels: { bar: { dataRef: 'd', config: { graphType: 'Bar' } } },
    insights: insights
  };
}

test('an insights block with thresholds, sources and a cap is valid; so is an empty one', function () {
  assert.deepEqual(validateSpec(spec({
    thresholds: [{ field: 'q30', op: 'lt', value: 85, label: 'Q30 below 85%', source: 'd' }],
    sources: ['d'], max: 4
  })).errors, []);
  assert.deepEqual(validateSpec(spec({})).errors, []);
});

test('every malformed part of an insights block is reported (the same words as the server validator)', function () {
  var errors = validateSpec(spec({
    thresholds: [{ field: '', op: 'near', value: 'x', label: 3, source: 'nope' }, 'x'],
    sources: ['ghost', 7], max: 0
  })).errors;
  [
    'spec.insights.thresholds[0].field must be a non-empty field name',
    'spec.insights.thresholds[0].op must be one of: lt, le, gt, ge',
    'spec.insights.thresholds[0].value must be a number',
    'spec.insights.thresholds[0].label must be a string',
    'spec.insights.thresholds[0].source "nope" has no matching entry in spec.data',
    'spec.insights.thresholds[1] must be an object',
    'spec.insights.sources[0] "ghost" has no matching entry in spec.data',
    'spec.insights.max must be a positive whole number'
  ].forEach(function (message) { assert.ok(errors.indexOf(message) !== -1, message); });
  [[1], 'yes', 3].forEach(function (wrong) {
    assert.deepEqual(validateSpec(spec(wrong)).errors, ['spec.insights must be an object']);
  });
  assert.ok(validateSpec(spec({ thresholds: 'all', sources: 'd', max: 1.5 })).errors.length === 3);
});

test('insights is a known top-level key: it keeps its place when a spec is saved', function () {
  var keys = Object.keys(canonicalSpec(spec({ max: 3 })));
  assert.ok(keys.indexOf('insights') > keys.indexOf('panels'));
  assert.deepEqual(canonicalSpec(spec({ max: 3 })).insights, { max: 3 });
});

// --- the strip ---

var BODY = {
  enabled: true, more: 2,
  checked: { sources: ['d'], tests: 6, skipped: [], problems: [] },
  insights: [
    { id: 'threshold:d:q30:lt:85', kind: 'threshold', severity: 'warn', source: 'd', field: 'q30',
      caption: 'Q30 below 85%: 3 of 48 records have q30 below 85 (S1, S4, S7).',
      figures: { field: 'q30', count: 3, n: 48, ids: [{ id: 'S1', value: 80 }, { id: 'S4', value: 81 }] }, ids: ['S1', 'S4', 'S7'] },
    { id: 'difference:d:lane:q30', kind: 'group-difference', severity: 'info', source: 'd', field: 'q30',
      caption: 'q30 differs by lane: L4 has the highest median.', figures: { p: 0.0004, epsilon2: 0.31, groups: [{ group: 'L4', n: 12, median: 91 }] }, ids: [] }
  ]
};

function fakeFetch(body, status) {
  var calls = [];
  var fn = function (url, init) {
    calls.push({ url: url, init: init });
    return Promise.resolve({ ok: status == null || status < 400, status: status || 200, json: function () { return Promise.resolve(body); } });
  };
  fn.calls = calls;
  return fn;
}

var DRILL_SPEC = {
  params: { 'case': { value: 'S1' } },
  data: { data: { kind: 'dataset', id: 'd' }, 'case': { kind: 'dataset', id: 'd', pushdown: { where: [{ column: 'smps', op: '=', value: '$case' }] } } },
  panels: { chart: { dataRef: 'data' }, 'case': { dataRef: 'case' } }
};

test('insightsDrill finds the case param and the card that reads it', function () {
  assert.deepEqual(insightsDrill(DRILL_SPEC), { param: 'case', panel: 'case' });
  assert.equal(insightsDrill({ panels: {}, data: {} }), null);
  assert.equal(insightsDrill(null), null);
});

test('the strip lists each caption with its figures, the records and a +N more note', async function () {
  installDom();
  var anchor = document.createElement('div');
  document.body.appendChild(anchor);
  var strip = await mountInsights({ baseUrl: '/app/', token: 'tok en', before: anchor, fetch: fakeFetch(BODY), document: document });
  assert.ok(strip, 'a strip was mounted');
  assert.equal(document.body.children.indexOf(strip) < document.body.children.indexOf(anchor), true, 'above the dashboard');
  var items = strip.querySelectorAll('.cxd-insight');
  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector('.cxd-insight-caption').textContent, BODY.insights[0].caption);
  assert.ok(/cxd-insight--warn/.test(items[0].className) && /cxd-insight--info/.test(items[1].className));
  var figures = items[0].querySelector('.cxd-insight-figures').textContent;
  assert.ok(figures.indexOf('count: 3') !== -1 && figures.indexOf('n: 48') !== -1 && figures.indexOf('id=S1 value=80') !== -1, figures);
  assert.ok(items[1].querySelector('.cxd-insight-figures').textContent.indexOf('median=91') !== -1);
  var notes = strip.querySelectorAll('.cxd-insights-note').map(function (n) { return n.textContent; });
  assert.ok(notes.some(function (t) { return t === '+2 more not shown'; }), JSON.stringify(notes));
  assert.ok(notes.some(function (t) { return t.indexOf('6 group comparisons, corrected for multiple testing') !== -1; }), JSON.stringify(notes));
});

test('a share link and a signed-in dashboard ask the right endpoints', async function () {
  installDom();
  var shared = fakeFetch(BODY);
  await mountInsights({ baseUrl: '/app', token: 'a/b c', fetch: shared, document: document });
  assert.equal(shared.calls[0].url, '/app/api/shared/a%2Fb%20c/insights');
  var own = fakeFetch(BODY);
  await mountInsights({ baseUrl: '', dashboardId: 'qc', owner: 'dr who', fetch: own, document: document });
  assert.equal(own.calls[0].url, '/api/dashboards/qc/insights?owner=dr%20who');
  assert.equal(own.calls[0].init.credentials, 'include');
});

test('clicking a record loads it into the case card and brings the card into view', async function () {
  installDom();
  var set = [], focused = [];
  var handle = { setParam: function (n, v) { set.push([n, v]); return Promise.resolve(); }, focusPanel: function (p) { focused.push(p); } };
  var strip = await mountInsights({ token: 't', spec: DRILL_SPEC, handle: handle, fetch: fakeFetch(BODY), document: document });
  var buttons = strip.querySelectorAll('.cxd-insight-id');
  assert.deepEqual(buttons.map(function (b) { return b.textContent; }), ['S1', 'S4', 'S7']);   // only the threshold has records
  buttons[1].dispatchEvent('click');
  assert.deepEqual(set, [['case', 'S4']]);
  assert.deepEqual(focused, ['case']);
});

test('records are not offered as buttons when the dashboard has no case card', async function () {
  installDom();
  var handle = { setParam: function () {}, focusPanel: function () {} };
  var strip = await mountInsights({ token: 't', spec: { params: {}, data: {}, panels: {} }, handle: handle, fetch: fakeFetch(BODY), document: document });
  assert.equal(strip.querySelectorAll('.cxd-insight-id').length, 0);
  assert.ok(strip.querySelector('.cxd-insight-caption'), 'the captions still show');
});

test('nothing is mounted when insights are off, empty, or the request fails', async function () {
  installDom();
  var count = function () { return document.body.children.length; };
  assert.equal(await mountInsights({ token: 't', fetch: fakeFetch({ enabled: false, insights: [] }), document: document }), null);
  assert.equal(await mountInsights({ token: 't', fetch: fakeFetch({ enabled: true, insights: [], more: 0 }), document: document }), null);
  assert.equal(await mountInsights({ token: 't', fetch: fakeFetch({}, 404), document: document }), null);
  assert.equal(await mountInsights({ token: 't', fetch: function () { return Promise.reject(new Error('offline')); }, document: document }), null);
  assert.equal(count(), 0);
});
