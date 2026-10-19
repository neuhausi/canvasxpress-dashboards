/**
 * Dashboard-level analysis controls — the FDR threshold slider, the transform
 * control contract, and the batch-correction hook. These are *analysis* controls:
 * one scientific parameter re-runs the analysis across every bound panel, not a
 * display filter. Built on the shipped substrate — `applyDashboardCorrection`
 * (statInference.js) for honest dashboard-scope FDR, `transforms.js` for the
 * client-side transforms, and `function` sources for the heavy server-side work.
 *
 * @module analysisControls
 */

import { applyDashboardCorrection, significanceStars } from './statInference.js';
import { TRANSFORM_METHODS, TRANSFORM_LABELS } from './transforms.js';

/**
 * Re-filter every panel by a single FDR threshold. Corrects once across all
 * comparisons (dashboard scope — the honest FDR unit), then marks each comparison
 * `hidden` when its adjusted p exceeds the threshold, and reports the −log10
 * cut-off a bound volcano should draw. One scientific parameter, whole-dashboard
 * reaction.
 *
 * Mutates each comparison (`padj`, `hidden`) and returns a summary so the renderer
 * can update bound panels (hide non-significant brackets, move the volcano FDR
 * line, re-run enrichment selection).
 *
 * @param {object[]} panels - Panels carrying `statInference.comparisons` (each {p}).
 * @param {object} options
 * @param {number} options.threshold - FDR cut-off on the adjusted-p scale (e.g. 0.05).
 * @param {string} [options.method='BH'] - Correction method (pAdjust).
 * @returns {{threshold:number, method:string, volcanoY:number, kept:number, total:number}}
 */
export function applyFdrThreshold(panels, options) {
  options = options || {};
  var threshold = options.threshold != null ? options.threshold : 0.05;
  var method = options.method || 'BH';
  applyDashboardCorrection(panels, method);
  var kept = 0;
  var total = 0;
  for (var i = 0; i < panels.length; i++) {
    var si = panels[i] && panels[i].statInference;
    if (si && Array.isArray(si.comparisons)) {
      for (var j = 0; j < si.comparisons.length; j++) {
        var cmp = si.comparisons[j];
        total++;
        cmp.hidden = !(cmp.padj != null && cmp.padj <= threshold);
        if (!cmp.hidden) { kept++; }
      }
      si.fdrThreshold = threshold;
    }
  }
  return {
    threshold: threshold,
    method: method,
    volcanoY: threshold > 0 ? (-Math.log(threshold) / Math.LN10) : 0,
    kept: kept,
    total: total
  };
}

/**
 * Significance verdict for a single feature at a threshold — the test an
 * enrichment/volcano panel applies per gene when the slider moves.
 * @param {number} padj - Adjusted p-value.
 * @param {number} threshold - FDR cut-off.
 * @returns {{significant:boolean, stars:string}}
 */
export function fdrVerdict(padj, threshold) {
  return { significant: padj != null && padj <= threshold, stars: significanceStars(padj) };
}

/**
 * Build an FDR threshold slider control spec (a param-mode range control). The
 * renderer wires the param to applyFdrThreshold across the dashboard's panels.
 *
 * @param {object} options
 * @param {string} [options.param='fdr'] - Dashboard param the slider sets.
 * @param {number} [options.value=0.05] - Initial threshold.
 * @param {number} [options.min=0.001] @param {number} [options.max=0.25]
 * @param {number} [options.step=0.001] @param {string} [options.method='BH']
 * @param {string} [options.title='FDR threshold']
 * @returns {object} A control-panel spec.
 */
export function buildFdrSliderControl(options) {
  options = options || {};
  return {
    type: 'control',
    mode: 'param',
    style: 'range',
    param: options.param || 'fdr',
    title: options.title || 'FDR threshold',
    analysis: 'fdr',
    method: options.method || 'BH',
    min: options.min != null ? options.min : 0.001,
    max: options.max != null ? options.max : 0.25,
    step: options.step != null ? options.step : 0.001,
    value: options.value != null ? options.value : 0.05
  };
}

/**
 * Build a transform control spec (a config-style control that re-expresses a
 * target panel's data through transforms.transformData). On change the renderer
 * calls `inst.updateData(transformData(original, method))`.
 *
 * @param {object} options
 * @param {string} options.target - Target panel id.
 * @param {string[]} [options.methods] - Subset of TRANSFORM_METHODS to offer.
 * @param {string} [options.value='none'] - Initial method.
 * @param {string} [options.title='Transform'] @param {string} [options.style='dropdown']
 * @returns {object} A control-panel spec.
 */
export function buildTransformControl(options) {
  options = options || {};
  var methods = options.methods || TRANSFORM_METHODS;
  return {
    type: 'control',
    mode: 'transform',
    style: options.style || 'dropdown',
    target: options.target,
    title: options.title || 'Transform',
    analysis: 'transform',
    value: options.value || 'none',
    options: methods.map(function (m) { return { label: TRANSFORM_LABELS[m] || m, value: m }; })
  };
}

/**
 * Build an opt-in batch-correction `function` source spec (the hook). Heavy
 * correction (limma removeBatchEffect / ComBat) runs server-side and stays OFF by
 * default; the body here is a documented stub for the host's functions runtime to
 * implement. The applied correction is recorded in provenance (see
 * describeAnalysisControl).
 *
 * @param {object} options
 * @param {string} options.input - Ref of the expression source to correct.
 * @param {string} options.batch - Sample annotation naming the batch factor.
 * @param {string} [options.method='combat'] - 'combat' | 'limma'.
 * @param {string} [options.language='R'] @param {string} [options.enabledParam='batchCorrect']
 * @returns {object} A `kind:'function'` source spec (disabled unless the param is truthy).
 */
export function batchCorrectionSource(options) {
  options = options || {};
  var method = options.method || 'combat';
  var language = options.language || 'R';
  var stub = language === 'R'
    ? '# Batch correction (opt-in, off by default). Host functions runtime should\n' +
      '# implement this, e.g. sva::ComBat or limma::removeBatchEffect, keyed on the\n' +
      '# `batch` sample annotation. Return the corrected CanvasXpress data object.\n' +
      'function(inputs, params) { inputs$expr }'
    : '# Batch correction stub (off by default) — implement ComBat/limma server-side.\n' +
      'def run(inputs, params):\n    return inputs["expr"]';
  return {
    kind: 'function',
    language: language,
    enabled: '$' + (options.enabledParam || 'batchCorrect'),
    inputs: { expr: options.input },
    args: { batch: options.batch, method: method },
    code: stub,
    analysis: 'batchCorrection',
    provenance: { kind: 'batchCorrection', method: method, batch: options.batch }
  };
}

/**
 * One-line provenance clause for an applied analysis control, so a silently
 * transformed/thresholded panel is never a reproducibility hazard (plan §4).
 *
 * @param {object} control - A control spec (transform/fdr) or {kind:'batchCorrection', ...}.
 * @param {*} [value] - The applied value (transform method or threshold).
 * @returns {string} A human-readable clause, or '' if nothing to record.
 */
export function describeAnalysisControl(control, value) {
  if (!control) { return ''; }
  var analysis = control.analysis || control.kind;
  if (analysis === 'transform') {
    var method = value != null ? value : control.value;
    if (!method || method === 'none') { return ''; }
    return 'values ' + (TRANSFORM_LABELS[method] || method) + '-transformed';
  }
  if (analysis === 'fdr') {
    var threshold = value != null ? value : control.value;
    return 'filtered at FDR ≤ ' + threshold + ' (' + (control.method || 'BH') + ' correction, dashboard-scope)';
  }
  if (analysis === 'batchCorrection') {
    return 'batch-corrected (' + (control.method || 'combat') + ', by ' + (control.batch || 'batch') + ')';
  }
  return '';
}

/**
 * Provenance clauses for every analysis control declared on a dashboard — the
 * transforms, FDR thresholds and batch corrections a reader needs to know were
 * applied (plan §4: a silently transformed/thresholded panel is a reproducibility
 * hazard). Scans spec.panels for control panels carrying an `analysis` tag and any
 * `analysis` function sources.
 *
 * @param {object} spec - A dashboard spec.
 * @returns {string[]} Non-empty provenance clauses, in panel order.
 */
export function describeAnalysisControls(spec) {
  var clauses = [];
  var panels = (spec && spec.panels) || {};
  Object.keys(panels).forEach(function (id) {
    var panel = panels[id];
    if (panel && panel.type === 'control' && panel.analysis) {
      var text = describeAnalysisControl(panel);
      if (text) { clauses.push(text); }
    }
  });
  var sources = (spec && spec.data) || {};
  Object.keys(sources).forEach(function (ref) {
    var src = sources[ref];
    if (src && src.analysis === 'batchCorrection' && src.provenance) {
      var text = describeAnalysisControl(src.provenance);
      if (text) { clauses.push(text); }
    }
  });
  return clauses;
}
