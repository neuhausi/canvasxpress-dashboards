/**
 * Dashboard-from-one-dataset assembly: given a parsed dataset, recognise a known
 * analysis shape (a patient cohort, an NGS run QC table) and SUGGEST a whole linked
 * dashboard — filters plus the panels that shape calls for — instead of one chart.
 *
 * Builds on the wizard's detection ({@link detectDataShapes}) and config builders
 * ({@link buildScientificConfig}, {@link buildChartConfig}); nothing here re-derives a
 * column match. Like the wizard it only ever *suggests*: it returns `null` when no
 * template fits (the caller keeps the single-chart flow) and never rewrites the data.
 * Every panel binds the one dataset, so the engine's broadcast links selections across
 * them. Pure functions (no DOM), unit-tested in node.
 *
 * @module suggestDashboard
 */

import { blankSpec, addPanel, setDataSource, setParam, updatePanel } from './builderModel.js';
import { tableFromData, profileColumns, detectDataShapes, buildScientificConfig,
  buildChartConfig, panelConfigFor } from './wizard.js';

// NGS run-QC metric families, matched case-insensitively against a numeric column header.
var QC_METRICS = {
  reads: /(^|[\s._-])(total[\s._-]?)?reads?($|[\s._-])|read[\s._-]?(pairs?|count)|^n[\s._-]?reads$|fragments?/i,
  mapping: /(mapped|mapping|aligned|alignment)/i,
  quality: /(q30|q20|phred|base[\s._-]?qual|mean[\s._-]?qual)/i,
  duplication: /(dup|duplicat)/i,
  gc: /(^|[\s._-])gc($|[\s._-])|gc[\s._-]?(content|pct|percent)/i,
  insert: /insert[\s._-]?size/i,
  coverage: /(coverage|depth|cov[\s._-]?x)/i,
  adapter: /adapter/i,
  contamination: /(contamin|freemix)/i
};

// Column names that usually carry the grouping a QC table or a cohort is compared by.
var BATCH_RE = /(lane|flow[\s._-]?cell|batch|run|plate|library|prep|instrument|machine|seq)/i;
var COHORT_GROUP_RE = /(arm|group|treat|cohort|stage|condition|sex|subtype|genotype)/i;

var MIN_PANELS = 3;
var MAX_FILTER_FIELDS = 6;
var GRID_H = 12;
var CARD_H = 4;

// The case drill: a click on a panel whose marks are single rows sets this param to the clicked
// row; the case card is a table over a second source of the same data, narrowed to that row.
var CASE_PARAM = 'case';
var CASE_SOURCE = 'case';
// A one-row table: no banner / toolbar / status bar / paging, shrunk to its rows, and no heat-colouring:
// the engine re-derives dataTableColored from the UI style (it is on for editorial and most others, and
// the config key is ignored), and the colours of a single record's values mean nothing — so their
// strength is set to 0, which IS honoured.
var CASE_CARD_CONFIG = { graphType: 'Bar', view: 'table', title: false, dataTableBannerShow: false,
  dataTableToolbarShow: false, dataTableStatusShow: false, dataTablePaginationShow: false,
  dataTableFitHeight: true, dataTableColorTransparency: 0 };

/**
 * Describe each non-id column of a dataset.
 * @param {object} data - CanvasXpress data object.
 * @returns {Array<{name: string, type: string, unique: number}>} Column name, profile
 *   type (`numeric` | `date` | `text`) and distinct-value count.
 * @private
 */
function describeColumns(data) {
  return profileColumns(tableFromData(data)).slice(1).map(function (p) {
    return { name: p.name, type: p.type, unique: p.unique };
  });
}

/**
 * The best grouping column: a text column with a few levels, preferring a name that
 * looks like one.
 * @param {Array} columns - From {@link describeColumns}.
 * @param {RegExp} preferred - Name hint.
 * @param {Array<string>} exclude - Column names that must not be picked.
 * @returns {(string|null)} The column name, or null.
 * @private
 */
function pickGroup(columns, preferred, exclude) {
  var candidates = columns.filter(function (c) {
    return c.type === 'text' && c.unique >= 2 && c.unique <= 6 && exclude.indexOf(c.name) === -1;
  });
  for (var i = 0; i < candidates.length; i++) {
    if (preferred.test(candidates[i].name)) return candidates[i].name;
  }
  return candidates.length ? candidates[0].name : null;
}

/**
 * The fields a Filters panel should offer: low-cardinality text columns first, then
 * numeric measures (range sliders), capped.
 * @param {Array} columns - From {@link describeColumns}.
 * @param {Array<string>} skip - Column names to leave out.
 * @returns {Array<string>} Field names.
 * @private
 */
function filterFields(columns, skip) {
  var categories = columns.filter(function (c) {
    return c.type === 'text' && c.unique >= 2 && c.unique <= 12 && skip.indexOf(c.name) === -1;
  });
  var measures = columns.filter(function (c) {
    return c.type === 'numeric' && skip.indexOf(c.name) === -1;
  });
  return categories.concat(measures).slice(0, MAX_FILTER_FIELDS).map(function (c) { return c.name; });
}

/**
 * Cohort template: a survival table with a grouping factor. Filters down the left, the
 * Kaplan–Meier curve across the top, and a measure compared by group and against time.
 * @param {object} data - CanvasXpress data object.
 * @param {Array} columns - From {@link describeColumns}.
 * @param {{time: string, event: string}} survival - The matched survival columns.
 * @returns {(object|null)} A suggestion, or null when the event column is not numeric or the
 *   template would have too few panels.
 * @private
 */
function cohortTemplate(data, columns, survival) {
  // The engine's Kaplan–Meier reads the event from a NUMERIC column. A text event (Dead / Alive)
  // is an annotation: the curve then draws silently wrong (flat steps, p = 1), so offer nothing.
  var eventColumn = columns.filter(function (c) { return c.name === survival.event; })[0];
  if (!eventColumn || eventColumn.type !== 'numeric') return null;
  var used = [survival.time, survival.event];
  var group = pickGroup(columns, COHORT_GROUP_RE, used);
  var measures = columns.filter(function (c) {
    return c.type === 'numeric' && used.indexOf(c.name) === -1;
  });
  var measure = measures.length ? measures[0].name : null;
  var panels = [{ id: 'filters', type: 'filters', title: 'Filters',
    fields: filterFields(columns, used), x: 0, y: 0, w: 3, h: GRID_H * 2 }];
  panels.push({ id: 'km', title: group ? 'Survival by ' + group : 'Survival',
    config: withoutTitle(buildScientificConfig('KaplanMeier',
      { time: survival.time, event: survival.event, group: group }, null, data)),
    x: 3, y: 0, w: 9, h: GRID_H });
  if (measure) {
    panels.push({ id: 'compare', title: measure + (group ? ' by ' + group : ''),
      config: withoutTitle(buildChartConfig('Boxplot', { x: measure, group: group, color: group },
        { graphOrientation: 'vertical', showBoxplotOriginalData: true }, data)),
      x: 3, y: GRID_H, w: 4, h: GRID_H });
    panels.push({ id: 'vs-time', title: measure + ' vs ' + survival.time,
      config: withoutTitle(buildChartConfig('Scatter2D', { x: measure, y: survival.time, color: group },
        { dataPointSize: 'auto' }, data)),
      x: 7, y: GRID_H, w: 5, h: GRID_H });
  }
  if (panels.length < MIN_PANELS) return null;
  return withCaseDrill({ template: 'cohort', label: 'Cohort overview', panels: withDashboardConfigs(panels, data),
    reason: 'Survival table (time "' + survival.time + '", event "' + survival.event + '")' +
      (group ? ' with grouping "' + group + '"' : '') + ': filters, a Kaplan–Meier curve and the ' +
      'measures that move with it; click a point to load that patient\'s record.' },
  data, 'Patient record — click a point to load', ['vs-time']);
}

/**
 * Names of the NGS QC metric families a header list covers, with the column that
 * represents each (first match wins).
 * @param {Array} columns - From {@link describeColumns}.
 * @returns {object} family -> column name.
 * @private
 */
function qcMetricColumns(columns) {
  var found = {};
  columns.forEach(function (c) {
    if (c.type !== 'numeric') return;
    for (var family in QC_METRICS) {
      if (Object.prototype.hasOwnProperty.call(QC_METRICS, family) && !found[family] &&
          QC_METRICS[family].test(c.name)) {
        found[family] = c.name;
        return;
      }
    }
  });
  return found;
}

/**
 * NGS run-QC template: a per-sample QC table. Filters, depth per sample, mapping against
 * duplication, and the quality metric by lane / batch.
 * @param {object} data - CanvasXpress data object.
 * @param {Array} columns - From {@link describeColumns}.
 * @param {object} metrics - From {@link qcMetricColumns}.
 * @returns {(object|null)} A suggestion, or null when it would have too few panels.
 * @private
 */
function qcTemplate(data, columns, metrics) {
  var metricNames = Object.keys(metrics).map(function (k) { return metrics[k]; });
  var batch = pickGroup(columns, BATCH_RE, []);
  var depth = metrics.reads || metrics.coverage || metricNames[0];
  var scatterX = metrics.mapping || metricNames[0];
  var scatterY = metrics.duplication || metricNames.filter(function (n) { return n !== scatterX; })[0];
  var quality = metrics.quality || metricNames.filter(function (n) { return n !== depth; })[0];
  var panels = [{ id: 'filters', type: 'filters', title: 'Filters',
    fields: filterFields(columns, []), x: 0, y: 0, w: 3, h: GRID_H * 2 }];
  panels.push({ id: 'depth', title: depth + ' per sample',
    config: withoutTitle(buildChartConfig('Bar', { x: depth, color: batch },
      { graphOrientation: 'vertical', smpLabelRotate: 45 }, data)),
    x: 3, y: 0, w: 9, h: GRID_H });
  if (scatterX && scatterY) {
    panels.push({ id: 'quality-scatter', title: scatterX + ' vs ' + scatterY,
      config: withoutTitle(buildChartConfig('Scatter2D', { x: scatterX, y: scatterY, color: batch },
        { dataPointSize: 'auto' }, data)),
      x: 3, y: GRID_H, w: 5, h: GRID_H });
  }
  if (quality) {
    // Always a Boxplot, grouped by batch when there is one: a Histogram needs the engine's
    // transposeData, which transposes the dataset IN PLACE — and every panel of the dashboard
    // shares that one data object, so the sibling panels would be drawn flipped.
    var byBatch = buildChartConfig('Boxplot', { x: quality, group: batch, color: batch },
      { graphOrientation: 'vertical', showBoxplotOriginalData: true }, data);
    panels.push({ id: 'quality-spread', title: quality + (batch ? ' by ' + batch : ''),
      config: withoutTitle(byBatch), x: 8, y: GRID_H, w: 4, h: GRID_H });
  }
  if (panels.length < MIN_PANELS) return null;
  return withCaseDrill({ template: 'ngs-qc', label: 'Sequencing run QC', panels: withDashboardConfigs(panels, data),
    reason: 'Per-sample QC table (' + Object.keys(metrics).join(', ') + '): filters, depth per ' +
      'sample, mapping against duplication and the quality spread' +
      (batch ? ' by "' + batch + '"' : '') + '; click a bar or point to load that sample\'s record.' },
  data, 'Sample record — click a bar or point to load', ['depth', 'quality-scatter']);
}

/**
 * Drop the config title (the panel header already shows it).
 * @param {object} config - A CanvasXpress config.
 * @returns {object} The same config with `title: false`.
 * @private
 */
function withoutTitle(config) {
  config.title = false;
  return config;
}

/**
 * Add each chart panel's dashboard form of its config. `config` is what the chart needs to
 * draw standalone (the wizard's previews); `dashboardConfig` is what the published dashboard
 * carries ({@link panelConfigFor}), set only where it differs.
 * @param {Array<object>} panels - Panel descriptors.
 * @param {object} data - The dataset's CanvasXpress data object.
 * @returns {Array<object>} The same panels.
 * @private
 */
function withDashboardConfigs(panels, data) {
  panels.forEach(function (panel) {
    if (!panel.config) return;
    var forDashboard = panelConfigFor(panel.config, data);
    if (JSON.stringify(forDashboard) !== JSON.stringify(panel.config)) panel.dashboardConfig = forDashboard;
  });
  return panels;
}

/**
 * Add the case drill to a suggestion: the click action on each panel whose marks are single
 * rows (a scatter point, a sample bar — NOT a box or a curve, whose click names a group), the
 * `drill` description (param, second source, the row the card starts on) and the case card
 * panel under everything. The card is added after the template's own size check, so it never
 * counts toward the minimum.
 * @param {object} suggestion - A template's suggestion.
 * @param {object} data - The dataset's CanvasXpress data object.
 * @param {string} cardTitle - The card's panel title.
 * @param {Array<string>} rowPanels - Ids of the panels a click on which names one row.
 * @returns {object} The same suggestion.
 * @private
 */
function withCaseDrill(suggestion, data, cardTitle, rowPanels) {
  suggestion.panels.forEach(function (panel) {
    if (rowPanels.indexOf(panel.id) !== -1) {
      panel.actions = [{ on: 'click', setParam: { name: CASE_PARAM } }];
    }
  });
  suggestion.panels.push({ id: 'case', card: true, title: cardTitle,
    config: JSON.parse(JSON.stringify(CASE_CARD_CONFIG)), x: 0, y: GRID_H * 2, w: 12, h: CARD_H });
  suggestion.drill = { param: CASE_PARAM, source: CASE_SOURCE, initial: String(data.y.smps[0]) };
  return suggestion;
}

/**
 * Suggest a whole linked dashboard for a dataset, if it matches a known analysis shape.
 *
 * Recognises:
 *  - a survival table → `cohort` (filters + Kaplan–Meier + measure by group / vs time);
 *  - a per-sample sequencing QC table (three or more QC metric families among the numeric
 *    columns) → `ngs-qc` (filters + depth + mapping vs duplication + quality by batch).
 *
 * No published panel carries the engine's `transposeData`: it transposes the dataset in
 * place, and all the panels share one data object (see {@link panelConfigFor}).
 *
 * Only the standard orientation is handled (variables are the measures, rows are the samples);
 * a table stored the other way round gets no suggestion.
 *
 * Each template ends with a **case drill**: clicking a point (or sample bar) loads that row's
 * record into a case card — see `drill` on the result and {@link dashboardSpec}.
 *
 * A suggestion only: the result is plain data (panel descriptors), turned into a spec by
 * {@link dashboardSpec} once the caller chooses it. A chart panel's `config` draws standalone
 * (previews); where the published dashboard must carry something different, `dashboardConfig`
 * holds it ({@link panelConfigFor}). A template that would yield fewer than
 * three panels is not offered.
 *
 * @param {object} data - CanvasXpress data object.
 * @returns {({template: string, label: string, reason: string, panels: Array<object>}|null)}
 *   The best suggestion, or null when nothing fits (keep the single-chart flow).
 * @public
 */
export function suggestDashboard(data) {
  if (!data || !data.y || !(data.y.vars || []).length) return null;
  // Standard orientation only: the measures are the variables, the rows the samples. A table
  // stored the other way round (more variables than samples, annotations in `z`) needs its source
  // row axis declared and per-panel transposes, and draws wrong without them — so offer nothing.
  if (data.y.vars.length > (data.y.smps || []).length) return null;
  var columns = describeColumns(data);
  if (!columns.length) return null;
  var shapes = detectDataShapes(data);
  var survival = null;
  shapes.forEach(function (s) { if (s.graphType === 'KaplanMeier' && s.columns) survival = s.columns; });
  var cohort = survival ? cohortTemplate(data, columns, survival) : null;
  if (cohort) return cohort;
  var metrics = qcMetricColumns(columns);
  if (Object.keys(metrics).length >= 3) return qcTemplate(data, columns, metrics);
  return null;
}

/**
 * The linked dashboard spec for a chosen suggestion: every panel bound to one data
 * source, so a selection in one panel selects the same rows in the rest.
 * @param {object} suggestion - From {@link suggestDashboard}.
 * @param {object} opts - `{id, title?, datasetId?, store?, source?, thresholds?}`. `source` (a
 *   spec data source) wins; otherwise the stored dataset `datasetId`. `thresholds` are failure
 *   conditions the caller declares (`{field, op, value, label?}`); they are never inferred.
 * @returns {object} A dashboard spec that opts in to proactive insights (`insights`: the
 *   data-derived checks, plus any `thresholds`). With a `drill`: a `case` param, a second source of the
 *   same data narrowed (browser-side pushdown on the row id) to that param, the card panel
 *   bound to it, and `setParam` click actions on the row-mark panels.
 * @public
 */
export function dashboardSpec(suggestion, opts) {
  var spec = blankSpec(opts.id, opts.title || suggestion.label);
  spec.insights = opts.thresholds && opts.thresholds.length ? { thresholds: JSON.parse(JSON.stringify(opts.thresholds)) } : {};
  var source = opts.source;
  if (!source) {
    source = { kind: 'dataset', id: opts.datasetId };
    if (opts.store) source.store = opts.store;
  }
  spec = setDataSource(spec, 'data', source);
  var drill = suggestion.drill;
  if (drill) {
    spec = setParam(spec, drill.param, { value: drill.initial });
    var caseSource = JSON.parse(JSON.stringify(source));
    caseSource.pushdown = { where: [{ column: 'smps', op: '=', value: '$' + drill.param }] };
    spec = setDataSource(spec, drill.source, caseSource);
  }
  suggestion.panels.forEach(function (panel) {
    var copy = JSON.parse(JSON.stringify(panel));
    if (copy.dashboardConfig) copy.config = copy.dashboardConfig;
    delete copy.dashboardConfig;
    copy.dataRef = copy.card && drill ? drill.source : 'data';
    var actions = copy.actions;
    delete copy.card;
    delete copy.actions;
    spec = addPanel(spec, copy);
    if (actions) spec = updatePanel(spec, copy.id, { actions: actions });
  });
  return spec;
}
