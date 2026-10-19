/**
 * Dashboard analysis controls: FDR threshold re-filter (on dashboard-scope BH
 * correction), control-spec builders, batch hook, and provenance. Run with
 * `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFdrThreshold, fdrVerdict, buildFdrSliderControl, buildTransformControl,
  batchCorrectionSource, describeAnalysisControl, describeAnalysisControls
} from '../src/analysisControls.js';

test('applyFdrThreshold: BH across panels, hides comparisons above the cutoff', function () {
  var panels = [
    { statInference: { comparisons: [{ p: 0.04 }, { p: 0.001 }] } },
    { statInference: { comparisons: [{ p: 0.2 }, { p: 0.01 }, { p: 0.5 }] } }
  ];
  var summary = applyFdrThreshold(panels, { threshold: 0.05, method: 'BH' });
  // pooled BH of [0.04,0.001,0.2,0.01,0.5] = [0.0667,0.005,0.25,0.025,0.5]
  var p0 = panels[0].statInference.comparisons;
  var p1 = panels[1].statInference.comparisons;
  assert.equal(p0[0].hidden, true);   // 0.0667 > 0.05
  assert.equal(p0[1].hidden, false);  // 0.005
  assert.equal(p1[0].hidden, true);   // 0.25
  assert.equal(p1[1].hidden, false);  // 0.025
  assert.equal(p1[2].hidden, true);   // 0.5
  assert.equal(summary.kept, 2);
  assert.equal(summary.total, 5);
  assert.ok(Math.abs(summary.volcanoY - (-Math.log(0.05) / Math.LN10)) < 1e-9);
  assert.equal(panels[0].statInference.fdrThreshold, 0.05);
});

test('applyFdrThreshold: moving the slider changes what is kept', function () {
  var panels = [{ statInference: { comparisons: [{ p: 0.04 }, { p: 0.001 }] } }];
  var tight = applyFdrThreshold(panels, { threshold: 0.01 });
  assert.equal(tight.kept, 1); // only padj 0.002 survives (BH of [0.04,0.001] = [0.04,0.002])
  var loose = applyFdrThreshold(panels, { threshold: 0.05 });
  assert.equal(loose.kept, 2);
});

test('fdrVerdict', function () {
  assert.deepEqual(fdrVerdict(0.005, 0.05), { significant: true, stars: '**' });
  assert.deepEqual(fdrVerdict(0.2, 0.05), { significant: false, stars: 'ns' });
  assert.equal(fdrVerdict(null, 0.05).significant, false);
});

test('buildFdrSliderControl: param-mode range control', function () {
  var c = buildFdrSliderControl({ value: 0.1, method: 'holm' });
  assert.equal(c.type, 'control');
  assert.equal(c.mode, 'param');
  assert.equal(c.style, 'range');
  assert.equal(c.param, 'fdr');
  assert.equal(c.value, 0.1);
  assert.equal(c.method, 'holm');
  assert.equal(c.analysis, 'fdr');
});

test('buildTransformControl: config-style control with method options', function () {
  var c = buildTransformControl({ target: 'heatmap', value: 'log2' });
  assert.equal(c.mode, 'transform');
  assert.equal(c.target, 'heatmap');
  assert.equal(c.value, 'log2');
  assert.ok(c.options.some(function (o) { return o.value === 'zscore'; }));
});

test('batchCorrectionSource: opt-in, off by default, provenance-labeled', function () {
  var src = batchCorrectionSource({ input: 'counts', batch: 'batch', method: 'combat' });
  assert.equal(src.kind, 'function');
  assert.equal(src.enabled, '$batchCorrect');          // off unless the param is truthy
  assert.deepEqual(src.inputs, { expr: 'counts' });
  assert.equal(src.args.batch, 'batch');
  assert.equal(src.provenance.kind, 'batchCorrection');
});

test('describeAnalysisControl: provenance clauses', function () {
  assert.equal(describeAnalysisControl({ analysis: 'transform' }, 'log2'), 'values log2-transformed');
  assert.equal(describeAnalysisControl({ analysis: 'transform' }, 'none'), '');
  assert.equal(describeAnalysisControl({ analysis: 'fdr', method: 'BH' }, 0.05),
    'filtered at FDR ≤ 0.05 (BH correction, dashboard-scope)');
  assert.equal(describeAnalysisControl({ kind: 'batchCorrection', method: 'combat', batch: 'lane' }),
    'batch-corrected (combat, by lane)');
});

test('describeAnalysisControls: scans a spec for active analysis controls', function () {
  var spec = {
    panels: {
      tf: { type: 'control', analysis: 'transform', value: 'log2' },
      tfNone: { type: 'control', analysis: 'transform', value: 'none' }, // no clause
      slider: { type: 'control', analysis: 'fdr', method: 'BH', value: 0.05 },
      chart: { dataRef: 'x' } // not a control
    },
    data: { x: { analysis: 'batchCorrection', provenance: { kind: 'batchCorrection', method: 'combat', batch: 'lane' } } }
  };
  var clauses = describeAnalysisControls(spec);
  assert.ok(clauses.indexOf('values log2-transformed') >= 0);
  assert.ok(clauses.indexOf('filtered at FDR ≤ 0.05 (BH correction, dashboard-scope)') >= 0);
  assert.ok(clauses.indexOf('batch-corrected (combat, by lane)') >= 0);
  assert.equal(clauses.length, 3); // 'none' transform produced nothing
});
