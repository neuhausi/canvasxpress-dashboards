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
