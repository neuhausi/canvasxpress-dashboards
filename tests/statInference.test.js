/**
 * Stat-inference dashboards glue: pAdjust validated against R's stats::p.adjust()
 * to full double precision, dashboard-scope correction pooling, and the spec
 * helper. R is the oracle. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pAdjust, significanceStars, applyDashboardCorrection, buildPanelStatInference, buildEffectSizeTile } from '../src/statInference.js';

function closeArray(got, want, eps) {
  assert.equal(got.length, want.length);
  for (var i = 0; i < want.length; i++) {
    assert.ok(Math.abs(got[i] - want[i]) < (eps || 1e-9), i + ': ' + got[i] + ' vs ' + want[i]);
  }
}

// Deliberately unsorted input — verifies order preservation too.
var P = [0.04, 0.001, 0.2, 0.01, 0.5];

test('pAdjust: BH matches R, input order preserved', function () {
  closeArray(pAdjust(P, 'BH'), [0.066666667, 0.005, 0.25, 0.025, 0.5]);
  closeArray(pAdjust(P, 'fdr'), [0.066666667, 0.005, 0.25, 0.025, 0.5]); // alias
});

test('pAdjust: bonferroni matches R', function () {
  closeArray(pAdjust(P, 'bonferroni'), [0.2, 0.005, 1.0, 0.05, 1.0]);
});

test('pAdjust: BY matches R', function () {
  closeArray(pAdjust(P, 'BY'), [0.152222222, 0.011416667, 0.570833333, 0.057083333, 1.0]);
});

test('pAdjust: holm matches R', function () {
  closeArray(pAdjust(P, 'holm'), [0.12, 0.005, 0.40, 0.04, 0.5]);
});

test('pAdjust: hochberg matches R', function () {
  closeArray(pAdjust(P, 'hochberg'), [0.12, 0.005, 0.40, 0.04, 0.5]);
});

test('pAdjust: none and empty', function () {
  closeArray(pAdjust(P, 'none'), P);
  assert.deepEqual(pAdjust([], 'BH'), []);
});

test('significanceStars: ggsignif thresholds', function () {
  assert.equal(significanceStars(0.00005), '****');
  assert.equal(significanceStars(0.0005), '***');
  assert.equal(significanceStars(0.005), '**');
  assert.equal(significanceStars(0.03), '*');
  assert.equal(significanceStars(0.2), 'ns');
  assert.equal(significanceStars(null), 'ns');
});

test('applyDashboardCorrection: pools comparisons across panels (dashboard scope)', function () {
  var panels = [
    { statInference: { comparisons: [{ groups: ['A', 'B'], p: 0.04 }, { groups: ['A', 'C'], p: 0.001 }] } },
    { statInference: { comparisons: [{ groups: ['X', 'Y'], p: 0.2 }, { groups: ['X', 'Z'], p: 0.01 }, { groups: ['Y', 'Z'], p: 0.5 }] } }
  ];
  applyDashboardCorrection(panels, 'BH');
  // Equivalent to a single BH over the pooled [0.04,0.001,0.2,0.01,0.5] (= P).
  var pooledPadj = panels[0].statInference.comparisons.map(function (c) { return c.padj; })
    .concat(panels[1].statInference.comparisons.map(function (c) { return c.padj; }));
  closeArray(pooledPadj, [0.066666667, 0.005, 0.25, 0.025, 0.5]);
});

test('applyDashboardCorrection: no comparisons is a no-op', function () {
  var panels = [{ foo: 1 }, { statInference: { comparisons: [] } }];
  assert.doesNotThrow(function () { applyDashboardCorrection(panels, 'BH'); });
});

test('buildPanelStatInference: panel scope corrects within panel', function () {
  var block = buildPanelStatInference({
    comparisons: [{ groups: ['A', 'B'], p: 0.04 }, { groups: ['A', 'C'], p: 0.001 }],
    method: 'BH', scope: 'panel', annotate: 'stars'
  });
  assert.equal(block.correction.scope, 'panel');
  assert.equal(block.annotate, 'stars');
  closeArray(block.comparisons.map(function (c) { return c.padj; }), [0.04, 0.002]); // BH over [0.04,0.001]
});

test('buildPanelStatInference: dashboard scope leaves padj for the pooled pass', function () {
  var block = buildPanelStatInference({
    comparisons: [{ groups: ['A', 'B'], p: 0.04 }], method: 'BH', scope: 'dashboard'
  });
  assert.equal(block.comparisons[0].padj, undefined);
  assert.equal(block.correction.scope, 'dashboard');
});

test('buildEffectSizeTile: assembles a Dotplot spec with CI segments + reference line', function () {
  var tile = buildEffectSizeTile({
    effects: [
      { label: 'DoseA', estimate: 0.9, ciLow: 0.4, ciHigh: 1.4 },
      { label: 'DoseB', estimate: 1.8, ciLow: 1.2, ciHigh: 2.4 }
    ],
    reference: 0, valueLabel: 'log2FC'
  });
  assert.equal(tile.config.graphType, 'Dotplot');
  assert.deepEqual(tile.data.y.smps, ['DoseA', 'DoseB']);
  assert.deepEqual(tile.data.y.data, [[0.9, 1.8]]);
  // one CI segment per effect + one reference line
  assert.equal(tile.config.decorations.line.length, 3);
  assert.equal(tile.config.decorations.line[0].catX, 1);
  assert.equal(tile.config.decorations.line[2].value, 0);
  // axis padded beyond the CIs
  assert.ok(tile.config.setMinX < 0 && tile.config.setMaxX > 2.4);
});
