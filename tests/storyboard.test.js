/**
 * Storyboards: the `storyboard` spec block (validated) and the player that steps a dashboard
 * through it. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '../src/validateSpec.js';
import { canonicalSpec } from '../src/spec.js';
import { mountStoryboard, storyboardSteps } from '../src/storyboard.js';
import { installDom } from './helpers/dom-stub.js';

function spec(storyboard) {
  return {
    id: 'sb',
    layout: { cols: 12, items: [{ panel: 'bar', x: 0, y: 0, w: 6, h: 3 }] },
    data: { d: { kind: 'inline', value: { y: {} } } },
    panels: { bar: { dataRef: 'd', config: { graphType: 'Bar' } } },
    params: { 'case': { value: 'P1' } },
    filterSchemes: { 'Drug arm': [{ dataRef: 'd', field: 'arm', values: ['Drug'] }] },
    storyboard: storyboard
  };
}

test('a storyboard of schemes, filters, params and a focus panel is valid', function () {
  assert.deepEqual(validateSpec(spec({
    title: 'Tour', seconds: 5,
    steps: [
      { title: 'All', narration: 'Everyone.' },
      { title: 'Drug', scheme: 'Drug arm', focus: 'bar' },
      { filters: [{ dataRef: 'd', field: 'arm', values: ['Placebo'] }], params: { 'case': 'P7' }, seconds: 3 }
    ]
  })).errors, []);
});

test('every malformed part of a storyboard is reported (the same words as the server validator)', function () {
  var errors = validateSpec(spec({
    title: 3, seconds: 0,
    steps: [
      { title: 1, narration: [], seconds: -1 },
      { scheme: 'nope' },
      { scheme: 'Drug arm', filters: [] },
      { filters: 'x', params: { ghost: 1 }, focus: 'missing' },
      { filters: [{ dataRef: 'zz', field: 'a' }], params: [1] },
      'x'
    ]
  })).errors;
  [
    'spec.storyboard.title must be a string',
    'spec.storyboard.seconds must be a number above 0',
    'spec.storyboard.steps[0].title must be a string',
    'spec.storyboard.steps[0].narration must be a string',
    'spec.storyboard.steps[0].seconds must be a number above 0',
    'spec.storyboard.steps[1].scheme "nope" has no matching entry in spec.filterSchemes',
    'spec.storyboard.steps[2] takes either scheme or filters, not both',
    'spec.storyboard.steps[3].filters must be an array of filters',
    'spec.storyboard.steps[3].params["ghost"] is not declared in spec.params',
    'spec.storyboard.steps[3].focus "missing" has no matching entry in spec.panels',
    'spec.storyboard.steps[4].filters[0].dataRef has no matching entry in spec.data',
    'spec.storyboard.steps[4].params must be an object map',
    'spec.storyboard.steps[5] must be an object'
  ].forEach(function (message) { assert.ok(errors.indexOf(message) !== -1, message + ' in ' + JSON.stringify(errors)); });
  assert.deepEqual(validateSpec(spec({ steps: [] })).errors, ['spec.storyboard.steps must be a non-empty array']);
  assert.deepEqual(validateSpec(spec([1])).errors, ['spec.storyboard must be an object']);
});

test('storyboard is a known top-level key: it keeps its place when a spec is saved', function () {
  var keys = Object.keys(canonicalSpec(spec({ steps: [{ title: 'a' }] })));
  assert.ok(keys.indexOf('storyboard') > keys.indexOf('panels'));
});

function fakeHandle() {
  var views = [];
  return { views: views, applyView: function (view) { views.push(view); return Promise.resolve(); } };
}
function fakeTimers() {
  var queue = [];
  return {
    queue: queue,
    setTimer: function (fn, ms) { queue.push({ fn: fn, ms: ms }); return queue.length; },
    clearTimer: function (id) { if (queue[id - 1]) queue[id - 1].fn = null; },
    fire: function () { var t = queue.filter(function (x) { return x.fn; }).pop(); var fn = t.fn; t.fn = null; fn(); }
  };
}
var SPEC = spec({ title: 'Tour', seconds: 4, steps: [
  { title: 'All', narration: 'Everyone <b>x</b>' },
  { title: 'Drug', scheme: 'Drug arm', focus: 'bar', seconds: 2 },
  { title: 'Case', params: { 'case': 'P7' } }
] });

test('nothing mounts without steps or without a handle that can apply a view', function () {
  installDom();
  assert.equal(mountStoryboard({ spec: { id: 'x' }, handle: fakeHandle(), document: document }), null);
  assert.equal(mountStoryboard({ spec: SPEC, handle: {}, document: document }), null);
  assert.deepEqual(storyboardSteps(null), []);
});

test('next, previous and the dots apply each step as a complete view; narration is text, never markup', async function () {
  installDom();
  var handle = fakeHandle();
  var host = document.createElement('div');
  document.body.appendChild(host);
  var player = mountStoryboard({ spec: SPEC, handle: handle, container: host, document: document });
  assert.ok(host.querySelector('.cxd-storyboard'), 'mounted in the container');
  assert.equal(handle.views.length, 0, 'the dashboard is left alone until the viewer acts');
  await player.next();
  assert.deepEqual(handle.views[0], { scheme: undefined, filters: undefined, params: undefined, focus: undefined });
  assert.equal(host.querySelector('.cxd-sb-title').textContent, 'All');
  assert.equal(host.querySelector('.cxd-sb-text').textContent, 'Everyone <b>x</b>');
  assert.equal(host.querySelector('.cxd-sb-count').textContent, '1 / 3');
  await player.next();
  assert.equal(handle.views[1].scheme, 'Drug arm');
  assert.equal(handle.views[1].focus, 'bar');
  await player.go(2);
  assert.deepEqual(handle.views[2].params, { 'case': 'P7' });
  await player.prev();
  assert.equal(handle.views[3].scheme, 'Drug arm', 'stepping back re-applies that step');
  assert.equal(host.querySelectorAll('.cxd-sb-dot--on').length, 1);
  assert.equal(host.querySelector('.cxd-sb-text').style.display, 'none', 'a step with no narration hides the line');
});

test('play advances after each step\'s own seconds (or the default), then stops at the end', async function () {
  installDom();
  var handle = fakeHandle();
  var timers = fakeTimers();
  var player = mountStoryboard({ spec: SPEC, handle: handle, document: document, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  await player.play();
  await Promise.resolve();
  assert.equal(handle.views.length, 1);
  assert.equal(timers.queue[0].ms, 4000, 'the storyboard default');
  timers.fire();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(handle.views.length, 2);
  assert.equal(timers.queue[1].ms, 2000, 'the step\'s own seconds');
  timers.fire();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(handle.views.length, 3);
  timers.fire();
  assert.equal(player.index(), 2);
  assert.equal(player.element.querySelector('.cxd-sb-play').textContent, '▶', 'stopped on the last step');
});

test('pausing cancels the pending advance; pressing next while playing pauses', async function () {
  installDom();
  var handle = fakeHandle();
  var timers = fakeTimers();
  var player = mountStoryboard({ spec: SPEC, handle: handle, document: document, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  await player.play();
  await Promise.resolve();
  player.pause();
  assert.equal(timers.queue.filter(function (t) { return t.fn; }).length, 0);
  assert.equal(handle.views.length, 1);
  player.destroy();
  assert.ok(!player.element.parentNode, 'destroy removes the bar');
});

test('the shipped Cohort Tour example is valid, in both validators, and its narration quotes its own data', async function () {
  var fs = await import('node:fs');
  var spec = JSON.parse(fs.readFileSync(new URL('../examples/cohort-tour.spec.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateSpec(spec).errors, []);
  assert.equal(spec.storyboard.steps.length, 4);
  var data = spec.data.data.value;
  var arm = data.x.arm, months = data.y.data[0];
  var drug = months.filter(function (m, i) { return arm[i] === 'Drug'; }).sort(function (a, b) { return a - b; });
  var mid = drug.length >> 1;
  var median = drug.length % 2 ? drug[mid] : (drug[mid - 1] + drug[mid]) / 2;
  assert.ok(spec.storyboard.steps[1].narration.indexOf('median follow-up is ' + median + ' months') !== -1,
    'the drug-arm step quotes the data: ' + spec.storyboard.steps[1].narration);
  // The engine's log-rank test throws when the two earliest distinct follow-up times are both censored.
  var event = data.y.data[1];
  var first = {};
  months.forEach(function (m, i) { first[m] = (first[m] || 0) + event[i]; });
  var leading = Object.keys(first).map(Number).sort(function (a, b) { return a - b; }).slice(0, 2);
  assert.ok(leading.some(function (t) { return first[t] > 0; }), 'a leading event keeps the Kaplan-Meier panel from throwing');
});
