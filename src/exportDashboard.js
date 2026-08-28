/**
 * Export a rendered dashboard as a self-contained HTML file, a PNG image, or a
 * single-page PDF.
 *
 * HTML export is fully self-contained: the CanvasXpress CSS/JS, the dashboards
 * UMD bundle, and a data-inlined copy of the spec are all embedded, so the file
 * renders offline with no server and no external requests. PNG/PDF rasterize the
 * live rendered container (`handle.container` from `renderDashboard`) via
 * html2canvas, and the PDF wraps that image with jsPDF.
 *
 * Reuses the Blob-download pattern from persistence.js and the data resolution
 * from dataStore.js so a dataset/connector-backed spec still exports with its
 * data baked in (every source becomes `kind:"inline"`).
 *
 * @module exportDashboard
 */

import { createDataStore } from './dataStore.js';

/**
 * Inline SVG favicon (a CanvasXpress-blue bar-chart glyph) as a data URI, so the
 * exported page shows a tab icon without any external request.
 * @type {string}
 * @private
 */
var FAVICON_DATA_URI =
  'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    '<rect width="16" height="16" rx="3" fill="#2563eb"/>' +
    '<rect x="3" y="8" width="2.4" height="5" rx="0.6" fill="#fff"/>' +
    '<rect x="6.8" y="5" width="2.4" height="8" rx="0.6" fill="#fff"/>' +
    '<rect x="10.6" y="3" width="2.4" height="10" rx="0.6" fill="#fff"/>' +
    '</svg>'
  );

/**
 * Trigger a browser download of a Blob (same pattern as persistence.exportSpec).
 * @param {Blob} blob - The file contents.
 * @param {string} name - Download filename.
 * @param {Document} [doc] - Document to use; defaults to global.
 * @returns {void}
 * @private
 */
function downloadBlob(blob, name, doc) {
  doc = doc || document;
  var url = URL.createObjectURL(blob);
  var a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Deep-clone the spec with every data source resolved to `kind:"inline"`,
 * fetching `dataset`/`connector` sources so the result carries its own data and
 * needs no server to render.
 * @param {object} spec - The dashboard spec.
 * @param {object} [opts] - Resolution options.
 * @param {string} [opts.baseUrl] - Base URL for dataset/connector resolution.
 * @param {function} [opts.fetch] - fetch implementation; defaults to global.
 * @param {object} [opts.params] - Current parameter values; sources are resolved
 *   against them so the snapshot captures the current selection, and param
 *   controls are frozen to it (see {@link freezeParamControls}).
 * @returns {Promise<object>} A self-contained spec (all sources inline).
 */
export function inlineSpecData(spec, opts) {
  opts = opts || {};
  var store = createDataStore({ baseUrl: opts.baseUrl || '', fetch: opts.fetch });
  var out = JSON.parse(JSON.stringify(spec));
  var params = currentParams(spec, opts.params);
  var sources = out.data || {};
  var refs = Object.keys(sources);
  return Promise.all(refs.map(function (ref) {
    var src = sources[ref];
    if (!src || src.kind === 'inline') return null;
    return store.resolve(ref, src, { params: params }).then(function (data) {
      // Drop the now-meaningless query template — the data is baked inline.
      sources[ref] = { kind: 'inline', value: data };
    });
  })).then(function () {
    freezeParamControls(out, params);
    return out;
  });
}

/**
 * Merge a spec's declared `params` defaults with any live overrides, yielding
 * the parameter values in effect for an export snapshot.
 * @param {object} spec - The dashboard spec (reads `params` defaults).
 * @param {object} [overrides] - Live values (e.g. current control selections).
 * @returns {object} name -> value.
 * @private
 */
function currentParams(spec, overrides) {
  var out = {};
  var declared = spec.params || {};
  for (var name in declared) {
    if (!Object.prototype.hasOwnProperty.call(declared, name)) continue;
    var def = declared[name];
    out[name] = def && typeof def === 'object' ? def.value : def;
  }
  if (overrides) {
    for (var key in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) out[key] = overrides[key];
    }
  }
  return out;
}

/**
 * Freeze every `mode:"param"` control in an exported spec: since the offline
 * file cannot reach a backend to re-query, the control is marked `disabled`
 * (rendered read-only with a "snapshot" note) and pinned to the value in effect
 * at export time so the visible state matches the baked-in data. Mutates `out`.
 * @param {object} out - The (already deep-cloned) export spec.
 * @param {object} params - The parameter values in effect at export time.
 * @returns {void}
 * @private
 */
function freezeParamControls(out, params) {
  var panels = out.panels || {};
  for (var id in panels) {
    if (!Object.prototype.hasOwnProperty.call(panels, id)) continue;
    var panel = panels[id];
    if (panel && panel.type === 'control' && panel.mode === 'param') {
      panel.disabled = true;
      if (panel.param != null && params[panel.param] != null) panel.value = params[panel.param];
    }
  }
}

/**
 * Fetch a URL and return its body text (used to inline the CX/CSS/UMD assets).
 * @param {string} url - The asset URL.
 * @param {function} [fetchImpl] - fetch implementation; defaults to global.
 * @returns {Promise<string>} The response text.
 * @private
 */
function fetchText(url, fetchImpl) {
  var f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return Promise.reject(new Error('no fetch available to inline ' + url));
  return f(url).then(function (res) {
    if (!res.ok) throw new Error('could not fetch ' + url + ' (HTTP ' + res.status + ')');
    return res.text();
  });
}

/**
 * Neutralize any literal `</script` (or `<!--`) inside injected JS/JSON so it
 * cannot prematurely terminate the embedding `<script>` tag. Only the actual
 * script-closing / comment-opening tokens are escaped — a blanket `</`→`<\/`
 * replace would corrupt legitimate JS the library contains (e.g. the regex
 * literal `/</g` becomes the unterminated `/<\/g`), which breaks the bundle.
 * @param {string} s - The text to guard.
 * @returns {string} Guarded text safe to place inside a `<script>` element.
 * @private
 */
function guardScript(s) {
  return String(s)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--');
}

/**
 * Build the exported page's footer: a "Built with CanvasXpress" link to the
 * site and, when a dashboard URL is known, a link back to the live dashboard.
 * @param {object} spec - The (data-inlined) dashboard spec.
 * @param {string} siteUrl - The CanvasXpress site URL.
 * @param {string} dashboardUrl - The live dashboard URL (empty to omit).
 * @returns {string} The footer HTML.
 * @private
 */
function buildFooter(spec, siteUrl, dashboardUrl) {
  var name = spec.title || spec.id || 'this dashboard';
  var parts = [
    'Built with <a href="' + escapeHtml(siteUrl) + '" target="_blank" rel="noopener">CanvasXpress</a>'
  ];
  if (dashboardUrl) {
    parts.push('<a href="' + escapeHtml(dashboardUrl) + '" target="_blank" rel="noopener">View “' +
      escapeHtml(name) + '” live</a>');
  }
  return '<footer class="cxd-export-footer"><span>' + parts.join('</span><span>') + '</span></footer>\n';
}

/**
 * Escape text for placement in an HTML title/attribute context.
 * @param {string} s - The raw text.
 * @returns {string} The escaped text.
 * @private
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/**
 * Build a fully self-contained HTML document string for a dashboard: the
 * CanvasXpress CSS/JS, the dashboards UMD bundle, and the data-inlined spec are
 * all embedded, so the file renders offline with no external requests.
 * @param {object} spec - The dashboard spec.
 * @param {object} [opts] - Build options.
 * @param {string} [opts.baseUrl] - Base URL for dataset/connector resolution.
 * @param {function} [opts.fetch] - fetch implementation; defaults to global.
 * @param {object} [opts.params] - Current parameter values; the snapshot bakes
 *   each source at these values and freezes param controls to them.
 * @param {string} [opts.cxJsUrl] - URL of canvasXpress.min.js to inline.
 * @param {string} [opts.cxCssUrl] - URL of canvasXpress.css to inline.
 * @param {string} [opts.umdUrl] - URL of the dashboards UMD bundle to inline.
 * @param {string} [opts.siteUrl] - "Built with CanvasXpress" link target in the
 *   exported page's footer (defaults to the CanvasXpress site).
 * @param {string} [opts.dashboardUrl] - Link back to the live dashboard; when
 *   given, a "View the live dashboard" link is added to the footer.
 * @returns {Promise<string>} The self-contained HTML document.
 */
export function buildDashboardHtml(spec, opts) {
  opts = opts || {};
  var cxJsUrl = opts.cxJsUrl || 'https://www.canvasxpress.org/dist/canvasXpress.min.js';
  var cxCssUrl = opts.cxCssUrl || 'https://www.canvasxpress.org/dist/canvasXpress.css';
  var umdUrl = opts.umdUrl || 'dist/canvasxpress-dashboards.umd.js';
  var siteUrl = opts.siteUrl || 'https://www.canvasxpress.org';
  var dashboardUrl = opts.dashboardUrl || '';
  return Promise.all([
    inlineSpecData(spec, opts),
    fetchText(cxCssUrl, opts.fetch),
    fetchText(cxJsUrl, opts.fetch),
    fetchText(umdUrl, opts.fetch)
  ]).then(function (parts) {
    var full = parts[0], css = parts[1], cxLib = parts[2], cxdLib = parts[3];
    var title = (full.title || full.id || 'Dashboard') + ' · CanvasXpress Dashboards';
    var specJson = guardScript(JSON.stringify(full));
    return '<!doctype html>\n<html lang="en">\n<head>\n' +
      '<meta charset="utf-8" />\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
      '<title>' + escapeHtml(title) + '</title>\n' +
      '<link rel="icon" href="' + FAVICON_DATA_URI + '" />\n' +
      '<style>\n' + css + '\n</style>\n' +
      '<style>\nbody{margin:0;font-family:system-ui,sans-serif;background:#f2f4f7;color:#222}' +
      '#dashboard{padding:16px 24px 32px}\n' +
      '.cxd-export-footer{padding:16px 24px 28px;font:13px/1.5 system-ui,sans-serif;color:#6b7280;' +
      'border-top:1px solid #e4e7eb;display:flex;flex-wrap:wrap;gap:6px 16px}\n' +
      '.cxd-export-footer a{color:#2563eb;text-decoration:none}\n' +
      '.cxd-export-footer a:hover{text-decoration:underline}\n' +
      '@media (prefers-color-scheme: dark){body{background:#0e1013;color:#e6e8ec}' +
      '.cxd-export-footer{color:#8a9099;border-top-color:#262b33}.cxd-export-footer a{color:#6ea8fe}}\n</style>\n' +
      '</head>\n<body>\n<div id="dashboard"></div>\n' +
      buildFooter(full, siteUrl, dashboardUrl) +
      '<script>' + guardScript(cxLib) + '</scr' + 'ipt>\n' +
      '<script>' + guardScript(cxdLib) + '</scr' + 'ipt>\n' +
      '<script>\nvar SPEC = ' + specJson + ';\n' +
      'CanvasXpressDashboards.renderDashboard(SPEC, "dashboard", {});\n' +
      '</scr' + 'ipt>\n</body>\n</html>\n';
  });
}

/**
 * Export the dashboard as a self-contained `.html` file (downloads it).
 * @param {object} spec - The dashboard spec.
 * @param {object} [opts] - Build options (see buildDashboardHtml) plus
 *   `filename`.
 * @param {string} [opts.filename] - Download name; defaults to `<id>.html`.
 * @param {Document} [doc] - Document to use; defaults to global.
 * @returns {Promise<void>} Resolves once the download has been triggered.
 */
export function exportDashboardHtml(spec, opts, doc) {
  opts = opts || {};
  return buildDashboardHtml(spec, opts).then(function (html) {
    var name = opts.filename || ((spec && spec.id ? spec.id : 'dashboard') + '.html');
    downloadBlob(new Blob([html], { type: 'text/html' }), name, doc);
  });
}

/**
 * Rasterize the rendered dashboard container to a PNG data URL via html2canvas.
 * @param {HTMLElement} container - `handle.container` from renderDashboard.
 * @param {object} [opts] - Options.
 * @param {function} [opts.html2canvas] - html2canvas impl; defaults to global.
 * @param {number} [opts.scale=2] - Device-scale for a crisper raster.
 * @param {string} [opts.background='#ffffff'] - Backdrop colour.
 * @returns {Promise<string>} A PNG data URL.
 */
export function dashboardToPng(container, opts) {
  opts = opts || {};
  var h2c = opts.html2canvas || (typeof window !== 'undefined' ? window.html2canvas : null);
  if (typeof h2c !== 'function') return Promise.reject(new Error('html2canvas is not loaded'));
  if (!container) return Promise.reject(new Error('no dashboard container to export'));
  return h2c(container, {
    scale: opts.scale || 2,
    backgroundColor: opts.background || '#ffffff',
    useCORS: true
  }).then(function (canvas) { return canvas.toDataURL('image/png'); });
}

/**
 * Export the rendered dashboard as a `.png` file (downloads it).
 * @param {HTMLElement} container - `handle.container` from renderDashboard.
 * @param {object} [opts] - Options (see dashboardToPng) plus `filename`.
 * @param {Document} [doc] - Document to use; defaults to global.
 * @returns {Promise<void>} Resolves once the download has been triggered.
 */
export function exportDashboardPng(container, opts, doc) {
  opts = opts || {};
  return dashboardToPng(container, opts).then(function (dataUrl) {
    return fetch(dataUrl).then(function (res) { return res.blob(); }).then(function (blob) {
      downloadBlob(blob, opts.filename || 'dashboard.png', doc);
    });
  });
}

/**
 * Export the rendered dashboard as a single-page PDF sized to the board and
 * download it. This is also the reliable "print" path (print the resulting PDF),
 * since a raw `window.print()` can clip canvases at page boundaries.
 * @param {HTMLElement} container - `handle.container` from renderDashboard.
 * @param {object} [opts] - Options.
 * @param {*} [opts.jsPDF] - jsPDF constructor; defaults to `window.jspdf.jsPDF`.
 * @param {function} [opts.html2canvas] - html2canvas impl; defaults to global.
 * @param {number} [opts.scale=2] - Raster scale passed to dashboardToPng.
 * @param {string} [opts.filename] - Download name; defaults to `dashboard.pdf`.
 * @returns {Promise<void>} Resolves once the PDF has been saved.
 */
export function exportDashboardPdf(container, opts, doc) {
  opts = opts || {};
  var JsPDF = opts.jsPDF ||
    (typeof window !== 'undefined' && window.jspdf ? window.jspdf.jsPDF : null);
  if (typeof JsPDF !== 'function') return Promise.reject(new Error('jsPDF is not loaded'));
  if (!container) return Promise.reject(new Error('no dashboard container to export'));
  var width = container.offsetWidth || 1024;
  var height = container.offsetHeight || 768;
  return dashboardToPng(container, opts).then(function (dataUrl) {
    var pdf = new JsPDF({
      orientation: width >= height ? 'landscape' : 'portrait',
      unit: 'px',
      format: [width, height]
    });
    pdf.addImage(dataUrl, 'PNG', 0, 0, width, height);
    pdf.save(opts.filename || 'dashboard.pdf');
  });
}
