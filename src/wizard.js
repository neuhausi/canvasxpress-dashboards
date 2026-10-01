/**
 * Data-first wizard helpers: Upload → Check → Visualize → Publish.
 *
 * Parsing is NOT done here: the wizard hands files / pasted text to the
 * CanvasXpress engine (`loadFile`, the same IO parsers the builder already
 * uses), and gets a CanvasXpress data object back. These helpers only
 * *inspect and reshape* that object — a column table for the preview and the
 * chart selector, a per-column type/bad-cell profile, and opt-in
 * decimal-comma number conversion — and build the one-panel spec to publish.
 * Pure functions (no DOM), so they are unit-tested in node.
 */

import { blankSpec, addPanel, setDataSource } from './builderModel.js';
// Transpose is the existing join helper (vars <-> smps, x <-> z): transposeCxData in join.js.

/**
 * The column axis of a CanvasXpress data object: the shorter of vars / smps
 * (how the app shows tables, and how the server's MCP bridge reads datasets).
 * @param {object} data - CanvasXpress data `{y: {vars, smps, data}, x?, z?}`.
 * @returns {boolean} True when vars are the columns (rows are the samples).
 * @private
 */
function varsAreColumns(data) {
  var y = (data && data.y) || {};
  return (y.vars || []).length <= (y.smps || []).length;
}

/**
 * Flatten a CanvasXpress data object into a header + rows table: the row-id
 * column, the measured columns, then the annotation (factor) columns that
 * describe each row.
 * @param {object} data - CanvasXpress data object.
 * @returns {Array<Array>} `[[headers…], [row…], …]` — the shape the chart
 *   selector (`/api/wizard/suggest`) and the preview profile expect.
 * @public
 */
export function tableFromData(data) {
  var y = (data && data.y) || {};
  var vars = y.vars || [];
  var smps = y.smps || [];
  var matrix = y.data || [];
  var byVar = varsAreColumns(data);
  var columns = byVar ? vars : smps;
  var rowIds = byVar ? smps : vars;
  // Annotations describing each ROW: x (per sample) when rows are samples, else z.
  var annotations = (byVar ? data && data.x : data && data.z) || {};
  var annotationKeys = Object.keys(annotations);
  var table = [['Id'].concat(columns.map(String), annotationKeys)];
  for (var r = 0; r < rowIds.length; r++) {
    var row = [rowIds[r]];
    for (var c = 0; c < columns.length; c++) {
      row.push(byVar ? (matrix[c] || [])[r] : (matrix[r] || [])[c]);
    }
    for (var a = 0; a < annotationKeys.length; a++) {
      row.push((annotations[annotationKeys[a]] || [])[r]);
    }
    table.push(row);
  }
  return table;
}

var DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/**
 * Is a cell a number (a JS number, or a plain numeric string)?
 * @param {*} value - Cell.
 * @returns {boolean}
 * @private
 */
function isNumeric(value) {
  if (typeof value === 'number') return isFinite(value);
  if (typeof value !== 'string') return false;
  var s = value.trim();
  return s !== '' && isFinite(Number(s));
}

/**
 * Is a cell empty / a missing-value marker?
 * @param {*} value - Cell.
 * @returns {boolean}
 * @private
 */
function isMissing(value) {
  if (value === null || value === undefined) return true;
  var s = String(value).trim();
  return s === '' || /^(na|n\/a|nan|null|-)$/i.test(s);
}

/**
 * Profile each column of a header + rows table for the Check step.
 * A column is `numeric` (or `date`) when most (more than half) of its
 * non-missing cells are; the remaining non-missing cells of a numeric/date column are flagged
 * as bad (e.g. "1.234,5" or "n.a." in a number column).
 * @param {Array<Array>} table - `[[headers…], [row…], …]` from {@link tableFromData}.
 * @returns {Array<object>} Per column: `{name, type: 'numeric'|'date'|'text',
 *   missing, bad, badRows: [row numbers, 1-based, at most 5], unique}`.
 * @public
 */
export function profileColumns(table) {
  var headers = (table && table[0]) || [];
  var rows = (table || []).slice(1);
  return headers.map(function (name, col) {
    var numeric = 0, dates = 0, present = 0, missing = 0;
    var seen = {};
    rows.forEach(function (row) {
      var value = row[col];
      if (isMissing(value)) { missing++; return; }
      present++;
      seen[String(value)] = true;
      if (isNumeric(value)) numeric++;
      else if (typeof value === 'string' && DATE_RE.test(value.trim())) dates++;
    });
    // Majority rule: a mostly-numeric column with a stray "oops" is a numeric
    // column with a bad cell (the engine files it as text — exactly what Check
    // must surface), not a text column.
    var type = present && numeric / present > 0.5 ? 'numeric'
      : present && dates / present > 0.5 ? 'date' : 'text';
    var badRows = [];
    var bad = 0;
    if (type !== 'text') {
      rows.forEach(function (row, r) {
        var value = row[col];
        if (isMissing(value)) return;
        var ok = type === 'numeric' ? isNumeric(value)
          : typeof value === 'string' && DATE_RE.test(value.trim());
        if (!ok) {
          bad++;
          if (badRows.length < 5) badRows.push(r + 1);
        }
      });
    }
    return { name: String(name), type: type, missing: missing, bad: bad, badRows: badRows,
      unique: Object.keys(seen).length };
  });
}

/**
 * Convert European-formatted numeric strings ("1.234,5", "12,5") in the data
 * matrix into numbers. Opt-in (the Check step's "decimal comma" toggle): a
 * value converts only when it is unambiguously comma-decimal, so plain numbers
 * and text are left alone.
 * @param {object} data - CanvasXpress data object.
 * @returns {{data: object, converted: number}} A new data object and how many
 *   cells were converted.
 * @public
 */
export function applyDecimalComma(data) {
  var converted = 0;
  var y = (data && data.y) || {};
  var matrix = (y.data || []).map(function (row) {
    return (row || []).map(function (value) {
      if (typeof value !== 'string') return value;
      var s = value.trim();
      // digits with optional '.' thousands groups, a ',' decimal part
      if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(s) || /^-?\d+,\d+$/.test(s)) {
        converted++;
        return Number(s.replace(/\./g, '').replace(',', '.'));
      }
      return value;
    });
  });
  var next = JSON.parse(JSON.stringify(data || {}));
  next.y = next.y || {};
  next.y.data = matrix;
  return { data: next, converted: converted };
}

/**
 * The one-panel dashboard the wizard publishes: a full-width chart bound to
 * the stored dataset.
 * @param {object} opts - `{id, title, datasetId, store?, config}`.
 * @returns {object} A valid dashboard spec.
 * @public
 */
export function wizardSpec(opts) {
  var spec = blankSpec(opts.id, opts.title);
  var source = { kind: 'dataset', id: opts.datasetId };
  if (opts.store) source.store = opts.store;
  spec = setDataSource(spec, 'data', source);
  var cols = spec.layout.cols;
  return addPanel(spec, {
    id: 'chart',
    title: opts.chartTitle || '',
    dataRef: 'data',
    config: opts.config || { graphType: 'Bar' },
    x: 0, y: 0, w: cols, h: 14
  });
}
