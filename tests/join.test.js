/**
 * Unit tests for data blending (`joinData`): join types, key forms, column
 * coalescing/suffixing, one-to-many ids, z annotations, and error cases.
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinData, joinCycle, joinProvenance, matchIds } from '../src/join.js';

// Samples: expression-style measurements per patient.
var SAMPLES = {
  y: { vars: ['Age', 'Score'], smps: ['p1', 'p2', 'p3'], data: [[50, 60, 70], [1.5, 2.5, 3.5]] },
  x: { Site: ['A', 'B', 'A'] },
  z: { Unit: ['yr', 'au'] }
};

// Clinical annotations keyed by the same patient ids (p4 has no sample).
var CLINICAL = {
  y: { vars: ['Dose'], smps: ['p2', 'p3', 'p4'], data: [[10, 20, 30]] },
  x: { Arm: ['drug', 'placebo', 'drug'] }
};

test('inner join on sample ids keeps matched rows, left columns first', function () {
  var out = joinData(SAMPLES, CLINICAL);
  assert.deepEqual(out.y.smps, ['p2', 'p3']);
  assert.deepEqual(out.y.vars, ['Age', 'Score', 'Dose']);
  assert.deepEqual(out.y.data, [[60, 70], [2.5, 3.5], [10, 20]]);
  assert.deepEqual(out.x, { Site: ['B', 'A'], Arm: ['drug', 'placebo'] });
});

test('left join keeps unmatched left rows with nulls', function () {
  var out = joinData(SAMPLES, CLINICAL, { how: 'left' });
  assert.deepEqual(out.y.smps, ['p1', 'p2', 'p3']);
  assert.deepEqual(out.y.data[2], [null, 10, 20]);
  assert.deepEqual(out.x.Arm, [null, 'drug', 'placebo']);
});

test('right join follows right row order and ids its right-only rows by key', function () {
  var out = joinData(SAMPLES, CLINICAL, { how: 'right' });
  assert.deepEqual(out.y.smps, ['p2', 'p3', 'p4']);
  assert.deepEqual(out.y.data[0], [60, 70, null]);
  assert.deepEqual(out.y.data[2], [10, 20, 30]);
});

test('outer join keeps both sides, unmatched right rows appended', function () {
  var out = joinData(SAMPLES, CLINICAL, { how: 'outer' });
  assert.deepEqual(out.y.smps, ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(out.x.Site, ['A', 'B', 'A', null]);
  assert.deepEqual(out.x.Arm, [null, 'drug', 'placebo', 'drug']);
});

test('joins on a shared annotation column, coalescing it into one column', function () {
  var left = { y: { vars: ['V'], smps: ['s1', 's2'], data: [[1, 2]] }, x: { Patient: ['p1', 'p2'] } };
  var right = { y: { vars: ['W'], smps: ['r1', 'r2'], data: [[7, 8]] }, x: { Patient: ['p2', 'p9'] } };
  var out = joinData(left, right, { on: 'Patient', how: 'outer' });
  assert.deepEqual(out.y.smps, ['s1', 's2', 'r2']);
  assert.deepEqual(Object.keys(out.x), ['Patient']);
  assert.deepEqual(out.x.Patient, ['p1', 'p2', 'p9']);
  assert.deepEqual(out.y.data, [[1, 2, null], [null, 7, 8]]);
});

test('maps differently named key columns with {left, right}', function () {
  var left = { y: { vars: ['V'], smps: ['s1', 's2'], data: [[1, 2]] }, x: { pid: ['p1', 'p2'] } };
  var right = { y: { vars: ['W'], smps: ['p2', 'p1'], data: [[20, 10]] } };
  var out = joinData(left, right, { on: { left: 'pid', right: 'smps' } });
  assert.deepEqual(out.y.smps, ['s1', 's2']);
  assert.deepEqual(out.y.data[1], [10, 20]);
  assert.deepEqual(out.x.pid, ['p1', 'p2']);
});

test('composite keys must match on every part', function () {
  var left = { y: { vars: ['V'], smps: ['a', 'b'], data: [[1, 2]] }, x: { pid: ['p1', 'p1'], visit: ['1', '2'] } };
  var right = { y: { vars: ['W'], smps: ['r1', 'r2'], data: [[5, 6]] }, x: { pid: ['p1', 'p1'], visit: ['2', '3'] } };
  var out = joinData(left, right, { on: ['pid', 'visit'] });
  assert.deepEqual(out.y.smps, ['b']);
  assert.deepEqual(out.y.data, [[2], [5]]);
});

test('keys compare as strings; missing keys never match', function () {
  var left = { y: { vars: ['Id', 'V'], smps: ['a', 'b', 'c'], data: [[1, 2, null], [10, 20, 30]] } };
  var right = { y: { vars: ['W'], smps: ['r1', 'r2', 'r3'], data: [[5, 6, 7]] }, x: { Id: ['1', '', null] } };
  var out = joinData(left, right, { on: 'Id', how: 'left' });
  assert.deepEqual(out.y.smps, ['a', 'b', 'c']);
  assert.deepEqual(out.y.data[2], [5, null, null]);
});

test('one-to-many emits a row per pair with unique qualified ids', function () {
  var left = { y: { vars: ['V'], smps: ['p1', 'p2'], data: [[1, 2]] } };
  var right = { y: { vars: ['W'], smps: ['v1', 'v2', 'v3'], data: [[5, 6, 7]] }, x: { pid: ['p1', 'p1', 'p2'] } };
  var out = joinData(left, right, { on: { left: 'smps', right: 'pid' } });
  assert.deepEqual(out.y.smps, ['p1|v1', 'p1|v2', 'p2']);
  assert.deepEqual(out.y.data, [[1, 1, 2], [5, 6, 7]]);
});

test('suffixes clashing right columns (default ".<rightName>", or custom)', function () {
  var left = { y: { vars: ['V'], smps: ['a'], data: [[1]] }, x: { Group: ['g'] } };
  var right = { y: { vars: ['V'], smps: ['a'], data: [[2]] }, x: { Group: ['h'] } };
  var out = joinData(left, right, { rightName: 'clin' });
  assert.deepEqual(out.y.vars, ['V', 'V.clin']);
  assert.deepEqual(Object.keys(out.x), ['Group', 'Group.clin']);
  var custom = joinData(left, right, { suffix: '_r' });
  assert.deepEqual(custom.y.vars, ['V', 'V_r']);
});

test('carries z annotations with their variable, null where a side lacks one', function () {
  var out = joinData(SAMPLES, CLINICAL);
  assert.deepEqual(out.z, { Unit: ['yr', 'au', null] });
});

test('column names shadowing Object.prototype are ordinary columns', function () {
  var left = { y: { vars: ['constructor'], smps: ['a'], data: [[1]] } };
  var right = { y: { vars: ['toString'], smps: ['a'], data: [[2]] }, x: { constructor: ['x'] } };
  var out = joinData(left, right);
  assert.deepEqual(out.y.vars, ['constructor', 'toString']);
  assert.deepEqual(Object.keys(out.x), ['constructor.right']);
});

test('an empty match yields an empty (but well-formed) data object', function () {
  var out = joinData(SAMPLES, { y: { vars: ['W'], smps: ['zz'], data: [[1]] } });
  assert.deepEqual(out.y.smps, []);
  assert.deepEqual(out.y.data, [[], [], []]);
});

test('rejects non-{y} inputs, unknown how, and missing keys', function () {
  assert.throws(function () { joinData([['a']], SAMPLES, { leftName: 'tab' }); }, /"tab" must be a CanvasXpress/);
  assert.throws(function () { joinData(SAMPLES, CLINICAL, { how: 'cross' }); }, /join how must be one of/);
  assert.throws(function () { joinData(SAMPLES, CLINICAL, { on: 'Nope', rightName: 'clin' }); }, /join key "Nope" not found in "left"/);
  assert.throws(function () { joinData(SAMPLES, CLINICAL, { on: [] }); }, /at least one key/);
});

test('joinCycle finds self-reference and indirect cycles', function () {
  var sources = {
    a: { kind: 'inline', value: {} },
    j: { kind: 'join', left: 'a', right: 'k' },
    k: { kind: 'join', left: 'j', right: 'a' },
    ok: { kind: 'join', left: 'a', right: 'a' }
  };
  assert.deepEqual(joinCycle('j', sources), ['j', 'k', 'j']);
  assert.equal(joinCycle('ok', sources), null);
  assert.equal(joinCycle('a', sources), null);
});

// --- row axis "vars" (scatter orientation), provenance, matchIds ---

// DEG table: genes are the points (vars); logFC / P are the columns (smps).
var DEG = {
  y: { vars: ['TP53', 'EGFR', 'MYC'], smps: ['logFC', 'P'], data: [[1.5, 0.01], [-2, 0.2], [0.3, 0.5]] },
  z: { Chr: ['17', '7', '8'] },
  x: { Unit: ['log2', 'p'] }
};
// Gene annotation table in the same orientation.
var GENES = { y: { vars: ['EGFR', 'TP53'], smps: ['Length'], data: [[190], [20]] }, z: { Pathway: ['RTK', 'p53'] } };

test('axis "vars" joins on variable ids and keeps the vars orientation', function () {
  var out = joinData(DEG, GENES, { axis: 'vars' });
  assert.deepEqual(out.y.vars, ['TP53', 'EGFR']);
  assert.deepEqual(out.y.smps, ['logFC', 'P', 'Length']);
  assert.deepEqual(out.y.data, [[1.5, 0.01, 20], [-2, 0.2, 190]]);
  assert.deepEqual(out.z, { Chr: ['17', '7'], Pathway: ['p53', 'RTK'] });
  assert.deepEqual(out.x, { Unit: ['log2', 'p', null] });
});

test('mixed axes: a vars-axis left joins a smps-axis right, output follows the left', function () {
  var rows = { y: { vars: ['Length'], smps: ['MYC', 'TP53'], data: [[40, 20]] }, x: { Pathway: ['myc', 'p53'] } };
  var out = joinData(DEG, rows, { leftAxis: 'vars', rightAxis: 'smps', how: 'left' });
  assert.deepEqual(out.y.vars, ['TP53', 'EGFR', 'MYC']);
  assert.deepEqual(out.y.smps, ['logFC', 'P', 'Length']);
  assert.deepEqual(out.y.data[2], [0.3, 0.5, 40]);
  assert.deepEqual(out.z.Pathway, ['p53', null, 'myc']);
});

test('the axis name is the row-id key; the other axis name is not a column', function () {
  assert.throws(function () { joinData(DEG, GENES, { axis: 'vars', on: 'smps' }); }, /join key "smps" not found/);
  assert.throws(function () { joinData(DEG, GENES, { axis: 'rows' }); }, /axis must be "smps" or "vars"/);
});

test('joinProvenance maps each output row to its input rows', function () {
  var out = joinData(SAMPLES, CLINICAL, { how: 'outer' });
  assert.deepEqual(joinProvenance(out), {
    axis: 'smps',
    ids: ['p1', 'p2', 'p3', 'p4'],
    left: ['p1', 'p2', 'p3', null],
    right: [null, 'p2', 'p3', 'p4']
  });
  assert.equal(joinProvenance({ y: {} }), null);
});

test('matchIds maps row ids through a key, across axes', function () {
  var visits = { y: { vars: ['W'], smps: ['v1', 'v2', 'v3'], data: [[1, 2, 3]] }, x: { pid: ['p2', 'p9', 'p2'] } };
  assert.deepEqual(matchIds(SAMPLES, visits, ['p2', 'p1'], { on: { left: 'smps', right: 'pid' } }), ['v1', 'v3']);
  assert.deepEqual(matchIds(visits, SAMPLES, ['v3'], { on: { left: 'pid', right: 'smps' } }), ['p2']);
  var geneRows = { y: { vars: ['Length'], smps: ['MYC', 'TP53'], data: [[40, 20]] } };
  assert.deepEqual(matchIds(DEG, geneRows, ['TP53', 'EGFR'], { fromAxis: 'vars', toAxis: 'smps' }), ['TP53']);
});

test('transposeCxData swaps axes, matrix and annotations', async function () {
  const { transposeCxData } = await import('../src/join.js');
  var data = { y: { vars: ['A', 'B'], smps: ['s1', 's2', 's3'], data: [[1, 2, 3], [4, 5, null]] }, x: { g: ['a', 'b', 'a'] }, z: { u: ['k', 'm'] }, m: { t: 1 } };
  var t = transposeCxData(data);
  assert.deepEqual(t.y, { vars: ['s1', 's2', 's3'], smps: ['A', 'B'], data: [[1, 4], [2, 5], [3, null]] });
  assert.deepEqual(t.z, { g: ['a', 'b', 'a'] });
  assert.deepEqual(t.x, { u: ['k', 'm'] });
  assert.deepEqual(t.m, { t: 1 });
  assert.deepEqual(transposeCxData(t).y, data.y, 'round trip');
});
