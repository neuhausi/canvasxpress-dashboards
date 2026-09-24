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

  if (panel.type === 'text') {
    // A text element: free-form text, no data source or graph config.
    next.panels[panel.id] = {
      type: 'text',
      title: panel.title || '',
      text: panel.text || ''
    };
  } else if (panel.type === 'image') {
    // An image element: a picture (URL or data: URI), scaled per `fit`. No data.
    next.panels[panel.id] = {
      type: 'image',
      title: panel.title || '',
      src: panel.src || '',
      fit: panel.fit || 'contain',
      alt: panel.alt || ''
    };
  } else if (panel.type === 'control') {
    // An annotation-filter control: one annotation of one dataset, broadcast
    // to every instance in the dashboard's coordination domain.
    var control = {
      type: 'control',
      title: panel.title || '',
      dataRef: panel.dataRef,
      compartment: panel.compartment || 'x',
      annotation: panel.annotation || '',
      style: panel.style || 'auto'
    };
    // A mode:"param" control drives a live query instead of a local filter; carry
    // its parameter + choice wiring through when the caller supplies it.
    if (panel.mode === 'param') {
      control.mode = 'param';
      control.param = panel.param || '';
      if (Array.isArray(panel.options)) control.options = panel.options;
      if (panel.optionsFrom) control.optionsFrom = panel.optionsFrom;
    }
    next.panels[panel.id] = control;
  } else if (panel.type === 'filters') {
    // A Filters panel: a multi-field filter inspector; no `fields` = every
    // annotation and numeric column of its dataRef.
    var filters = { type: 'filters', title: panel.title || 'Filters', dataRef: panel.dataRef };
    if (Array.isArray(panel.fields)) filters.fields = panel.fields;
    next.panels[panel.id] = filters;
  } else {
    next.panels[panel.id] = {
      title: panel.title || panel.id,
      dataRef: panel.dataRef,
      config: panel.config || { graphType: 'Bar' }
    };
  }
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
 * Do two layout items overlap?
 * @param {object} a - Item `{x,y,w,h}`.
 * @param {object} b - Item `{x,y,w,h}`.
 * @returns {boolean} True when the rectangles intersect.
 * @private
 */
function itemsCollide(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Resolve panel collisions after a resize (or programmatic placement): the
 * active panel keeps its place, colliding panels are pushed DOWN. The layout
 * is WYSIWYG — there is no auto-compaction, so panels stay where the user put
 * them, gaps included. Text panels are free-floating — they neither push nor
 * get pushed, and may overlap anything. Control panels are SOLID: they hold
 * their row, so graphs can never land on top of a filter bar and hide it.
 *
 * @param {object} spec - The current spec.
 * @param {string} [activeId] - The panel the user just resized (placed first
 *   so it wins its spot; others yield).
 * @returns {object} A new spec with a collision-free solid-panel layout.
 */
export function resolveCollisions(spec, activeId) {
  var next = cloneSpec(spec);
  var solids = solidItems(next);
  if (solids.length < 2) return next;

  // Placement order: the active panel first (it owns its position), then the
  // rest top-to-bottom, left-to-right — a stable order keeps pushes predictable.
  var ordered = solids.slice().sort(function (a, b) {
    if (a.panel === activeId) return -1;
    if (b.panel === activeId) return 1;
    return (a.y - b.y) || (a.x - b.x);
  });

  // Push phase: place each item; while it overlaps anything already placed,
  // move it down one row. There is NO compaction pass: panels stay where the
  // user put them (gaps and all) — auto-compacting yanks panels back up the
  // moment they are dropped over empty space, which reads as the layout
  // fighting the user.
  var placed = [];
  ordered.forEach(function (it) {
    var overlaps = function (p) { return itemsCollide(it, p); };
    var guard = 0;
    while (placed.some(overlaps) && guard++ < 1000) it.y += 1;
    placed.push(it);
  });
  return next;
}

/**
 * The layout items that take part in collision resolution: everything except
 * free-floating text panels. Controls are solid — they hold their row.
 * @param {object} spec - A (cloned) spec whose items may be mutated in place.
 * @returns {Array} The solid layout items.
 * @private
 */
function solidItems(spec) {
  return (spec.layout.items || []).filter(function (it) {
    var p = spec.panels[it.panel];
    return !(p && p.type === 'text');
  });
}

/**
 * Resolve a completed (or in-progress) DRAG at a drop position. Unlike
 * {@link resolveCollisions} — where the active panel always wins its exact
 * spot — the drop position expresses *ordering intent*: panels are placed
 * top-to-bottom by their current y (the active panel at its drop y, losing
 * ties in the direction it moved), each pushed down past earlier ones it
 * overlaps. There is no auto-compaction: the dropped panel stays EXACTLY
 * where it was dropped — over empty space, below a wider panel, anywhere —
 * instead of snapping back to where it came from.
 *
 * @param {object} spec - Spec with the active panel already at its drop x/y.
 * @param {string} activeId - The dragged panel.
 * @param {boolean} movedDown - True when the drag ended below its start row
 *   (the active panel then loses y-ties, so "just past the top edge" of a
 *   panel reads as "below it").
 * @returns {object} A new spec with a collision-free solid-panel layout.
 */
export function resolveDrop(spec, activeId, movedDown) {
  var next = cloneSpec(spec);
  var solids = solidItems(next);
  if (solids.length < 2) return next;

  var ordered = solids.slice().sort(function (a, b) {
    if (a.y !== b.y) return a.y - b.y;
    if (a.panel === activeId) return movedDown ? 1 : -1;
    if (b.panel === activeId) return movedDown ? -1 : 1;
    return a.x - b.x;
  });

  // Place in order: each item keeps its y unless it overlaps an earlier one,
  // in which case it moves down past it. No compaction: the dropped panel
  // stays EXACTLY where it was dropped, gaps included.
  var placed = [];
  ordered.forEach(function (it) {
    var overlaps = function (p) { return itemsCollide(it, p); };
    var guard = 0;
    while (placed.some(overlaps) && guard++ < 1000) it.y += 1;
    placed.push(it);
  });
  return next;
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
  if (Object.prototype.hasOwnProperty.call(changes, 'text')) panel.text = changes.text;
  ['compartment', 'annotation', 'style', 'align', 'valign', 'mode', 'param', 'placeholder', 'debounce',
    'src', 'fit', 'alt', 'href'].forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) panel[key] = changes[key];
  });
  // Param-control choice sources are mutually exclusive: setting one clears the
  // other so a control never carries a stale static list and a live query.
  if (Object.prototype.hasOwnProperty.call(changes, 'options')) {
    if (changes.options && changes.options.length) { panel.options = changes.options; delete panel.optionsFrom; }
    else delete panel.options;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'optionsFrom')) {
    if (changes.optionsFrom) { panel.optionsFrom = changes.optionsFrom; delete panel.options; }
    else delete panel.optionsFrom;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'html')) {
    panel.html = changes.html;
    delete panel.text;   // rich html supersedes the plain-text fallback
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'bg')) {
    if (changes.bg) panel.bg = changes.bg;
    else delete panel.bg;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'hideTitle')) {
    if (changes.hideTitle) panel.hideTitle = true;
    else delete panel.hideTitle;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'measures')) {
    if (changes.measures && changes.measures.length) panel.measures = changes.measures;
    else delete panel.measures;
  }
  // Chart-click cross-filter wiring (graph panels).
  if (Object.prototype.hasOwnProperty.call(changes, 'clickParam')) {
    if (changes.clickParam) panel.clickParam = changes.clickParam;
    else delete panel.clickParam;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'clickField')) {
    if (changes.clickField) panel.clickField = changes.clickField;
    else delete panel.clickField;
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
 * Declare (or update) a dashboard parameter. Parameters are the values a
 * `mode:"param"` control writes and a source's `query` reads via `$name`.
 * @param {object} spec - The current spec.
 * @param {string} name - The parameter name.
 * @param {object} [def] - `{ value, type }`; defaults to `{ value: null }`.
 * @returns {object} A new spec with the parameter declared.
 */
export function setParam(spec, name, def) {
  var next = cloneSpec(spec);
  if (!next.params) next.params = {};
  else next.params = shallow(next.params);
  next.params[name] = def || { value: null };
  return next;
}

/**
 * Remove a dashboard parameter (leaves any source query/control referencing it
 * untouched — validateSpec will flag a now-dangling reference).
 * @param {object} spec - The current spec.
 * @param {string} name - The parameter to remove.
 * @returns {object} A new spec without that parameter.
 */
export function removeParam(spec, name) {
  var next = cloneSpec(spec);
  if (next.params && Object.prototype.hasOwnProperty.call(next.params, name)) {
    next.params = shallow(next.params);
    delete next.params[name];
  }
  return next;
}

/**
 * Set (or clear) one entry of a data source's `query` template — the wiring
 * that makes a source consume a parameter (`field -> "$param"`). A null/empty
 * token removes the entry (and the whole `query` when it empties).
 * @param {object} spec - The current spec.
 * @param {string} ref - The data source name.
 * @param {string} field - The backend request field (query key).
 * @param {(string|null)} token - e.g. `"$region"`, or null/'' to clear.
 * @returns {object} A new spec with the source query updated.
 */
export function setSourceQuery(spec, ref, field, token) {
  var next = cloneSpec(spec);
  var source = next.data[ref];
  if (!source) return next;
  source = shallow(source);
  next.data[ref] = source;
  var query = source.query ? shallow(source.query) : {};
  if (token) query[field] = token;
  else delete query[field];
  if (Object.keys(query).length) source.query = query;
  else delete source.query;
  return next;
}

/**
 * Update dashboard-level presentation settings, purely. Recognized keys:
 * top-level `background` (CSS color), `backgroundImage` (URL or data URI),
 * `canvasInset` (px margin around each graph), `theme` (a CanvasXpress library
 * theme name, or `'auto'` to follow the OS light/dark preference),
 * `colorScheme` (a CanvasXpress library color-scheme name applied to every
 * chart), `coordinateBackground` (boolean; sync the dashboard background to the
 * theme's panel background), `panelColor` (CSS color for the panel chrome —
 * title bar, panel background, and border), `coordinatePanel` (boolean; match
 * the panel chrome to the dashboard background for a borderless look); and
 * layout `cols`, `rowHeight`, `gap` (px between panels). A nullish/empty
 * `background`/`backgroundImage`/`theme`/`colorScheme`/`panelColor` clears it.
 * `coordinateBackground`/`coordinatePanel` are deleted when falsy.
 *
 * @param {object} spec - The current spec.
 * @param {object} changes - Any subset of the recognized keys.
 * @returns {object} A new spec with the settings applied.
 */
export function updateSettings(spec, changes) {
  var next = cloneSpec(spec);
  ['background', 'backgroundImage', 'canvasInset', 'theme', 'colorScheme', 'panelColor', 'width', 'height', 'maxWidth', 'fontName'].forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) return;
    var value = changes[key];
    if (value == null || value === '') delete next[key];
    else next[key] = value;
  });
  ['coordinateBackground', 'coordinatePanel'].forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) return;
    if (changes[key]) next[key] = true;
    else delete next[key];
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
    layout: { cols: cols || DEFAULT_COLS, rowHeight: 30, gap: 12, items: [] },
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
