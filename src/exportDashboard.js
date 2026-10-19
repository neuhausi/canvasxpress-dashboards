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
import { zipSync } from './zip.js';
import { panelProvenanceText, describeSource } from './provenance.js';
import { sha256Hex } from './hash.js';

/**
 * Inline SVG favicon (a bar-chart glyph in the accent-strong role colour; a data URI cannot use
 * var(), so this mirrors --cx-ui-accent-strong) so the exported page shows a tab icon without any
 * external request.
 * @type {string}
 * @private
 */
var FAVICON_DATA_URI =
  'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    '<rect width="16" height="16" rx="3" fill="#3d58ff"/>' +
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
  var original = spec.data || {};   // unmutated, so joins still see their inputs' specs
  var refs = Object.keys(sources);
  var memo = {};
  /**
   * Resolve a source once per export, shared by the panels and joins reading it.
   * @param {string} ref - Source ref name.
   * @returns {Promise<object>} Its data.
   */
  function resolveInput(ref) {
    if (!memo[ref]) {
      memo[ref] = store.resolve(ref, original[ref], { params: params, sources: original, resolveInput: resolveInput });
    }
    return memo[ref];
  }
  return Promise.all(refs.map(function (ref) {
    var src = sources[ref];
    if (!src || src.kind === 'inline') return null;
    return resolveInput(ref).then(function (data) {
      // Drop the now-meaningless query template — the data is baked inline — but
      // carry forward any provenance metadata (method / dataVersion) so it is
      // not lost when the source is replaced.
      var inlineSrc = { kind: 'inline', value: data };
      if (src.provenance) inlineSrc.provenance = src.provenance;
      sources[ref] = inlineSrc;
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
    return '<!doctype html>\n<html lang="en" data-cx-ui-theme="auto">\n<head>\n' +
      '<meta charset="utf-8" />\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
      '<title>' + escapeHtml(title) + '</title>\n' +
      '<link rel="icon" href="' + FAVICON_DATA_URI + '" />\n' +
      '<style>\n' + css + '\n</style>\n' +
      '<style>\nbody{margin:0;font-family:var(--cx-font-sans);background:var(--cx-ui-surface-sunken);color:var(--cx-ui-text)}' +
      '#dashboard{padding:16px 24px 32px}\n' +
      '.cxd-export-footer{padding:16px 24px 28px;font:13px/1.5 var(--cx-font-sans);color:var(--cx-ui-text-muted);' +
      'border-top:1px solid var(--cx-ui-border-subtle);display:flex;flex-wrap:wrap;gap:6px 16px}\n' +
      '.cxd-export-footer a{color:var(--cx-ui-accent-strong);text-decoration:none}\n' +
      '.cxd-export-footer a:hover{text-decoration:underline}\n' +
      '</style>\n' +
      '</head>\n<body>\n<div id="dashboard"></div>\n' +
      buildFooter(full, siteUrl, dashboardUrl) +
      '<script>' + guardScript(cxLib) + '</scr' + 'ipt>\n' +
      '<script>' + guardScript(cxdLib) + '</scr' + 'ipt>\n' +
      '<script>\nvar SPEC = ' + specJson + ';\n' +
      // The page (footer) follows the dashboard's light/dark theme, like the viewer
      'CanvasXpressDashboards.renderDashboard(SPEC, "dashboard", {}).then(function () {\n' +
      '  document.documentElement.setAttribute("data-cx-ui-theme",\n' +
      '    document.getElementById("dashboard").getAttribute("data-cx-ui-theme") || "auto");\n' +
      '});\n' +
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
 * Strip the syntax-highlight markup the engine's code-emitters (`dataToR`,
 * `dataToPython`, `dataToCxplot`) wrap around their output: they return HTML
 * with `<span class=cX-Code-*>` tokens for the on-screen code modal, which the
 * engine's own UI recovers as plain text via `.innerText`. The bundle writer
 * has no DOM to lean on, so it removes the tags and decodes the handful of HTML
 * entities the emitters can introduce.
 * @param {string} html - The emitter's highlighted output.
 * @returns {string} Plain source text.
 * @private
 */
function stripCodeHtml(html) {
  return String(html == null ? '' : html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Sanitize a panel id / source ref for use as a file name inside the bundle.
 * @param {string} name - The id or ref.
 * @returns {string} A safe `[A-Za-z0-9._-]` name.
 * @private
 */
function safeName(name) {
  return String(name == null ? 'item' : name).replace(/[^A-Za-z0-9._-]+/g, '_') || 'item';
}

/**
 * Call an engine code-emitter on a live instance, returning plain source text
 * (or '' when the instance lacks the method or it throws). `dataToCxplot`
 * returns a stub for non-cxplot charts, which this reports as empty.
 * @param {object} instance - A live CanvasXpress instance.
 * @param {string} method - 'dataToR' | 'dataToPython' | 'dataToCxplot'.
 * @param {Array} [args] - Arguments for the emitter.
 * @returns {string} The plain code (empty when unavailable).
 * @private
 */
function emitCode(instance, method, args) {
  if (!instance || typeof instance[method] !== 'function') return '';
  try {
    var code = stripCodeHtml(instance[method].apply(instance, args || []));
    if (method === 'dataToCxplot' && /No cxplot spec available/.test(code)) return '';
    return code;
  } catch (e) {
    return '';
  }
}

/**
 * Build the files of a reproducible-science bundle from a LIVE dashboard handle
 * (from {@link renderDashboard}): the engine code-emitters it reuses read each
 * panel's rendered instance, so a bare spec is not enough.
 *
 * The bundle contains:
 *  - `spec.json` — the self-contained spec (every source inlined; see
 *    {@link inlineSpecData}), so the dashboard re-renders offline;
 *  - `data/<ref>.json` — a snapshot of each source's resolved data;
 *  - `code/<panel>.R` and `code/<panel>.py` — per-panel regeneration code from
 *    the engine's `dataToR`/`dataToPython` (plus `code/<panel>-cxplot.R` for a
 *    ggplot/cxplot chart);
 *  - `methods.md` — a human methods note: the auto-derived method line per panel
 *    and the provenance of each data source.
 *
 * @param {object} handle - A live dashboard handle (`spec`, `panelInstances()`,
 *   `getParams()`).
 * @param {object} [opts] - Options (also passed to {@link inlineSpecData}).
 * @param {string} [opts.baseUrl] - Base URL for source resolution.
 * @param {function} [opts.fetch] - fetch implementation.
 * @param {string} [opts.engineVersion] - CanvasXpress engine version, recorded
 *   in methods.md when known (formal version/asOf stamping lands in P4).
 * @param {function} [opts.now] - Clock returning the capture time (ISO string
 *   or Date); defaults to the system clock. Injectable for deterministic tests.
 * @returns {Promise<Array<{name: string, content: string}>>} The bundle files.
 * @public
 */
export function buildBundleFiles(handle, opts) {
  opts = opts || {};
  if (!handle || !handle.spec) return Promise.reject(new Error('no dashboard handle to export'));
  var spec = handle.spec;
  var params = typeof handle.getParams === 'function' ? handle.getParams() : (opts.params || {});
  var instances = typeof handle.panelInstances === 'function' ? handle.panelInstances() : {};
  var asOf = toIso(typeof opts.now === 'function' ? opts.now() : new Date());

  return inlineSpecData(spec, { baseUrl: opts.baseUrl, fetch: opts.fetch, params: params }).then(function (inlined) {
    // P4: stamp each inlined source's provenance with the capture time and the
    // params the snapshot was taken at (author-set method/dataVersion kept).
    stampSourceProvenance(inlined, asOf, params);

    var files = [];
    files.push({ name: 'spec.json', content: JSON.stringify(inlined, null, 2) + '\n' });

    // Data snapshot per source (from the now-inlined spec).
    var sources = inlined.data || {};
    Object.keys(sources).forEach(function (ref) {
      var src = sources[ref];
      var value = src && src.kind === 'inline' ? src.value : src;
      files.push({ name: 'data/' + safeName(ref) + '.json', content: JSON.stringify(value, null, 2) + '\n' });
    });

    // Per-panel regeneration code from the live instances.
    Object.keys(instances).forEach(function (panelId) {
      var instance = instances[panelId];
      var rCode = emitCode(instance, 'dataToR');
      var pyCode = emitCode(instance, 'dataToPython');
      var cxplot = emitCode(instance, 'dataToCxplot');
      if (rCode) files.push({ name: 'code/' + safeName(panelId) + '.R', content: rCode + '\n' });
      if (pyCode) files.push({ name: 'code/' + safeName(panelId) + '.py', content: pyCode + '\n' });
      if (cxplot) files.push({ name: 'code/' + safeName(panelId) + '-cxplot.R', content: cxplot + '\n' });
    });

    // Read function-source code from the ORIGINAL spec (inlining bakes it to
    // data, dropping the snippet), so the bundle can regenerate it too.
    var originalSources = spec.data || {};
    Object.keys(originalSources).forEach(function (ref) {
      var src = originalSources[ref];
      if (src && src.kind === 'function' && src.code) {
        var ext = src.language === 'python' ? '.py' : (src.language === 'r' ? '.R' : '.txt');
        files.push({ name: 'code/source-' + safeName(ref) + ext, content: String(src.code) + '\n' });
      }
    });

    // P4: version/asOf/engine stamping + a content hash so a reviewer can tell
    // two figures apart. Per-file hashes cover the actual files. The overall
    // contentHash is a stable FIGURE FINGERPRINT over the reproducible inputs
    // (spec + data + code), excluding the timestamped methods.md / manifest.json
    // and the volatile `provenance` metadata (asOf/params) — so re-exporting the
    // same figure at a different time yields the same hash, while different data
    // or config yields a different one.
    var perFile = {};
    var sorted = files.slice().sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
    sorted.forEach(function (f) { perFile[f.name] = 'sha256:' + sha256Hex(f.content); });
    var hashInput = sorted.map(function (f) {
      return f.name + '\u0000' + (f.name === 'spec.json' ? fingerprintSpecJson(f.content) : f.content);
    }).join('\n');
    var contentHash = 'sha256:' + sha256Hex(hashInput);

    var manifest = {
      generated: asOf,
      schemaVersion: inlined.schemaVersion || null,
      engineVersion: opts.engineVersion || null,
      dashboard: { id: spec.id || null, title: spec.title || null, version: spec.version != null ? spec.version : null },
      params: params,
      contentHash: contentHash,
      files: perFile
    };

    files.push({ name: 'methods.md', content: buildMethodsMd(spec, instances, asOf, opts.engineVersion, contentHash) });
    files.push({ name: 'manifest.json', content: JSON.stringify(manifest, null, 2) + '\n' });
    return files;
  });
}

/**
 * Produce a provenance-free view of `spec.json` for the figure fingerprint:
 * drop each source's `provenance` (its `asOf`/`params` are volatile metadata, and
 * a param change already shows up as different data). Config, layout, panels and
 * panel provenance are kept, so two genuinely different figures still differ.
 * @param {string} specJson - The serialized inlined spec.
 * @returns {string} A canonical provenance-free JSON string.
 * @private
 */
function fingerprintSpecJson(specJson) {
  var clone = JSON.parse(specJson);
  var sources = clone.data || {};
  Object.keys(sources).forEach(function (ref) {
    if (sources[ref] && typeof sources[ref] === 'object') delete sources[ref].provenance;
  });
  return JSON.stringify(clone);
}

/**
 * Stamp each inlined source's `provenance.asOf` and `provenance.params` with the
 * export capture time and the params it was taken at, preserving any author-set
 * `method` / `dataVersion`. Mutates `inlined` in place.
 * @param {object} inlined - The data-inlined spec.
 * @param {string} asOf - Capture time (ISO).
 * @param {object} params - The params the snapshot was taken at.
 * @returns {void}
 * @private
 */
function stampSourceProvenance(inlined, asOf, params) {
  var sources = inlined.data || {};
  Object.keys(sources).forEach(function (ref) {
    var src = sources[ref];
    if (!src || typeof src !== 'object') return;
    var prov = src.provenance && typeof src.provenance === 'object' ? src.provenance : {};
    prov.asOf = asOf;
    prov.params = params;
    src.provenance = prov;
  });
}

/**
 * Build a reproducible-science bundle as a `.zip` byte array.
 * @param {object} handle - A live dashboard handle (see {@link buildBundleFiles}).
 * @param {object} [opts] - Options (see {@link buildBundleFiles}).
 * @returns {Promise<Uint8Array>} The `.zip` bytes.
 * @public
 */
export function buildReproducibleBundle(handle, opts) {
  return buildBundleFiles(handle, opts).then(function (files) { return zipSync(files); });
}

/**
 * Export a reproducible-science bundle as a `.zip` file (downloads it).
 * @param {object} handle - A live dashboard handle (see {@link buildBundleFiles}).
 * @param {object} [opts] - Options (see {@link buildBundleFiles}) plus `filename`.
 * @param {string} [opts.filename] - Download name; defaults to `<id>-bundle.zip`.
 * @param {Document} [doc] - Document to use; defaults to global.
 * @returns {Promise<void>} Resolves once the download has been triggered.
 * @public
 */
export function exportReproducibleBundle(handle, opts, doc) {
  opts = opts || {};
  return buildReproducibleBundle(handle, opts).then(function (bytes) {
    var id = handle && handle.spec && handle.spec.id ? handle.spec.id : 'dashboard';
    var name = opts.filename || (id + '-bundle.zip');
    downloadBlob(new Blob([bytes], { type: 'application/zip' }), name, doc);
  });
}

/**
 * Normalize a time value to an ISO 8601 string.
 * @param {(Date|string|number)} t - The time.
 * @returns {string} ISO string.
 * @private
 */
function toIso(t) {
  if (t instanceof Date) return t.toISOString();
  if (typeof t === 'number') return new Date(t).toISOString();
  return String(t);
}

/**
 * Build the `methods.md` text: a per-panel method line (auto-derived) and the
 * provenance of each data source.
 * @param {object} spec - The dashboard spec.
 * @param {object} instances - panelId -> live instance (which panels have code).
 * @param {string} asOf - Capture time (ISO).
 * @param {string} [engineVersion] - Engine version, when known.
 * @param {string} [contentHash] - The bundle's content hash (P4), when computed.
 * @returns {string} The Markdown document.
 * @private
 */
function buildMethodsMd(spec, instances, asOf, engineVersion, contentHash) {
  var title = spec.title || spec.id || 'Dashboard';
  var lines = [];
  lines.push('# ' + title + ' — reproducible bundle');
  lines.push('');
  lines.push('Generated ' + asOf + ' with CanvasXpress Dashboards' +
    (engineVersion ? ' (engine ' + engineVersion + ')' : '') + '.');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push('| Dashboard | ' + title + (spec.id ? ' (`' + spec.id + '`)' : '') + ' |');
  if (spec.version != null) lines.push('| Version | ' + spec.version + ' |');
  lines.push('| Captured | ' + asOf + ' |');
  if (engineVersion) lines.push('| Engine | ' + engineVersion + ' |');
  if (contentHash) lines.push('| Content hash | `' + contentHash + '` |');
  lines.push('');
  lines.push('This bundle reproduces the figures offline:');
  lines.push('');
  lines.push('- `spec.json` — the self-contained dashboard spec (all data inlined).');
  lines.push('- `data/` — a snapshot of each data source.');
  lines.push('- `code/` — per-panel R and Python code that regenerates each chart.');
  lines.push('');

  var panels = spec.panels || {};
  var panelIds = Object.keys(panels).filter(function (id) {
    var p = panels[id];
    return !p || !p.type;   // graph panels only (text/control/image/filters have no type===undefined)
  });
  if (panelIds.length) {
    lines.push('## Panels');
    lines.push('');
    panelIds.forEach(function (id) {
      var panel = panels[id];
      lines.push('### ' + (panel.title || id) + ' (`' + id + '`)');
      var method = panelProvenanceText(spec, id);
      lines.push('');
      lines.push(method || '_No method information._');
      lines.push('');
      var bits = [];
      if (panel.dataRef) bits.push('Data source: `' + panel.dataRef + '`.');
      if (instances[id]) bits.push('Regenerate: `code/' + safeName(id) + '.R`, `code/' + safeName(id) + '.py`.');
      if (bits.length) { lines.push(bits.join(' ')); lines.push(''); }
    });
  }

  var sources = spec.data || {};
  var refs = Object.keys(sources);
  if (refs.length) {
    lines.push('## Data sources');
    lines.push('');
    refs.forEach(function (ref) {
      var src = sources[ref];
      lines.push('### `' + ref + '` (' + (src.kind || 'inline') + ')');
      lines.push('');
      var line = describeSource(ref, spec) || '_No provenance._';
      var prov = src.provenance || {};
      var meta = [];
      if (prov.dataVersion) meta.push('version ' + prov.dataVersion);
      if (prov.asOf) meta.push('as of ' + prov.asOf);
      lines.push(line + (meta.length ? ' (' + meta.join('; ') + ')' : ''));
      lines.push('');
    });
  }

  return lines.join('\n');
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
    useCORS: true,
    // Skip CanvasXpress's screen-reader-only nodes (the "Data table for chart"
    // a11y table + the live region): they hide with clip:rect(0 0 0 0), which
    // html2canvas ignores, so they would otherwise paint over the chart.
    ignoreElements: opts.ignoreElements || isScreenReaderOnly
  }).then(function (canvas) { return canvas.toDataURL('image/png'); });
}

/**
 * Whether an element is a CanvasXpress screen-reader-only node that must not be
 * rasterized (the a11y data table `#…-cX-a11y-table` or the live region
 * `.cX-a11y-live`). These are visually hidden with `clip:rect(0 0 0 0)`, which
 * html2canvas does not honour.
 * @param {Element} el - A candidate element.
 * @returns {boolean} True to skip it during rasterization.
 * @private
 */
function isScreenReaderOnly(el) {
  if (!el || el.nodeType !== 1) return false;
  if (typeof el.id === 'string' && /-cX-a11y-table$/.test(el.id)) return true;
  var cls = el.getAttribute ? (el.getAttribute('class') || '') : '';
  return /(^|\s)cX-a11y-live(\s|$)/.test(cls);
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

/* ------------------------------------------------------------------------- *
 * Per-panel TRUE VECTOR export (figure composer P1).
 *
 * Unlike the whole-container raster path above (html2canvas/jsPDF), these read
 * a single live panel's CanvasXpress instance and emit the engine's own vector
 * output: `getSVGString()` (a complete, standalone `<svg>` document with the
 * chart's a11y description) and `getPDFBytes()` (a vector PDF Blob). Both are
 * public engine methods preserved through `--secure` obfuscation, so they work
 * against the production (minified) engine, not only the debug build.
 *
 * P4 composes the per-panel SVG strings these return into one multi-panel
 * figure; P1 exposes the single-panel seam and its download helpers.
 * ------------------------------------------------------------------------- */

/**
 * Resolve one live panel instance from a dashboard handle, by panel id.
 * @param {object} handle - A live dashboard handle (needs `panelInstances()`).
 * @param {string} panelId - The panel's id in the spec.
 * @returns {object} The live CanvasXpress instance for that panel.
 * @throws {Error} When the handle has no such rendered graph panel.
 * @private
 */
function resolvePanelInstance(handle, panelId) {
  var instances = handle && typeof handle.panelInstances === 'function'
    ? handle.panelInstances() : null;
  var instance = instances && Object.prototype.hasOwnProperty.call(instances, panelId)
    ? instances[panelId] : null;
  if (!instance) {
    throw new Error('no rendered graph panel "' + panelId + '" to export');
  }
  return instance;
}

/**
 * Serialize one dashboard panel to a true-vector SVG string via the engine's
 * `getSVGString()` (the whole chart as a standalone `<svg>` document, including
 * its author a11y description) — NOT an html2canvas raster.
 * @param {object} handle - A live dashboard handle (from renderDashboard).
 * @param {string} panelId - The panel to export.
 * @returns {string} The SVG document.
 * @throws {Error} When the panel is missing or the engine lacks getSVGString
 *   (a pre-71.3 or externally-renamed engine).
 * @public
 */
export function panelToSvg(handle, panelId) {
  var instance = resolvePanelInstance(handle, panelId);
  if (typeof instance.getSVGString !== 'function') {
    throw new Error('this CanvasXpress engine has no getSVGString() ' +
      '(needs engine >= 71.3 with the method preserved through obfuscation)');
  }
  return instance.getSVGString();
}

/**
 * Export one dashboard panel as a `.svg` file (downloads it), true vector.
 * @param {object} handle - A live dashboard handle (from renderDashboard).
 * @param {string} panelId - The panel to export.
 * @param {object} [opts] - Options.
 * @param {string} [opts.filename] - Download name; defaults to `<panelId>.svg`.
 * @param {Document} [doc] - Document to use; defaults to global.
 * @returns {void}
 * @public
 */
export function exportPanelSvg(handle, panelId, opts, doc) {
  opts = opts || {};
  var svg = panelToSvg(handle, panelId);
  var blob = new Blob([svg], { type: 'image/svg+xml' });
  downloadBlob(blob, opts.filename || safeName(panelId) + '.svg', doc);
}

/**
 * Serialize one dashboard panel to a true-vector PDF Blob via the engine's
 * `getPDFBytes()` — NOT an html2canvas raster.
 * @param {object} handle - A live dashboard handle (from renderDashboard).
 * @param {string} panelId - The panel to export.
 * @returns {Promise<Blob>} The vector PDF.
 * @throws {Error} When the panel is missing or the engine lacks getPDFBytes.
 * @public
 */
export function panelToPdf(handle, panelId) {
  var instance = resolvePanelInstance(handle, panelId);
  if (typeof instance.getPDFBytes !== 'function') {
    return Promise.reject(new Error('this CanvasXpress engine has no getPDFBytes()'));
  }
  return Promise.resolve(instance.getPDFBytes());
}

/**
 * Export one dashboard panel as a `.pdf` file (downloads it), true vector.
 * @param {object} handle - A live dashboard handle (from renderDashboard).
 * @param {string} panelId - The panel to export.
 * @param {object} [opts] - Options.
 * @param {string} [opts.filename] - Download name; defaults to `<panelId>.pdf`.
 * @param {Document} [doc] - Document to use; defaults to global.
 * @returns {Promise<void>} Resolves once the download has been triggered.
 * @public
 */
export function exportPanelPdf(handle, panelId, opts, doc) {
  opts = opts || {};
  return panelToPdf(handle, panelId).then(function (bytes) {
    var blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'application/pdf' });
    downloadBlob(blob, opts.filename || safeName(panelId) + '.pdf', doc);
  });
}
