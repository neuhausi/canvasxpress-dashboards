/**
 * Unit tests for the spec validator. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '../src/validateSpec.js';

var VALID = {
  id: 'sales-overview',
  layout: { cols: 12, items: [{ panel: 'bar', x: 0, y: 0, w: 6, h: 3 }] },
  data: { sales: { kind: 'inline', value: { y: {} } } },
  panels: { bar: { dataRef: 'sales', config: { graphType: 'Bar' } } },
  controls: [{ kind: 'table', dataRef: 'sales' }]
};

test('accepts a well-formed spec', function () {
  var result = validateSpec(VALID);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('rejects a non-object spec', function () {
  assert.equal(validateSpec(null).valid, false);
  assert.equal(validateSpec('nope').valid, false);
  assert.equal(validateSpec([]).valid, false);
});

test('requires id, layout, and panels', function () {
  var result = validateSpec({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(function (e) { return e.includes('spec.id'); }));
  assert.ok(result.errors.some(function (e) { return e.includes('spec.layout'); }));
  assert.ok(result.errors.some(function (e) { return e.includes('spec.panels'); }));
});

test('flags a layout item referencing an unknown panel', function () {
  var spec = clone(VALID);
  spec.layout.items[0].panel = 'ghost';
  var result = validateSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(function (e) { return e.includes('no matching entry in spec.panels'); }));
});

test('flags a panel dataRef with no matching data source', function () {
  var spec = clone(VALID);
  spec.panels.bar.dataRef = 'missing';
  var result = validateSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(function (e) { return e.includes('dataRef "missing"'); }));
});

test('requires integer x/y/w/h on layout items', function () {
  var spec = clone(VALID);
  spec.layout.items[0].w = 'six';
  var result = validateSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(function (e) { return e.includes('.w is required'); }));
});

test('requires inline sources to carry a value and connectors a url', function () {
  var spec = clone(VALID);
  spec.data.sales = { kind: 'inline' };
  assert.equal(validateSpec(spec).valid, false);

  spec.data.sales = { kind: 'connector' };
  assert.equal(validateSpec(spec).valid, false);

  spec.data.sales = { kind: 'connector', url: '/api/data?source=sales' };
  // panel still points at sales; connector url present -> valid
  assert.equal(validateSpec(spec).valid, true);
});

test('requires dataset sources to carry an id', function () {
  var spec = clone(VALID);
  spec.data.sales = { kind: 'dataset' };
  assert.equal(validateSpec(spec).valid, false);

  spec.data.sales = { kind: 'dataset', id: 'sales-2026' };
  assert.equal(validateSpec(spec).valid, true);
});

test('flags an unknown control kind', function () {
  var spec = clone(VALID);
  spec.controls = [{ kind: 'widget' }];
  var result = validateSpec(spec);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(function (e) { return e.includes('.kind must be "filter" or "table"'); }));
});

/**
 * Deep-clone a JSON-safe fixture.
 * @param {object} obj - Source.
 * @returns {object} A structural copy.
 */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

test('a text panel needs no dataRef or inline data', function () {
  var spec = {
    id: 'd1', title: 'D',
    layout: { cols: 12, items: [{ panel: 't1', x: 0, y: 0, w: 4, h: 2 }] },
    panels: { t1: { type: 'text', text: 'Hi' } },
    data: {}
  };
  var res = validateSpec(spec);
  assert.equal(res.valid, true, JSON.stringify(res.errors));
});

test('a valid control panel passes', function () {
  var spec = {
    id: 'd1',
    layout: { cols: 12, items: [{ panel: 'c1', x: 0, y: 0, w: 4, h: 2 }] },
    data: { sales: { kind: 'inline', value: { y: {} } } },
    panels: { c1: { type: 'control', dataRef: 'sales', compartment: 'x', annotation: 'Region', style: 'auto' } }
  };
  var res = validateSpec(spec);
  assert.equal(res.valid, true, JSON.stringify(res.errors));
});

test('flags a bad control compartment and style', function () {
  var spec = {
    id: 'd1',
    layout: { cols: 12, items: [{ panel: 'c1', x: 0, y: 0, w: 4, h: 2 }] },
    data: { sales: { kind: 'inline', value: { y: {} } } },
    panels: { c1: { type: 'control', dataRef: 'sales', compartment: 'y', style: 'sliders' } }
  };
  var res = validateSpec(spec);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(function (e) { return e.includes('.compartment must be'); }));
  assert.ok(res.errors.some(function (e) { return e.includes('.style must be'); }));
});

test('flags bad align/valign values', function () {
  var spec = {
    id: 'd1',
    layout: { cols: 12, items: [{ panel: 't1', x: 0, y: 0, w: 4, h: 2 }] },
    panels: { t1: { type: 'text', text: 'Hi', align: 'justify', valign: 'baseline' } },
    data: {}
  };
  var res = validateSpec(spec);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(function (e) { return e.includes('.align must be'); }));
  assert.ok(res.errors.some(function (e) { return e.includes('.valign must be'); }));
});

test('accepts a param control + parameterized source', function () {
  var spec = {
    id: 'live',
    params: { region: { value: 'All', type: 'string' } },
    layout: { cols: 12, items: [
      { panel: 'pick', x: 0, y: 0, w: 3, h: 1 },
      { panel: 'bar', x: 0, y: 1, w: 6, h: 3 }
    ] },
    data: { sales: { kind: 'connector', url: '/api/data', query: { region: '$region' } } },
    panels: {
      pick: { type: 'control', mode: 'param', param: 'region', options: ['All', 'EMEA', 'APAC'] },
      bar: { dataRef: 'sales', config: { graphType: 'Bar' } }
    }
  };
  var res = validateSpec(spec);
  assert.equal(res.valid, true, JSON.stringify(res.errors));
});

test('flags a param control referencing an undeclared param', function () {
  var spec = {
    id: 'live',
    params: { region: { value: 'All' } },
    layout: { cols: 12, items: [{ panel: 'pick', x: 0, y: 0, w: 3, h: 1 }] },
    panels: { pick: { type: 'control', mode: 'param', param: 'zone', options: ['a'] } }
  };
  var res = validateSpec(spec);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(function (e) { return e.includes('.param "zone"'); }));
});

test('flags a query token referencing an undeclared param', function () {
  var spec = {
    id: 'live',
    layout: { cols: 12, items: [{ panel: 'bar', x: 0, y: 0, w: 6, h: 3 }] },
    data: { sales: { kind: 'connector', url: '/api/data', query: { region: '$region' } } },
    panels: { bar: { dataRef: 'sales' } }
  };
  var res = validateSpec(spec);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(function (e) { return e.includes('undeclared param "region"'); }));
});

test('flags a bad control mode', function () {
  var spec = {
    id: 'live',
    layout: { cols: 12, items: [{ panel: 'pick', x: 0, y: 0, w: 3, h: 1 }] },
    data: { s: { kind: 'inline', value: { y: {} } } },
    panels: { pick: { type: 'control', mode: 'nope', dataRef: 's' } }
  };
  var res = validateSpec(spec);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(function (e) { return e.includes('.mode must be'); }));
});
