/**
 * Analysis transforms — client-side, dependency-free, deterministic.
 *
 * These are *analysis* controls, not display filters: a scientist toggles a
 * transform and every bound panel recomputes. Light, deterministic transforms
 * (log, z-score, median-center, quantile normalization) run here in the browser
 * so the control is instant and offline; heavy batch correction (ComBat / limma)
 * stays a server-side `function` source (see analysisControls.batchCorrectionSource).
 *
 * Each row-wise transform matches its R reference to double precision (validated
 * in transforms.test.js): log2/log10 = base change, zscore = R `scale()` (sample
 * sd, n-1), medianCenter = `x - median(x)`, quantileNormalize = the
 * preprocessCore rank→mean-of-sorted interpolation.
 *
 * @module transforms
 */

/** Transform ids this module understands, in menu order. */
export var TRANSFORM_METHODS = ['none', 'log2', 'log10', 'zscore', 'medianCenter', 'quantileNormalize'];

/** Human labels for the control UI. */
export var TRANSFORM_LABELS = {
  none: 'None',
  log2: 'log2',
  log10: 'log10',
  zscore: 'Z-score',
  medianCenter: 'Median-center',
  quantileNormalize: 'Quantile normalize'
};

function median(values) {
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var n = sorted.length;
  if (!n) { return 0; }
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** log base-2 of each value. @param {number[]} row @returns {number[]} */
export function log2Row(row) { return row.map(function (v) { return Math.log(v) / Math.LN2; }); }

/** log base-10 of each value. @param {number[]} row @returns {number[]} */
export function log10Row(row) { return row.map(function (v) { return Math.log(v) / Math.LN10; }); }

/**
 * Z-score (R `scale()`): subtract the mean, divide by the sample sd (n-1).
 * A zero-variance row returns all zeros rather than NaN.
 * @param {number[]} row @returns {number[]}
 */
export function zscoreRow(row) {
  var n = row.length;
  if (!n) { return []; }
  var mean = row.reduce(function (a, b) { return a + b; }, 0) / n;
  var ss = row.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0);
  var sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  if (!sd) { return row.map(function () { return 0; }); }
  return row.map(function (v) { return (v - mean) / sd; });
}

/** Median-center: subtract the row median. @param {number[]} row @returns {number[]} */
export function medianCenterRow(row) {
  var med = median(row);
  return row.map(function (v) { return v - med; });
}

/**
 * Average ranks (ties.method="average"), 1-based, as R's rank().
 * @param {number[]} column @returns {number[]}
 * @private
 */
function averageRanks(column) {
  var order = column.map(function (_, i) { return i; })
    .sort(function (a, b) { return column[a] - column[b]; });
  var ranks = new Array(column.length);
  var i = 0;
  while (i < order.length) {
    var j = i;
    while (j + 1 < order.length && column[order[j + 1]] === column[order[i]]) { j++; }
    var avg = (i + j) / 2 + 1;
    for (var k = i; k <= j; k++) { ranks[order[k]] = avg; }
    i = j + 1;
  }
  return ranks;
}

/**
 * Quantile-normalize a matrix given as an array of columns (each column an array
 * of equal length). Matches preprocessCore::normalize.quantiles: mean of the
 * sorted values per rank, then map each column's average ranks back through that
 * reference by linear interpolation (so tied/fractional ranks interpolate).
 * @param {number[][]} columns @returns {number[][]} normalized columns
 */
export function quantileNormalize(columns) {
  if (!columns.length) { return []; }
  var nrow = columns[0].length;
  var ncol = columns.length;
  var sortedColumns = columns.map(function (c) { return c.slice().sort(function (a, b) { return a - b; }); });
  var referenceMeans = [];
  for (var r = 0; r < nrow; r++) {
    var sum = 0;
    for (var c = 0; c < ncol; c++) { sum += sortedColumns[c][r]; }
    referenceMeans.push(sum / ncol);
  }
  var interpolate = function (rank) {
    var low = Math.floor(rank) - 1;
    var high = Math.ceil(rank) - 1;
    var frac = rank - Math.floor(rank);
    if (low < 0) { low = 0; }
    if (high >= nrow) { high = nrow - 1; }
    return referenceMeans[low] + frac * (referenceMeans[high] - referenceMeans[low]);
  };
  return columns.map(function (column) {
    var ranks = averageRanks(column);
    return ranks.map(interpolate);
  });
}

/**
 * Apply a transform to a CanvasXpress data object, returning a NEW object (the
 * source is left untouched so the control can re-transform or reset). `data.y.data`
 * is a rows (vars) x columns (smps) matrix. Row-wise transforms (log/zscore/
 * medianCenter) map each variable's row; quantileNormalize works across samples
 * (columns). `none` returns a shallow copy unchanged.
 *
 * @param {object} cxData - A CanvasXpress data object with `y.data`.
 * @param {string} method - A TRANSFORM_METHODS id.
 * @returns {object} A new CanvasXpress data object with the transform applied.
 */
export function transformData(cxData, method) {
  if (!cxData || !cxData.y || !Array.isArray(cxData.y.data)) { return cxData; }
  if (!method || method === 'none' || TRANSFORM_METHODS.indexOf(method) < 0) {
    return shallowCloneData(cxData);
  }
  var matrix = cxData.y.data;
  var out;
  if (method === 'quantileNormalize') {
    // Columns = samples. Transpose, normalize, transpose back.
    var nrow = matrix.length;
    var ncol = nrow ? matrix[0].length : 0;
    var columns = [];
    for (var c = 0; c < ncol; c++) {
      var col = [];
      for (var r = 0; r < nrow; r++) { col.push(matrix[r][c]); }
      columns.push(col);
    }
    var normalized = quantileNormalize(columns);
    out = [];
    for (var ri = 0; ri < nrow; ri++) {
      var newRow = [];
      for (var ci = 0; ci < ncol; ci++) { newRow.push(normalized[ci][ri]); }
      out.push(newRow);
    }
  } else {
    var rowFn = method === 'log2' ? log2Row
      : method === 'log10' ? log10Row
      : method === 'zscore' ? zscoreRow
      : medianCenterRow;
    out = matrix.map(function (row) { return rowFn(row); });
  }
  var clone = shallowCloneData(cxData);
  clone.y = {};
  for (var key in cxData.y) { if (Object.prototype.hasOwnProperty.call(cxData.y, key)) { clone.y[key] = cxData.y[key]; } }
  clone.y.data = out;
  return clone;
}

/** Shallow clone of a CX data object (top level + y container). @private */
function shallowCloneData(cxData) {
  var clone = {};
  for (var key in cxData) { if (Object.prototype.hasOwnProperty.call(cxData, key)) { clone[key] = cxData[key]; } }
  return clone;
}
