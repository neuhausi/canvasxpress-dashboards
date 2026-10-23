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

import { blankSpec, addPanel, setDataSource, setParam } from './builderModel.js';
import { shouldTranspose } from './renderDashboard.js';
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
 * A chart config as a dashboard panel must carry it. {@link orientConfig} sets the
 * engine's `transposeData` so a chart drawn on its own (the wizard's previews) resolves
 * its axes; inside a dashboard the renderer already transposes row-per-sample data for
 * scatter-type panels ({@link shouldTranspose}), so the same flag would flip the data
 * back — the engine then fails (KaplanMeier) or plots the wrong axes (Scatter2D). The
 * flag is dropped exactly when the renderer will transpose, and kept for the graph types
 * the renderer leaves alone (Histogram, Ridgeline, ...). Note the kept flag is not free in a
 * multi-panel dashboard: the engine transposes the data object in place, and the panels of
 * one source share it — so a dashboard assembled from several panels must not emit it.
 * @param {object} config - A CanvasXpress config, as {@link orientConfig} returned it.
 * @param {object} data - The CanvasXpress data object the panel will be bound to.
 * @returns {object} A copy of the config fit to publish in a dashboard.
 * @public
 */
export function panelConfigFor(config, data) {
  var out = JSON.parse(JSON.stringify(config || {}));
  if (out.transposeData && shouldTranspose({ config: out }, data)) delete out.transposeData;
  return out;
}

/**
 * The one-panel dashboard the wizard publishes: a full-width chart bound to
 * the stored dataset.
 * @param {object} opts - `{id, title, datasetId, store?, config, data?}`. `data` (the
 *   dataset's CanvasXpress data object) lets the config be made dashboard-ready
 *   ({@link panelConfigFor}); without it the config is published as given.
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
    config: opts.data ? panelConfigFor(opts.config || { graphType: 'Bar' }, opts.data)
      : opts.config || { graphType: 'Bar' },
    x: 0, y: 0, w: cols, h: 14
  });
}

// Graph types the engine draws as Scatter2D (its `ScatterGraphs` list): their
// xAxis / yAxis name SAMPLES, and their groups (ridgeBy, groupingFactors) are
// VARIABLE (z) annotations — the opposite of the bar/box family.
var SCATTER_FAMILY = ['Bin', 'Binplot', 'Bump', 'CDF', 'Contour', 'Density', 'Distribution', 'Hex',
  'Hexplot', 'Histogram', 'KaplanMeier', 'QQ', 'Quantile', 'Ridgeline', 'Scatter2D',
  'ScatterBubble2D', 'Scatter3D', 'Spaghetti', 'SPLOM', 'Streamgraph', 'TimeSeries', 'Volcano'];

/**
 * Orient a chart config to its data. The chart selector names COLUMNS of
 * {@link tableFromData}; when those columns are variables (rows are samples,
 * as a CSV or a database query parses), a scatter-family chart needs the
 * engine's `transposeData` so its axes and groups resolve — otherwise a
 * Ridgeline has no ridges and a CDF plots a single point.
 * @param {object} config - A CanvasXpress config (`graphType` …).
 * @param {object} data - The CanvasXpress data object it will draw.
 * @returns {object} The config, copied with `transposeData: true` when needed.
 * @public
 */
export function orientConfig(config, data) {
  var out = JSON.parse(JSON.stringify(config || {}));
  if (SCATTER_FAMILY.indexOf(out.graphType) !== -1 && out.transposeData == null && varsAreColumns(data)) {
    out.transposeData = true;
  }
  return out;
}

// ---- "Dashboard from database" wizard -------------------------------------
// The database explorer pattern the shipped GTEx dashboard uses: a CHOICES
// query fills a Control, and a DETAIL query with a `:param` re-runs on every
// pick. Both are the user's own read-only database sources (canvasxpress-
// connectors); these helpers only build the SQL templates and the spec.

/**
 * The `:name` bind parameters a SQL statement declares, in first-seen order —
 * the client-side mirror of the connectors app's `bind_param_names`. Quoted
 * strings and comments are skipped, and `::type` casts are not parameters.
 * @param {string} sql - A SELECT statement.
 * @returns {Array<string>} Distinct parameter names.
 * @public
 */
export function sqlParamNames(sql) {
  var text = String(sql || '')
    .replace(/'(?:[^']|'')*'/g, "''")      // string literals
    .replace(/"(?:[^"]|"")*"/g, '""')      // quoted identifiers
    .replace(/--[^\n]*/g, ' ')             // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ');    // block comments
  var re = /(^|[^:\w]):([A-Za-z_]\w*)/g;
  var seen = {};
  var out = [];
  var m;
  while ((m = re.exec(text))) {
    if (!seen[m[2]]) { seen[m[2]] = true; out.push(m[2]); }
  }
  return out;
}

/**
 * A parameter name made from a column name: lower-case letters, digits and
 * `_`, starting with a letter (`Gene Name` → `gene_name`).
 * @param {string} column - A column name.
 * @returns {string} A valid bind-parameter name (`value` when nothing is left).
 * @public
 */
export function paramNameFor(column) {
  var name = String(column || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+|_+$/g, '');
  return name || 'value';
}

/**
 * The CHOICES query template: the distinct values of one column. The value is
 * returned twice — as the row id and as a text column named after the
 * parameter — because the connectors app turns the first column into sample
 * ids and the other TEXT columns into the annotation a Control lists.
 * @param {string} table - Table (or view) name, as the database spells it.
 * @param {string} column - The column whose values the Control offers.
 * @param {string} param - The parameter (and annotation) name.
 * @returns {string} A read-only SELECT.
 * @public
 */
export function choicesSql(table, column, param) {
  return 'SELECT DISTINCT ' + column + ' AS id, ' + column + ' AS ' + param +
    ' FROM ' + table + ' WHERE ' + column + ' IS NOT NULL ORDER BY 1';
}

/**
 * The DETAIL query template: every row for the chosen value.
 * @param {string} table - Table (or view) name.
 * @param {string} column - The column the parameter filters.
 * @param {string} param - The parameter name (bound as `:param`).
 * @returns {string} A read-only SELECT with one bind parameter.
 * @public
 */
export function detailSql(table, column, param) {
  return 'SELECT * FROM ' + table + ' WHERE ' + column + ' = :' + param;
}

/**
 * The connector URL of a database source, ROOT-relative so the renderer
 * resolves it against the app base ("" in dev, "/dashboards" behind a proxy)
 * from any page depth.
 * @param {string} name - The database source name.
 * @returns {string} `/connectors/api/data?source=<name>`.
 * @public
 */
export function connectorSourceUrl(name) {
  return '/connectors/api/data?source=' + encodeURIComponent(name);
}

/**
 * The database explorer dashboard: a param Control whose choices come from the
 * CHOICES source, over a chart of the DETAIL source re-queried with the
 * picked value (`query: {<param>: "$<param>"}`).
 * @param {object} opts - `{id, title, param, value, choicesSource,
 *   detailSource, choicesAnnotation?, choicesCount?, controlTitle?, chartTitle?,
 *   config}`; `choicesSource` / `detailSource` are database source names, and
 *   `choicesAnnotation` is the choices column the Control lists (default: `param`).
 * @returns {object} A valid dashboard spec.
 * @public
 */
export function databaseExplorerSpec(opts) {
  var param = opts.param;
  var spec = blankSpec(opts.id, opts.title);
  var cols = spec.layout.cols;
  spec = setParam(spec, param, { value: opts.value == null ? null : String(opts.value), type: 'string' });
  spec = setDataSource(spec, 'choices', { kind: 'connector', url: connectorSourceUrl(opts.choicesSource), ttl: 600000 });
  var query = {};
  query[param] = '$' + param;
  spec = setDataSource(spec, 'detail', { kind: 'connector', url: connectorSourceUrl(opts.detailSource), query: query, ttl: 0 });
  spec = addPanel(spec, {
    id: 'control',
    type: 'control',
    mode: 'param',
    param: param,
    title: opts.controlTitle || param,
    // A long list reads better as type-ahead than as a huge dropdown.
    style: (opts.choicesCount || 0) > 50 ? 'search' : 'dropdown',
    optionsFrom: { dataRef: 'choices', annotation: opts.choicesAnnotation || param },
    x: 0, y: 0, w: Math.max(1, Math.floor(cols / 2)), h: 2
  });
  var config = JSON.parse(JSON.stringify(opts.config || { graphType: 'Bar' }));
  config.title = false;   // the panel title names the chart
  return addPanel(spec, {
    id: 'chart',
    title: opts.chartTitle || '',
    dataRef: 'detail',
    config: config,
    x: 0, y: 2, w: cols, h: 14
  });
}

// ---- Chart + Configure steps ----------------------------------------------

/**
 * The chart types the database wizard offers: the ones that draw a measure
 * split by groups (a query result) well. Pie and Heatmap are left out.
 * @type {Array<string>}
 * @public
 */
export var WIZARD_CHART_TYPES = ['Boxplot', 'Violin', 'Bar', 'Dotplot', 'Line', 'Area', 'Stacked',
  'Scatter2D', 'Histogram', 'Density', 'Ridgeline', 'CDF'];

/**
 * Which Configure fields a chart type takes, and the config key "Group by"
 * maps to: a scatter plot has X + Y + Color by; every other chart X (the
 * measure) + Group by + Color by — Ridgeline groups by `ridgeBy`, and
 * Histogram / Density take no group (the engine ignores one there).
 * @param {string} graphType - A CanvasXpress graph type.
 * @returns {{y: boolean, groupKey: (string|null)}} The extra fields.
 * @public
 */
export function chartFieldsFor(graphType) {
  if (graphType === 'Scatter2D') return { y: true, groupKey: null };
  if (graphType === 'Ridgeline') return { y: false, groupKey: 'ridgeBy' };
  if (graphType === 'Histogram' || graphType === 'Density') return { y: false, groupKey: null };
  return { y: false, groupKey: 'groupingFactors' };
}

/**
 * Build the chart config from the Configure step: the picked fields, then the
 * user's extra config on top (it wins), oriented to the data
 * ({@link orientConfig}).
 * @param {string} graphType - A CanvasXpress graph type.
 * @param {object} fields - `{x?, y?, group?, color?}` column names ('' = none).
 * @param {object} [extra] - Extra CanvasXpress config, merged last.
 * @param {object} data - The sample data the chart draws.
 * @returns {object} A CanvasXpress config.
 * @public
 */
export function buildChartConfig(graphType, fields, extra, data) {
  var spec = chartFieldsFor(graphType);
  var f = fields || {};
  var config = { graphType: graphType };
  if (f.x) config.xAxis = [f.x];
  if (spec.y && f.y) config.yAxis = [f.y];
  if (spec.groupKey && f.group) config[spec.groupKey] = spec.groupKey === 'ridgeBy' ? f.group : [f.group];
  if (f.color) config.colorBy = f.color;
  var more = extra || {};
  for (var k in more) {
    if (Object.prototype.hasOwnProperty.call(more, k)) config[k] = more[k];
  }
  return orientConfig(config, data);
}

/**
 * The columns of a CanvasXpress data object, split for the Configure fields:
 * measures (numeric) and annotations (text) on the column axis.
 * @param {object} data - CanvasXpress data object.
 * @returns {{numbers: Array<string>, texts: Array<string>}} Column names.
 * @public
 */
export function chartColumns(data) {
  var y = (data && data.y) || {};
  if (varsAreColumns(data)) {
    return { numbers: (y.vars || []).slice(), texts: Object.keys((data && data.x) || {}) };
  }
  return { numbers: (y.smps || []).slice(), texts: Object.keys((data && data.z) || {}) };
}

// ---- Scientific data-shape detection (P1) ---------------------------------
// Given a bound source, recognise the common scientific data shapes so the
// wizard can SUGGEST the matching scientific panel (never a silent rewrite —
// see the plan's risk note). Pure functions over the CanvasXpress data object
// and its column profile; no DOM, no engine.

// Column-name hints, matched case-insensitively against the whole header.
var SURVIVAL_TIME_RE = /^(time|t|surv(ival)?|os|pfs|dfs|efs|tte|duration|follow[\s._-]?up|fu|days?|months?|weeks?|years?)$|^(os|pfs|dfs|efs|rfs|dss|ttp)[\s._-]?(time|months?|days?|weeks?|years?|duration)$|^(overall|progression[\s._-]?free|disease[\s._-]?free|event[\s._-]?free|relapse[\s._-]?free)[\s._-]?survival[\s._-]?(time|months?|days?|weeks?|years?)$/i;
var SURVIVAL_EVENT_RE = /(event|status|dead|death|censor|vital|outcome|relapse|progress|recur)/i;
var GENOME_CHR_RE = /^(chr(om(osome)?)?)$/i;
var GENOME_POS_RE = /^(pos(ition)?|bp|loc(ation)?|coord(inate)?|start)$/i;
var PVALUE_RE = /^(p|pval(ue)?|p[\s._-]?val(ue)?|padj|adj[\s._-]?p(val(ue)?)?|fdr|q(val(ue)?)?)$/i;
var LOGFC_RE = /(log2?[\s._-]?(fold[\s._-]?)?change|log2?fc|logfc|l2fc|fold[\s._-]?change)/i;

// Oncoprint alteration tokens (engine `arrayToCXOncoprint`): a cell is one or
// more of these, optionally delimited by `;`, `,` or `|`.
var ALTERATION_TOKEN_RE = /^(mut(ation)?|amp(lification)?|del(etion)?|homdel|hetloss|homdel_rec|gain|loss|fusion|trunc(ating)?|inframe|missense|splice|promoter|up|down|wt)$/i;

/**
 * Column-name match against a header list.
 * @param {Array<string>} headers - Column names.
 * @param {RegExp} re - Hint pattern.
 * @returns {number} The matching column index, or -1.
 * @private
 */
function findHeader(headers, re) {
  for (var i = 0; i < headers.length; i++) {
    if (re.test(String(headers[i]).trim())) return i;
  }
  return -1;
}

/**
 * The non-missing values of one table column (rows only, header dropped).
 * @param {Array<Array>} rows - Table rows (no header).
 * @param {number} col - Column index.
 * @returns {Array} The non-missing cells.
 * @private
 */
function columnCells(rows, col) {
  var out = [];
  for (var r = 0; r < rows.length; r++) {
    var value = rows[r][col];
    if (!isMissing(value)) out.push(value);
  }
  return out;
}

/**
 * Does a column read as a survival EVENT indicator — binary 0/1, or a small
 * set of alive/dead-style status strings?
 * @param {Array} cells - Non-missing cells of the column.
 * @returns {boolean}
 * @private
 */
function looksLikeEvent(cells) {
  if (!cells.length) return false;
  var binary = cells.every(function (value) {
    var s = String(value).trim();
    return s === '0' || s === '1' || s === 'true' || s === 'false';
  });
  if (binary) return true;
  var seen = {};
  cells.forEach(function (value) { seen[String(value).trim().toLowerCase()] = true; });
  var levels = Object.keys(seen);
  if (levels.length > 3) return false;
  return levels.every(function (level) {
    return /^(dead|alive|death|censor(ed)?|event|no[\s._-]?event|yes|no|deceased|living|1|0|relapse|progression|cr|pd)$/i.test(level);
  });
}

/**
 * Detect the scientific shape(s) of a bound data source and suggest the
 * matching scientific panel type(s). A *suggestion* only — ranked by
 * confidence (0–1); the wizard offers them, it never rewrites silently.
 *
 * Recognises, by column name and value shape:
 *  - survival table → `KaplanMeier` (a numeric time measure + a numeric 0/1 event,
 *    optional grouping factor; a text event such as Dead / Alive is not suggested — the engine's
 *    curve is wrong for it);
 *  - GWAS summary → `Manhattan` (chromosome + position + p-value);
 *  - differential-expression table → `Volcano` (log-fold-change + p-value);
 *  - alteration matrix → `Oncoprint` (matrix cells are alteration tokens);
 *  - numeric gene×sample matrix → `Heatmap` (clustered expression matrix).
 *
 * @param {object} data - CanvasXpress data object.
 * @returns {Array<{graphType: string, reason: string, confidence: number, columns?: object}>}
 *   Suggestions, highest confidence first ([] when nothing scientific fits).
 *   `columns` names the matched fields (the keys of {@link scientificFieldsFor}) for the
 *   column-driven shapes (KaplanMeier, Manhattan, Volcano).
 * @public
 */
export function detectDataShapes(data) {
  var table = tableFromData(data);
  var headers = (table[0] || []).slice(1);        // drop the row-id column
  var rows = table.slice(1).map(function (row) { return row.slice(1); });
  if (!headers.length || !rows.length) return [];
  var profile = profileColumns(table).slice(1);   // aligned to `headers`
  var numericCols = [];
  var textCols = [];
  profile.forEach(function (p, i) {
    if (p.type === 'numeric') numericCols.push(i);
    else textCols.push(i);
  });
  var suggestions = [];

  // Survival: a time-like numeric column + an event-like NUMERIC column. The engine's Kaplan–Meier
  // reads the event from a numeric measure; a text event (Dead / Alive) is an annotation and draws
  // a silently wrong curve (flat steps, p = 1), so it is not suggested.
  var timeCol = findHeader(headers, SURVIVAL_TIME_RE);
  var eventCol = findHeader(headers, SURVIVAL_EVENT_RE);
  if (timeCol !== -1 && profile[timeCol].type === 'numeric' && eventCol !== -1 &&
      eventCol !== timeCol && profile[eventCol].type === 'numeric' &&
      looksLikeEvent(columnCells(rows, eventCol))) {
    suggestions.push({ graphType: 'KaplanMeier', confidence: 0.9,
      columns: { time: String(headers[timeCol]), event: String(headers[eventCol]) },
      reason: 'Survival table: time column "' + headers[timeCol] + '" + event column "' +
        headers[eventCol] + '".' });
  }

  // GWAS / Manhattan: chromosome + position + p-value.
  var chrCol = findHeader(headers, GENOME_CHR_RE);
  var posCol = findHeader(headers, GENOME_POS_RE);
  var pCol = findHeader(headers, PVALUE_RE);
  if (chrCol !== -1 && posCol !== -1 && pCol !== -1 &&
      profile[posCol].type === 'numeric' && profile[pCol].type === 'numeric') {
    suggestions.push({ graphType: 'Manhattan', confidence: 0.9,
      columns: { chr: String(headers[chrCol]), pos: String(headers[posCol]), p: String(headers[pCol]) },
      reason: 'GWAS summary: chromosome "' + headers[chrCol] + '", position "' +
        headers[posCol] + '", p-value "' + headers[pCol] + '".' });
  }

  // Volcano: a log-fold-change column + a p-value column.
  var fcCol = findHeader(headers, LOGFC_RE);
  if (fcCol !== -1 && pCol !== -1 && fcCol !== pCol &&
      profile[fcCol].type === 'numeric' && profile[pCol].type === 'numeric') {
    suggestions.push({ graphType: 'Volcano', confidence: 0.8,
      columns: { fc: String(headers[fcCol]), p: String(headers[pCol]) },
      reason: 'Differential expression: fold-change "' + headers[fcCol] + '" + p-value "' +
        headers[pCol] + '".' });
  }

  // Oncoprint: the matrix cells are alteration tokens (text, from the vocabulary).
  if (textCols.length >= 2) {
    var tokenCells = 0, nonMissing = 0;
    textCols.forEach(function (col) {
      columnCells(rows, col).forEach(function (value) {
        nonMissing++;
        var ok = String(value).trim().split(/[;,|]/).every(function (part) {
          return part.trim() !== '' && ALTERATION_TOKEN_RE.test(part.trim());
        });
        if (ok) tokenCells++;
      });
    });
    if (nonMissing && tokenCells / nonMissing > 0.6) {
      suggestions.push({ graphType: 'Oncoprint', confidence: 0.85,
        reason: 'Alteration matrix: ' + textCols.length + ' columns of mutation/CNA tokens.' });
    }
  }

  // Expression matrix: a wide, mostly-numeric matrix (gene×sample). Low/medium
  // confidence — it is the generic numeric-matrix fallback, so rank it last.
  if (numericCols.length >= 3 && rows.length >= 3 &&
      numericCols.length >= headers.length * 0.6) {
    suggestions.push({ graphType: 'Heatmap', confidence: 0.6,
      reason: 'Numeric matrix: ' + rows.length + '×' + numericCols.length +
        ' — a clustered heatmap suits an expression matrix.' });
  }

  suggestions.sort(function (a, b) { return b.confidence - a.confidence; });
  return suggestions;
}

/**
 * The single best scientific-panel suggestion for a bound source, if any.
 * @param {object} data - CanvasXpress data object.
 * @returns {{graphType: string, reason: string, confidence: number}|null}
 * @public
 */
export function suggestPanelType(data) {
  var shapes = detectDataShapes(data);
  return shapes.length ? shapes[0] : null;
}

// ---- Scientific panel presets (P2) ----------------------------------------
// Wizard entries for the panel types the engine already renders but the
// generic chart selector does not surface. Kept SEPARATE from
// WIZARD_CHART_TYPES (whose contract is "a measure split by groups, Pie and
// Heatmap left out") — these map their own fields and carry panel-specific
// sane defaults, so they do not fit that list's generic X + Group model.

/**
 * The scientific panel presets the wizard offers in addition to
 * {@link WIZARD_CHART_TYPES}. Pair with {@link detectDataShapes} (suggest) and
 * {@link buildScientificConfig} (build).
 * @type {Array<string>}
 * @public
 */
export var WIZARD_SCIENCE_TYPES = ['KaplanMeier', 'Oncoprint', 'Heatmap', 'Manhattan', 'Volcano'];

/**
 * Which Configure fields a scientific preset collects. Matrix panels
 * (Oncoprint/Heatmap) take no field mapping — they draw the bound matrix as-is.
 * @param {string} graphType - A scientific preset graph type.
 * @returns {Array<{key: string, label: string, numeric?: boolean}>} The fields
 *   to collect (empty for matrix panels).
 * @public
 */
export function scientificFieldsFor(graphType) {
  if (graphType === 'KaplanMeier') {
    return [{ key: 'time', label: 'Time', numeric: true },
      { key: 'event', label: 'Event / censor' },
      { key: 'group', label: 'Group (optional)' }];
  }
  if (graphType === 'Manhattan') {
    return [{ key: 'chr', label: 'Chromosome' },
      { key: 'pos', label: 'Position', numeric: true },
      { key: 'p', label: 'p-value', numeric: true }];
  }
  if (graphType === 'Volcano') {
    return [{ key: 'fc', label: 'Fold change (log2)', numeric: true },
      { key: 'p', label: 'p-value', numeric: true },
      { key: 'label', label: 'Label / colour (optional)' }];
  }
  return [];   // Oncoprint, Heatmap: the matrix is the data
}

/**
 * Build a CanvasXpress config for a scientific preset: the chosen fields mapped
 * to the panel's real engine keys, panel-specific sane defaults, then the
 * user's extra config on top, oriented to the data ({@link orientConfig}).
 *
 * Defaults are grounded in the shipping engine params (verified 2026-10-16):
 * Kaplan-Meier shows CI + log-rank p (`kmPvalue`) + at-risk table + censor rug;
 * Heatmap clusters both axes (dendrograms) with a diverging spectrum; Manhattan
 * points its marker keys at the chosen columns; Volcano is the native alias
 * (Scatter2D) over fold-change vs p — auto significance thresholds are
 * deliberately left to the engine's statistical-inference layer, so
 * no threshold-line coordinates are fabricated here.
 *
 * @param {string} graphType - A member of {@link WIZARD_SCIENCE_TYPES}.
 * @param {object} [fields] - Field map (keys from {@link scientificFieldsFor}).
 * @param {object} [extra] - Extra CanvasXpress config, merged last (it wins).
 * @param {object} data - The data the panel draws (for orientation).
 * @returns {object} A CanvasXpress config.
 * @public
 */
export function buildScientificConfig(graphType, fields, extra, data) {
  var f = fields || {};
  var config;
  if (graphType === 'KaplanMeier') {
    // The engine KM reads time from xAxis, event from yAxis (geomKaplanMeier
    // computeKMForPair: [xAxisIndex=time, yAxisIndex=event]).
    config = { graphType: 'KaplanMeier',
      showKMConfidenceIntervals: true, kmPvalue: true, kmRiskTable: true, kmCensoredRug: true };
    if (f.time) config.xAxis = [f.time];
    if (f.event) config.yAxis = [f.event];
    if (f.group) config.colorBy = f.group;
  } else if (graphType === 'Oncoprint') {
    config = { graphType: 'Oncoprint' };
  } else if (graphType === 'Heatmap') {
    config = { graphType: 'Heatmap', samplesClustered: true, variablesClustered: true,
      colorSpectrum: ['navy', 'white', 'firebrick3'] };
  } else if (graphType === 'Manhattan') {
    config = { graphType: 'Manhattan' };
    if (f.chr) config.manhattanMarkerChromosomeNumber = f.chr;
    if (f.pos) config.manhattanMarkerPosition = f.pos;
    if (f.p) config.manhattanMarkerLogPValue = f.p;
  } else if (graphType === 'Volcano') {
    config = { graphType: 'Volcano' };
    if (f.fc) config.xAxis = [f.fc];
    if (f.p) config.yAxis = [f.p];
    if (f.label) config.colorBy = f.label;
  } else {
    config = { graphType: graphType };
  }
  var more = extra || {};
  for (var k in more) {
    if (Object.prototype.hasOwnProperty.call(more, k)) config[k] = more[k];
  }
  return orientConfig(config, data);
}
