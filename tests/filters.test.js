/**
 * Unit tests for the Filters-panel model: field resolution and summaries,
 * predicate evaluation, and state normalization.
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFields, summarizeField, rowsPassing, normalizeState, isActive, MAX_LIST_VALUES } from '../src/filters.js';

var CLIN = {
  y: { vars: ['Age'], smps: ['c1', 'c2', 'c3', 'c4', 'c5'], data: [[61, 55, 70, null, 66]] },
  x: { Arm: ['drug', 'placebo', 'drug', 'placebo', null], Site: ['Boston', 'boston', 'Austin', 'Denver', 'Boston'] }
};
var GENES = { y: { vars: ['TP53', 'EGFR'], smps: ['logFC'], data: [[1.5], [-2]] }, z: { Chr: ['17', '7'] } };
var AXES = { clin: 'smps', genes: 'vars' };

/**
 * Data lookup for the fixtures.
 * @param {string} ref - Source ref.
 * @returns {object} Data.
 */
function dataOf(ref) { return { clin: CLIN, genes: GENES }[ref] || null; }
/**
 * Axis lookup for the fixtures.
 * @param {string} ref - Source ref.
 * @returns {string} Axis.
 */
function axisOf(ref) { return AXES[ref] || 'smps'; }

test('auto fields: row annotations then numeric columns, kinds detected', function () {
  var fields = resolveFields({ dataRef: 'clin' }, dataOf, axisOf);
  assert.deepEqual(fields.map(function (f) { return f.field + ':' + f.kind; }), ['Arm:values', 'Site:values', 'Age:range']);
  assert.deepEqual(fields[0].summary.values, [{ value: 'drug', count: 2 }, { value: 'placebo', count: 2 }]);
  assert.equal(fields[2].summary.min, 55);
  assert.equal(fields[2].summary.max, 70);
});

test('auto fields follow the source axis (vars: z annotations, sample columns)', function () {
  var fields = resolveFields({ dataRef: 'genes' }, dataOf, axisOf);
  assert.deepEqual(fields.map(function (f) { return f.field + ':' + f.kind; }), ['Chr:values', 'logFC:range']);
});

test('explicit fields: names of the panel source, or {field, dataRef, kind, label}', function () {
  var fields = resolveFields({ dataRef: 'clin', fields: ['Arm', { field: 'smps', kind: 'search' }, { field: 'Chr', dataRef: 'genes', label: 'Chromosome' }, 'Nope'] }, dataOf, axisOf);
  assert.deepEqual(fields.map(function (f) { return [f.label, f.kind]; }), [
    ['Arm (clin)', 'values'], ['smps (clin)', 'search'], ['Chromosome', 'values']
  ]);
});

test('many distinct values become a search box; ids are never a range', function () {
  var ids = [];
  var vals = [];
  for (var i = 0; i <= MAX_LIST_VALUES; i++) { ids.push('s' + i); vals.push('v' + i); }
  var data = { y: { vars: ['N'], smps: ids, data: [ids.map(function (_, k) { return k; })] }, x: { Tag: vals } };
  var fields = resolveFields({ dataRef: 'big', fields: ['Tag', 'smps'] }, function () { return data; }, function () { return 'smps'; });
  assert.deepEqual(fields.map(function (f) { return f.kind; }), ['search', 'search']);
  assert.equal(summarizeField({ y: { vars: [], smps: ['1', '2'], data: [] } }, 'smps', 'smps').numeric, false);
});

test('rowsPassing: values, ranges and text AND together; missing values fail', function () {
  var state = [
    { dataRef: 'clin', field: 'Arm', values: ['drug', 'placebo'] },
    { dataRef: 'clin', field: 'Age', min: 56 },
    { dataRef: 'clin', field: 'Site', text: 'BOS' },
    { dataRef: 'other', field: 'X', values: [] }
  ];
  assert.deepEqual(rowsPassing(state, 'clin', CLIN, 'smps'), ['c1']);
  assert.deepEqual(rowsPassing([{ dataRef: 'clin', field: 'Age', max: 65 }], 'clin', CLIN, 'smps'), ['c1', 'c2']);
  assert.deepEqual(rowsPassing([{ dataRef: 'clin', field: 'Arm', values: [] }], 'clin', CLIN, 'smps'), []);
  assert.equal(rowsPassing(state, 'nobody', CLIN, 'smps'), null);
  assert.equal(rowsPassing([{ dataRef: 'clin', field: 'Arm', text: '  ' }], 'clin', CLIN, 'smps'), null, 'blank text is inactive');
});

test('normalizeState keeps one active predicate per field (last wins)', function () {
  var out = normalizeState([
    { dataRef: 'clin', field: 'Arm', values: ['drug'] },
    { dataRef: 'clin', field: 'Age', min: 'x' },
    null,
    { dataRef: 'clin', field: 'Arm', values: [1, 'placebo'], extra: true },
    { dataRef: 'clin', field: 'Site', text: 'bo' }
  ]);
  assert.deepEqual(out, [
    { dataRef: 'clin', field: 'Arm', values: ['1', 'placebo'] },
    { dataRef: 'clin', field: 'Site', text: 'bo' }
  ]);
  assert.equal(isActive({ min: 0 }), true);
  assert.equal(isActive({}), false);
});
