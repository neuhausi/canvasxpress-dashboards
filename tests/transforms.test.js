/**
 * Analysis transforms validated against R (log2/log10, scale(), median center,
 * preprocessCore::normalize.quantiles). R is the oracle. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  log2Row, log10Row, zscoreRow, medianCenterRow, quantileNormalize, transformData, TRANSFORM_METHODS
} from '../src/transforms.js';

function closeArray(got, want, eps) {
  assert.equal(got.length, want.length);
  for (var i = 0; i < want.length; i++) {
    assert.ok(Math.abs(got[i] - want[i]) < (eps || 1e-6), i + ': ' + got[i] + ' vs ' + want[i]);
  }
}

var X = [2, 5, 7, 10, 3, 8];

test('log2Row / log10Row match R', function () {
  closeArray(log2Row(X), [1.0, 2.321928, 2.807355, 3.321928, 1.584963, 3.0]);
  closeArray(log10Row(X), [0.301030, 0.698970, 0.845098, 1.0, 0.477121, 0.903090]);
});

test('zscoreRow matches R scale() (sample sd)', function () {
  closeArray(zscoreRow(X), [-1.252518, -0.272287, 0.381201, 1.361433, -0.925774, 0.707945]);
});

test('zscoreRow: zero-variance row -> zeros, not NaN', function () {
  closeArray(zscoreRow([5, 5, 5]), [0, 0, 0]);
});

test('medianCenterRow matches R x - median(x)', function () {
  closeArray(medianCenterRow(X), [-4, -1, 1, 4, -3, 2]);
});

test('quantileNormalize matches R preprocessCore', function () {
  // R matrix rbind(c(5,4,3), c(2,1,6), c(3,8,9)) -> columns [5,2,3],[4,1,8],[3,6,9]
  var cols = [[5, 2, 3], [4, 1, 8], [3, 6, 9]];
  var qn = quantileNormalize(cols);
  closeArray(qn[0], [7.333333, 2, 4.333333]);
  closeArray(qn[1], [4.333333, 2, 7.333333]);
  closeArray(qn[2], [2, 4.333333, 7.333333]);
});

test('transformData: row-wise on a CX data object, returns a new object', function () {
  var cx = { y: { vars: ['g1', 'g2'], smps: ['s1', 's2', 's3'], data: [[2, 5, 7], [10, 3, 8]] } };
  var out = transformData(cx, 'log2');
  assert.notEqual(out, cx);
  assert.notEqual(out.y.data, cx.y.data);
  closeArray(out.y.data[0], [1.0, 2.321928, 2.807355]);
  // source untouched
  assert.deepEqual(cx.y.data[0], [2, 5, 7]);
});

test('transformData: none / unknown returns an unchanged copy', function () {
  var cx = { y: { vars: ['g'], smps: ['a', 'b'], data: [[1, 2]] } };
  assert.deepEqual(transformData(cx, 'none').y.data, [[1, 2]]);
  assert.deepEqual(transformData(cx, 'bogus').y.data, [[1, 2]]);
});

test('transformData: quantileNormalize works across samples (columns)', function () {
  var cx = { y: { vars: ['g1', 'g2', 'g3'], smps: ['c1', 'c2', 'c3'], data: [[5, 4, 3], [2, 1, 6], [3, 8, 9]] } };
  var out = transformData(cx, 'quantileNormalize');
  // same as the matrix test, by row now
  closeArray(out.y.data[0], [7.333333, 4.333333, 2]);
  closeArray(out.y.data[1], [2, 2, 4.333333]);
  closeArray(out.y.data[2], [4.333333, 7.333333, 7.333333]);
});

test('TRANSFORM_METHODS menu order', function () {
  assert.deepEqual(TRANSFORM_METHODS, ['none', 'log2', 'log10', 'zscore', 'medianCenter', 'quantileNormalize']);
});
