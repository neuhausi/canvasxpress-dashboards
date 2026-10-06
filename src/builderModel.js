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

import { sourceAxis, JOIN_TYPES } from './join.js';

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
  if (Object.prototype.hasOwnProperty.call(changes, 'actions')) {
    if (Array.isArray(changes.actions) && changes.actions.length) panel.actions = changes.actions;
    else delete panel.actions;
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

/** @type {string[]} How a selection shows in related panels (default `focus`). */
export var MARKING_MODES = ['focus', 'highlight', 'ghost'];

/**
 * Encode a pair of key columns as the `on` grammar that `kind:"join"` sources
 * and `spec.relationships` share. An empty key means "the row id", which is
 * spelled as the source's row axis (`"smps"` / `"vars"`). Both sides on their
 * row id is the default, so `on` is omitted; the same name on both sides is a
 * plain string; otherwise `{left, right}`.
 * @param {object} spec - The spec (for each source's row axis).
 * @param {string} left - Left source ref.
 * @param {string} right - Right source ref.
 * @param {string} [leftKey] - Left key column ('' = row id).
 * @param {string} [rightKey] - Right key column ('' = row id).
 * @returns {(string|object|undefined)} The `on` value, or undefined for row ids.
 * @public
 */
export function encodeKeys(spec, left, right, leftKey, rightKey) {
  var sources = spec.data || {};
  var leftAxis = sourceAxis(left, sources);
  var rightAxis = sourceAxis(right, sources);
  var lk = leftKey || leftAxis;
  var rk = rightKey || rightAxis;
  if (lk === leftAxis && rk === rightAxis) return undefined;
  if (lk === rk) return lk;
  return { left: lk, right: rk };
}

/**
 * Add a cross-source relationship: selecting rows in panels on `left` marks
 * the rows of `right` whose key matches (and vice versa). The sources are not
 * blended — each keeps its own panels.
 * @param {object} spec - The current spec.
 * @param {object} link - `{left, right, leftKey?, rightKey?}`; an empty key
 *   is the row id.
 * @returns {object} A new spec with the relationship appended.
 * @throws {Error} When a source is missing, both sides are the same source, or
 *   the same link already exists (in either direction).
 * @public
 */
export function addRelationship(spec, link) {
  var left = link && link.left;
  var right = link && link.right;
  checkLinkRefs(spec, left, right);
  var on = encodeKeys(spec, left, right, link.leftKey, link.rightKey);
  var rel = { left: left, right: right };
  if (on !== undefined) rel.on = on;
  (spec.relationships || []).forEach(function (existing) {
    if (sameLink(existing, rel)) {
      throw new Error('"' + left + '" and "' + right + '" are already linked on that key');
    }
  });
  var next = cloneSpec(spec);
  next.relationships = (spec.relationships || []).concat([rel]);
  return next;
}

/**
 * Remove the relationship at an index; drops `relationships` when it empties.
 * @param {object} spec - The current spec.
 * @param {number} index - Position in `spec.relationships`.
 * @returns {object} A new spec without that relationship.
 * @public
 */
export function removeRelationship(spec, index) {
  var next = cloneSpec(spec);
  var rels = (spec.relationships || []).filter(function (rel, i) { return i !== index; });
  if (rels.length) next.relationships = rels;
  else delete next.relationships;
  return next;
}

/**
 * Set how a selection shows in related panels: `focus` (grey the rest, the
 * default), `highlight` (outline the related rows) or `ghost` (fade the rest).
 * An empty value restores the default by removing the key.
 * @param {object} spec - The current spec.
 * @param {string} mode - A {@link MARKING_MODES} value, or '' / null.
 * @returns {object} A new spec with the marking mode set.
 * @throws {Error} When the mode is not recognized.
 * @public
 */
export function setMarkingMode(spec, mode) {
  if (mode && MARKING_MODES.indexOf(mode) === -1) {
    throw new Error('marking mode must be one of: ' + MARKING_MODES.join(', '));
  }
  var next = cloneSpec(spec);
  if (mode && mode !== 'focus') next.markingMode = mode;
  else delete next.markingMode;
  return next;
}

/**
 * Build a `kind:"join"` source that blends two existing sources on a key.
 * @param {object} spec - The spec (for each source's row axis).
 * @param {object} def - `{left, right, how?, leftKey?, rightKey?}`; `how` is
 *   one of `inner` (default) / `left` / `right` / `outer`, and an empty key is
 *   the row id.
 * @returns {object} The join source spec.
 * @throws {Error} When a source is missing, both sides are the same source, or
 *   `how` is not recognized.
 * @public
 */
export function buildJoinSource(spec, def) {
  var left = def && def.left;
  var right = def && def.right;
  checkLinkRefs(spec, left, right);
  var how = def.how || 'inner';
  if (JOIN_TYPES.indexOf(how) === -1) throw new Error('join type must be one of: ' + JOIN_TYPES.join(', '));
  var source = { kind: 'join', left: left, right: right };
  var on = encodeKeys(spec, left, right, def.leftKey, def.rightKey);
  if (on !== undefined) source.on = on;
  source.how = how;
  return source;
}

/**
 * Add a calculated field to a data source, or replace the one with the same
 * name (keeping its position). The field is computed once on the source's
 * data, so every panel, Filters panel, join and link on the source sees it.
 * @param {object} spec - The current spec.
 * @param {string} ref - The data source name.
 * @param {object} def - `{name, target?, formula}` or `{name, target?, bin}`.
 * @returns {object} A new spec with the field set.
 * @throws {Error} When the source is missing or live, or the field has no name.
 * @public
 */
export function setCalculatedField(spec, ref, def) {
  var source = (spec.data || {})[ref];
  if (!source) throw new Error('no data source named "' + ref + '"');
  if (source.kind === 'live') throw new Error('a live source cannot have calculated fields');
  if (!def || typeof def.name !== 'string' || !def.name.trim()) throw new Error('a calculated field needs a name');
  var next = cloneSpec(spec);
  var copy = shallow(source);
  var fields = (source.calculatedFields || []).slice();
  var at = -1;
  fields.forEach(function (f, i) { if (f && f.name === def.name) at = i; });
  if (at > -1) fields[at] = def;
  else fields.push(def);
  copy.calculatedFields = fields;
  next.data[ref] = copy;
  return next;
}

/**
 * Remove a data source's calculated field by name; drops the key when empty.
 * @param {object} spec - The current spec.
 * @param {string} ref - The data source name.
 * @param {string} name - The field to remove.
 * @returns {object} A new spec without that field.
 * @public
 */
export function removeCalculatedField(spec, ref, name) {
  var next = cloneSpec(spec);
  var source = next.data[ref];
  if (!source || !Array.isArray(source.calculatedFields)) return next;
  var copy = shallow(source);
  var kept = source.calculatedFields.filter(function (f) { return !f || f.name !== name; });
  if (kept.length) copy.calculatedFields = kept;
  else delete copy.calculatedFields;
  next.data[ref] = copy;
  return next;
}

/**
 * Set (or clear) a data source's `pushdown` query: filter, keep columns or
 * summarize, sort and limit its rows (in its database when it has one,
 * otherwise in the browser). An empty query removes the key; the existing
 * `filters` flag (whether a Filters panel pushes its picks) is kept.
 * @param {object} spec - The current spec.
 * @param {string} ref - The data source name.
 * @param {?object} query - `{where?, columns?, groupBy?, measures?, orderBy?, limit?}`, or null.
 * @returns {object} A new spec with the query set.
 * @throws {Error} When the source is missing or live.
 * @public
 */
export function setSourcePushdown(spec, ref, query) {
  var source = (spec.data || {})[ref];
  if (!source) throw new Error('no data source named "' + ref + '"');
  if (source.kind === 'live') throw new Error('a live source cannot be shaped');
  var next = cloneSpec(spec);
  var copy = shallow(source);
  var out = {};
  ['where', 'columns', 'groupBy', 'measures', 'orderBy'].forEach(function (k) {
    if (query && Array.isArray(query[k]) && query[k].length) out[k] = query[k];
  });
  if (query && typeof query.limit === 'number' && query.limit > 0) out.limit = query.limit;
  var old = source.pushdown;
  if (Object.keys(out).length) {
    if (old && typeof old === 'object' && Object.prototype.hasOwnProperty.call(old, 'filters')) out.filters = old.filters;
    copy.pushdown = out;
  } else {
    delete copy.pushdown;
  }
  next.data[ref] = copy;
  return next;
}

/**
 * A one-line, human description of a calculated field, e.g.
 * `"PerUnit = Revenue / Units"` or `"Tier: 4 quantile bins of Revenue"`.
 * @param {object} def - A calculated-field definition.
 * @returns {string} The description.
 * @public
 */
export function describeCalculatedField(def) {
  if (def.bin) {
    var n = def.bin.bins || 4;
    var method = def.bin.method || 'equalWidth';
    var how = method === 'custom' ? 'custom bins' : n + ' ' + (method === 'equalWidth' ? 'equal-width' : method) + ' bins';
    return def.name + ': ' + how + ' of ' + def.bin.field;
  }
  return def.name + ' = ' + def.formula;
}

/**
 * A one-line, human description of a relationship's key, e.g.
 * `"clinical (row id) ↔ labs.patient"`. Composite keys are joined with ` + `.
 * @param {object} spec - The spec (for each source's row axis).
 * @param {object} rel - A `spec.relationships` entry or join source.
 * @returns {string} The description.
 * @public
 */
export function describeLink(spec, rel) {
  var sources = spec.data || {};
  var leftAxis = rel.leftAxis || rel.axis || sourceAxis(rel.left, sources);
  var rightAxis = rel.rightAxis || rel.axis || sourceAxis(rel.right, sources);
  var keys = rel.on == null ? [{ left: leftAxis, right: rightAxis }] : (Array.isArray(rel.on) ? rel.on : [rel.on]);
  function side(ref, key, axis) {
    return key === axis ? ref + ' (row id)' : ref + '.' + key;
  }
  return keys.map(function (key) {
    var lk = typeof key === 'string' ? key : key.left;
    var rk = typeof key === 'string' ? key : key.right;
    return side(rel.left, lk, leftAxis) + ' ↔ ' + side(rel.right, rk, rightAxis);
  }).join(' + ');
}

/**
 * Throw unless `left` and `right` name two different existing sources.
 * @param {object} spec - The spec.
 * @param {string} left - Left source ref.
 * @param {string} right - Right source ref.
 * @returns {void}
 * @private
 */
function checkLinkRefs(spec, left, right) {
  var sources = spec.data || {};
  [left, right].forEach(function (ref) {
    if (typeof ref !== 'string' || !ref) throw new Error('choose two data sources');
    if (!Object.prototype.hasOwnProperty.call(sources, ref)) throw new Error('no data source named "' + ref + '"');
  });
  if (left === right) throw new Error('choose two different data sources');
}

/**
 * Whether two relationships link the same pair of sources on the same key,
 * in either direction.
 * @param {object} a - A relationship.
 * @param {object} b - A relationship.
 * @returns {boolean} True when they are the same link.
 * @private
 */
function sameLink(a, b) {
  if (a.left === b.left && a.right === b.right) return JSON.stringify(a.on) === JSON.stringify(b.on);
  if (a.left === b.right && a.right === b.left) return JSON.stringify(a.on) === JSON.stringify(swapOn(b.on));
  return false;
}

/**
 * Reverse the orientation of an `on` key spec.
 * @param {(string|object|Array)} [on] - Key spec oriented left -> right.
 * @returns {(string|object|Array|undefined)} The same keys oriented right -> left.
 * @private
 */
function swapOn(on) {
  if (on == null || typeof on === 'string') return on;
  if (Array.isArray(on)) return on.map(swapOn);
  return { left: on.right, right: on.left };
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
