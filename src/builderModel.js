/**
 * Pure spec-editing operations behind the no-code builder. Every builder action
 * is a function from a spec to a new spec — "the builder is a spec editor,
 * nothing more" (Phase 4 acceptance). Keeping these pure makes them unit-testable
 * without a DOM and guarantees the builder can never do anything unexpressible in
 * the spec.
 *
 * All operations return a NEW spec (shallow-cloned where mutated); the input is
 * never modified.
 *
 * @module builderModel
 */

/**
 * The default number of grid columns when a spec doesn't specify one.
 * @type {number}
 */
export var DEFAULT_COLS = 12;

/**
 * Add a panel to the spec: a `panels[id]` entry and a `layout.items` placement.
 * @param {object} spec - The current spec.
 * @param {object} panel - New panel descriptor.
 * @param {string} panel.id - Unique panel id (also the layout item's `panel`).
 * @param {string} [panel.title] - Panel title.
 * @param {string} [panel.dataRef] - Data source ref.
 * @param {object} [panel.config] - CanvasXpress config (defaults to `{graphType:'Bar'}`).
 * @param {number} [panel.x] - Grid column (defaults to 0).
 * @param {number} [panel.y] - Grid row (defaults below existing content).
 * @param {number} [panel.w] - Width in columns (defaults to half the grid).
 * @param {number} [panel.h] - Height in rows (defaults to 3).
 * @returns {object} A new spec with the panel added.
 */
export function addPanel(spec, panel) {
  if (!panel || !panel.id) throw new Error('addPanel requires a panel id');
  if (spec.panels && Object.prototype.hasOwnProperty.call(spec.panels, panel.id)) {
    throw new Error('panel id "' + panel.id + '" already exists');
  }
  var cols = colsOf(spec);
  var next = cloneSpec(spec);
  var w = clampInt(panel.w, 1, cols, Math.max(1, Math.floor(cols / 2)));
  var h = clampInt(panel.h, 1, 1000, 3);
  var x = clampInt(panel.x, 0, cols - w, 0);
  var y = panel.y != null ? clampInt(panel.y, 0, 100000, 0) : nextFreeRow(spec);

  next.panels[panel.id] = {
    title: panel.title || panel.id,
    dataRef: panel.dataRef,
    config: panel.config || { graphType: 'Bar' }
  };
  next.layout.items.push({ panel: panel.id, x: x, y: y, w: w, h: h });
  return next;
}

/**
 * Remove a panel (its `panels` entry and every matching layout item).
 * @param {object} spec - The current spec.
 * @param {string} panelId - The panel id to remove.
 * @returns {object} A new spec with the panel removed.
 */
export function removePanel(spec, panelId) {
  var next = cloneSpec(spec);
  delete next.panels[panelId];
  next.layout.items = next.layout.items.filter(function (item) { return item.panel !== panelId; });
  return next;
}

/**
 * Move a panel to a new grid position, clamped inside the grid.
 * @param {object} spec - The current spec.
 * @param {string} panelId - The panel id.
 * @param {number} x - Target column.
 * @param {number} y - Target row.
 * @returns {object} A new spec with the panel moved.
 */
export function movePanel(spec, panelId, x, y) {
  var cols = colsOf(spec);
  return withItem(spec, panelId, function (item) {
    item.x = clampInt(x, 0, cols - item.w, item.x);
    item.y = clampInt(y, 0, 100000, item.y);
  });
}

/**
 * Resize a panel, clamped so it stays within the grid width and at least 1×1.
 * @param {object} spec - The current spec.
 * @param {string} panelId - The panel id.
 * @param {number} w - Target width (columns).
 * @param {number} h - Target height (rows).
 * @returns {object} A new spec with the panel resized.
 */
export function resizePanel(spec, panelId, w, h) {
  var cols = colsOf(spec);
  return withItem(spec, panelId, function (item) {
    item.w = clampInt(w, 1, cols - item.x, item.w);
    item.h = clampInt(h, 1, 1000, item.h);
  });
}

/**
 * Update a panel's editable fields (title, dataRef, config, measures). Only
 * provided keys change; `config` replaces the whole config object. A `measures`
 * of `undefined` (or empty) clears the projection (plot all variables).
 * @param {object} spec - The current spec.
 * @param {string} panelId - The panel id.
 * @param {object} changes - `{ title?, dataRef?, config?, measures? }`.
 * @returns {object} A new spec with the panel updated.
 */
export function updatePanel(spec, panelId, changes) {
  var next = cloneSpec(spec);
  var panel = next.panels[panelId];
  if (!panel) throw new Error('no such panel "' + panelId + '"');
  if (Object.prototype.hasOwnProperty.call(changes, 'title')) panel.title = changes.title;
  if (Object.prototype.hasOwnProperty.call(changes, 'dataRef')) panel.dataRef = changes.dataRef;
  if (Object.prototype.hasOwnProperty.call(changes, 'config')) panel.config = changes.config;
  if (Object.prototype.hasOwnProperty.call(changes, 'measures')) {
    if (changes.measures && changes.measures.length) panel.measures = changes.measures;
    else delete panel.measures;
  }
  return next;
}

/**
 * Add (or replace) a named inline data source.
 * @param {object} spec - The current spec.
 * @param {string} ref - The source name.
 * @param {object} source - A data source spec (`{kind, value|url, …}`).
 * @returns {object} A new spec with the source set.
 */
export function setDataSource(spec, ref, source) {
  var next = cloneSpec(spec);
  next.data[ref] = source;
  return next;
}

/**
 * Update dashboard-level presentation settings, purely. Recognized keys:
 * top-level `background` (CSS color), `backgroundImage` (URL or data URI),
 * `canvasInset` (px margin around each graph), `theme` ('light'|'dark'|'auto');
 * and layout `cols`, `rowHeight`, `gap` (px between panels). A nullish/empty
 * `background`/`backgroundImage` clears it.
 *
 * @param {object} spec - The current spec.
 * @param {object} changes - Any subset of the recognized keys.
 * @returns {object} A new spec with the settings applied.
 */
export function updateSettings(spec, changes) {
  var next = cloneSpec(spec);
  ['background', 'backgroundImage', 'canvasInset', 'theme', 'width', 'height'].forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) return;
    var value = changes[key];
    if (value == null || value === '') delete next[key];
    else next[key] = value;
  });
  ['cols', 'rowHeight', 'gap'].forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(changes, key) && changes[key] != null) {
      next.layout[key] = changes[key];
    }
  });
  return next;
}

/**
 * Create an empty, valid starter spec.
 * @param {string} id - Dashboard id.
 * @param {string} [title] - Dashboard title.
 * @param {number} [cols=12] - Grid columns.
 * @returns {object} A new blank spec.
 */
export function blankSpec(id, title, cols) {
  return {
    id: id,
    title: title || id,
    version: 1,
    broadcastGroup: id,
    layout: { cols: cols || DEFAULT_COLS, rowHeight: 130, gap: 12, items: [] },
    data: {},
    panels: {}
  };
}

/**
 * The grid column count for a spec.
 * @param {object} spec - The spec.
 * @returns {number} Columns (defaults to {@link DEFAULT_COLS}).
 * @private
 */
function colsOf(spec) {
  return (spec.layout && spec.layout.cols) || DEFAULT_COLS;
}

/**
 * The first grid row below all existing items (for auto-placement).
 * @param {object} spec - The spec.
 * @returns {number} The next free row index.
 * @private
 */
function nextFreeRow(spec) {
  var items = (spec.layout && spec.layout.items) || [];
  var maxBottom = 0;
  items.forEach(function (item) { maxBottom = Math.max(maxBottom, item.y + item.h); });
  return maxBottom;
}

/**
 * Clone a spec deeply enough that editing the copy never touches the original.
 * @param {object} spec - The spec.
 * @returns {object} A structural clone with layout/data/panels ready to edit.
 * @private
 */
function cloneSpec(spec) {
  var next = shallow(spec);
  next.layout = shallow(spec.layout || {});
  next.layout.items = ((spec.layout && spec.layout.items) || []).map(shallow);
  next.data = shallow(spec.data || {});
  next.panels = {};
  var panels = spec.panels || {};
  Object.keys(panels).forEach(function (k) { next.panels[k] = shallow(panels[k]); });
  return next;
}

/**
 * Apply a mutator to a panel's layout item within a cloned spec.
 * @param {object} spec - The spec.
 * @param {string} panelId - The panel id.
 * @param {function(object): void} mutator - Mutates the found item in place.
 * @returns {object} The new spec.
 * @private
 */
function withItem(spec, panelId, mutator) {
  var next = cloneSpec(spec);
  var item = next.layout.items.filter(function (i) { return i.panel === panelId; })[0];
  if (!item) throw new Error('no layout item for panel "' + panelId + '"');
  mutator(item);
  return next;
}

/**
 * Shallow-clone a plain object.
 * @param {object} obj - Source.
 * @returns {object} A copy of own enumerable keys.
 * @private
 */
function shallow(obj) {
  var out = {};
  for (var k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

/**
 * Coerce to an integer within [min, max], falling back when not a finite number.
 * @param {*} value - Candidate value.
 * @param {number} min - Lower bound (inclusive).
 * @param {number} max - Upper bound (inclusive).
 * @param {number} fallback - Value used when `value` isn't a finite number.
 * @returns {number} The clamped integer.
 * @private
 */
function clampInt(value, min, max, fallback) {
  var n = Math.round(Number(value));
  if (!isFinite(n)) n = fallback;
  if (max < min) max = min;
  return Math.max(min, Math.min(max, n));
}
