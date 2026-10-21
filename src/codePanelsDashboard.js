/**
 * codePanelsDashboard — assemble a dashboard spec from R `canvasXpress` code
 * conversions.
 *
 * The sibling of {@link module:ggplotDashboard}. Where that lays out
 * self-contained `isGGPlot` specs (from ggplot2), this lays out native
 * CanvasXpress specs (`{data, config, …}`, from the R `canvasXpress` package's
 * own `canvasXpress(...)` call) as a grid of `type:"cxcode"` panels that
 * {@link module:renderDashboard} draws as ordinary, interactive CanvasXpress
 * charts. No dataRef / inline data is needed — the data rides inside each spec.
 *
 * @module codePanelsDashboard
 */

/**
 * One converted canvasXpress chart.
 * @typedef {object} CodePanelConversion
 * @property {string} key - Stable panel id (kebab-case).
 * @property {string} [title] - Panel title (defaults to the key).
 * @property {object} spec - A native CanvasXpress spec (`{data, config, …}`,
 *   with a `config` object and embedded `data`), exactly as the R
 *   `canvasXpress()` widget emits it (its `$x`).
 * @property {string} [code] - The original R source for this chart, kept so the
 *   dashboard can show how it was made (the "</> Code" recipe).
 */

/**
 * Build a dashboard spec that renders a collection of canvasXpress charts as a
 * grid of self-contained `cxcode` panels.
 *
 * @param {CodePanelConversion[]} conversions - The converted charts, in order.
 * @param {object} [opts] - Options.
 * @param {string} [opts.id="canvasxpress-dashboard"] - Dashboard id.
 * @param {string} [opts.title="CanvasXpress Dashboard"] - Dashboard title.
 * @param {string} [opts.theme="auto"] - "light" | "dark" | "auto".
 * @param {number} [opts.cols=12] - Grid column count.
 * @param {number} [opts.perRow=2] - Panels per row.
 * @param {number} [opts.panelHeight=7] - Panel height in grid rows.
 * @param {number} [opts.rowHeight=40] - Grid row height in px.
 * @param {number} [opts.gap=12] - Grid gap in px.
 * @param {string} [opts.intro] - Optional intro text/HTML shown in a full-width
 *   banner above the charts. Omit for no banner.
 * @returns {object} A dashboard spec (schema `panels` + `layout`), ready for
 *   {@link validateSpec} and {@link renderDashboard}.
 * @throws {Error} If any conversion lacks a string `key` or a spec with a
 *   `config` object.
 * @public
 */
export function buildCodePanelsDashboardSpec(conversions, opts) {
  var options = opts || {};
  var cols = options.cols || 12;
  var perRow = options.perRow || 2;
  var panelHeight = options.panelHeight || 7;
  var panelWidth = Math.max(1, Math.floor(cols / perRow));

  var items = [];
  var panels = {};
  var cursorY = 0;

  if (options.intro) {
    panels.intro = { type: 'text', html: options.intro };
    items.push({ panel: 'intro', x: 0, y: cursorY, w: cols, h: 2 });
    cursorY += 2;
  }

  for (var i = 0; i < conversions.length; i++) {
    var conv = conversions[i];
    if (!conv || typeof conv.key !== 'string' || !conv.key) {
      throw new Error('conversion[' + i + '] needs a string "key"');
    }
    if (!conv.spec || typeof conv.spec !== 'object' ||
        !conv.spec.config || typeof conv.spec.config !== 'object') {
      throw new Error('conversion "' + conv.key + '" needs a spec with a config object');
    }
    var col = i % perRow;
    if (col === 0 && i > 0) cursorY += panelHeight;   // start a fresh row
    items.push({
      panel: conv.key,
      x: col * panelWidth,
      y: cursorY,
      w: panelWidth,
      h: panelHeight
    });
    panels[conv.key] = {
      type: 'cxcode',
      title: conv.title || conv.key,
      spec: conv.spec
    };
    if (typeof conv.code === 'string' && conv.code) {
      panels[conv.key].code = conv.code;   // R source for the "</> Code" recipe
    }
  }

  return {
    $schema: 'https://canvasxpress.org/schema/dashboard.schema.json',
    schemaVersion: '1.3',
    id: options.id || 'canvasxpress-dashboard',
    title: options.title || 'CanvasXpress Dashboard',
    version: 1,
    theme: options.theme || 'auto',
    layout: {
      cols: cols,
      rowHeight: options.rowHeight || 40,
      gap: options.gap || 12,
      items: items
    },
    data: {},
    panels: panels
  };
}
