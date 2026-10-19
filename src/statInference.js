/**
 * Statistics as first-class dashboard objects — the dashboards-layer glue for
 * the engine's renderer-first significance layer.
 *
 * The engine (CanvasXpress) RENDERS significance brackets from a per-panel
 * `statInference` config block; the test statistics themselves are computed
 * upstream (R / Python / the dashboards server). The only computation that
 * belongs client-side is multiple-testing correction, because the FDR control
 * must recorrect instantly across panels as the viewer filters — without a
 * server round-trip. This module owns that cross-panel correction and the
 * helpers that assemble the per-panel config.
 *
 * `pAdjust` here matches R's stats::p.adjust() to full double precision for
 * BH, bonferroni, BY, holm, hochberg and none (validated in statInference.test.js)
 * and mirrors the engine's this.pAdjust so both sides agree. The existing
 * enrichment.js benjaminiHochberg stays for the hypergeometric path.
 *
 * @module statInference
 */

/**
 * Adjust a set of p-values for multiple testing. ES-module port that matches R's
 * stats::p.adjust() to full double precision. NA handling is not reproduced:
 * callers pass finite p-values only.
 *
 * @param {number[]} pValues - Finite raw p-values.
 * @param {string} [method='BH'] - "BH" (default), "bonferroni", "BY", "holm",
 *   "hochberg", "none" ("fdr" is accepted as an alias for BH; case-insensitive).
 * @returns {number[]} Adjusted p-values, in the same order as the input.
 */
export function pAdjust(pValues, method) {
  var n = pValues.length;
  var adjusted = new Array(n);
  var i;
  if (n === 0) {
    return adjusted;
  }
  method = method ? String(method) : 'BH';
  if (method.toLowerCase() === 'fdr') {
    method = 'BH';
  }
  if (method === 'none') {
    for (i = 0; i < n; i++) {
      adjusted[i] = pValues[i];
    }
    return adjusted;
  }
  if (method === 'bonferroni') {
    for (i = 0; i < n; i++) {
      adjusted[i] = Math.min(1, pValues[i] * n);
    }
    return adjusted;
  }
  var order = new Array(n);
  for (i = 0; i < n; i++) {
    order[i] = i;
  }
  if (method === 'holm') {
    // Step-down: ascending order, running max of (n - i) * p.
    order.sort(function (a, b) { return pValues[a] - pValues[b]; });
    var runningMax = 0;
    var holmValue;
    for (i = 0; i < n; i++) {
      holmValue = (n - i) * pValues[order[i]];
      if (holmValue > runningMax) {
        runningMax = holmValue;
      }
      adjusted[order[i]] = Math.min(1, runningMax);
    }
    return adjusted;
  }
  // BH, BY and hochberg: descending order, running min of a rank factor * p.
  order.sort(function (a, b) { return pValues[b] - pValues[a]; });
  var byConstant = 1;
  if (method === 'BY') {
    byConstant = 0;
    for (i = 1; i <= n; i++) {
      byConstant += 1 / i;
    }
  }
  var runningMin = Infinity;
  var rankFactor;
  var candidate;
  for (i = 0; i < n; i++) {
    var descendingRank = n - i;
    if (method === 'hochberg') {
      rankFactor = (n - descendingRank + 1);
    } else {
      rankFactor = byConstant * n / descendingRank;
    }
    candidate = rankFactor * pValues[order[i]];
    if (candidate < runningMin) {
      runningMin = candidate;
    }
    adjusted[order[i]] = Math.min(1, runningMin);
  }
  return adjusted;
}

/**
 * Significance stars following the ggsignif / GraphPad convention.
 * @param {number} p - A p-value (raw or adjusted).
 * @returns {string} "****" (<1e-4), "***" (<1e-3), "**" (<1e-2), "*" (<0.05), "ns".
 */
export function significanceStars(p) {
  if (p == null) { return 'ns'; }
  if (p < 0.0001) { return '****'; }
  if (p < 0.001) { return '***'; }
  if (p < 0.01) { return '**'; }
  if (p < 0.05) { return '*'; }
  return 'ns';
}

/**
 * Apply dashboard-scope multiple-testing correction. The honest FDR unit for a
 * dashboard is the whole set of comparisons the viewer is looking at, not one
 * panel: this pools every comparison across the given panels, corrects once, and
 * writes the adjusted p-value back onto each comparison (`padj`). Mutates and
 * returns the panels so callers can re-render in place.
 *
 * @param {object[]} panels - Panels, each optionally carrying
 *   `statInference.comparisons` (array of {p, ...}).
 * @param {string} [method='BH'] - Correction method (see pAdjust).
 * @returns {object[]} The same panels, with each comparison's `padj` set.
 */
export function applyDashboardCorrection(panels, method) {
  var pooled = [];
  var backRefs = [];
  var i, j;
  for (i = 0; i < panels.length; i++) {
    var si = panels[i] && panels[i].statInference;
    if (si && Array.isArray(si.comparisons)) {
      for (j = 0; j < si.comparisons.length; j++) {
        if (typeof si.comparisons[j].p === 'number') {
          pooled.push(si.comparisons[j].p);
          backRefs.push(si.comparisons[j]);
        }
      }
    }
  }
  if (!pooled.length) {
    return panels;
  }
  var adjusted = pAdjust(pooled, method || 'BH');
  for (i = 0; i < backRefs.length; i++) {
    backRefs[i].padj = adjusted[i];
  }
  return panels;
}

/**
 * Assemble a per-panel `statInference` config block for the engine, applying
 * within-panel correction up front so the block is self-describing. For
 * dashboard-scope correction, call applyDashboardCorrection across panels
 * instead and leave `correction.scope` as "dashboard".
 *
 * @param {object} options
 * @param {object[]} options.comparisons - [{groups:[a,b], p, value?, label?}, ...].
 * @param {string} [options.method='BH'] - Correction method.
 * @param {string} [options.scope='dashboard'] - "dashboard" or "panel".
 * @param {string} [options.annotate='padj'] - "p" | "padj" | "stars".
 * @returns {object} A statInference block ready to assign on a panel config.
 */
export function buildPanelStatInference(options) {
  options = options || {};
  var comparisons = (options.comparisons || []).map(function (c) {
    var copy = {};
    for (var k in c) { if (Object.prototype.hasOwnProperty.call(c, k)) { copy[k] = c[k]; } }
    return copy;
  });
  var method = options.method || 'BH';
  var scope = options.scope || 'dashboard';
  if (scope === 'panel' && method !== 'none') {
    var pooled = comparisons.map(function (c) { return c.p; });
    var adjusted = pAdjust(pooled, method);
    for (var i = 0; i < comparisons.length; i++) {
      comparisons[i].padj = adjusted[i];
    }
  }
  return {
    comparisons: comparisons,
    correction: { method: method, scope: scope },
    annotate: options.annotate || 'padj'
  };
}

/**
 * Build an effect-size / forest tile: a point estimate with a confidence interval
 * per row, instead of a bare KPI number. Renderer-first — it assembles a
 * CanvasXpress Dotplot config that draws each estimate as a point with a vertical
 * CI segment (reusing the engine's proven category-segment + point decoration
 * primitives) and a reference line (default 0, e.g. "no effect" / log2FC 0).
 *
 * @param {object} options
 * @param {object[]} options.effects - [{label, estimate, ciLow, ciHigh}, ...].
 * @param {number} [options.reference=0] - Reference line on the value axis.
 * @param {string} [options.valueLabel='estimate'] - Value-axis / series name.
 * @param {string} [options.color] - CI line color (default: engine foreground).
 * @param {string} [options.referenceColor] - Reference-line color (default: engine foreground).
 * @param {number} [options.pad=0.2] - Fractional axis padding beyond the CIs.
 * @returns {{data: object, config: object}} A CanvasXpress {data, config} spec.
 */
export function buildEffectSizeTile(options) {
  options = options || {};
  var effects = options.effects || [];
  var reference = options.reference != null ? options.reference : 0;
  var valueLabel = options.valueLabel || 'estimate';
  // Colors are left to the engine's foreground/decoration defaults unless the
  // caller supplies them, so the tile follows the active theme.
  var color = options.color;
  var referenceColor = options.referenceColor;
  var labels = effects.map(function (e) { return e.label; });
  var estimates = effects.map(function (e) { return e.estimate; });
  var lo = effects.map(function (e) { return e.ciLow; });
  var hi = effects.map(function (e) { return e.ciHigh; });
  var lowest = Math.min(reference, lo.length ? Math.min.apply(null, lo) : reference);
  var highest = Math.max(reference, hi.length ? Math.max.apply(null, hi) : reference);
  var span = (highest - lowest) || 1;
  var pad = (options.pad != null ? options.pad : 0.2) * span;
  var lines = effects.map(function (e, i) {
    var seg = { catX: i + 1, valueMin: e.ciLow, valueMax: e.ciHigh, width: 2 };
    if (color) { seg.color = color; }
    return seg;
  });
  var refLine = { value: reference, type: 'dash', width: 1 };
  if (referenceColor) { refLine.color = referenceColor; }
  lines.push(refLine);
  return {
    data: { y: { vars: [valueLabel], smps: labels, data: [estimates] } },
    config: {
      graphType: 'Dotplot',
      graphOrientation: 'vertical',
      setMinX: lowest - pad,
      setMaxX: highest + pad,
      decorations: { line: lines }
    }
  };
}
