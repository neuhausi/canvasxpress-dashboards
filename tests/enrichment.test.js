/**
 * P5: over-representation (enrichment) analysis. Hypergeometric tail + BH FDR
 * validated against R (phyper / p.adjust). Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hypergeometricPValue, benjaminiHochberg, enrich, enrichmentToData } from '../src/enrichment.js';

function close(a, b, eps) { assert.ok(Math.abs(a - b) < (eps || 1e-9), a + ' vs ' + b); }

test('hypergeometricPValue: matches R phyper(lower.tail=FALSE)', function () {
  close(hypergeometricPValue(8, 40, 50, 1000), 0.000498068888373, 1e-12);
  close(hypergeometricPValue(5, 30, 20, 1000), 0.000194865919312, 1e-12);
});

test('hypergeometricPValue: edge cases', function () {
  assert.equal(hypergeometricPValue(0, 40, 50, 1000), 1);     // ≥0 is certain
  assert.equal(hypergeometricPValue(41, 40, 50, 1000), 0);    // more hits than draws
});

test('benjaminiHochberg: matches R p.adjust(method="BH"), input order preserved', function () {
  var q = benjaminiHochberg([0.001, 0.01, 0.02, 0.2, 0.5]).map(function (x) { return Math.round(x * 1e6) / 1e6; });
  assert.deepEqual(q, [0.005, 0.025, 0.033333, 0.25, 0.5]);
});

test('enrich: ranks the planted pathway first with a significant FDR', function () {
  // Query is 10 genes; PATH_A contains 8 of them → strong enrichment.
  var query = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'X1', 'X2'];
  var universe = [];
  for (var i = 1; i <= 500; i++) universe.push('U' + i);
  for (i = 1; i <= 8; i++) universe.push('G' + i);
  universe.push('X1', 'X2', 'G9', 'G10');
  var geneSets = [
    { id: 'PATH_A', name: 'Planted pathway', genes: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10'] },
    { id: 'PATH_B', name: 'Unrelated pathway', genes: ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10'] }
  ];
  var res = enrich(query, geneSets, { universe: universe });
  assert.equal(res[0].id, 'PATH_A');
  assert.equal(res[0].overlap, 8);
  assert.ok(res[0].fdr < 0.001, 'planted FDR ' + res[0].fdr);
  assert.ok(res[0].enrichment > 1);
  var b = res.find(function (r) { return r.id === 'PATH_B'; });
  assert.ok(b.fdr > res[0].fdr);
});

test('enrich: self-contained universe (no explicit background)', function () {
  var res = enrich(['A', 'B', 'C'], [
    { id: 'S1', genes: ['A', 'B', 'C', 'D'] },
    { id: 'S2', genes: ['E', 'F', 'G'] }
  ]);
  assert.equal(res[0].id, 'S1');
  assert.equal(res.find(function (r) { return r.id === 'S2'; }).overlap, 0);
});

test('enrichmentToData: shapes a CanvasXpress object (pathways as samples)', function () {
  var res = enrich(['A', 'B', 'C'], [{ id: 'S1', name: 'Set 1', genes: ['A', 'B', 'C', 'D'] }]);
  var data = enrichmentToData(res, 10);
  assert.deepEqual(data.y.vars, ['negLog10FDR']);
  assert.equal(data.y.smps[0], 'Set 1');
  assert.equal(data.y.data[0].length, data.y.smps.length);
  assert.ok('Overlap' in data.x && 'FDR' in data.x);
});
