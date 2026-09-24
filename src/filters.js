/**
 * Global filter model for the dashboard Filters panel (`type: "filters"`).
 *
 * A filter state is a serializable list of predicates, one per filtered field:
 *
 *   [{ dataRef: "clin", field: "Arm", values: ["drug"] },
 *    { dataRef: "clin", field: "Age", min: 50, max: 70 },
 *    { dataRef: "expr", field: "smps", text: "p1" }]
 *
 *  - `values` keeps rows whose value is one of the listed values;
 *  - `min` / `max` keep rows whose numeric value lies in the (inclusive) range;
 *  - `text` keeps rows whose value contains the text (case-insensitive).
 * Predicates on one source AND together. This module evaluates them against a
 * source's data; the renderer translates the surviving rows to related
 * sources (see `marking.js`). Named states are the dashboard's filter schemes.
 *
 * @module filters
 */

import { tableFields, tableColumn } from './join.js';

/** @type {string[]} Field widget kinds. */
export var FIELD_KINDS = ['values', 'range', 'search'];

/**
 * Above this many distinct values an auto-detected categorical field becomes a
 * search box instead of a checkbox list.
 * @type {number}
 */
export var MAX_LIST_VALUES = 50;

/**
 * Resolve a Filters panel's field list: its explicit `fields` (strings name
 * fields of `panel.dataRef`), or — when absent — every row annotation and
 * numeric column of `panel.dataRef`. Each field's widget kind is its explicit
 * `kind`, else detected from the data (numeric -> range; up to
 * {@link MAX_LIST_VALUES} distinct values -> values; else search).
 * @param {object} panel - The Filters panel spec.
 * @param {function} dataOf - `function(ref)` -> resolved data, or null.
 * @param {function} axisOf - `function(ref)` -> the source's row axis.
 * @returns {Array<{dataRef: string, field: string, kind: string, label: string}>}
 *   Resolved fields (fields whose source data is missing are dropped).
 * @public
 */
export function resolveFields(panel, dataOf, axisOf) {
  var entries = [];
  if (Array.isArray(panel.fields) && panel.fields.length) {
    panel.fields.forEach(function (f) {
      if (typeof f === 'string') entries.push({ dataRef: panel.dataRef, field: f });
      else if (f && typeof f.field === 'string') entries.push({ dataRef: f.dataRef || panel.dataRef, field: f.field, kind: f.kind, label: f.label });
    });
  } else if (panel.dataRef && dataOf(panel.dataRef)) {
    var names = tableFields(dataOf(panel.dataRef), axisOf(panel.dataRef));
    names.annotations.concat(names.columns).forEach(function (field) {
      entries.push({ dataRef: panel.dataRef, field: field });
    });
  }
  var refs = {};
  entries.forEach(function (e) { refs[e.dataRef] = true; });
  var multi = Object.keys(refs).length > 1;
  var out = [];
  entries.forEach(function (e) {
    var data = e.dataRef ? dataOf(e.dataRef) : null;
    if (!data) return;
    var summary = summarizeField(data, axisOf(e.dataRef), e.field);
    if (!summary) return;
    var kind = FIELD_KINDS.indexOf(e.kind) !== -1 ? e.kind
      : summary.numeric ? 'range'
      : summary.values.length <= MAX_LIST_VALUES ? 'values' : 'search';
    out.push({
      dataRef: e.dataRef,
      field: e.field,
      kind: kind,
      label: e.label || (multi ? e.field + ' (' + e.dataRef + ')' : e.field),
      summary: summary
    });
  });
  return out;
}

/**
 * Summarize a field for its widget: distinct values with counts (sorted,
 * numeric-aware), and whether every non-missing value is a number (with the
 * numeric min/max). Numeric-looking strings count as categories.
 * @param {object} data - CanvasXpress data object.
 * @param {string} axis - Row axis.
 * @param {string} field - Field name.
 * @returns {({values: Array<{value: string, count: number}>, numeric: boolean, min: number, max: number}|null)}
 *   The summary, or null when the field does not exist.
 * @public
 */
export function summarizeField(data, axis, field) {
  var column = tableColumn(data, axis, field);
  if (!column) return null;
  var counts = Object.create(null);
  var order = [];
  var numeric = true;
  var seenValue = false;
  var min = Infinity;
  var max = -Infinity;
  column.values.forEach(function (v) {
    if (v == null || v === '') return;
    seenValue = true;
    var key = String(v);
    if (!(key in counts)) { counts[key] = 0; order.push(key); }
    counts[key]++;
    // Only real numbers make a range: a numeric-looking annotation string
    // ("17" for a chromosome, a zip code) is a category.
    if (typeof v !== 'number' || !isFinite(v)) numeric = false;
    else { if (v < min) min = v; if (v > max) max = v; }
  });
  // The row ids are names, never a numeric range.
  if (field === axis) numeric = false;
  // Sorted (numeric-aware), so a checkbox list reads I, II, III, IV — not data order.
  order.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); });
  return {
    values: order.map(function (k) { return { value: k, count: counts[k] }; }),
    numeric: numeric && seenValue,
    min: numeric && seenValue ? min : null,
    max: numeric && seenValue ? max : null
  };
}

/**
 * Whether a predicate narrows anything.
 * @param {object} p - Predicate `{values?, min?, max?, text?}`.
 * @returns {boolean} True when it filters rows.
 * @public
 */
export function isActive(p) {
  if (!p) return false;
  return Array.isArray(p.values) || isNumber(p.min) || isNumber(p.max) ||
    (typeof p.text === 'string' && p.text.trim() !== '');
}

/**
 * The rows of a source that pass every active predicate on it.
 * @param {object[]} state - The filter state (predicates for any sources).
 * @param {string} ref - The source to evaluate.
 * @param {object} data - Its data object.
 * @param {string} axis - Its row axis.
 * @returns {(string[]|null)} Surviving row ids, or null when no active
 *   predicate targets this source.
 * @public
 */
export function rowsPassing(state, ref, data, axis) {
  var preds = (state || []).filter(function (p) { return p && p.dataRef === ref && isActive(p); });
  if (!preds.length) return null;
  var keep = null;
  preds.forEach(function (p) {
    var column = tableColumn(data, axis, p.field);
    if (!column) return;   // a field the data lacks narrows nothing
    if (keep === null) {
      keep = [];
      for (var k = 0; k < column.ids.length; k++) keep.push(true);
    }
    for (var i = 0; i < column.values.length; i++) {
      if (keep[i] && !passes(p, column.values[i])) keep[i] = false;
    }
  });
  if (keep === null) return null;
  var ids = tableColumn(data, axis, axis).ids;
  return ids.filter(function (id, i) { return keep[i]; });
}

/**
 * Normalize a filter state: drop malformed and inactive predicates and keep
 * one predicate per source + field (the last wins).
 * @param {*} state - Candidate state.
 * @returns {object[]} A clean, serializable state.
 * @public
 */
export function normalizeState(state) {
  var byKey = {};
  var order = [];
  (Array.isArray(state) ? state : []).forEach(function (p) {
    if (!p || typeof p.dataRef !== 'string' || typeof p.field !== 'string' || !isActive(p)) return;
    var clean = { dataRef: p.dataRef, field: p.field };
    if (Array.isArray(p.values)) clean.values = p.values.map(String);
    if (isNumber(p.min)) clean.min = p.min;
    if (isNumber(p.max)) clean.max = p.max;
    if (typeof p.text === 'string' && p.text.trim() !== '') clean.text = p.text;
    var key = fieldKey(p.dataRef, p.field);
    if (!Object.prototype.hasOwnProperty.call(byKey, key)) order.push(key);
    byKey[key] = clean;
  });
  return order.map(function (k) { return byKey[k]; });
}

/**
 * A stable key for a source + field.
 * @param {string} dataRef - Source ref.
 * @param {string} field - Field name.
 * @returns {string} The key.
 * @public
 */
export function fieldKey(dataRef, field) {
  return dataRef + '\u0001' + field;
}

/**
 * Whether one value passes a predicate. A missing value fails any active
 * predicate (like SQL NULL).
 * @param {object} p - Predicate.
 * @param {*} value - Cell value.
 * @returns {boolean} True when it passes.
 * @private
 */
function passes(p, value) {
  if (value == null || value === '') return false;
  if (Array.isArray(p.values) && p.values.indexOf(String(value)) === -1) return false;
  if (isNumber(p.min) || isNumber(p.max)) {
    var n = typeof value === 'number' ? value : Number(value);
    if (isNaN(n)) return false;
    if (isNumber(p.min) && n < p.min) return false;
    if (isNumber(p.max) && n > p.max) return false;
  }
  if (typeof p.text === 'string' && p.text.trim() !== '' &&
      String(value).toLowerCase().indexOf(p.text.trim().toLowerCase()) === -1) return false;
  return true;
}

/**
 * Finite-number check.
 * @param {*} v - Value.
 * @returns {boolean} True for a finite number.
 * @private
 */
function isNumber(v) {
  return typeof v === 'number' && isFinite(v);
}
