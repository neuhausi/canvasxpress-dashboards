/**
 * Publication Figure Composer — turn a rendered dashboard into a submission-ready
 * multi-panel figure: pick panels, auto-label them A/B/C/…, size to a journal
 * column, and export ONE true-vector SVG (plus a flattened PDF) at publication
 * DPI. This is the composition layer on top of the engine's per-chart vector
 * output (`instance.getSVGString()` / `getPDFBytes()`); it adds no `build/js`
 * graphType and does not rasterize.
 *
 * Pipeline:
 *  - composeFigureModel — chosen panels + grid placement + subplot labels;
 *  - JOURNAL_PRESETS / figureDimensions — journal column widths + DPI;
 *  - composeFigureSvg / composeFigurePdf — stitch into one vector figure.
 *
 * @module figureComposer
 */

import { panelToSvg } from './exportDashboard.js';

/* ========================================================================= *
 * P3 — Journal presets + DPI
 * ========================================================================= */

/**
 * Journal column-width presets, in millimetres. Single- and double-column
 * widths follow each publisher's author guidelines (rounded to the published
 * figure of 1/100 mm). `generic` is a neutral A4-derived pair.
 * @type {Object<string, {label: string, oneCol: number, twoCol: number}>}
 * @public
 */
export var JOURNAL_PRESETS = {
  nature: { label: 'Nature', oneCol: 89, twoCol: 183 },
  cell: { label: 'Cell', oneCol: 85, twoCol: 174 },
  science: { label: 'Science (AAAS)', oneCol: 55, twoCol: 120 },
  plos: { label: 'PLOS', oneCol: 83, twoCol: 173 },
  generic: { label: 'Generic', oneCol: 90, twoCol: 180 }
};

/** Millimetres per inch. @type {number} @private */
var MM_PER_INCH = 25.4;

/**
 * Convert a millimetre length to pixels at a given DPI.
 * @param {number} mm - Length in millimetres.
 * @param {number} dpi - Dots per inch (e.g. 300 for print).
 * @returns {number} The length in pixels (rounded).
 * @public
 */
export function mmToPx(mm, dpi) {
  return Math.round((mm / MM_PER_INCH) * dpi);
}

/**
 * Resolve a figure's pixel size from a journal preset, column span and DPI.
 * @param {object} [opts] - Sizing options.
 * @param {string} [opts.preset='generic'] - A key of {@link JOURNAL_PRESETS}.
 * @param {('one'|'two')} [opts.columns='one'] - One- or two-column width.
 * @param {number} [opts.dpi=300] - Target DPI.
 * @param {number} [opts.aspect=0.75] - Figure height / width ratio.
 * @param {number} [opts.widthMm] - Explicit width in mm (overrides the preset).
 * @param {number} [opts.heightMm] - Explicit height in mm (overrides aspect).
 * @returns {{widthPx:number, heightPx:number, widthMm:number, heightMm:number, dpi:number}}
 * @public
 */
export function figureDimensions(opts) {
  opts = opts || {};
  var dpi = opts.dpi || 300;
  var preset = JOURNAL_PRESETS[opts.preset] || JOURNAL_PRESETS.generic;
  var widthMm = opts.widthMm != null
    ? opts.widthMm
    : (opts.columns === 'two' ? preset.twoCol : preset.oneCol);
  var aspect = opts.aspect != null ? opts.aspect : 0.75;
  var heightMm = opts.heightMm != null ? opts.heightMm : widthMm * aspect;
  return {
    widthPx: mmToPx(widthMm, dpi),
    heightPx: mmToPx(heightMm, dpi),
    widthMm: widthMm,
    heightMm: heightMm,
    dpi: dpi
  };
}

/* ========================================================================= *
 * P2 — Figure composition model
 * ========================================================================= */

/**
 * Whether a spec panel is a graph panel (as opposed to a control / text /
 * image / filters panel). Graph panels are the ones with a live instance and
 * `type === undefined`.
 * @param {object} panel - A `spec.panels[id]` entry.
 * @returns {boolean} True for a graph panel.
 * @private
 */
function isGraphPanel(panel) {
  return !!panel && !panel.type;
}

/**
 * The subplot label for the n-th panel (0-based) in a given style.
 * @param {number} index - 0-based panel index.
 * @param {('A'|'a'|'1'|'none')} style - Label alphabet; 'none' yields ''.
 * @returns {string} The label (e.g. 'A', 'c', '3').
 * @private
 */
function subplotLabel(index, style) {
  if (style === 'none') return '';
  if (style === '1') return String(index + 1);
  var base = style === 'a' ? 97 : 65;   // 'a' or 'A'
  // Beyond 26 panels, wrap to AA, AB, … (rare for a figure, but defined).
  var letters = '';
  var n = index;
  do {
    letters = String.fromCharCode(base + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

/**
 * Build the composition model for a figure: which panels, in what order, where
 * on the grid, and their subplot labels — WITHOUT rendering yet. Order and grid
 * come from the dashboard's `layout.items` (reading order: top-to-bottom, then
 * left-to-right) unless overridden.
 *
 * @param {object} handle - A live dashboard handle (needs `spec` and, for
 *   rendering, `panelInstances()`).
 * @param {object} [opts] - Composition options.
 * @param {string[]} [opts.panels] - Explicit ordered panel ids (overrides the
 *   layout-derived order; unknown / non-graph ids are dropped).
 * @param {('A'|'a'|'1'|'none')} [opts.labelStyle='A'] - Subplot label alphabet.
 * @param {number} [opts.cols] - Figure grid columns (defaults to the dashboard
 *   `layout.cols`, or a near-square packing when the layout has no grid).
 * @returns {{panels: Array<{id:string, label:string, x:number, y:number, w:number, h:number}>, cols: number, labelStyle: string}}
 *   The model; `x/y/w/h` are in grid units.
 * @public
 */
export function composeFigureModel(handle, opts) {
  opts = opts || {};
  var spec = (handle && handle.spec) || {};
  var panels = spec.panels || {};
  var layout = spec.layout || {};
  var items = layout.items || [];
  var labelStyle = opts.labelStyle || 'A';

  // Map panel id -> its layout item (for geometry), graph panels only.
  var itemByPanel = {};
  items.forEach(function (it) {
    if (it && it.panel && isGraphPanel(panels[it.panel])) itemByPanel[it.panel] = it;
  });

  // Resolve the ordered list of panel ids.
  var ordered;
  if (opts.panels && opts.panels.length) {
    ordered = opts.panels.filter(function (id) { return isGraphPanel(panels[id]); });
  } else {
    // Reading order from the layout; panels absent from the layout trail at the end.
    var placed = items
      .filter(function (it) { return it && isGraphPanel(panels[it.panel]); })
      .slice()
      .sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); })
      .map(function (it) { return it.panel; });
    var seen = {};
    ordered = [];
    placed.forEach(function (id) { if (!seen[id]) { seen[id] = true; ordered.push(id); } });
    Object.keys(panels).forEach(function (id) {
      if (isGraphPanel(panels[id]) && !seen[id]) { seen[id] = true; ordered.push(id); }
    });
  }

  var haveGrid = ordered.every(function (id) { return itemByPanel[id]; }) && ordered.length > 0;
  var cols, modelPanels;

  if (haveGrid && !opts.cols) {
    // Reuse the dashboard's own grid geometry, re-based to the selection's
    // bounding box so a sub-selection isn't marooned in whitespace.
    cols = layout.cols || 12;
    var minX = Infinity, minY = Infinity;
    ordered.forEach(function (id) {
      minX = Math.min(minX, itemByPanel[id].x);
      minY = Math.min(minY, itemByPanel[id].y);
    });
    modelPanels = ordered.map(function (id, i) {
      var it = itemByPanel[id];
      return { id: id, label: subplotLabel(i, labelStyle), x: it.x - minX, y: it.y - minY, w: it.w, h: it.h };
    });
    // Tighten cols to the selection's actual width.
    var maxRight = 0;
    modelPanels.forEach(function (p) { maxRight = Math.max(maxRight, p.x + p.w); });
    cols = Math.min(cols, maxRight) || maxRight;
  } else {
    // No usable grid (or explicit cols): pack into a near-square grid.
    cols = opts.cols || Math.ceil(Math.sqrt(ordered.length));
    modelPanels = ordered.map(function (id, i) {
      return { id: id, label: subplotLabel(i, labelStyle), x: i % cols, y: Math.floor(i / cols), w: 1, h: 1 };
    });
  }

  return { panels: modelPanels, cols: cols, labelStyle: labelStyle };
}

/* ========================================================================= *
 * P4 — Composite vector export
 * ========================================================================= */

/**
 * Read the intrinsic width/height from a panel's `<svg>` root tag.
 * @param {string} svg - An SVG document string.
 * @returns {{width:number, height:number}} Intrinsic size (defaults 680x440).
 * @private
 */
function svgIntrinsicSize(svg) {
  var open = (svg.match(/<svg\b[^>]*>/i) || [''])[0];
  var w = /\bwidth\s*=\s*"?([\d.]+)/i.exec(open);
  var h = /\bheight\s*=\s*"?([\d.]+)/i.exec(open);
  return { width: w ? parseFloat(w[1]) : 680, height: h ? parseFloat(h[1]) : 440 };
}

/**
 * Re-root a panel's SVG for placement inside a composite: give it a `viewBox`
 * equal to its intrinsic size (so it SCALES, not clips) and set the placement
 * `x`/`y`/`width`/`height`. The `<svg>` stays a valid nested element.
 * @param {string} svg - The panel SVG document.
 * @param {{x:number, y:number, width:number, height:number}} box - Placement.
 * @returns {string} The re-rooted SVG string (still one `<svg>…</svg>`).
 * @private
 */
function placePanelSvg(svg, box) {
  var size = svgIntrinsicSize(svg);
  var open = (svg.match(/<svg\b[^>]*>/i) || ['<svg>'])[0];
  var rest = svg.slice(open.length);
  // Strip any existing x/y/width/height/viewBox off the root, keep the rest
  // (xmlns, version, desc…), then add our placement + a viewBox for scaling.
  var attrs = open
    .replace(/^<svg\b/i, '')
    .replace(/>\s*$/, '')
    .replace(/\s(?:x|y|width|height|viewBox)\s*=\s*"[^"]*"/gi, '')
    .trim();
  var placed = '<svg ' + attrs +
    ' x="' + box.x + '" y="' + box.y + '"' +
    ' width="' + box.width + '" height="' + box.height + '"' +
    ' viewBox="0 0 ' + size.width + ' ' + size.height + '"' +
    ' preserveAspectRatio="xMidYMid meet">';
  return placed + rest;
}

/** XML-escape a caption / label string. @private */
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Compose the chosen dashboard panels into ONE true-vector multi-panel SVG
 * figure, sized to a journal column, with auto A/B/C labels and an optional
 * shared caption. Each panel is the engine's own `getSVGString()` output,
 * placed and scaled — no rasterization.
 *
 * @param {object} handle - A live dashboard handle (`spec`, `panelInstances()`).
 * @param {object} [opts] - Composition + sizing options.
 * @param {string[]} [opts.panels] - Ordered panel ids (see composeFigureModel).
 * @param {('A'|'a'|'1'|'none')} [opts.labelStyle='A'] - Subplot label style.
 * @param {number} [opts.cols] - Figure grid columns override.
 * @param {string} [opts.preset] - Journal preset (see figureDimensions).
 * @param {('one'|'two')} [opts.columns] - Column span for the preset.
 * @param {number} [opts.dpi] - Target DPI.
 * @param {number} [opts.aspect] - Figure height/width ratio.
 * @param {number} [opts.widthMm] - Explicit figure width (mm).
 * @param {number} [opts.heightMm] - Explicit figure height (mm).
 * @param {number} [opts.gap=0.02] - Gutter between panels, as a fraction of the
 *   figure width.
 * @param {string} [opts.caption] - A shared caption drawn under the figure.
 * @param {string} [opts.background='#ffffff'] - Figure backdrop.
 * @param {function(string, object):string} [opts.panelSvg] - Override for
 *   obtaining a panel's SVG (id, panel-model) -> svg; defaults to the engine.
 * @returns {{svg:string, model:object, size:object}} The composite SVG plus the
 *   model and resolved pixel size used.
 * @public
 */
export function composeFigureSvg(handle, opts) {
  opts = opts || {};
  var model = composeFigureModel(handle, opts);
  var size = figureDimensions(opts);
  if (!model.panels.length) throw new Error('figure has no graph panels to compose');

  var rows = 0;
  model.panels.forEach(function (p) { rows = Math.max(rows, p.y + p.h); });
  var cols = model.cols || 1;

  var gapFrac = opts.gap != null ? opts.gap : 0.02;
  var gapPx = Math.round(size.widthPx * gapFrac);
  var captionH = opts.caption ? Math.round(size.heightPx * 0.08) : 0;
  var labelPx = model.labelStyle === 'none' ? 0 : Math.max(10, Math.round(size.widthPx * 0.035));

  // Cell geometry in figure pixels (uniform-gap grid).
  var gridW = size.widthPx - gapPx * (cols + 1);
  var gridH = size.heightPx - captionH - gapPx * (rows + 1);
  var cellW = gridW / cols;
  var cellH = gridH / rows;

  var parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    'version="1.1" width="' + size.widthPx + '" height="' + size.heightPx + '" ' +
    'viewBox="0 0 ' + size.widthPx + ' ' + size.heightPx + '">');
  parts.push('<rect x="0" y="0" width="' + size.widthPx + '" height="' + size.heightPx +
    '" fill="' + (opts.background || '#ffffff') + '"/>');

  var getPanelSvg = opts.panelSvg || function (id) { return panelToSvg(handle, id); };

  model.panels.forEach(function (p) {
    var x = gapPx + p.x * (cellW + gapPx);
    var y = gapPx + p.y * (cellH + gapPx);
    var w = p.w * cellW + (p.w - 1) * gapPx;
    var h = p.h * cellH + (p.h - 1) * gapPx;
    var chartY = y + labelPx;
    var chartH = Math.max(1, h - labelPx);

    var panelSvg = getPanelSvg(p.id, p);
    parts.push(placePanelSvg(panelSvg, { x: x, y: chartY, width: w, height: chartH }));

    if (p.label) {
      parts.push('<text x="' + x + '" y="' + (y + labelPx * 0.8) + '" ' +
        'font-family="Arial, Helvetica, sans-serif" font-size="' + labelPx + '" ' +
        'font-weight="bold" fill="#000000" text-anchor="start">' + xmlEscape(p.label) + '</text>');
    }
  });

  if (opts.caption) {
    var capSize = Math.max(9, Math.round(captionH * 0.3));
    parts.push('<text x="' + gapPx + '" y="' + (size.heightPx - captionH + capSize * 1.2) + '" ' +
      'font-family="Arial, Helvetica, sans-serif" font-size="' + capSize + '" fill="#333333" ' +
      'text-anchor="start">' + xmlEscape(opts.caption) + '</text>');
  }

  parts.push('</svg>');
  return { svg: parts.join('\n'), model: model, size: size };
}

/**
 * Export the composed figure as a `.svg` file (downloads it), true vector.
 * @param {object} handle - A live dashboard handle.
 * @param {object} [opts] - See {@link composeFigureSvg}, plus `filename`.
 * @param {Document} [doc] - Document to use; defaults to global.
 * @returns {object} The composition result (`svg`, `model`, `size`).
 * @public
 */
export function exportFigureSvg(handle, opts, doc) {
  opts = opts || {};
  var result = composeFigureSvg(handle, opts);
  doc = doc || (typeof document !== 'undefined' ? document : null);
  if (doc) {
    var blob = new Blob([result.svg], { type: 'image/svg+xml' });
    var url = URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = opts.filename || 'figure.svg';
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  return result;
}

/**
 * Flatten the composed figure to a single-page PDF at the chosen size/DPI.
 * Prefers a TRUE-VECTOR path (an injected `svg2pdf` + `jsPDF`); otherwise falls
 * back to a high-DPI raster of the composite SVG (`<img>` → canvas → jsPDF).
 * Pure-browser (needs a DOM); the SVG composition itself is environment-free.
 *
 * @param {object} handle - A live dashboard handle.
 * @param {object} [opts] - See {@link composeFigureSvg}, plus:
 * @param {*} [opts.jsPDF] - jsPDF constructor; defaults to `window.jspdf.jsPDF`.
 * @param {function} [opts.svg2pdf] - svg2pdf(element, pdf, options); when given,
 *   the figure is embedded as vector. Defaults to `window.svg2pdf` if present.
 * @returns {Promise<{blob:Blob, model:object, size:object}>} The PDF.
 * @public
 */
export function composeFigurePdf(handle, opts) {
  opts = opts || {};
  var result;
  try { result = composeFigureSvg(handle, opts); }
  catch (e) { return Promise.reject(e); }

  var JsPDF = opts.jsPDF || (typeof window !== 'undefined' && window.jspdf ? window.jspdf.jsPDF : null);
  if (typeof JsPDF !== 'function') return Promise.reject(new Error('jsPDF is not loaded'));
  var svg2pdf = opts.svg2pdf || (typeof window !== 'undefined' ? window.svg2pdf : null);
  var w = result.size.widthPx, h = result.size.heightPx;
  var pdf = new JsPDF({ orientation: w >= h ? 'landscape' : 'portrait', unit: 'px', format: [w, h] });

  if (typeof svg2pdf === 'function' && typeof document !== 'undefined') {
    // True-vector embed.
    var holder = document.createElement('div');
    holder.innerHTML = result.svg.replace(/^<\?xml[^>]*>\s*/, '');
    var el = holder.querySelector('svg');
    return Promise.resolve(svg2pdf(el, pdf, { x: 0, y: 0, width: w, height: h }))
      .then(function () { return { blob: pdf.output('blob'), model: result.model, size: result.size }; });
  }

  // Raster fallback: paint the composite SVG onto a canvas at full pixel size.
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return Promise.reject(new Error('composeFigurePdf raster fallback needs a browser DOM'));
  }
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var svgBlob = new Blob([result.svg], { type: 'image/svg+xml' });
    var url = URL.createObjectURL(svgBlob);
    img.onload = function () {
      try {
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve({ blob: pdf.output('blob'), model: result.model, size: result.size });
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('failed to rasterize composite SVG')); };
    img.src = url;
  });
}

/**
 * Export the composed figure as a `.pdf` file (downloads it).
 * @param {object} handle - A live dashboard handle.
 * @param {object} [opts] - See {@link composeFigurePdf}, plus `filename`.
 * @param {Document} [doc] - Document to use; defaults to global.
 * @returns {Promise<object>} The composition result.
 * @public
 */
export function exportFigurePdf(handle, opts, doc) {
  opts = opts || {};
  return composeFigurePdf(handle, opts).then(function (result) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (doc) {
      var url = URL.createObjectURL(result.blob);
      var a = doc.createElement('a');
      a.href = url;
      a.download = opts.filename || 'figure.pdf';
      doc.body.appendChild(a);
      a.click();
      doc.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    return result;
  });
}
