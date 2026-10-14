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
