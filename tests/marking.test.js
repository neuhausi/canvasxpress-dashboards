/**
 * Unit tests for cross-source marking: the relationship graph (explicit
 * relationships + join sources) and breadth-first mark translation.
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRelationships, relationGraph, translateMarks } from '../src/marking.js';
import { joinData } from '../src/join.js';

var EXPR = { y: { vars: ['GeneA'], smps: ['p1', 'p2', 'p3'], data: [[1, 2, 3]] }, x: { Top: ['TP53', 'EGFR', 'MYC'] } };
var CLIN = { y: { vars: ['Age'], smps: ['c1', 'c2', 'c3', 'c4'], data: [[61, 55, 70, 48]] }, x: { patient_id: ['p3', 'p1', 'p2', 'p2'] } };
var GENES = { y: { vars: ['TP53', 'EGFR', 'MYC'], smps: ['logFC', 'P'], data: [[1, 2], [3, 4], [5, 6]] } };

/**
 * A spec wiring expr <-> clin (patient_id) and expr <-> genes (Top -> gene id).
 * @param {object} [extra] - Extra top-level spec fields.
 * @returns {object} Spec.
 */
function spec(extra) {
  var s = {
    data: {
      expr: { kind: 'inline', value: EXPR },
      clin: { kind: 'inline', value: CLIN },
      genes: { kind: 'inline', axis: 'vars', value: GENES }
    },
    relationships: [
      { left: 'expr', right: 'clin', on: { left: 'smps', right: 'patient_id' } },
      { left: 'expr', right: 'genes', on: { left: 'Top', right: 'vars' } }
    ]
  };
  Object.keys(extra || {}).forEach(function (k) { s[k] = extra[k]; });
  return s;
}

/**
 * Data lookup over a spec's inline sources (plus overrides).
 * @param {object} s - Spec.
 * @param {object} [extra] - ref -> data overrides.
 * @returns {function} dataOf(ref).
 */
function lookup(s, extra) {
  return function (ref) {
    if (extra && extra[ref]) return extra[ref];
    var src = s.data[ref];
    return src && src.kind === 'inline' ? src.value : null;
  };
}

test('hasRelationships sees explicit relationships and join sources', function () {
  assert.equal(hasRelationships({ data: { a: { kind: 'inline', value: {} } } }), false);
  assert.equal(hasRelationships(spec()), true);
  assert.equal(hasRelationships({ data: { j: { kind: 'join', left: 'a', right: 'b' } } }), true);
});

test('translates marks both ways through a key relationship', function () {
  var s = spec();
  var g = relationGraph(s);
  assert.deepEqual(translateMarks('expr', ['p2'], g, lookup(s)).clin, ['c3', 'c4']);
  assert.deepEqual(translateMarks('clin', ['c1'], g, lookup(s)).expr, ['p3']);
});

test('walks several hops and across axes (samples -> variables)', function () {
  var s = spec();
  var marks = translateMarks('clin', ['c2'], relationGraph(s), lookup(s));
  assert.deepEqual(marks, { expr: ['p1'], genes: ['TP53'] });
});

test('a related source with no matching rows maps to an empty list', function () {
  var s = spec();
  var clinNoP1 = { y: { vars: ['Age'], smps: ['c9'], data: [[1]] }, x: { patient_id: ['p9'] } };
  var marks = translateMarks('expr', ['p1'], relationGraph(s), lookup(s, { clin: clinNoP1 }));
  assert.deepEqual(marks.clin, []);
  assert.deepEqual(marks.genes, ['TP53']);
});

test('an unresolved source is skipped, not marked', function () {
  var s = spec();
  var marks = translateMarks('expr', ['p1'], relationGraph(s), function (ref) { return ref === 'clin' ? null : lookup(s)(ref); });
  assert.ok(!('clin' in marks));
  assert.deepEqual(marks.genes, ['TP53']);
});

test('a join links its inputs and maps to/from its own rows via provenance', function () {
  var s = {
    data: {
      expr: { kind: 'inline', value: EXPR },
      clin: { kind: 'inline', value: CLIN },
      blend: { kind: 'join', left: 'expr', right: 'clin', on: { left: 'smps', right: 'patient_id' }, how: 'left' }
    }
  };
  var blend = joinData(EXPR, CLIN, { on: { left: 'smps', right: 'patient_id' }, how: 'left' });
  var dataOf = lookup(s, { blend: blend });
  var g = relationGraph(s);
  assert.deepEqual(blend.y.smps, ['p1', 'p2|c3', 'p2|c4', 'p3']);
  // Input -> join rows (one-to-many), and join rows -> both inputs.
  assert.deepEqual(translateMarks('expr', ['p2'], g, dataOf).blend, ['p2|c3', 'p2|c4']);
  assert.deepEqual(translateMarks('blend', ['p2|c4'], g, dataOf), { expr: ['p2'], clin: ['c4'] });
  // The inputs relate to each other through the join's key.
  assert.deepEqual(translateMarks('clin', ['c1'], g, dataOf).expr, ['p3']);
});
