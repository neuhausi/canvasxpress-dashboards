/**
 * Run a `pushdown` query in the browser, over a source that has no database:
 * the same grammar a connector source runs in its database
 * (`{columns?, groupBy?, measures?, where?, orderBy?, limit?}`, see
 * `pushdownQuery` in dataStore.js), with the connector's semantics:
 *
 *  - `where`: `=`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not_in`, `between`
 *    (inclusive), `is_null`, `not_null`, all AND-ed. SQL null rules: a
 *    comparison with a missing value is false; `= null` / `!= null` mean
 *    is / is not null.
 *  - Rows mode (`columns`, or nothing): keep the matching rows and the listed
 *    columns. The row id stays the row id (named after the axis, `"smps"`);
 *    numeric columns stay variables and annotations stay annotations.
 *  - Aggregate mode (`groupBy` and/or `measures`): one row per group, in order
 *    of first appearance; no `groupBy` is one row named `all` (even over no
 *    rows, as SQL). Measures `count` (rows, or non-missing values of a column),
 *    `count_distinct`, `sum`, `avg` (alias `mean`), `min`, `max`, over
 *    non-missing values. The output goes through the connector's own
 *    rows -> CanvasXpress rule (first column = row ids; numeric columns are
 *    variables, the rest annotations), so it matches a database source.
 *  - `orderBy` names an output column (nulls last); `limit` keeps the first N.
 *
 * @module pushdown
 */

import { tableFields, tableColumn } from './join.js';

/** @type {string[]} Aggregate functions a measure may use. */
export var PUSHDOWN_FUNCTIONS = ['count', 'count_distinct', 'sum', 'avg', 'mean', 'min', 'max'];

/**
 * Run a pushdown query over a CanvasXpress data object.
 * @param {object} data - The source's data `{y:{vars,smps,data}, x?, z?}` (not modified).
 * @param {object} query - The query, `$param` tokens already resolved.
 * @param {string} [axis='smps'] - The source's row axis.
 * @returns {object} The result as a CanvasXpress data object.
 * @throws {Error} On an unknown column, function or operator, or an orderBy
 *   that is not an output column (the connector's messages).
 * @public
 */
export function runPushdown(data, query, axis) {
  axis = axis || 'smps';
  query = query || {};
  var fields = tableFields(data, axis);
  var available = [axis].concat(fields.columns, fields.annotations);
  var cache = {};

  /**
   * A column's values by row, checked to exist.
   * @param {string} name - Column name (the axis name is the row id).
   * @returns {Array} Values.
   */
  function column(name) {
    if (!Object.prototype.hasOwnProperty.call(cache, name)) {
      var col = typeof name === 'string' ? tableColumn(data, axis, name) : null;
      if (!col) throw new Error('No column named "' + name + '" in this source (it has: ' + available.join(', ') + ')');
      cache[name] = col.values;
    }
    return cache[name];
  }

  var ids = column(axis);
  var rows = [];
  for (var r = 0; r < ids.length; r++) rows.push(r);
  (query.where || []).forEach(function (clause) {
    var values = column(clause.column);
    var test = predicate(clause.op || '=', clause.value);
    rows = rows.filter(function (row) { return test(values[row]); });
  });

  var measures = (query.measures || []).map(normalizeMeasure);
  var groupBy = query.groupBy || [];
  if (groupBy.length || measures.length) {
    if (query.columns && query.columns.length) {
      throw new Error('Use \'columns\' for rows, or \'groupBy\'/\'measures\' for aggregates');
    }
    return aggregate(rows, groupBy, measures, query, column);
  }
  return selectRows(data, axis, fields, rows, query, column);
}

/**
 * Rows mode: keep rows and columns, sort, limit; keep each column's kind.
 * @param {object} data - Source data.
 * @param {string} axis - Row axis.
 * @param {{columns: string[], annotations: string[]}} fields - Its fields.
 * @param {number[]} rows - Matching row indices.
 * @param {object} query - The query.
 * @param {function} column - Checked column reader.
 * @returns {object} The CanvasXpress data object.
 */
function selectRows(data, axis, fields, rows, query, column) {
  var keep = query.columns && query.columns.length ? query.columns.slice() : fields.columns.concat(fields.annotations);
  keep.forEach(function (name) { column(name); });
  var outputs = [axis].concat(keep);
  rows = sortRows(rows, query.orderBy, outputs, function (name, row) { return column(name)[row]; });
  if (typeof query.limit === 'number') rows = rows.slice(0, query.limit);

  var numeric = keep.filter(function (name) { return fields.columns.indexOf(name) > -1; });
  var annotations = keep.filter(function (name) { return fields.columns.indexOf(name) === -1 && name !== axis; });
  var rowIds = rows.map(function (row) { return column(axis)[row]; });
  var bySmps = axis === 'smps';
  var y = data.y;
  var cols = bySmps ? y.vars : y.smps;
  var colIndex = numeric.map(function (name) { return cols.indexOf(name); });
  var out = { y: {} };
  var matrix;
  if (bySmps) {
    // y.data is vars x smps: one row per kept variable, one value per kept sample.
    matrix = numeric.map(function (name) { return rows.map(function (row) { return column(name)[row]; }); });
    out.y = { vars: numeric, smps: rowIds, data: matrix };
  } else {
    // Rows are variables: one row per kept variable (row), one value per kept sample (column).
    matrix = rows.map(function (row) { return numeric.map(function (name) { return column(name)[row]; }); });
    out.y = { vars: rowIds, smps: numeric, data: matrix };
  }
  var rowAnn = {};
  annotations.forEach(function (name) { rowAnn[name] = rows.map(function (row) { return column(name)[row]; }); });
  var colAnnIn = bySmps ? data.z : data.x;
  var colAnn = null;
  if (colAnnIn && numeric.length) {
    colAnn = {};
    Object.keys(colAnnIn).forEach(function (key) {
      var values = colAnnIn[key];
      colAnn[key] = colIndex.map(function (i) { return Array.isArray(values) ? values[i] : undefined; });
    });
  }
  if (Object.keys(rowAnn).length) out[bySmps ? 'x' : 'z'] = rowAnn;
  if (colAnn) out[bySmps ? 'z' : 'x'] = colAnn;
  return out;
}

/**
 * Aggregate mode: one output row per group (first-appearance order), or one
 * `all` row without groupBy; then sort, limit, and convert as the connector.
 * @param {number[]} rows - Matching row indices.
 * @param {string[]} groupBy - Group columns.
 * @param {object[]} measures - Normalized measures.
 * @param {object} query - The query.
 * @param {function} column - Checked column reader.
 * @returns {object} The CanvasXpress data object.
 */
function aggregate(rows, groupBy, measures, query, column) {
  var header = groupBy.length ? groupBy.slice() : ['group'];
  measures.forEach(function (m) {
    if (header.indexOf(m.as) > -1) throw new Error('Two outputs are named "' + m.as + '"');
    header.push(m.as);
    if (m.column) column(m.column);
  });
  groupBy.forEach(function (name) { column(name); });
  var groups = [];
  var byKey = {};
  if (!groupBy.length) {
    groups.push({ values: ['all'], rows: rows });
  } else {
    rows.forEach(function (row) {
      var values = groupBy.map(function (name) { return column(name)[row]; });
      var key = JSON.stringify(values);
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
        byKey[key] = { values: values, rows: [] };
        groups.push(byKey[key]);
      }
      byKey[key].rows.push(row);
    });
  }
  var table = groups.map(function (g) {
    return g.values.concat(measures.map(function (m) { return measure(m, g.rows, column); }));
  });
  var order = sortRows(table.map(function (row, i) { return i; }), query.orderBy, header, function (name, i) {
    return table[i][header.indexOf(name)];
  });
  if (typeof query.limit === 'number') order = order.slice(0, query.limit);
  return rowsToCx(header, order.map(function (i) { return table[i]; }));
}

/**
 * Normalize a measure: `mean` is `avg`, the function must be known, and a
 * measure other than `count` needs a column.
 * @param {object} m - `{fn, column?, as}`.
 * @returns {object} `{fn, column, as}`.
 */
function normalizeMeasure(m) {
  var fn = m && m.fn === 'mean' ? 'avg' : (m && m.fn);
  if (PUSHDOWN_FUNCTIONS.indexOf(fn) === -1) {
    throw new Error('fn must be one of: count, count_distinct, sum, avg, min, max');
  }
  if (fn !== 'count' && !(m && m.column)) throw new Error(fn + ' needs a column');
  return { fn: fn, column: m.column || null, as: m.as || (m.column ? fn + '_' + m.column : fn) };
}

/**
 * Compute one measure over a group's rows, ignoring missing values (SQL).
 * @param {object} m - Normalized measure.
 * @param {number[]} rows - The group's row indices.
 * @param {function} column - Checked column reader.
 * @returns {*} The value (null when there is nothing to aggregate, as SQL).
 */
function measure(m, rows, column) {
  if (m.fn === 'count' && !m.column) return rows.length;
  var values = rows.map(function (row) { return column(m.column)[row]; }).filter(function (v) { return !isMissing(v); });
  if (m.fn === 'count') return values.length;
  if (m.fn === 'count_distinct') {
    var seen = {};
    values.forEach(function (v) { seen[typeof v + ':' + v] = true; });
    return Object.keys(seen).length;
  }
  if (!values.length) return null;
  if (m.fn === 'min' || m.fn === 'max') {
    return values.reduce(function (best, v) {
      var c = compare(v, best);
      return (m.fn === 'min' ? c < 0 : c > 0) ? v : best;
    });
  }
  var sum = values.reduce(function (acc, v) { return acc + Number(v); }, 0);
  return m.fn === 'sum' ? sum : sum / values.length;
}

/**
 * A row test for one `where` clause.
 * @param {string} op - Operator.
 * @param {*} value - Operand (a list for in / not_in, [lo, hi] for between).
 * @returns {function(*): boolean} The test.
 */
function predicate(op, value) {
  switch (op) {
    case '=': return value == null ? isMissing : function (v) { return !isMissing(v) && equal(v, value); };
    case '!=': return value == null ? function (v) { return !isMissing(v); } : function (v) { return !isMissing(v) && !equal(v, value); };
    case '<': return function (v) { return !isMissing(v) && compare(v, value) < 0; };
    case '<=': return function (v) { return !isMissing(v) && compare(v, value) <= 0; };
    case '>': return function (v) { return !isMissing(v) && compare(v, value) > 0; };
    case '>=': return function (v) { return !isMissing(v) && compare(v, value) >= 0; };
    case 'in': return function (v) { return !isMissing(v) && list(value).some(function (x) { return equal(v, x); }); };
    case 'not_in': return function (v) { return !isMissing(v) && !list(value).some(function (x) { return equal(v, x); }); };
    case 'between': return function (v) {
      var range = list(value);
      return !isMissing(v) && compare(v, range[0]) >= 0 && compare(v, range[1]) <= 0;
    };
    case 'is_null': return isMissing;
    case 'not_null': return function (v) { return !isMissing(v); };
    default: throw new Error('Unknown filter operator "' + op + '"');
  }
}

/**
 * Sort row indices by `orderBy` output columns, missing values last.
 * @param {number[]} rows - Row indices.
 * @param {Array} [orderBy] - Names or `{column, desc}`.
 * @param {string[]} outputs - The output column names.
 * @param {function(string, number): *} valueOf - Reads an output of a row.
 * @returns {number[]} Sorted indices (stable).
 */
function sortRows(rows, orderBy, outputs, valueOf) {
  var keys = (orderBy || []).map(function (o) { return typeof o === 'string' ? { column: o, desc: false } : o; });
  if (!keys.length) return rows;
  keys.forEach(function (k) {
    if (outputs.indexOf(k.column) === -1) throw new Error('orderBy "' + k.column + '" is not an output column');
  });
  return rows.map(function (row, i) { return { row: row, i: i }; }).sort(function (a, b) {
    for (var k = 0; k < keys.length; k++) {
      var va = valueOf(keys[k].column, a.row);
      var vb = valueOf(keys[k].column, b.row);
      if (isMissing(va) !== isMissing(vb)) return isMissing(va) ? 1 : -1;   // nulls last
      if (isMissing(va)) continue;
      var c = compare(va, vb);
      if (c) return keys[k].desc ? -c : c;
    }
    return a.i - b.i;
  }).map(function (e) { return e.row; });
}

/**
 * The connector's rows -> CanvasXpress rule (cx_connectors.reshape.rows_to_cx):
 * the first column is the row ids; each other column is a variable when every
 * value is a number, else an annotation. No rows is an empty, valid object.
 * @param {string[]} header - Column names.
 * @param {Array[]} rows - Rows.
 * @returns {object} The CanvasXpress data object.
 */
export function rowsToCx(header, rows) {
  var numericCol = header.map(function (h, c) {
    return rows.length > 0 && rows.every(function (row) { return typeof row[c] === 'number' && isFinite(row[c]); });
  });
  var vars = [];
  var data = [];
  var x = {};
  for (var c = 1; c < header.length; c++) {
    var values = rows.map(function (row) { return row[c]; });
    if (numericCol[c]) {
      vars.push(header[c]);
      data.push(values);
    } else {
      x[header[c]] = values;
    }
  }
  var out = { y: { vars: vars, smps: rows.map(function (row) { return String(row[0]); }), data: data } };
  if (Object.keys(x).length) out.x = x;
  return out;
}

/**
 * Whether a cell is missing (SQL NULL): null, undefined, or NaN. An empty
 * string is a value, as in SQL.
 * @param {*} v - Cell.
 * @returns {boolean} True when missing.
 */
function isMissing(v) {
  return v == null || (typeof v === 'number' && isNaN(v));
}

/**
 * Compare two cells: numerically when both read as numbers, else as strings.
 * @param {*} a - Cell.
 * @param {*} b - Cell.
 * @returns {number} Negative, zero, or positive.
 */
function compare(a, b) {
  var na = typeof a === 'number' ? a : Number(a);
  var nb = typeof b === 'number' ? b : Number(b);
  if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb;
  var sa = String(a);
  var sb = String(b);
  return sa < sb ? -1 : (sa > sb ? 1 : 0);
}

/**
 * Cell equality with the same number/string rule as {@link compare}.
 * @param {*} a - Cell.
 * @param {*} b - Cell.
 * @returns {boolean} True when equal.
 */
function equal(a, b) {
  return compare(a, b) === 0;
}

/**
 * A value as a list (a scalar becomes a one-item list).
 * @param {*} value - Value.
 * @returns {Array} The list.
 */
function list(value) {
  return Array.isArray(value) ? value : [value];
}
