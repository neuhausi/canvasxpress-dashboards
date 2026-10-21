/**
 * ggplotDashboard — assemble a dashboard spec from ggplot conversions.
 *
 * The R `ggplot.as.list()` converter turns each ggplot object into a
 * self-contained CanvasXpress "isGGPlot" spec (it embeds its own data frame).
 * This module lays those out into a grid of `type:"ggplot"` panels that
 * {@link module:renderDashboard} renders as native, interactive CanvasXpress
 * charts. No dataRef / inline data is needed — the data rides inside each spec.
 *
 * @module ggplotDashboard
 */

/**
 * One converted ggplot chart.
 * @typedef {object} GgplotConversion
 * @property {string} key - Stable panel id (kebab-case).
 * @property {string} [title] - Panel title (defaults to the key).
 * @property {object} spec - A CanvasXpress isGGPlot spec (`isGGPlot:true`, with
 *   embedded `data`), exactly as `ggplot.as.list()` emits it.
 * @property {string} [code] - The original R/ggplot2 source for this chart, kept
 *   so the dashboard can show how it was made (the "</> Code" recipe).
 */

/**
 * Build a dashboard spec that renders a collection of ggplot charts as a grid
 * of self-contained `ggplot` panels.
 *
 * @param {GgplotConversion[]} conversions - The converted charts, in order.
 * @param {object} [opts] - Options.
 * @param {string} [opts.id="ggplot-dashboard"] - Dashboard id.
 * @param {string} [opts.title="ggplot Dashboard"] - Dashboard title.
 * @param {string} [opts.theme="auto"] - "light" | "dark" | "auto".
 * @param {number} [opts.cols=12] - Grid column count.
 * @param {number} [opts.perRow=2] - ggplot panels per row.
 * @param {number} [opts.panelHeight=7] - Panel height in grid rows.
 * @param {number} [opts.rowHeight=40] - Grid row height in px.
 * @param {number} [opts.gap=12] - Grid gap in px.
 * @param {string} [opts.intro] - Optional intro text/HTML shown in a full-width
 *   banner above the charts. Omit for no banner.
 * @returns {object} A dashboard spec (schema `panels` + `layout`), ready for
 *   {@link validateSpec} and {@link renderDashboard}.
 * @public
 */
export function buildGgplotDashboardSpec(conversions, opts) {
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
    if (!conv.spec || conv.spec.isGGPlot !== true) {
      throw new Error('conversion "' + conv.key + '" needs a spec with isGGPlot:true');
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
      type: 'ggplot',
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
    id: options.id || 'ggplot-dashboard',
    title: options.title || 'ggplot Dashboard',
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
