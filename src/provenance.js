/**
 * Auto-derive an **honest** method line for a panel or data source — a one-line
 * human description of how the numbers were actually produced, read from the
 * operations already declared in the spec (never free text that can drift):
 *
 *  - the base source origin (inline / dataset / connector / live);
 *  - a `kind:"join"` (how + inputs + key), recursively through nested joins;
 *  - a `kind:"function"` source's language;
 *  - a source's `pushdown` aggregate / filter / sort / limit;
 *  - a source's `calculatedFields` (formula and binning);
 *  - the panel's chart type and its statistical overlays (loess / regression /
 *    forecast, with confidence intervals) read from the chart `config`.
 *
 * Every clause is emitted only when the corresponding operation is present, so
 * the line can always be defended against the spec. This module is pure (no DOM,
 * no engine) so it unit-tests directly and runs in the bundle writer (P3) as
 * well as the live footer (renderDashboard).
 *
 * @module provenance
 */

/** @type {object} Chart-config stat overlays → how each reads in the method line. */
var STAT_OVERLAYS = [
  { key: 'showLoessFit', label: 'a loess fit' },
  { key: 'showRegressionFit', label: 'a regression fit' },
  { key: 'showForecast', label: 'a forecast' }
];

/**
 * Join a list of clauses into one sentence-like line (clauses separated by
 * "; "), dropping empties.
 * @param {string[]} clauses - The clause strings (some may be empty/null).
 * @returns {string} The joined line (empty when nothing to say).
 * @private
 */
function joinClauses(clauses) {
  var kept = [];
  for (var i = 0; i < clauses.length; i++) {
    if (clauses[i]) kept.push(clauses[i]);
  }
  return kept.join('; ');
}

/**
 * Describe one aggregate measure (`{fn, column, as}`) in words.
 * @param {object} m - A pushdown measure.
 * @returns {string} e.g. "sum of Revenue", "distinct count of Id", "count".
 * @private
 */
function describeMeasure(m) {
  if (!m || !m.fn) return '';
  var fn = m.fn === 'mean' ? 'avg' : m.fn;
  var names = { count: 'count', count_distinct: 'distinct count', sum: 'sum', avg: 'average', min: 'minimum', max: 'maximum' };
  var word = names[fn] || fn;
  if (fn === 'count' && !m.column) return 'count';
  return word + (m.column ? ' of ' + m.column : '');
}

/**
 * Describe a `pushdown` query (aggregate / rows / filter / sort / limit) as a
 * method clause. Reads only what is present.
 * @param {(object|boolean)} pushdown - The source's `pushdown`.
 * @returns {string} The clause (empty when there is no pushdown or it is `true`).
 * @public
 */
export function describePushdown(pushdown) {
  if (!pushdown || pushdown === true || typeof pushdown !== 'object') return '';
  var clauses = [];
  var measures = Array.isArray(pushdown.measures) ? pushdown.measures : [];
  var groupBy = Array.isArray(pushdown.groupBy) ? pushdown.groupBy : [];
  if (measures.length || groupBy.length) {
    var agg = 'aggregated';
    if (measures.length) {
      var parts = [];
      for (var i = 0; i < measures.length; i++) {
        var d = describeMeasure(measures[i]);
        if (d) parts.push(d);
      }
      if (parts.length) agg += ' (' + parts.join(', ') + ')';
    }
    if (groupBy.length) agg += ' grouped by ' + groupBy.join(', ');
    clauses.push(agg);
  } else if (Array.isArray(pushdown.columns) && pushdown.columns.length) {
    clauses.push('selected columns ' + pushdown.columns.join(', '));
  }
  var where = Array.isArray(pushdown.where) ? pushdown.where : [];
  if (where.length) {
    var conds = [];
    for (var w = 0; w < where.length; w++) {
      var c = where[w];
      if (c && c.column) conds.push(c.column + ' ' + (c.op || '=') + ' ' + formatValue(c.value));
    }
    if (conds.length) clauses.push('filtered where ' + conds.join(' and '));
  }
  if (Array.isArray(pushdown.orderBy) && pushdown.orderBy.length) {
    clauses.push('sorted by ' + pushdown.orderBy.map(orderByName).join(', '));
  }
  if (typeof pushdown.limit === 'number') {
    clauses.push('limited to ' + pushdown.limit + ' rows');
  }
  return joinClauses(clauses);
}

/**
 * Name an orderBy entry (string or `{column, desc}`).
 * @param {(string|object)} o - The orderBy entry.
 * @returns {string} The column (with " desc" when descending).
 * @private
 */
function orderByName(o) {
  if (typeof o === 'string') return o;
  if (o && o.column) return o.column + (o.desc ? ' desc' : '');
  return '';
}

/**
 * Render a where-clause value for display: a list joins with ", " in brackets,
 * an unresolved "$param" token shows as the parameter name, else the literal.
 * @param {*} value - The clause value.
 * @returns {string} A short display string.
 * @private
 */
function formatValue(value) {
  if (Array.isArray(value)) return '[' + value.join(', ') + ']';
  if (value == null) return '';
  return String(value);
}

/**
 * Describe a source's `calculatedFields` (formula fields and binning) as a clause.
 * @param {object[]} fields - The `calculatedFields` array.
 * @returns {string} e.g. "computed Margin = Revenue / Units; binned Age into 4 quantile bins".
 * @public
 */
export function describeCalculatedFields(fields) {
  if (!Array.isArray(fields) || !fields.length) return '';
  var parts = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (!f || !f.name) continue;
    if (f.formula != null) {
      parts.push('computed ' + f.name + ' = ' + f.formula);
    } else if (f.bin && f.bin.field) {
      var method = f.bin.method || 'equalWidth';
      var methodWord = { equalWidth: 'equal-width', quantile: 'quantile', percentile: 'percentile', custom: 'custom' }[method] || method;
      var count = method === 'custom'
        ? (Array.isArray(f.bin.breaks) ? Math.max(f.bin.breaks.length - 1, 1) : '')
        : (f.bin.bins || 4);
      parts.push('binned ' + f.bin.field + ' into ' + (count ? count + ' ' : '') + methodWord + ' bins as ' + f.name);
    }
  }
  return joinClauses(parts);
}

/**
 * Describe a chart config's statistical overlays (loess / regression / forecast)
 * and whether confidence intervals are shown.
 * @param {object} config - The panel's CanvasXpress chart `config`.
 * @returns {string} e.g. "with a regression fit (linear) and 95% confidence
 *   interval", or empty when the chart carries no stat overlay.
 * @public
 */
export function describeStatOptions(config) {
  if (!config || typeof config !== 'object') return '';
  var overlays = [];
  for (var i = 0; i < STAT_OVERLAYS.length; i++) {
    var ov = STAT_OVERLAYS[i];
    if (config[ov.key]) {
      var label = ov.label;
      if (ov.key === 'showRegressionFit' && config.regressionType) {
        label += ' (' + config.regressionType + ')';
      }
      overlays.push(label);
    }
  }
  if (!overlays.length) return '';
  var line = 'with ' + humanList(overlays);
  var showsCI = config.showConfidenceIntervals;
  if (showsCI) {
    var level = typeof config.confidenceInterval === 'number'
      ? Math.round(config.confidenceInterval * (config.confidenceInterval <= 1 ? 100 : 1)) + '%'
      : '';
    line += ' and ' + (level ? level + ' ' : '') + 'confidence interval';
  }
  return line;
}

/**
 * Join a list with commas and a trailing "and" ("a, b and c").
 * @param {string[]} items - The items.
 * @returns {string} The human list.
 * @private
 */
function humanList(items) {
  if (items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

/**
 * Describe a data source's origin and its transformations, recursing through a
 * join's inputs. Returns a method clause for that source alone.
 * @param {string} ref - The source ref (key in `spec.data`).
 * @param {object} spec - The dashboard spec.
 * @param {object} [seen] - Internal: refs already visited (cycle guard).
 * @returns {string} The source's method clause (empty when the ref is unknown).
 * @public
 */
export function describeSource(ref, spec, seen) {
  var sources = (spec && spec.data) || {};
  var src = sources[ref];
  if (!src) return '';
  seen = seen || {};
  if (seen[ref]) return ref;    // cycle guard: name it, don't recurse again
  seen[ref] = true;

  var origin = '';
  if (src.kind === 'join') {
    var how = src.how || 'inner';
    var left = wrapInput(describeSource(src.left, spec, seen) || src.left);
    var right = wrapInput(describeSource(src.right, spec, seen) || src.right);
    origin = how + ' join of ' + left + ' and ' + right + (src.on ? ' on ' + describeJoinKey(src.on) : '');
  } else if (src.kind === 'function') {
    var lang = src.language === 'r' ? 'R' : (src.language === 'python' ? 'Python' : (src.language || 'a data'));
    origin = 'transformed by ' + (lang === 'a data' ? 'a data function' : 'a ' + lang + ' function');
  } else if (src.kind === 'dataset') {
    origin = 'dataset ' + (src.id || '');
  } else if (src.kind === 'connector') {
    origin = 'connector data';
  } else if (src.kind === 'live') {
    origin = 'a live stream';
  } else if (src.kind === 'inline') {
    origin = 'inline data';
  } else if (src.kind) {
    origin = src.kind + ' data';
  }

  return joinClauses([origin, describeCalculatedFields(src.calculatedFields), describePushdown(src.pushdown)]).trim();
}

/**
 * Parenthesize a join input's description when it carries more than one clause,
 * so the join line stays readable ("left join of (connector data; aggregated …)
 * and dataset r1").
 * @param {string} s - A source description.
 * @returns {string} Wrapped in parentheses when multi-clause, else unchanged.
 * @private
 */
function wrapInput(s) {
  return s && s.indexOf('; ') !== -1 ? '(' + s + ')' : s;
}

/**
 * Render a join key (the row id by default, a shared column, a {left,right}
 * mapping, or an array of those) for the method line.
 * @param {*} on - The join `on` value.
 * @returns {string} A short key description.
 * @private
 */
function describeJoinKey(on) {
  if (Array.isArray(on)) return on.map(describeJoinKey).join(' + ');
  if (on && typeof on === 'object') return (on.left || '') + '=' + (on.right || '');
  return String(on);
}

/**
 * The method line for a self-contained code panel (`ggplot` / `cxcode`): the code
 * it was converted from, then what it draws — the ggplot2 layers, or the
 * CanvasXpress graph type with any statistical overlays.
 * @param {object} panel - A `ggplot` or `cxcode` panel.
 * @returns {string} The method line (never empty: the origin is always known).
 * @private
 */
function deriveCodePanelMethod(panel) {
  var inner = panel.spec || {};
  var clauses = [];
  if (panel.type === 'ggplot') {
    clauses.push('R ggplot2 code, converted');
    var layers = [];
    // `geoms` is a list in a real conversion but a single name in some callers.
    var geoms = Array.isArray(inner.geoms) ? inner.geoms : (inner.geoms ? [inner.geoms] : []);
    geoms.forEach(function (geom) {
      // GeomPoint → "point", GeomSmooth → "smooth", GeomBoxplot → "boxplot"
      var name = String(geom).replace(/^Geom/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      if (name && layers.indexOf(name) === -1) layers.push(name);
    });
    if (layers.length) clauses.push('layers: ' + layers.join(', '));
  } else {
    clauses.push((panel.language === 'python' ? 'Python canvasxpress' : 'R canvasXpress') + ' code, converted');
    var config = inner.config || {};
    if (config.graphType) {
      var stat = describeStatOptions(config);
      clauses.push('plotted as ' + config.graphType + (stat ? ' ' + stat : ''));
    }
  }
  return joinClauses(clauses);
}

/**
 * Derive the full method line for a graph panel: the source's origin and
 * transformations followed by the chart type and any statistical overlays.
 * @param {object} spec - The dashboard spec.
 * @param {string} panelId - The panel's id (key in `spec.panels`).
 * @returns {string} The auto-derived method line (empty when nothing is known).
 * @public
 */
export function derivePanelMethod(spec, panelId) {
  var panel = spec && spec.panels && spec.panels[panelId];
  if (!panel) return '';
  // Code panels carry their own data and chart (no dataRef / panel.config): their
  // method is where the chart came from and what it draws.
  if (panel.type === 'ggplot' || panel.type === 'cxcode') return deriveCodePanelMethod(panel);
  var clauses = [];
  if (panel.dataRef) {
    var sourceLine = describeSource(panel.dataRef, spec);
    if (sourceLine) clauses.push(sourceLine);
  }
  var config = panel.config || {};
  var graphType = config.graphType;
  if (graphType) {
    var stat = describeStatOptions(config);
    clauses.push('plotted as ' + graphType + (stat ? ' ' + stat : ''));
  } else {
    var statOnly = describeStatOptions(config);
    if (statOnly) clauses.push(statOnly);
  }
  return joinClauses(clauses);
}

/**
 * The method line to display for a panel, honouring its `provenance`:
 *  - an author-pinned method (`provenance.auto === false` with a `method`) is
 *    used verbatim;
 *  - otherwise the method is auto-derived ({@link derivePanelMethod});
 *  - a `provenance.notes` string is appended after an em-dash.
 * @param {object} spec - The dashboard spec.
 * @param {string} panelId - The panel's id.
 * @returns {string} The display line (empty when there is nothing to show).
 * @public
 */
export function panelProvenanceText(spec, panelId) {
  var panel = spec && spec.panels && spec.panels[panelId];
  var prov = panel && panel.provenance;
  var method;
  if (prov && prov.auto === false && prov.method) {
    method = prov.method;
  } else {
    method = derivePanelMethod(spec, panelId);
  }
  if (prov && prov.notes) {
    method = method ? method + ' — ' + prov.notes : prov.notes;
  }
  return method || '';
}
