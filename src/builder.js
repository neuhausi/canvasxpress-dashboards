/**
 * No-code dashboard builder (Phase 4). The builder handles the things that are
 * the *dashboard's* concern — layout (drag to move, corner to resize), adding /
 * deleting panels, assigning a data source, and Save — and delegates all *graph*
 * editing to CanvasXpress's own **customizer**: each
 * panel renders live, and a ⚙ icon on its title bar opens the native customizer
 * (`instance.showCustomizer`). Edits are read back with `instance.getConfig()`
 * and persisted into `panel.config`, so the builder stays a pure spec editor.
 *
 * Vanilla + zero-dependency: no framework, no drag-grid library.
 *
 * @module builder
 */

import { injectStyles } from './styles.js';
import { renderDashboard, resizeInstance, sanitizeHtml, annotationNames } from './renderDashboard.js';
import { validateSpec } from './validateSpec.js';
import { gridTemplate, cellArea } from './gridLayout.js';
import { addPanel, removePanel, movePanel, resizePanel, resolveCollisions, resolveDrop, updatePanel, setDataSource, setParam, setSourceQuery, blankSpec, DEFAULT_COLS }
  from './builderModel.js';

// MS-Word-style colour-control icons (the coloured bar is rendered separately).
var FONT_COLOR_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
  '<path fill="currentColor" d="M11 3L5.5 17h2.25l1.12-3h6.25l1.12 3h2.25L13 3h-2zm-1.38 9L12 5.67 14.38 12H9.62z"/></svg>';
var HIGHLIGHT_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
  '<path fill="currentColor" d="M17.75 7L14 3.25l-10 10V17h3.75l10-10zm2.96-2.96c.39-.39.39-1.02 0-1.41L18.37.29a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
var CHEVRON_UP = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">' +
  '<path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var CHEVRON_DOWN = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">' +
  '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Parse CSV text into a CanvasXpress data object, mirroring the server reshape
 * (and `canvasxpress-connectors`): the first column becomes sample ids
 * (`y.smps`); a column whose non-blank cells are all numeric becomes a variable
 * (`y.vars` + `y.data`), with any missing cells emitted as `null` (CanvasXpress
 * renders those as gaps); every other column becomes a string annotation (`x`).
 *
 * @param {string} text - Raw CSV text (comma-separated; quotes supported).
 * @returns {object} A CanvasXpress data object `{ y: { vars, smps, data }, x? }`.
 * @throws {Error} If the CSV has no header or no data rows.
 */
export function csvToCx(text) {
  var rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV is empty');
  var header = rows[0];
  var bodyRows = rows.slice(1).filter(function (r) { return r.some(function (c) { return c !== ''; }); });
  if (!bodyRows.length) throw new Error('CSV has no data rows');

  var ncols = header.length;
  // A column is a numeric measure when every non-blank cell is numeric and at
  // least one is; blanks are missing values (emitted as null below). A single
  // non-blank non-numeric value makes it a string annotation instead.
  var numeric = [];
  for (var c = 0; c < ncols; c++) {
    numeric[c] = isMeasureColumn(bodyRows, c);
  }

  var smps = bodyRows.map(function (r) { return String(r[0]); });
  var vars = [];
  var data = [];
  var x = {};
  for (var col = 1; col < ncols; col++) {
    if (numeric[col]) {
      vars.push(header[col]);
      data.push(bodyRows.map(function (r) {
        return isBlank(r[col]) ? null : parseFloat(r[col]);
      }));
    } else {
      x[header[col]] = bodyRows.map(function (r) { return r[col]; });
    }
  }
  var out = { y: { vars: vars, smps: smps, data: data } };
  if (Object.keys(x).length) out.x = x;
  return out;
}

/**
 * Whether a body column is a numeric measure: every non-blank cell numeric and
 * at least one numeric value present.
 * @param {Array<Array<string>>} bodyRows - Parsed CSV data rows.
 * @param {number} col - Column index.
 * @returns {boolean} True if the column should be a numeric variable.
 */
function isMeasureColumn(bodyRows, col) {
  var sawNumber = false;
  for (var i = 0; i < bodyRows.length; i++) {
    var cell = bodyRows[i][col];
    if (isBlank(cell)) continue;
    if (isNumeric(cell)) { sawNumber = true; } else { return false; }
  }
  return sawNumber;
}

/**
 * Build a dashboard data-source object from raw dialog input.
 * @param {('json'|'csv'|'connector')} kind - Input mode.
 * @param {string} text - JSON/CSV text, or a URL for connector.
 * @returns {object} A data source spec (`{kind:'inline', value}` or `{kind:'connector', url}`).
 * @throws {Error} If the input can't be parsed / is empty.
 */
export function buildDataSource(kind, text) {
  if (kind === 'connector') {
    var url = (text || '').trim();
    if (!url) throw new Error('Connector URL is required');
    return { kind: 'connector', url: url };
  }
  if (kind === 'csv') return { kind: 'inline', value: csvToCx(text) };
  var value;
  try { value = JSON.parse(text); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
  return { kind: 'inline', value: value };
}

/**
 * Minimal CSV parser supporting quoted fields and escaped quotes.
 * @param {string} text - CSV text.
 * @returns {string[][]} Rows of string cells.
 * @private
 */
function parseCsv(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (var i = 0; i < src.length; i++) {
    var ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.length > 1 || (r.length === 1 && r[0] !== ''); });
}

/**
 * Whether a CSV cell holds a finite number.
 * @param {string} value - Cell text.
 * @returns {boolean} True when numeric.
 * @private
 */
function isNumeric(value) {
  if (value == null) return false;
  var trimmed = String(value).trim();
  if (trimmed === '') return false;
  return !isNaN(Number(trimmed)) && isFinite(Number(trimmed));
}

/**
 * Whether a cell is a missing value (null/undefined or empty/whitespace text).
 * @param {*} value - Cell value.
 * @returns {boolean} True when the cell is blank.
 */
function isBlank(value) {
  return value == null || String(value).trim() === '';
}

/**
 * Convert a pointer position to a grid cell coordinate.
 * @param {number} clientX - Pointer X (viewport).
 * @param {number} clientY - Pointer Y (viewport).
 * @param {{left:number, top:number, width:number}} gridRect - Grid bounding box.
 * @param {number} cols - Column count.
 * @param {number} rowHeight - Row height in px.
 * @param {number} gap - Grid gap in px.
 * @returns {{x:number, y:number}} Zero-based column/row.
 */
export function pointerToCell(clientX, clientY, gridRect, cols, rowHeight, gap) {
  var colWidth = (gridRect.width + gap) / cols;
  var x = Math.floor((clientX - gridRect.left) / Math.max(1, colWidth));
  var y = Math.floor((clientY - gridRect.top) / Math.max(1, rowHeight + gap));
  return { x: clampCol(x, cols), y: Math.max(0, y) };
}

/**
 * Create a builder bound to a container.
 * @param {(HTMLElement|string)} target - Container element or id.
 * @param {object} [options] - Builder options.
 * @param {object} [options.spec] - Initial spec (a blank one is created if omitted).
 * @param {object} [options.client] - A dashboards persistence client (for Save/Share).
 * @param {string} [options.baseUrl] - cxd_server origin used to resolve
 *   `kind:"dataset"` panel sources (defaults to same-origin `/api/datasets`).
 * @param {*} [options.CanvasXpress] - CanvasXpress constructor; defaults to global.
 * @param {function} [options.onChange] - Called with the new spec after every edit.
 * @returns {BuilderHandle} A handle to drive/read the builder.
 */
export function createBuilder(target, options) {
  options = options || {};
  var container = typeof target === 'string' ? document.getElementById(target) : target;
  if (!container) throw new Error('Builder target element not found.');
  injectStyles(container.ownerDocument || document);

  var spec = options.spec || blankSpec('dashboard-1', 'New Dashboard');
  var client = options.client || null;
  // Whether the toolbar shows the "+ Data" (add data source) button. Apps that
  // manage datasets elsewhere (e.g. a dedicated Data page) can hide it and bind
  // panels via the per-panel Data dropdown instead.
  var showAddData = options.showAddData !== false;
  // When true, the per-panel Data dropdown offers only datasets the spec
  // already declares as sources (spec.data), instead of every stored dataset —
  // lets a host UI (e.g. a dataset checklist) own which datasets are in play.
  var limitDatasetsToSpec = !!options.limitDatasetsToSpec;
  var addPanelBtn = null;   // disabled while no data source is declared (see updateAddPanelState)
  var addControlBtn = null; // disabled until the dashboard has data AND a graph panel
  var baseUrl = options.baseUrl || '';   // cxd_server origin for kind:"dataset" sources
  var CX = options.CanvasXpress || (typeof globalThis !== 'undefined' ? globalThis.CanvasXpress : undefined);
  var selectedId = null;
  var liveHandle = null;    // the current renderDashboard handle (live instances)
  var lastRender = Promise.resolve();
  var gridEl = null;        // the live grid element (stable during a drag)
  var cellEls = {};         // panelId -> panel cell element
  var instByPanel = {};     // panelId -> CanvasXpress instance
  var baselineConfigs = {}; // panelId -> {configKey: JSON} snapshot at render (diff-based save capture)
  var availableDatasets = []; // stored datasets (client.listDatasets) for quick-bind
  var availableConnectors = []; // connector sources ({name, url}) from options.listConnectorSources
  var liveRefs = {};        // data-source names the current liveHandle was built with
  var savedTextRange = null; // last selection inside a text editor (for format buttons)

  /** The CanvasXpress web-safe font families (default: Arial). */
  var CX_FONTS = ['American Typewriter', 'Andale Mono', 'Arial', 'Bradley Hand',
    'Comic Sans MS', 'Courier', 'Monaco', 'Optima', 'Times New Roman', 'Trebuchet MS'];

  container.innerHTML = '';
  var root = el('div', 'cxb');
  container.appendChild(root);

  // The toolbar host is either an app-shell element passed in (so a view's
  // actions land in the app's toolbar) or one we create above the stage.
  var externalToolbar = options.toolbar
    ? (typeof options.toolbar === 'string' ? document.getElementById(options.toolbar) : options.toolbar)
    : null;
  var toolbarHost = externalToolbar || el('div');
  if (!externalToolbar) root.appendChild(toolbarHost);

  var titleInput = el('input');
  titleInput.type = 'text';
  titleInput.className = 'cxb-title-input';
  titleInput.value = spec.title || spec.id;
  titleInput.setAttribute('aria-label', 'Dashboard title');
  on(titleInput, 'input', function () { commit(updateTitle(spec, titleInput.value), false); });

  // The selected-panel properties render into this toolbar group (they used to
  // live in a left panel; per the app-shell model, a view's actions sit in the
  // toolbar). Graph styling stays in the per-panel ⚙ customizer.
  var propsGroup = el('div', 'cxb-tgroup cxb-props');

  /**
   * Fill the toolbar host with the builder's action groups. The builder owns the
   * *authoring* actions (add panel/data, panel properties, save); dashboard-level
   * actions (share/export/import) are left to the host app.
   * @returns {void}
   */
  function buildToolbar() {
    toolbarHost.innerHTML = '';
    toolbarHost.classList.add('cxb-topbar');
    // Row 1: "create" actions (dashboard title + add panel/text/control/data)
    // and Save, always on one line.
    var row1 = el('div', 'cxb-trow');
    addPanelBtn = button('+ Panel', function () { doAddPanel(); });
    addControlBtn = button('+ Control', function () { doAddControl(); });
    var editJsonBtn = button('✎', function () { doEditJson(); });
    editJsonBtn.setAttribute('title', 'Edit dashboard JSON');
    editJsonBtn.setAttribute('aria-label', 'Edit dashboard JSON');
    var createActions = [titleInput, editJsonBtn, addPanelBtn,
      button('+ Text', function () { doAddText(); }),
      addControlBtn];
    if (showAddData) createActions.push(button('+ Data', function () { doAddDataSource(); }));
    createActions.push(button('Save', function () { doSave(); }, 'cxb-btn-primary'));
    append(row1, createActions);
    // Row 2: the selected element's configuration. The row is ALWAYS present
    // (min-height reserved in CSS), so selecting or adding an element never
    // changes the toolbar height — the stage doesn't jump.
    append(toolbarHost, [row1, propsGroup]);
  }
  buildToolbar();
  updateAddPanelState();

  // The stage comes FIRST so the dashboard starts at the same offset as the
  // viewer pages; the status message line sits below it.
  var stage = el('div', 'cxb-stage');
  root.appendChild(stage);

  var msg = el('div', 'cxb-msg');
  root.appendChild(msg);
  // Clicking empty space (not a panel) stops the edit state — deselects the
  // current panel and clears its properties from the toolbar.
  on(stage, 'click', function (ev) {
    if (ev.target && ev.target.closest && !ev.target.closest('.cxb-cell')) deselect();
  });
  // Track the selection inside text editors so the format toolbar (which blurs
  // the editor when clicked) can restore it before applying a command.
  if (typeof document !== 'undefined' && document.addEventListener && typeof window !== 'undefined') {
    document.addEventListener('selectionchange', function () {
      var sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return;
      var node = sel.anchorNode;
      var elm = node && (node.nodeType === 1 ? node : node.parentNode);
      if (elm && elm.closest && elm.closest('.cxb-editable')) savedTextRange = sel.getRangeAt(0);
    });
  }

  rebuild();
  loadDatasets();

  // ---------------------------------------------------------------- actions
  /**
   * Fetch the stored datasets (once) so the panel Data dropdown can offer them
   * for one-click binding. Refreshes the props panel if one is open. No-op when
   * the client can't list datasets (front-end-only / not signed in).
   * @returns {void}
   */
  function loadDatasets() {
    if (typeof options.listConnectorSources === 'function') {
      // Host-provided database/connector sources ({name, url}) — offered in
      // the Data dropdown alongside stored datasets.
      Promise.resolve(options.listConnectorSources()).then(function (list) {
        availableConnectors = list || [];
        if (selectedId) renderProps();
      }, function () { /* leave availableConnectors as-is on failure */ });
    }
    if (!client || typeof client.listDatasets !== 'function') return;
    client.listDatasets().then(function (list) {
      availableDatasets = list || [];
      if (selectedId) renderProps();
    }, function () { /* leave availableDatasets as-is on failure */ });
  }

  /**
   * Add a panel bound to the first data source, then re-render live.
   * @returns {void}
   */
  function doAddPanel() {
    var id = uniquePanelId(spec);
    var firstRef = Object.keys(spec.data || {})[0];
    commit(addPanel(spec, { id: id, title: 'Panel ' + id.replace(/\D/g, ''), dataRef: firstRef, w: 6, h: 12, config: { graphType: 'Bar' } }), false);
    selectedId = id;
    // Add incrementally so existing panels (and their live customizer state) are
    // never destroyed — a full re-render would reset them.
    if (liveHandle && liveHandle.addPanel && gridEl) {
      lastRender = liveHandle.addPanel(itemFor(id), spec.panels[id], spec.layout.items).then(function () { renderProps(); });
    } else {
      rebuild();
    }
  }

  /**
   * Add a text element and select it. Text elements carry free-form text instead
   * of a graph (edited in the panel properties).
   * @returns {void}
   */
  function doAddText() {
    var id = uniquePanelId(spec);
    commit(addPanel(spec, { id: id, type: 'text', text: 'Click to edit text…', w: 4, h: 1 }), false);
    selectedId = id;
    if (liveHandle && liveHandle.addPanel && gridEl) {
      lastRender = liveHandle.addPanel(itemFor(id), spec.panels[id], spec.layout.items).then(function () { renderProps(); });
    } else {
      rebuild();
    }
  }

  /**
   * Add an annotation-filter control and select it. The control binds ONE
   * annotation of one dataset; its properties (data / scope / annotation /
   * style) are edited in the toolbar props group. Like text elements it floats
   * free on the grid and may overlap any panel.
   * @returns {void}
   */
  function doAddControl() {
    var id = uniquePanelId(spec);
    var firstRef = Object.keys(spec.data || {})[0];
    commit(addPanel(spec, {
      id: id, type: 'control', title: 'Filter', dataRef: firstRef,
      compartment: 'x', annotation: '', style: 'auto', w: 4, h: 2
    }), false);
    selectedId = id;
    if (liveHandle && liveHandle.addPanel && gridEl) {
      lastRender = liveHandle.addPanel(itemFor(id), spec.panels[id], spec.layout.items).then(function () { renderProps(); });
    } else {
      rebuild();
    }
  }

  /**
   * Open the "Add data source" dialog and register the chosen source. Adding a
   * source doesn't touch existing panels, so no re-render is needed.
   * @returns {void}
   */
  function doAddDataSource() {
    var doc = container.ownerDocument || document;
    // Offer the "upload to a store" path only when a client can list stores, and
    // the "use an existing dataset" path when it can list datasets.
    var storesPromise = (client && typeof client.listStores === 'function')
      ? client.listStores('dataset').then(function (s) { return s; }, function () { return []; })
      : Promise.resolve([]);
    var datasetsPromise = (client && typeof client.listDatasets === 'function')
      ? client.listDatasets().then(function (d) { return d; }, function () { return []; })
      : Promise.resolve([]);
    Promise.all([storesPromise, datasetsPromise]).then(function (res) {
      openDataDialog(doc, Object.keys(spec.data || {}),
        { client: client, stores: res[0], datasets: res[1] }).then(function (result) {
        if (!result) return;
        commit(setDataSource(spec, result.name, result.source), false);
        renderProps();
        loadDatasets();   // a store upload may have created a new dataset
      });
    });
  }

  /**
   * Persist the current spec via the client.
   * @returns {void}
   */
  function doSave() {
    if (!client) return showError('No persistence client configured.');
    // The store keys dashboards by spec.id — re-derive it from the (possibly
    // renamed) title so "save under a new name" creates a NEW dashboard
    // instead of silently overwriting the last one. An unchanged name keeps
    // the id, so re-saving still updates in place.
    var slug = String(spec.title || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug && slug !== spec.id) {
      var next = Object.assign({}, spec, { id: slug });
      // A broadcastGroup that just mirrored the old id follows the rename, so
      // separately-saved dashboards don't share a coordination domain.
      if (spec.broadcastGroup === spec.id) next.broadcastGroup = slug;
      spec = next;
      if (options.onChange) { try { options.onChange(getSpec()); } catch (e) { /* noop */ } }
    }
    setMsg('Saving…');
    client.save(getSpec()).then(function () { setMsg('Saved “' + spec.id + '”.'); }, showError);
  }

  /**
   * Open a modal editor on the dashboard's raw spec JSON (the ✎ button next to
   * the title). Save first parses the JSON, then runs {@link validateSpec};
   * nothing is applied until both pass — errors show inline and the editor
   * stays open. A valid spec replaces the current one, re-renders the board,
   * and persists through the normal save path when a client is attached.
   * @returns {void}
   */
  function doEditJson() {
    var overlay = el('div', 'cxb-modal-overlay');
    var modal = el('div', 'cxb-modal cxb-modal-wide');
    var heading = el('h3', 'cxb-modal-title');
    heading.textContent = 'Edit dashboard JSON';
    // highlight.js-style editor: a line-number gutter and a colorized layer
    // sit UNDER a transparent-text textarea; the textarea owns editing/scroll
    // and the layers follow it. Self-contained (no external highlighter).
    var editor = el('div', 'cxb-jsoned');
    var gutter = el('div', 'cxb-jsoned-gutter');
    var hl = el('pre', 'cxb-jsoned-hl');
    var hlCode = el('code');
    hl.appendChild(hlCode);
    var area = el('textarea', 'cxb-jsoned-ta');
    area.value = JSON.stringify(getSpec(), null, 2);
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Dashboard spec JSON');
    var editorBody = el('div', 'cxb-jsoned-body');
    append(editorBody, [hl, area]);
    append(editor, [gutter, editorBody]);

    /**
     * Rebuild the colorized layer + line numbers from the textarea text.
     * Tokens follow highlight.js JSON classes: attr (key), string, number,
     * literal (true/false/null).
     * @returns {void}
     */
    function refreshHighlight() {
      var text = area.value;
      var esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      var html = esc.replace(
        /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
        function (m, str, colon, lit) {
          if (str) {
            return colon
              ? '<span class="cxb-hl-attr">' + str + '</span>' + colon
              : '<span class="cxb-hl-string">' + str + '</span>';
          }
          if (lit) return '<span class="cxb-hl-literal">' + lit + '</span>';
          return '<span class="cxb-hl-number">' + m + '</span>';
        });
      // A failed Save marks the offending line (errLine, 1-based): red-tinted
      // in the code layer and bold red in the gutter, cleared on the next edit.
      if (errLine > 0) {
        var lineParts = html.split('\n');
        if (errLine <= lineParts.length) {
          lineParts[errLine - 1] =
            '<span class="cxb-hl-errline">' + (lineParts[errLine - 1] || ' ') + '</span>';
        }
        html = lineParts.join('\n');
      }
      // Trailing newline needs a placeholder line so the layer keeps its height.
      hlCode.innerHTML = html + (/\n$/.test(text) ? ' ' : '');
      var lines = text.split('\n').length;
      var nums = [];
      for (var i = 1; i <= lines; i++) {
        nums.push(i === errLine ? '<span class="cxb-jsoned-gutter-err">' + i + '</span>' : i);
      }
      gutter.innerHTML = nums.join('\n');
    }
    function syncScroll() {
      hl.scrollTop = area.scrollTop;
      hl.scrollLeft = area.scrollLeft;
      gutter.scrollTop = area.scrollTop;
    }

    var errLine = 0;   // 1-based line to mark; 0 = none

    /**
     * Mark a line as the error location: tint it, flag its gutter number,
     * scroll it into view, and put the caret at its start.
     * @param {number} line - 1-based line number.
     * @returns {void}
     */
    function markErrorLine(line) {
      errLine = line;
      refreshHighlight();
      var lineHeight = 13 * 1.5;   // editor font metrics (see styles)
      area.scrollTop = Math.max(0, (line - 4) * lineHeight);
      var idx = 0, text = area.value;
      for (var i = 1; i < line; i++) {
        idx = text.indexOf('\n', idx) + 1;
        if (idx === 0) { idx = text.length; break; }
      }
      if (typeof area.setSelectionRange === 'function') area.setSelectionRange(idx, idx);
      if (typeof area.focus === 'function') area.focus();
      syncScroll();
    }

    /**
     * Best-effort line number for an error message: prefer an explicit
     * "(line N column M)", fall back to "position N" (counted into the text),
     * else look up the first quoted key/path segment the message names.
     * @param {string} msg - The error message.
     * @returns {number} 1-based line, or 0 when nothing locatable.
     */
    function errorLineFor(msg) {
      var m = /line (\d+) column \d+/.exec(msg);
      if (m) return +m[1];
      m = /position (\d+)/.exec(msg);
      if (m) return area.value.slice(0, +m[1]).split('\n').length;
      m = /"([^"]+)"/.exec(msg) || /spec\.(\w+)/.exec(msg);
      if (m) {
        var at = area.value.indexOf('"' + m[1].split('.').pop() + '"');
        if (at !== -1) return area.value.slice(0, at).split('\n').length;
      }
      return 0;
    }
    on(area, 'input', function () {
      if (errLine) errLine = 0;
      refreshHighlight();
    });
    on(area, 'scroll', syncScroll);
    // Tab inserts two spaces instead of leaving the editor.
    on(area, 'keydown', function (ev) {
      if (ev.key === 'Tab') {
        ev.preventDefault();
        var s = area.selectionStart, e2 = area.selectionEnd;
        area.value = area.value.slice(0, s) + '  ' + area.value.slice(e2);
        area.selectionStart = area.selectionEnd = s + 2;
        refreshHighlight();
      }
    });
    refreshHighlight();
    var errEl = el('div', 'cxb-modal-err');
    function fail(text) {
      errEl.textContent = '⚠ ' + text;
      var line = errorLineFor(text);
      if (line > 0) markErrorLine(line);
    }
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    var cancelBtn = button('Cancel', close);
    var saveBtn = button('Save', function () {
      var next;
      try {
        next = JSON.parse(area.value);
      } catch (e) {
        return fail('Invalid JSON: ' + (e && e.message || e));
      }
      var result = validateSpec(next);
      if (!result.valid) {
        return fail('Invalid spec: ' + result.errors.join(' · '));
      }
      close();
      setSpec(next);
      titleInput.value = next.title || next.id;
      if (client) doSave();
      else setMsg('Spec updated.');
    }, 'cxb-btn-primary');
    var footer = el('div', 'cxb-modal-footer');
    append(footer, [cancelBtn, saveBtn]);
    append(modal, [heading, editor, errEl, footer]);
    overlay.appendChild(modal);
    on(overlay, 'click', function (ev) { if (ev.target === overlay) close(); });
    (document.body || document.documentElement).appendChild(overlay);
    if (typeof area.focus === 'function') area.focus();
  }

  // ---------------------------------------------------------------- render
  /**
   * Rebuild the stage (live panels) and the editor drawer.
   * @returns {void}
   */
  function rebuild() {
    titleInput.value = spec.title || spec.id;
    renderStage();
    renderProps();
  }

  /**
   * Render the live panel grid — decorated with editing chrome in edit mode,
   * clean in preview mode.
   * @returns {void}
   */
  function renderStage() {
    teardownLive();
    stage.innerHTML = '';
    cellEls = {};
    instByPanel = {};
    gridEl = null;

    if (!(spec.layout.items || []).length) {
      // options.emptyHint: false hides the empty-state hint (the host shows its
      // own guidance), a string replaces it, undefined keeps the default.
      if (options.emptyHint !== false) {
        var hint = el('div', 'cxb-msg');
        hint.textContent = typeof options.emptyHint === 'string'
          ? options.emptyHint
          : 'Empty dashboard — click “+ Data” then “+ Panel” to begin.';
        stage.appendChild(hint);
      }
      lastRender = Promise.resolve();
      return;
    }

    var host = el('div');
    stage.appendChild(host);
    // WYSIWYG: the builder renders with EXACTLY the options the viewer pages
    // use (no editing-only canvasInset) so what you build is what a client
    // sees. Only a spec-level canvasInset (Settings) applies, as everywhere.
    var opts = { CanvasXpress: CX, validate: false, baseUrl: baseUrl, observeResize: false };
    opts.onPanelRendered = decorate;
    opts.onControlRendered = decorateControl;
    // Record the sources this render resolves against; the live handle closes
    // over this spec snapshot, so a later fast per-panel re-render can only bind
    // to these refs. Binding a source added afterwards needs a full rebuild.
    liveRefs = {};
    Object.keys(spec.data || {}).forEach(function (ref) { liveRefs[ref] = true; });
    lastRender = renderDashboard(rawSpec(), host, opts).then(function (handle) {
      liveHandle = handle;
      gridEl = host.querySelector('.cxd-grid');
      return handle.ready;
    }).catch(showError);
  }

  /**
   * Attach editing chrome to a dashboard-wide control (table/filter strip):
   * a delete icon and a bottom edge that drags to resize its height. The
   * chosen height persists as `control.height` in the spec.
   * @param {object} info - `{ control, index, cell, instance, state }`.
   * @returns {void}
   * @private
   */
  function decorateControl(info) {
    var cell = info.cell;
    cell.classList.add('cxb-cell');

    var chrome = el('div', 'cxb-chrome');
    var del = iconBtn('×', 'Delete', function (ev) {
      stop(ev);
      var next = rawSpec();
      next.controls.splice(info.index, 1);
      commit(next, false);
      rebuild();
    });
    on(del, 'pointerdown', stop);
    var tools = el('span', 'cxb-tools');
    append(tools, [del]);
    append(chrome, [tools]);
    cell.appendChild(chrome);

    // Bottom-edge height resize: live-drag the cell, persist on release.
    var handleEl = el('div', 'cxb-ctl-resize');
    handleEl.setAttribute('title', 'Drag to resize');
    on(handleEl, 'pointerdown', function (ev) {
      stop(ev);
      var startY = ev.clientY;
      var startH = cell.getBoundingClientRect().height;
      function move(e) {
        cell.style.height = Math.max(120, startH + (e.clientY - startY)) + 'px';
      }
      function up() {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        var next = rawSpec();
        if (next.controls && next.controls[info.index]) {
          next.controls[info.index].height = Math.round(cell.getBoundingClientRect().height);
          commit(next, false);
          rebuild();   // re-render so the canvas resizes to the new cell height
        }
      }
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
    cell.appendChild(handleEl);
  }

  /**
   * Attach editing chrome to a freshly-rendered live panel: drag-to-move on the
   * title, a ⚙ customize icon (opens the native CanvasXpress customizer), a
   * delete icon, and a corner resize handle.
   * @param {object} info - `{ panelId, item, cell, canvas, body, instance }`.
   * @returns {void}
   * @private
   */
  function decorate(info) {
    var cell = info.cell;
    var panelType = info.type ||
      (spec.panels[info.panelId] && spec.panels[info.panelId].type);
    var isText = panelType === 'text';
    var isControl = panelType === 'control';
    cell.classList.add('cxb-cell');
    if (info.panelId === selectedId) cell.classList.add('cxb-selected');
    cellEls[info.panelId] = cell;
    instByPanel[info.panelId] = info.instance;
    // Baseline for diff-based save capture: what getConfig() reports right
    // after render, per key as JSON. On save, only keys whose value CHANGED
    // since this snapshot (i.e. actual customizer edits) are persisted —
    // render-derived state present from the start never reaches the spec.
    if (info.instance && typeof info.instance.getConfig === 'function') {
      try {
        var snap = info.instance.getConfig() || {};
        var base = {};
        for (var bk in snap) {
          if (Object.prototype.hasOwnProperty.call(snap, bk)) {
            try { base[bk] = JSON.stringify(snap[bk]); } catch (e) { /* skip unserializable */ }
          }
        }
        baselineConfigs[info.panelId] = base;
      } catch (e) { /* no baseline: fall back to blocklist-only capture */ }
    }

    var cols = gridCols(spec);
    var rowHeight = (spec.layout && spec.layout.rowHeight) || 30;
    var gap = (spec.layout && spec.layout.gap != null) ? spec.layout.gap : 12;

    // Floating chrome (drag grip + tools), shown on hover/selection. It works
    // with or without a title bar — text elements and hidden-title panels have
    // no bar, so the chrome is what makes them movable/deletable.
    var chrome = el('div', 'cxb-chrome');
    var grip = el('span', 'cxb-grip');
    grip.textContent = '⠿';
    grip.setAttribute('title', 'Drag to move');
    on(grip, 'pointerdown', function (ev) { startDrag(ev, info.panelId, cols, rowHeight, gap); });
    on(grip, 'click', function (ev) { stop(ev); selectPanel(info.panelId); });
    var tools = el('span', 'cxb-tools');
    if (!isText && !isControl) {
      var gear = iconBtn('⚙', 'Customize graph', function (ev) {
        stop(ev);
        var inst = instByPanel[info.panelId];
        if (inst && typeof inst.showCustomizer === 'function') inst.showCustomizer(ev);
      });
      on(gear, 'pointerdown', stop);
      append(tools, [gear]);
    }
    var del = iconBtn('×', 'Delete', function (ev) { stop(ev); removePanelById(info.panelId); });
    on(del, 'pointerdown', stop);
    append(tools, [del]);
    append(chrome, [grip, tools]);
    cell.appendChild(chrome);

    // A title bar (when shown) is also a drag handle + click-to-select.
    var title = cell.querySelector('.cxd-panel-title');
    if (title) {
      on(title, 'pointerdown', function (ev) { startDrag(ev, info.panelId, cols, rowHeight, gap); });
      on(title, 'click', function () { selectPanel(info.panelId); });
    }

    var resize = el('div', 'cxb-resize');
    resize.setAttribute('title', 'Resize');
    on(resize, 'pointerdown', function (ev) { startResize(ev, info.panelId, cols, rowHeight, gap); });
    cell.appendChild(resize);

    // Text elements are edited inline (contenteditable + format toolbar);
    // graphs are data drop targets.
    if (isText) {
      var textEl = cell.querySelector('.cxd-text');
      if (textEl) setupTextEditing(textEl, info.panelId);
    } else if (isControl) {
      // Clicking the widget selects the control (its inputs keep working).
      on(cell, 'click', function () { if (selectedId !== info.panelId) selectPanel(info.panelId); });
    } else {
      setupPanelDrop(cell, info.panelId);
    }
  }

  /**
   * Make a text element editable in place: contenteditable + persist edits as
   * sanitized HTML; pasted content is sanitized too.
   * @param {HTMLElement} textEl - The `.cxd-text` element.
   * @param {string} panelId - The text panel id.
   * @returns {void}
   * @private
   */
  function setupTextEditing(textEl, panelId) {
    textEl.setAttribute('contenteditable', 'true');
    textEl.classList.add('cxb-editable');
    on(textEl, 'focus', function () { selectPanel(panelId); });
    on(textEl, 'click', function () { if (selectedId !== panelId) selectPanel(panelId); });
    // Remember the selection inside the editor so toolbar clicks (which blur it)
    // can restore it before applying a format command.
    on(textEl, 'keyup', saveTextSelection);
    on(textEl, 'mouseup', saveTextSelection);
    on(textEl, 'input', function () {
      saveTextSelection();
      // Persist without re-rendering (keeps the caret in place).
      commit(updatePanel(spec, panelId, { html: sanitizeHtml(textEl.innerHTML) }), false);
    });
    on(textEl, 'paste', function (ev) {
      ev.preventDefault();
      var cd = ev.clipboardData || (typeof window !== 'undefined' && window.clipboardData);
      var html = cd && (cd.getData('text/html') || '');
      var clean = html ? sanitizeHtml(html) : escapeTextHtml(cd ? cd.getData('text/plain') : '');
      if (document.execCommand) document.execCommand('insertHTML', false, clean);
    });
  }

  /** Save the current selection range if it's inside a text editor. @private */
  function saveTextSelection() {
    if (typeof window === 'undefined' || !window.getSelection) return;
    var sel = window.getSelection();
    if (sel && sel.rangeCount) savedTextRange = sel.getRangeAt(0);
  }

  /**
   * Build the text formatting toolbar (bold / italic / underline / colour /
   * size). Commands apply to the selected text element via execCommand.
   * @returns {HTMLElement} The toolbar.
   * @private
   */
  function buildTextFormatBar(panel) {
    var bar = el('span', 'cxb-fmt');
    function cmdBtn(label, cmd, styleCss) {
      var b = el('span', 'cxb-fmtbtn');
      b.textContent = label;
      if (styleCss) b.setAttribute('style', styleCss);
      b.setAttribute('title', cmd);
      // mousedown+preventDefault keeps the editor focused (selection intact).
      on(b, 'mousedown', function (ev) { ev.preventDefault(); execFormat(cmd); });
      return b;
    }
    // Text colour: the Word "A" icon over a bar showing the current colour.
    var color = colorControl(FONT_COLOR_ICON, 'Text colour', '#000000', function (value) {
      execFormat('foreColor', value);
    });

    // Grow / shrink font size (MS Word style): chevron up / down.
    var sizeUp = sizeBtn(CHEVRON_UP, +1, 'Increase font size');
    var sizeDown = sizeBtn(CHEVRON_DOWN, -1, 'Decrease font size');

    // Background (fill) for the whole text element — the Word highlighter icon;
    // defaults to the dashboard background so a new text element blends in.
    var bg = colorControl(HIGHLIGHT_ICON, 'Background colour', (panel && panel.bg) || dashboardColor(), function (value) {
      commit(updatePanel(spec, selectedId, { bg: value }), false);
      var cell = cellEls[selectedId];
      if (cell) { cell.classList.add('cxd-text-cell'); cell.style.background = value; }
    });

    var sup = cmdBtn('x²', 'superscript', 'font-size:15px');
    var sub = cmdBtn('x₂', 'subscript', 'font-size:15px');

    // Font family — the CanvasXpress web-safe set, applied to the selection.
    var fontSel = el('select', 'cxb-fmtfont');
    fontSel.setAttribute('title', 'Font family');
    CX_FONTS.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      o.style.fontFamily = f;
      fontSel.appendChild(o);
    });
    fontSel.value = 'Arial';
    on(fontSel, 'mousedown', function (ev) { ev.stopPropagation(); });
    on(fontSel, 'change', function () { execFormat('fontName', fontSel.value); });

    // Styles, grow/shrink size, super/subscript, font, then the colour controls.
    append(bar, [cmdBtn('B', 'bold', 'font-weight:700'), cmdBtn('I', 'italic', 'font-style:italic'),
      cmdBtn('U', 'underline', 'text-decoration:underline'),
      cmdBtn('S', 'strikeThrough', 'text-decoration:line-through'),
      sizeUp, sizeDown, sup, sub, fontSel, color, bg]);
    return bar;
  }

  /**
   * A font grow/shrink button. Steps the selection's HTML font size (1–7).
   * @param {string} iconSvg - Inline SVG chevron (trusted constant).
   * @param {number} delta - +1 to grow, -1 to shrink.
   * @param {string} title - Tooltip.
   * @returns {HTMLElement} The button.
   * @private
   */
  function sizeBtn(iconSvg, delta, title) {
    var b = el('span', 'cxb-fmtbtn cxb-fmtsizebtn');
    var a = el('span', 'cxb-fmtsizeA' + (delta < 0 ? ' cxb-fmtsizeA-small' : ''));
    a.textContent = 'A';
    var chev = el('span', 'cxb-fmtsizechev');
    chev.innerHTML = iconSvg;   // trusted constant SVG
    append(b, [a, chev]);
    b.setAttribute('title', title);
    on(b, 'mousedown', function (ev) { ev.preventDefault(); stepFontSize(delta); });
    return b;
  }

  /**
   * Grow/shrink the selected text's font size within the HTML 1–7 scale.
   * @param {number} delta - +1 or -1.
   * @returns {void}
   * @private
   */
  function stepFontSize(delta) {
    var cell = cellEls[selectedId];
    var textEl = cell && cell.querySelector('.cxd-text');
    if (!textEl || !document.execCommand) return;
    textEl.focus();
    if (savedTextRange && typeof window !== 'undefined' && window.getSelection) {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedTextRange);
    }
    // Step in pixels (x1.2 per click) with no legacy 1-7 ceiling: read the
    // selection's computed size, mark the selection via the legacy fontSize
    // command, then convert the generated <font size="7"> wrappers into
    // px-styled spans at the stepped size.
    var sel = typeof window !== 'undefined' && window.getSelection && window.getSelection();
    var node = sel && sel.anchorNode;
    var anchorEl = node && (node.nodeType === 1 ? node : node.parentNode);
    // When the selection wraps an element from outside (anchor = parent,
    // offset = child index — the shape our own re-selection produces), probe
    // the wrapped child, not the parent, or every step re-reads the base size.
    if (node && node.nodeType === 1 && sel.anchorOffset != null) {
      var wrapped = node.childNodes[sel.anchorOffset];
      if (wrapped && wrapped.nodeType === 1) anchorEl = wrapped;
    }
    var curPx = 16;
    if (anchorEl && anchorEl.ownerDocument && anchorEl.ownerDocument.defaultView) {
      curPx = parseFloat(anchorEl.ownerDocument.defaultView.getComputedStyle(anchorEl).fontSize) || 16;
    }
    var nextPx = Math.round(delta > 0 ? curPx * 1.2 : curPx / 1.2);
    nextPx = Math.max(8, Math.min(400, nextPx));
    document.execCommand('fontSize', false, '7');
    var wrappers = textEl.querySelectorAll('font[size="7"]');
    var spans = [];
    for (var i = 0; i < wrappers.length; i++) {
      var f = wrappers[i];
      var span = textEl.ownerDocument.createElement('span');
      span.style.fontSize = nextPx + 'px';
      while (f.firstChild) span.appendChild(f.firstChild);
      f.parentNode.replaceChild(span, f);
      spans.push(span);
    }
    // Re-select the converted spans — the old range pointed at the replaced
    // <font> nodes, and without this the next step would lose the selection.
    if (spans.length && sel) {
      var range = textEl.ownerDocument.createRange();
      range.setStartBefore(spans[0]);
      range.setEndAfter(spans[spans.length - 1]);
      sel.removeAllRanges();
      sel.addRange(range);
      savedTextRange = range;
    }
    saveTextSelection();
    commit(updatePanel(spec, selectedId, { html: sanitizeHtml(textEl.innerHTML) }), false);
  }

  /**
   * A labelled colour control: an icon glyph over a bar showing the current
   * colour, with the native colour picker overlaid transparently.
   * @param {string} iconSvg - Inline SVG icon markup (trusted constant).
   * @param {string} title - Tooltip.
   * @param {string} initial - Initial `#rrggbb` value.
   * @param {function(string): void} onColor - Called with the chosen colour.
   * @returns {HTMLElement} The control.
   * @private
   */
  function colorControl(iconSvg, title, initial, onColor) {
    var wrap = el('span', 'cxb-colorctl');
    wrap.setAttribute('title', title);
    var icon = el('span', 'cxb-colorctl-ic');
    icon.innerHTML = iconSvg;   // trusted constant SVG
    var barEl = el('span', 'cxb-colorctl-bar');
    barEl.style.background = initial;
    var input = el('input');
    input.type = 'color';
    input.className = 'cxb-colorctl-input';
    input.value = initial;
    on(input, 'change', function () { barEl.style.background = input.value; onColor(input.value); });
    append(wrap, [icon, barEl, input]);
    return wrap;
  }

  /**
   * The dashboard's background as a hex colour for a color input, or white.
   * @returns {string} A `#rrggbb` colour.
   * @private
   */
  function dashboardColor() {
    var b = spec.background;
    return (typeof b === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(b)) ? b : '#ffffff';
  }

  /**
   * Apply a formatting command to the selected text element, restoring the saved
   * selection first (a toolbar click may have blurred the editor).
   * @param {string} cmd - execCommand name.
   * @param {string} [value] - Command value.
   * @returns {void}
   * @private
   */
  function execFormat(cmd, value) {
    var cell = cellEls[selectedId];
    var textEl = cell && cell.querySelector('.cxd-text');
    if (!textEl || !document.execCommand) return;
    textEl.focus();
    if (savedTextRange && typeof window !== 'undefined' && window.getSelection) {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedTextRange);
    }
    document.execCommand(cmd, false, value == null ? undefined : value);
    saveTextSelection();
    commit(updatePanel(spec, selectedId, { html: sanitizeHtml(textEl.innerHTML) }), false);
  }

  /**
   * Make a panel cell a drop target: dropping a valid CanvasXpress file (CSV /
   * TSV / CanvasXpress JSON / PNG / …) loads it, stores it, and binds the panel
   * to it. No-op without a client (nowhere to persist).
   * @param {HTMLElement} cell - The panel cell element.
   * @param {string} panelId - The panel this cell belongs to.
   * @returns {void}
   * @private
   */
  function setupPanelDrop(cell, panelId) {
    if (!client || typeof client.uploadDataset !== 'function') return;
    function stopEv(ev) { ev.preventDefault(); ev.stopPropagation(); }
    // Capture phase so we intercept before CanvasXpress's own canvas drop.
    cell.addEventListener('dragenter', function (ev) { stopEv(ev); cell.classList.add('cxb-drop'); }, true);
    cell.addEventListener('dragover', function (ev) {
      stopEv(ev); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'; cell.classList.add('cxb-drop');
    }, true);
    cell.addEventListener('dragleave', function (ev) {
      stopEv(ev); if (!cell.contains(ev.relatedTarget)) cell.classList.remove('cxb-drop');
    }, true);
    cell.addEventListener('drop', function (ev) {
      stopEv(ev); cell.classList.remove('cxb-drop');
      var file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file) handlePanelDrop(panelId, ev, file);
    }, true);
  }

  /**
   * Read a dropped CanvasXpress JSON's own `config` (a CX export is
   * `{data, config}`). Non-JSON files resolve to null (their config, if any,
   * comes from the parsed instance instead).
   * @param {File} file - The dropped file.
   * @param {function(object|null): void} done - Receives the file's config or null.
   * @returns {void}
   * @private
   */
  function readFileConfig(file, done) {
    var name = (file.name || '').toLowerCase();
    var looksJson = /\.(json|cx)$/.test(name) || (file.type || '').indexOf('json') >= 0;
    if (!looksJson || typeof FileReader === 'undefined') { done(null); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var cfg = null;
      try {
        var obj = JSON.parse(reader.result);
        if (obj && obj.config && typeof obj.config === 'object') cfg = stripDerived(obj.config);
      } catch (e) { cfg = null; }
      done(cfg);
    };
    reader.onerror = function () { done(null); };
    reader.readAsText(file);
  }

  /**
   * Handle a file dropped on a panel: let CanvasXpress parse it (via the panel's
   * own instance), persist the loaded data to the store, and bind this panel to
   * the new dataset.
   * @param {string} panelId - The panel the file was dropped on.
   * @param {DataTransfer} dataTransfer - The drop's data transfer.
   * @param {File} file - The dropped file.
   * @returns {void}
   * @private
   */
  function handlePanelDrop(panelId, event, file) {
    var inst = instByPanel[panelId];
    if (!inst || typeof inst.loadFile !== 'function') return;
    var title = (file.name || 'dataset').replace(/\.[^.]+$/, '');
    setMsg('Loading “' + (file.name || 'file') + '” …');
    // Read the file's own config first (CanvasXpress JSON = {data, config}); a
    // File stays valid across this async read, so we pass it to loadFile below.
    readFileConfig(file, function (fileConfig) {
      // loadFile(event, isFlag, callback, providedFile, asTable): CanvasXpress
      // parses the file (via providedFile) and hands the new instance back.
      inst.loadFile(event, false, function (newInstance) {
        var data = newInstance && newInstance.data;
        if (!data || !data.y) { showError('That file isn’t a dataset CanvasXpress can load.'); return; }
        // Prefer the file's explicit config; else fall back to the parsed
        // instance's non-default config. Associated so panels bound to this
        // dataset adopt it as their initial state.
        var config = fileConfig;
        if (!config) {
          try {
            if (typeof newInstance.getConfig === 'function') config = stripDerived(newInstance.getConfig() || {});
          } catch (e) { config = null; }
        }
        var opts = { format: 'cx', title: title };
        if (config && Object.keys(config).length) opts.config = config;
        client.uploadDataset({ y: data.y, x: data.x }, opts).then(function (summary) {
          availableDatasets.push(summary);   // selectable immediately (carries config)
          selectedId = panelId;              // bind + select the dropped panel
          useDataset(summary);               // create/reuse source, adopt config, re-render
          loadDatasets();                    // refresh the cached dataset list
          setMsg('Loaded “' + (summary.title || summary.id) + '”.');
        }, showError);
      }, file, false);
    });
  }

  /**
   * Render the selected panel's properties inline in the toolbar (label, title,
   * data source, delete). Empty when nothing is selected. Graph styling lives in
   * the per-panel ⚙ customizer, not here.
   * @returns {void}
   */
  function renderProps() {
    if (!propsGroup) return;
    propsGroup.innerHTML = '';
    if (!selectedId || !spec.panels[selectedId]) return;
    var panel = spec.panels[selectedId];
    var refs = Object.keys(spec.data || {});

    var titleLabel = el('span', 'cxb-tlabel');
    titleLabel.textContent = 'Panel';

    var titleField = el('input');
    titleField.type = 'text';
    titleField.className = 'cxb-tinput';
    titleField.value = panel.title || '';
    titleField.setAttribute('title', 'Panel title');
    on(titleField, 'input', function () {
      commit(updatePanel(spec, selectedId, { title: titleField.value }), false);
      updateCellTitle(selectedId, titleField.value);
    });

    // Text elements: edit inline (contenteditable); the toolbar hosts the
    // formatting controls (bold/italic/underline, colour, size) plus the
    // cell alignment fields.
    if (panel.type === 'text') {
      var textLabel = el('span', 'cxb-tlabel');
      textLabel.textContent = 'Text';
      append(propsGroup, [textLabel, buildTextFormatBar(panel)].concat(alignmentFields(panel)));
      return;
    }

    // Annotation-filter controls: label + data source + scope (samples /
    // variables) + annotation + widget style. One annotation per control.
    if (panel.type === 'control') {
      renderControlProps(panel, refs, titleField);
      return;
    }

    var dataLabel = el('span', 'cxb-tlabel');
    dataLabel.textContent = 'Data';

    var dsField = buildDataSelect(panel, refs);
    dsField.setAttribute('title', 'Data source');

    // A checkbox to show/hide this panel's title bar.
    var titleToggle = el('label', 'cxb-check');
    var checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !panel.hideTitle;
    on(checkbox, 'change', function () {
      commit(updatePanel(spec, selectedId, { hideTitle: !checkbox.checked }), false);
      rerenderPanel(selectedId);   // adding/removing the title bar changes the DOM
    });
    var toggleText = el('span');
    toggleText.textContent = 'Title';
    titleToggle.appendChild(checkbox);
    titleToggle.appendChild(toggleText);

    // No Delete here — the panel frame already carries a × delete control.
    append(propsGroup, [titleLabel, titleField, dataLabel, dsField, titleToggle]);
  }


  /**
   * Toolbar properties for an annotation-filter control: Label (+ show/hide
   * checkbox), Data, Annotation (enumerated from the bound dataset's metadata,
   * sample and variable annotations together — the compartment is detected
   * from the chosen name), and widget Style. Committing annotation/style
   * re-renders just this control so the live widget follows immediately.
   * @param {object} panel - The selected control panel.
   * @param {string[]} refs - Current spec data-source names.
   * @param {HTMLInputElement} titleField - The shared title input (as Label).
   * @returns {void}
   * @private
   */
  function renderControlProps(panel, refs, titleField) {
    var labelTag = el('span', 'cxb-tlabel');
    labelTag.textContent = 'Filter';
    titleField.style.width = '90px';   // compact: the whole row fits one line
    // Keep the live widget's inline label in step while typing.
    on(titleField, 'input', function () {
      var cell = cellEls[selectedId];
      var lbl = cell && cell.querySelector('.cxd-annctl-label');
      if (lbl) lbl.textContent = titleField.value;
    });

    // Whether the widget shows its label in the dashboard.
    var labelToggle = el('label', 'cxb-check');
    var labelCheck = el('input');
    labelCheck.type = 'checkbox';
    labelCheck.checked = !panel.hideTitle;
    on(labelCheck, 'change', function () {
      commit(updatePanel(spec, selectedId, { hideTitle: !labelCheck.checked }), false);
      rerenderPanel(selectedId);
    });
    var labelToggleText = el('span');
    labelToggleText.textContent = 'Title';
    labelToggle.appendChild(labelCheck);
    labelToggle.appendChild(labelToggleText);
    labelToggle.setAttribute('title', 'Show the filter title in the dashboard');

    var dataLabel = el('span', 'cxb-tlabel');
    dataLabel.textContent = 'Data';
    var dsField = buildDataSelect(panel, refs);
    dsField.setAttribute('title', 'Data source');

    // Annotation names from BOTH compartments; choosing one detects whether it
    // is a sample ('x') or variable ('z') annotation — no Scope field needed.
    var COMP_OPT = ':';   // option value = compartment + ':' + name
    var annField = el('select');
    annField.setAttribute('title', 'Annotation');
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = panel.dataRef ? '(choose annotation)' : '(bind data first)';
    annField.appendChild(placeholder);
    var currentValue = (panel.compartment || 'x') + COMP_OPT + panel.annotation;
    if (panel.annotation) {
      // Show the current pick immediately; the resolved list replaces it below.
      var cur = document.createElement('option');
      cur.value = currentValue;
      cur.textContent = panel.annotation;
      annField.appendChild(cur);
      annField.value = currentValue;
    }
    var editingId = selectedId;
    function fillAnnotations(data) {
      if (selectedId !== editingId) return;   // selection moved on
      var xNames = annotationNames(data, 'x');
      var zNames = annotationNames(data, 'z');
      while (annField.options.length > 1) annField.remove(1);
      if (!xNames.length && !zNames.length) placeholder.textContent = '(no annotations)';
      function addNames(names, comp, host) {
        names.forEach(function (name) {
          var o = document.createElement('option');
          o.value = comp + COMP_OPT + name;
          o.textContent = name;
          host.appendChild(o);
        });
      }
      if (xNames.length && zNames.length) {
        // Both kinds present: group them so same-named annotations stay distinct.
        var gx = document.createElement('optgroup');
        gx.label = 'Samples';
        addNames(xNames, 'x', gx);
        annField.appendChild(gx);
        var gz = document.createElement('optgroup');
        gz.label = 'Variables';
        addNames(zNames, 'z', gz);
        annField.appendChild(gz);
      } else {
        addNames(xNames, 'x', annField);
        addNames(zNames, 'z', annField);
      }
      var have = xNames.indexOf(panel.annotation) >= 0 || zNames.indexOf(panel.annotation) >= 0;
      annField.value = have ? currentValue : '';
      if (annField.value !== currentValue && have) {
        // The stored compartment didn't match where the name actually lives —
        // select by detected compartment instead.
        annField.value = (xNames.indexOf(panel.annotation) >= 0 ? 'x' : 'z') + COMP_OPT + panel.annotation;
      }
    }
    if (panel.dataRef) {
      // Prefer the metadata a live panel bound to the same source already
      // holds — no refetch, and it works even when the source can't be
      // re-resolved right now. Fall back to resolving through the data store.
      var liveData = null;
      Object.keys(instByPanel).some(function (id) {
        var p = spec.panels[id];
        var inst = instByPanel[id];
        if (p && p.dataRef === panel.dataRef && inst && inst.data) { liveData = inst.data; return true; }
        return false;
      });
      if (liveData) {
        fillAnnotations(liveData);
      } else if (liveHandle && liveHandle.store) {
        liveHandle.store.resolve(panel.dataRef, (spec.data || {})[panel.dataRef]).then(fillAnnotations,
          function (err) {
            if (selectedId !== editingId) return;
            placeholder.textContent = '(data failed: ' + (err && err.message || err) + ')';
          });
      }
    }
    on(annField, 'change', function () {
      var v = annField.value;
      var sep = v.indexOf(COMP_OPT);
      var comp = sep > 0 ? v.slice(0, sep) : 'x';
      var name = sep > 0 ? v.slice(sep + 1) : '';
      commit(updatePanel(spec, selectedId, { compartment: comp, annotation: name }), false);
      rerenderPanel(selectedId);
    });

    var styleField = selectField(['auto', 'dropdown', 'radio', 'buttons'], panel.style || 'auto', function (value) {
      commit(updatePanel(spec, selectedId, { style: value }), false);
      rerenderPanel(selectedId);
    });
    styleField.setAttribute('title', 'Widget style');
    labelOptions(styleField, { auto: 'Auto', dropdown: 'Dropdown', radio: 'Radio', buttons: 'Buttons' });

    var annLabel = el('span', 'cxb-tlabel');
    annLabel.textContent = 'Annotation';
    var styleLabel = el('span', 'cxb-tlabel');
    styleLabel.textContent = 'Style';

    // Mode: filter the page (client-side, default) vs write a parameter that
    // re-queries a data source and refreshes the bound panels (live data).
    var mode = panel.mode === 'param' ? 'param' : 'filter';
    var modeLabel = el('span', 'cxb-tlabel');
    modeLabel.textContent = 'Action';
    var modeField = selectField(['filter', 'param'], mode, function (value) {
      commit(updatePanel(spec, selectedId, { mode: value }), false);
      renderProps();          // swap the field set for the chosen mode
      rerenderPanel(selectedId);
    });
    modeField.setAttribute('title', 'Filter this page, or query a data source');
    labelOptions(modeField, { filter: 'Filter page', param: 'Query source' });

    if (mode !== 'param') {
      // The show-title checkbox goes LAST, mirroring the Panel props row.
      append(propsGroup, [labelTag, titleField, modeLabel, modeField, dataLabel, dsField,
        annLabel, annField, styleLabel, styleField]
        .concat(alignmentFields(panel), [labelToggle]));
    } else {
      append(propsGroup, [labelTag, titleField, modeLabel, modeField]
        .concat(paramControlFields(panel, refs, styleField))
        .concat(alignmentFields(panel), [labelToggle]));
    }
  }

  /**
   * The extra property fields for a `mode:"param"` control: the parameter name,
   * the choice source (a static list or another dataset's values), and the
   * "applies to" wiring that writes `$param` into a target source's query.
   * @param {object} panel - The selected control panel.
   * @param {string[]} refs - Current spec data-source names.
   * @param {HTMLElement} styleField - The shared widget-style select.
   * @returns {HTMLElement[]} Fields to append to the props row.
   * @private
   */
  function paramControlFields(panel, refs, styleField) {
    var out = [];

    // Parameter name — declared in spec.params so a source query can read it.
    var paramLabel = el('span', 'cxb-tlabel');
    paramLabel.textContent = 'Param';
    var paramField = el('input');
    paramField.type = 'text';
    paramField.value = panel.param || '';
    paramField.setAttribute('placeholder', 'e.g. region');
    paramField.setAttribute('title', 'Parameter name (shared with the source query)');
    paramField.style.width = '90px';
    on(paramField, 'change', function () {
      var name = paramField.value.trim();
      var next = spec;
      if (name) next = setParam(next, name, (spec.params && spec.params[name]) || { value: null });
      next = updatePanel(next, selectedId, { param: name });
      commit(next, false);
      rerenderPanel(selectedId);
    });
    out.push(paramLabel, paramField);

    // Choices: a static list, or another dataset's distinct values.
    var usesFrom = panel.optionsFrom != null;
    var choiceLabel = el('span', 'cxb-tlabel');
    choiceLabel.textContent = 'Choices';
    var choiceField = selectField(['static', 'from'], usesFrom ? 'from' : 'static', function (value) {
      var next;
      if (value === 'from') next = updatePanel(spec, selectedId, { optionsFrom: { dataRef: refs[0] || '' } });
      else next = updatePanel(spec, selectedId, { options: [], optionsFrom: null });
      commit(next, false);
      renderProps();
      rerenderPanel(selectedId);
    });
    choiceField.setAttribute('title', 'Where the control gets its choices');
    labelOptions(choiceField, { static: 'Static list', from: 'From data' });
    out.push(choiceLabel, choiceField);

    if (!usesFrom) {
      var listField = el('input');
      listField.type = 'text';
      listField.value = (panel.options || []).join(', ');
      listField.setAttribute('placeholder', 'EMEA, APAC, AMER');
      listField.setAttribute('title', 'Comma-separated choices (an "All" entry is added automatically)');
      listField.style.width = '160px';
      on(listField, 'change', function () {
        var options = listField.value.split(',').map(function (s) { return s.trim(); })
          .filter(function (s) { return s.length; });
        commit(updatePanel(spec, selectedId, { options: options }), false);
        rerenderPanel(selectedId);
      });
      out.push(listField);
    } else {
      var from = panel.optionsFrom || {};
      var fromSrc = selectField(refs, from.dataRef || refs[0] || '', function (value) {
        commit(updatePanel(spec, selectedId, { optionsFrom: mergeInto(panel.optionsFrom, { dataRef: value }) }), false);
        rerenderPanel(selectedId);
      });
      fromSrc.setAttribute('title', 'Dataset supplying the choices');
      var fromAnn = el('input');
      fromAnn.type = 'text';
      fromAnn.value = from.annotation || '';
      fromAnn.setAttribute('placeholder', 'field');
      fromAnn.setAttribute('title', 'Annotation/field whose values become the choices');
      fromAnn.style.width = '90px';
      on(fromAnn, 'change', function () {
        commit(updatePanel(spec, selectedId, { optionsFrom: mergeInto(panel.optionsFrom, { annotation: fromAnn.value.trim() }) }), false);
        rerenderPanel(selectedId);
      });
      out.push(fromSrc, fromAnn);
    }

    // Applies to: which source gets `$param` written into which query field.
    var binding = findParamBinding(spec, panel.param);
    var appliesLabel = el('span', 'cxb-tlabel');
    appliesLabel.textContent = 'Query';
    var targetField = selectField([''].concat(refs), binding ? binding.ref : '', function (value) {
      rewireParamBinding(value, fieldField.value.trim());
    });
    targetField.setAttribute('title', 'Data source this control queries');
    labelOptions(targetField, { '': '(none)' });
    var fieldField = el('input');
    fieldField.type = 'text';
    fieldField.value = binding ? binding.field : '';
    fieldField.setAttribute('placeholder', 'field');
    fieldField.setAttribute('title', 'Backend query field the parameter fills');
    fieldField.style.width = '90px';
    on(fieldField, 'change', function () { rewireParamBinding(targetField.value, fieldField.value.trim()); });
    out.push(appliesLabel, targetField, fieldField);

    var styleLabel2 = el('span', 'cxb-tlabel');
    styleLabel2.textContent = 'Style';
    out.push(styleLabel2, styleField);
    return out;
  }

  /**
   * Rewire the "applies to" query binding for the selected param control: clear
   * any existing `$param` entries, then (when both target and field are given)
   * write the token into the chosen source's query.
   * @param {string} target - Target data-source ref (or '' to unbind).
   * @param {string} field - Backend query field name.
   * @returns {void}
   * @private
   */
  function rewireParamBinding(target, field) {
    var param = spec.panels[selectedId] && spec.panels[selectedId].param;
    if (!param) return;
    var next = clearParamBindings(spec, param);
    if (target && field) next = setSourceQuery(next, target, field, '$' + param);
    commit(next, false);
    rerenderPanel(selectedId);
  }

  /**
   * Find which data source consumes a parameter, and via which query field.
   * @param {object} spec - The dashboard spec.
   * @param {string} param - The parameter name.
   * @returns {?{ref: string, field: string}} The binding, or null if unbound.
   * @private
   */
  function findParamBinding(spec, param) {
    if (!param) return null;
    var token = '$' + param;
    var sources = spec.data || {};
    var found = null;
    Object.keys(sources).some(function (ref) {
      var query = sources[ref] && sources[ref].query;
      if (!query) return false;
      return Object.keys(query).some(function (field) {
        if (query[field] === token) { found = { ref: ref, field: field }; return true; }
        return false;
      });
    });
    return found;
  }

  /**
   * Remove every query entry (across all sources) that references `$param`.
   * @param {object} spec - The dashboard spec.
   * @param {string} param - The parameter name.
   * @returns {object} A new spec with those bindings cleared.
   * @private
   */
  function clearParamBindings(spec, param) {
    var token = '$' + param;
    var next = spec;
    var sources = spec.data || {};
    Object.keys(sources).forEach(function (ref) {
      var query = sources[ref] && sources[ref].query;
      if (!query) return;
      Object.keys(query).forEach(function (field) {
        if (query[field] === token) next = setSourceQuery(next, ref, field, null);
      });
    });
    return next;
  }

  /**
   * Shallow-merge patch keys onto a copy of an object (or a fresh one).
   * @param {?object} base - The object to extend (may be null).
   * @param {object} patch - Keys to set.
   * @returns {object} The merged object.
   * @private
   */
  function mergeInto(base, patch) {
    var out = {};
    if (base) for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (var p in patch) if (Object.prototype.hasOwnProperty.call(patch, p)) out[p] = patch[p];
    return out;
  }

  /**
   * The Align (left/center/right) + Baseline (top/middle/bottom) fields shared
   * by text and control props — they position the content within its grid
   * cell. Committing re-renders just the selected element.
   * @param {object} panel - The selected panel (reads `align`, `valign`).
   * @returns {HTMLElement[]} Label + select pairs to append to the props row.
   * @private
   */
  function alignmentFields(panel) {
    var alignLabel = el('span', 'cxb-tlabel');
    alignLabel.textContent = 'Align';
    var alignField = selectField(['left', 'center', 'right'], panel.align || 'left', function (value) {
      commit(updatePanel(spec, selectedId, { align: value }), false);
      rerenderPanel(selectedId);
    });
    alignField.setAttribute('title', 'Horizontal alignment in the cell');
    labelOptions(alignField, { left: 'Left', center: 'Center', right: 'Right' });

    var valignField = selectField(['top', 'middle', 'bottom'], panel.valign || 'top', function (value) {
      commit(updatePanel(spec, selectedId, { valign: value }), false);
      rerenderPanel(selectedId);
    });
    valignField.setAttribute('title', 'Vertical alignment (baseline) in the cell');
    labelOptions(valignField, { top: 'Top', middle: 'Middle', bottom: 'Bottom' });
    // One label for both axes keeps the control props row on a single line.
    return [alignLabel, alignField, valignField];
  }

  // Sentinel prefix marking a "use a stored dataset" option (vs a spec ref).
  var STORE_OPT = ' ds:';
  // Sentinel prefix marking a "use a database/connector source" option.
  var CONN_OPT = ' cx:';

  /**
   * Build the panel Data dropdown. Every dataset from the store is directly
   * usable (no "add" step): picking one binds the panel to it, transparently
   * reusing or creating the underlying spec source. Inline/connector sources the
   * dashboard already defines stay listed as their own options.
   * @param {object} panel - The selected panel.
   * @param {string[]} refs - Current spec data-source names.
   * @returns {HTMLSelectElement} The configured <select>.
   * @private
   */
  function buildDataSelect(panel, refs) {
    var doc = container.ownerDocument || document;
    var select = el('select');

    function addOption(value, label) {
      var o = doc.createElement('option');
      o.value = value;
      o.textContent = label;
      select.appendChild(o);
      return o;
    }

    addOption('', '(none)');

    // Non-dataset sources (inline JSON / connector) remain named options.
    refs.forEach(function (ref) {
      var src = (spec.data || {})[ref];
      if (!src || src.kind !== 'dataset') addOption(ref, ref);
    });

    // Every stored dataset, directly usable — unless the host UI owns the
    // dataset roster (limitDatasetsToSpec), in which case only datasets the
    // spec declares as sources are offered.
    var declared = null;
    if (limitDatasetsToSpec) {
      declared = {};
      refs.forEach(function (ref) {
        var src = (spec.data || {})[ref];
        if (src && src.kind === 'dataset' && src.id) declared[src.id] = true;
      });
    }
    availableDatasets.forEach(function (d, i) {
      if (declared && !declared[d.id]) return;
      addOption(STORE_OPT + i, (d.title || d.id) + (d.store ? '  (' + d.store + ')' : ''));
    });

    // Database/connector sources the host exposes (e.g. per-user
    // canvasxpress-connectors sources) — picking one binds the panel to a
    // live-querying connector source.
    availableConnectors.forEach(function (c, i) {
      addOption(CONN_OPT + i, '\u{1F5C4} ' + (c.title || c.name));
    });

    // Reflect the panel's current binding as the selected option.
    var current = '';
    var curSrc = panel.dataRef ? (spec.data || {})[panel.dataRef] : null;
    if (curSrc && curSrc.kind === 'dataset' && curSrc.id) {
      var idx = indexOfDataset(curSrc.id);
      if (idx >= 0) {
        current = STORE_OPT + idx;
      } else {
        addOption(panel.dataRef, curSrc.id);   // dataset not loaded yet
        current = panel.dataRef;
      }
    } else if (curSrc && curSrc.kind === 'connector') {
      var ci = -1;
      availableConnectors.forEach(function (c, i) { if (ci < 0 && c.url === curSrc.url) ci = i; });
      current = ci >= 0 ? CONN_OPT + ci : panel.dataRef;
      if (ci >= 0) {
        // Remove the duplicate plain-ref option (the connector row covers it).
        for (var oi = select.options.length - 1; oi >= 0; oi--) {
          if (select.options[oi].value === panel.dataRef) select.remove(oi);
        }
      }
    } else if (curSrc) {
      current = panel.dataRef;   // inline
    }
    select.value = current;

    on(select, 'change', function () {
      var v = select.value;
      if (v.indexOf(STORE_OPT) === 0) {
        var d = availableDatasets[parseInt(v.slice(STORE_OPT.length), 10)];
        if (d) useDataset(d); else renderProps();
        return;
      }
      if (v.indexOf(CONN_OPT) === 0) {
        var c = availableConnectors[parseInt(v.slice(CONN_OPT.length), 10)];
        if (c) useConnectorSource(c); else renderProps();
        return;
      }
      // Changing the source re-instantiates this panel's graph.
      commit(updatePanel(spec, selectedId, { dataRef: v || undefined }), false);
      rerenderPanel(selectedId);
    });
    return select;
  }

  /**
   * Index of a dataset by id in the loaded list, or -1.
   * @param {string} id - Dataset id.
   * @returns {number} Index or -1.
   * @private
   */
  function indexOfDataset(id) {
    for (var i = 0; i < availableDatasets.length; i++) {
      if (availableDatasets[i].id === id) return i;
    }
    return -1;
  }

  /**
   * Bind the selected panel to a stored dataset, reusing a source that already
   * points at it or creating one transparently.
   * @param {object} dataset - A dataset summary ({id, title, store}).
   * @returns {void}
   * @private
   */
  function useDataset(dataset) {
    var existing = spec.data || {};
    var name = null;
    Object.keys(existing).forEach(function (ref) {
      var srcx = existing[ref];
      if (!name && srcx && srcx.kind === 'dataset' && srcx.id === dataset.id) name = ref;
    });
    var next = spec;
    if (!name) {
      name = uniqueSourceName(dataset.id);
      var source = { kind: 'dataset', id: dataset.id };
      if (dataset.store) source.store = dataset.store;
      next = setDataSource(spec, name, source);
    }
    next = updatePanel(next, selectedId, { dataRef: name });
    // If the dataset carries an associated config, adopt it as the panel's
    // initial state (a deep copy so the shared dataset config isn't mutated).
    var adoptedConfig = dataset.config && Object.keys(dataset.config).length;
    if (adoptedConfig) {
      next = updatePanel(next, selectedId, { config: JSON.parse(JSON.stringify(dataset.config)) });
    }
    commit(next, false);
    // The rebuild path folds each live instance's config back into the spec
    // (syncLiveConfigs). Drop this panel's stale instance so that fold doesn't
    // clobber the config we just adopted from the dataset.
    if (adoptedConfig) delete instByPanel[selectedId];
    rerenderPanel(selectedId);
    renderProps();
  }

  /**
   * Bind the selected panel to a database/connector source, reusing a spec
   * source that already points at its URL or creating one transparently.
   * @param {object} connector - `{name, url}` from options.listConnectorSources.
   * @returns {void}
   * @private
   */
  function useConnectorSource(connector) {
    var existing = spec.data || {};
    var name = null;
    Object.keys(existing).forEach(function (ref) {
      var srcx = existing[ref];
      if (!name && srcx && srcx.kind === 'connector' && srcx.url === connector.url) name = ref;
    });
    var next = spec;
    if (!name) {
      name = uniqueSourceName(connector.name);
      next = setDataSource(spec, name, { kind: 'connector', url: connector.url });
    }
    next = updatePanel(next, selectedId, { dataRef: name });
    commit(next, false);
    rerenderPanel(selectedId);
    renderProps();
  }

  /**
   * A data-source name based on `base`, de-duplicated against existing sources.
   * @param {string} base - Preferred name (usually the dataset id).
   * @returns {string} A name not already present in spec.data.
   * @private
   */
  function uniqueSourceName(base) {
    var existing = spec.data || {};
    if (!existing[base]) return base;
    for (var n = 2; ; n++) {
      if (!existing[base + '-' + n]) return base + '-' + n;
    }
  }

  /**
   * Update a live cell's visible title without a rebuild.
   * @param {string} id - Panel id.
   * @param {string} value - New title text.
   * @returns {void}
   * @private
   */
  function updateCellTitle(id, value) {
    var cell = cellEls[id];
    var titleEl = cell && cell.querySelector('.cxd-panel-title');
    if (titleEl && titleEl.childNodes && titleEl.childNodes.length) titleEl.childNodes[0].textContent = value;
  }

  // ---------------------------------------------------------------- drag/resize
  /**
   * Begin a move drag on a panel title.
   * @param {object} ev - pointerdown event.
   * @param {string} panelId - Panel being moved.
   * @param {number} cols - Columns.
   * @param {number} rowHeight - Row height px.
   * @param {number} gap - Gap px.
   * @returns {void}
   * @private
   */
  function startDrag(ev, panelId, cols, rowHeight, gap) {
    stop(ev);
    selectPanel(panelId);
    var rect0 = gridEl && gridEl.getBoundingClientRect();
    var item0 = itemFor(panelId);
    if (!rect0 || !item0) return;
    // Preserve where within the panel (relative to its top-left cell) the drag
    // started — otherwise the panel snaps its top-left to the pointer, which is
    // jumpy when the drag handle sits away from the top-left (e.g. the grip that
    // floats above the panel).
    var start = rawCell(ev.clientX, ev.clientY, rect0, cols, rowHeight, gap);
    var offX = item0.x - start.x;
    var offY = item0.y - start.y;
    // Every frame resolves from the DRAG-START spec (spec0) plus the current
    // pointer cell — never from the incrementally mutated spec, where displaced
    // panels drift further on every move and the release resolution becomes
    // meaningless (the panel snaps back to where it came from).
    var spec0 = spec;
    var y0 = item0.y;
    var lastX = item0.x, lastY = item0.y;
    // While held, the cell floats above the board semi-transparent, so passing
    // over another panel reads as "in motion", not as a broken overlap.
    var dragCell = cellEls[panelId];
    if (dragCell) dragCell.classList.add('cxb-dragging');
    dragLoop(ev, function (moveEv) {
      if (!gridEl) return;
      var rect = gridEl.getBoundingClientRect();
      var c = rawCell(moveEv.clientX, moveEv.clientY, rect, cols, rowHeight, gap);
      var nx = c.x + offX;
      var ny = c.y + offY;
      if (nx === lastX && ny === lastY) return;
      lastX = nx; lastY = ny;
      // Preview: the other panels take their would-be drop layout, while the
      // held panel itself tracks the pointer cell (the trailing movePanel
      // overrides only the resolver's placement of the active panel).
      var preview = resolveDrop(movePanel(spec0, panelId, nx, ny), panelId, ny > y0);
      commit(movePanel(preview, panelId, nx, ny), false);
      applyAllCellRects();
    }, function () {
      // Release: resolve the drop for real — the drop row expresses ordering
      // intent, so the panel lands (and stays) where it was dropped.
      if (dragCell) dragCell.classList.remove('cxb-dragging');
      commit(resolveDrop(movePanel(spec0, panelId, lastX, lastY), panelId, lastY > y0), false);
      applyAllCellRects();
    });
  }

  /**
   * Pointer position → grid cell, WITHOUT clamping (may be negative/out of
   * range), so grab-offset maths stays correct above/left of the grid.
   * @param {number} clientX - Pointer X.
   * @param {number} clientY - Pointer Y.
   * @param {DOMRect} rect - Grid bounding rect.
   * @param {number} cols - Columns.
   * @param {number} rowHeight - Row height px.
   * @param {number} gap - Gap px.
   * @returns {{x:number, y:number}} Raw (unclamped) cell.
   * @private
   */
  function rawCell(clientX, clientY, rect, cols, rowHeight, gap) {
    var colWidth = (rect.width + gap) / cols;
    return {
      x: Math.floor((clientX - rect.left) / Math.max(1, colWidth)),
      y: Math.floor((clientY - rect.top) / Math.max(1, rowHeight + gap))
    };
  }

  /**
   * Begin a resize drag on a panel's corner handle.
   * @param {object} ev - pointerdown event.
   * @param {string} panelId - Panel being resized.
   * @param {number} cols - Columns.
   * @param {number} rowHeight - Row height px.
   * @param {number} gap - Gap px.
   * @returns {void}
   * @private
   */
  function startResize(ev, panelId, cols, rowHeight, gap) {
    stop(ev);
    selectPanel(panelId);
    var cell = cellEls[panelId];
    var item0 = itemFor(panelId);
    if (!cell || !item0) return;
    // Measure the panel's own cell as the ruler: a panel spans exactly its
    // columns/rows with NO internal gap tracks, so cell.width/w and cell.height/h
    // are the true per-unit sizes. (pointerToCell divides by rowHeight+gap
    // uniformly, which drifts across gutters and makes resize jumpy.) The panel's
    // top-left is fixed while dragging the bottom-right handle.
    var r0 = cell.getBoundingClientRect();
    var leftPx = r0.left, topPx = r0.top;
    var colUnit = r0.width / Math.max(1, item0.w);
    var rowUnit = r0.height / Math.max(1, item0.h);
    dragLoop(ev, function (moveEv) {
      if (!gridEl) return;
      var item = itemFor(panelId);
      if (!item) return;
      var w = Math.max(1, Math.round((moveEv.clientX - leftPx) / colUnit));
      var h = Math.max(1, Math.round((moveEv.clientY - topPx) / rowUnit));
      if (w !== item.w || h !== item.h) {
        commit(resolveCollisions(resizePanel(spec, panelId, w, h), panelId), false);
        applyAllCellRects();
      }
    }, function () { resizePanelGraph(panelId); });   // fit the graph once the drag ends
  }

  /**
   * Fit a panel's graph to its (just-resized) cell once the drag ends, by
   * calling CanvasXpress `setDimensions` (via resizeInstance) at the cell size.
   * @param {string} panelId - Panel to fit.
   * @returns {void}
   * @private
   */
  function resizePanelGraph(panelId) {
    var inst = instByPanel[panelId];
    var cell = cellEls[panelId];
    if (!inst || !cell) return;
    var body = cell.querySelector('.cxd-panel-body') || cell;
    var box = body.getBoundingClientRect();
    var inset = typeof spec.canvasInset === 'number' ? spec.canvasInset : 0;
    resizeInstance(inst, Math.floor(box.width) - inset, Math.floor(box.height) - inset);
  }

  /**
   * Update one cell's grid placement from the current spec, in place — the grid
   * (and any live instance) stays intact; a ResizeObserver in the renderer keeps
   * the graph sized to the cell.
   * @param {string} panelId - Panel to reposition.
   * @returns {void}
   * @private
   */
  /**
   * Re-place EVERY panel cell after a layout change that may have moved
   * neighbours (collision push / compaction), then restyle the grid tracks.
   * @returns {void}
   * @private
   */
  function applyAllCellRects() {
    (spec.layout.items || []).forEach(function (it) { applyCellRect(it.panel); });
  }

  function applyCellRect(panelId) {
    var cell = cellEls[panelId];
    var item = itemFor(panelId);
    if (!cell || !item) return;
    var area = cellArea(item);
    cell.style.gridColumn = area.column;
    cell.style.gridRow = area.row;
    // The row count can change as a panel moves, so refresh the track template
    // in place (uniform gap and column count are unaffected; placement is a
    // plain span, so cells never jump).
    if (gridEl) {
      var cols = gridCols(spec);
      var rowHeight = (spec.layout && spec.layout.rowHeight) || 30;
      var gap = (spec.layout && spec.layout.gap != null) ? spec.layout.gap : 12;
      var tpl = gridTemplate(spec.layout.items || [], cols, rowHeight, gap);
      gridEl.style.gridTemplateColumns = tpl.columns;
      gridEl.style.gridTemplateRows = tpl.rows;
      gridEl.style.gap = tpl.gap;
    }
  }

  /**
   * Attach transient pointermove/up listeners for a drag gesture.
   * @param {object} startEv - The initiating pointerdown event.
   * @param {function(object): void} onMove - Called on each pointermove.
   * @param {function(): void} [onEnd] - Called once on pointerup (gesture end).
   * @returns {void}
   * @private
   */
  function dragLoop(startEv, onMove, onEnd) {
    var doc = container.ownerDocument || document;
    function move(e) { onMove(e); }
    function up() {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      if (typeof onEnd === 'function') onEnd();
    }
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
  }

  // ---------------------------------------------------------------- helpers
  /**
   * Select a panel: outline it and open the editor drawer (no stage re-render,
   * so live instances and any open customizer are preserved).
   * @param {string} panelId - Panel id.
   * @returns {void}
   */
  function selectPanel(panelId) {
    selectedId = panelId;
    Object.keys(cellEls).forEach(function (id) {
      var c = cellEls[id];
      if (!c) return;
      if (id === panelId) c.classList.add('cxb-selected');
      else c.classList.remove('cxb-selected');
    });
    renderProps();
  }

  /**
   * Stop the edit state: deselect the current panel and clear its properties.
   * @returns {void}
   * @private
   */
  function deselect() {
    if (selectedId == null) return;
    selectedId = null;
    Object.keys(cellEls).forEach(function (id) {
      if (cellEls[id]) cellEls[id].classList.remove('cxb-selected');
    });
    renderProps();
  }

  /**
   * Delete a panel (capturing any customizer edits on the others first).
   * @param {string} panelId - Panel id.
   * @returns {void}
   * @private
   */
  function removePanelById(panelId) {
    commit(removePanel(spec, panelId), false);
    if (selectedId === panelId) selectedId = null;
    // Remove incrementally so the other panels keep their live state.
    if (liveHandle && liveHandle.removePanel && gridEl) {
      liveHandle.removePanel(panelId, spec.layout.items);
      delete cellEls[panelId];
      delete instByPanel[panelId];
      delete baselineConfigs[panelId];
      renderProps();
    } else {
      rebuild();
    }
  }

  /**
   * Re-render just one panel (used when its data source changes — it needs a new
   * instance, but the other panels must be left intact).
   * @param {string} panelId - Panel id.
   * @returns {void}
   * @private
   */
  function rerenderPanel(panelId) {
    var panel = spec.panels[panelId];
    var ref = panel && panel.dataRef;
    // The fast incremental path binds against sources the live handle already
    // knows; if this panel now points at a source added since the last render,
    // fall back to a full rebuild (folding live edits first so none are lost).
    var handleKnowsRef = !ref || liveRefs[ref];
    if (handleKnowsRef && liveHandle && liveHandle.removePanel && liveHandle.addPanel && gridEl) {
      liveHandle.removePanel(panelId, spec.layout.items);
      delete cellEls[panelId];
      delete instByPanel[panelId];
      delete baselineConfigs[panelId];
      lastRender = liveHandle.addPanel(itemFor(panelId), spec.panels[panelId], spec.layout.items).then(renderProps);
    } else {
      syncLiveConfigs();
      rebuild();
    }
  }

  /**
   * Fold each live instance's current CanvasXpress config back into the spec, so
   * customizer edits survive a re-render / save / export.
   * @returns {void}
   * @private
   */
  function syncLiveConfigs() {
    Object.keys(instByPanel).forEach(function (id) {
      var inst = instByPanel[id];
      if (!inst || typeof inst.getConfig !== 'function' || !spec.panels[id]) return;
      try {
        // getConfig() reflects live customizer edits (via this.graphType etc.),
        // but also injects derived render-state — notably the internal
        // "__FACTOR__" sentinel in groupingFactors — which, fed back with fresh
        // data on re-render, makes the graph fall back to bars. Strip any value
        // carrying that sentinel (real user grouping like ["Region"] is kept).
        var live = stripDerived(inst.getConfig() || {});
        // MERGE over the existing config, skipping undefined values. Transient
        // keys are dropped from the existing config too, so a spec polluted by
        // an older save self-heals on the next one.
        var merged = {};
        var existing = spec.panels[id].config || {};
        var k;
        for (k in existing) {
          if (Object.prototype.hasOwnProperty.call(existing, k) && !TRANSIENT_CONFIG_KEYS[k]) {
            merged[k] = existing[k];
          }
        }
        // Diff-based capture: a live key is persisted only when its value
        // CHANGED since the post-render baseline (a real customizer edit).
        // Render-derived state that getConfig() reports from the moment the
        // chart exists never reaches the spec — even keys the blocklist has
        // never heard of. Without a baseline (older instances), everything
        // non-transient is taken, as before.
        var baseline = baselineConfigs[id];
        for (k in live) {
          if (!Object.prototype.hasOwnProperty.call(live, k) || live[k] === undefined) continue;
          if (baseline && Object.prototype.hasOwnProperty.call(baseline, k)) {
            var liveJson;
            try { liveJson = JSON.stringify(live[k]); } catch (e) { continue; }
            if (liveJson === baseline[k] &&
                !Object.prototype.hasOwnProperty.call(existing, k)) {
              continue;   // unchanged since render and not authored: derived state
            }
          }
          merged[k] = live[k];
        }
        spec = updatePanel(spec, id, { config: merged });
      } catch (e) { /* keep going */ }
    });
  }

  /**
   * Apply a new spec, notify onChange, and optionally re-render the editor.
   * @param {object} nextSpec - The edited spec.
   * @param {boolean} rerenderEditor - Whether to re-render the editor drawer.
   * @returns {void}
   * @private
   */
  function commit(nextSpec, rerenderEditor) {
    spec = nextSpec;
    updateAddPanelState();
    if (options.onChange) { try { options.onChange(getSpec()); } catch (e) { /* noop */ } }
    if (rerenderEditor) renderProps();
  }

  /**
   * With limitDatasetsToSpec, a panel can only bind to a declared source — so
   * "+ Panel" is disabled until the spec has at least one data source.
   * "+ Control" additionally needs a graph panel: an annotation filter selects
   * by broadcasting to bound instances, so without data and a panel it can do
   * nothing.
   * @returns {void}
   */
  function updateAddPanelState() {
    var hasData = Object.keys(spec.data || {}).length > 0;
    if (addPanelBtn && limitDatasetsToSpec) {
      addPanelBtn.disabled = !hasData;
      addPanelBtn.title = hasData ? '' : 'Select a dataset first';
    }
    if (addControlBtn) {
      var hasGraphPanel = Object.keys(spec.panels || {}).some(function (id) {
        return !spec.panels[id].type;   // graph panels carry no type marker
      });
      addControlBtn.disabled = !(hasData && hasGraphPanel);
      addControlBtn.title = addControlBtn.disabled ? 'Add a panel with data first' : '';
    }
  }

  /** @returns {object} A deep copy of the current spec (raw, no live sync). */
  function rawSpec() { return JSON.parse(JSON.stringify(spec)); }

  /** @returns {object} The current spec with live customizer edits folded in. */
  function getSpec() { syncLiveConfigs(); return JSON.parse(JSON.stringify(spec)); }

  /**
   * Replace the current spec and re-render everything.
   * @param {object} nextSpec - The new spec.
   * @returns {void}
   */
  function setSpec(nextSpec) {
    spec = nextSpec;
    selectedId = null;
    updateAddPanelState();
    if (options.onChange) { try { options.onChange(rawSpec()); } catch (e) { /* noop */ } }
    rebuild();
  }

  /**
   * Find the layout item for a panel.
   * @param {string} panelId - Panel id.
   * @returns {object|undefined} The layout item.
   * @private
   */
  function itemFor(panelId) {
    return (spec.layout.items || []).filter(function (i) { return i.panel === panelId; })[0];
  }

  /**
   * Destroy the live render (instances + observers).
   * @returns {void}
   * @private
   */
  function teardownLive() {
    if (liveHandle) { try { liveHandle.destroy(); } catch (e) { /* noop */ } liveHandle = null; }
  }

  /**
   * Show a message.
   * @param {string} text - Message.
   * @returns {void}
   * @private
   */
  function setMsg(text) { msg.textContent = text; }

  /**
   * Show an error message.
   * @param {(Error|string)} err - Error.
   * @returns {void}
   * @private
   */
  function showError(err) { setMsg('⚠ ' + (err && err.message || err)); }

  return {
    getSpec: getSpec,
    setSpec: setSpec,
    /** @returns {Promise<void>} Resolves when the current live render settles. */
    whenReady: function () { return lastRender; },
    /**
     * Add a panel programmatically (same incremental path as the toolbar button
     * — existing panels are not re-rendered).
     * @param {object} descriptor - Panel descriptor for {@link addPanel}.
     * @returns {void}
     */
    addPanel: function (descriptor) {
      commit(addPanel(spec, descriptor), false);
      selectedId = descriptor.id;
      if (liveHandle && liveHandle.addPanel && gridEl) {
        lastRender = liveHandle.addPanel(itemFor(descriptor.id), spec.panels[descriptor.id], spec.layout.items).then(function () { renderProps(); });
      } else {
        rebuild();
      }
    },
    /**
     * Select a panel (opens its editor).
     * @param {string} panelId - Panel id.
     * @returns {void}
     */
    selectPanel: selectPanel,
    container: container,
    /**
     * Tear down the builder and any live render.
     * @returns {void}
     */
    destroy: function () {
      teardownLive();
      container.innerHTML = '';
      if (externalToolbar) externalToolbar.innerHTML = '';
    }
  };
}

// -------------------------------------------------------------------- utils

/**
 * Remove config values that carry CanvasXpress's internal "__FACTOR__" sentinel
 * (derived grouping state that breaks a re-render with fresh data). Real,
 * user-set values (e.g. `groupingFactors: ["Region"]`) are preserved.
 * @param {object} config - A config object from `getConfig()`.
 * @returns {object} A cleaned shallow copy.
 * @private
 */
/**
 * Live-instance config keys that are TRANSIENT RENDER STATE, never authored
 * intent — they must not be persisted into the spec. filterSmpBy/filterVarBy
 * are the worst offenders: a broadcast filter (e.g. a Region control pick)
 * serialized mid-session crashes CanvasXpress at construction on the next
 * load ("Cannot read properties of null (reading 'length')"), bricking the
 * dashboard. The rest are UI/session chrome that only adds noise.
 * @type {Object<string, boolean>}
 */
var TRANSIENT_CONFIG_KEYS = {
  filterSmpBy: true, filterVarBy: true,
  broadcastGroup: true,            // the renderer re-injects the spec's group
  llmHeader: true, resizable: true, toolbarSize: true,
  fontScaleFontFactor: true, smpTextScaleFontFactor: true,
  customizerCloseBackgroundColor: true, dataTablePaginationSelectTextColor: true,
  // Theme-derived label/title colors: the "auto" theme reports these from
  // getConfig() as if authored, so a save folds them into every panel and they
  // then self-perpetuate via the existing-config carry-forward. Block them so
  // the fold never writes them and any already-polluted spec self-heals on its
  // next save. (Sample label/title colors are theme-driven here by design.)
  smpTextColor: true, smpTitleColor: true
};

function stripDerived(config) {
  var out = {};
  for (var k in config) {
    if (Object.prototype.hasOwnProperty.call(config, k) &&
        !TRANSIENT_CONFIG_KEYS[k] &&
        !hasFactorSentinel(config[k])) {
      out[k] = config[k];
    }
  }
  return out;
}

/**
 * Whether a value contains the "__FACTOR__" internal sentinel.
 * @param {*} value - Any config value.
 * @returns {boolean} True if the sentinel is present.
 * @private
 */
function hasFactorSentinel(value) {
  if (typeof value === 'string') return value.indexOf('__FACTOR__') !== -1;
  if (Array.isArray(value)) return value.some(hasFactorSentinel);
  return false;
}

/**
 * Escape plain text to HTML (for pasting plain text into a rich editor).
 * @param {string} text - Raw text.
 * @returns {string} HTML-escaped text with newlines as <br>.
 * @private
 */
function escapeTextHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/**
 * Return a new spec with the dashboard title set.
 * @param {object} spec - Current spec.
 * @param {string} title - New title.
 * @returns {object} A new spec with the title set.
 * @private
 */
function updateTitle(spec, title) {
  var next = {};
  for (var k in spec) { if (Object.prototype.hasOwnProperty.call(spec, k)) next[k] = spec[k]; }
  next.title = title;
  return next;
}

/**
 * Generate a panel id not already used.
 * @param {object} spec - Current spec.
 * @returns {string} A fresh panel id like "p3".
 * @private
 */
function uniquePanelId(spec) {
  var n = 1;
  while (spec.panels && Object.prototype.hasOwnProperty.call(spec.panels, 'p' + n)) n++;
  return 'p' + n;
}

/**
 * Grid columns for a spec.
 * @param {object} spec - Spec.
 * @returns {number} Column count.
 * @private
 */
function gridCols(spec) { return (spec.layout && spec.layout.cols) || DEFAULT_COLS; }

/**
 * Clamp a column index into [0, cols-1].
 * @param {number} x - Column.
 * @param {number} cols - Column count.
 * @returns {number} Clamped column.
 * @private
 */
function clampCol(x, cols) { return Math.max(0, Math.min(cols - 1, x)); }

/**
 * Create an element with an optional class name.
 * @param {string} tag - Tag name.
 * @param {string} [className] - Class attribute.
 * @returns {HTMLElement} The element.
 * @private
 */
function el(tag, className) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * Create a toolbar button.
 * @param {string} label - Button text.
 * @param {function} handler - Click handler.
 * @param {string} [extra] - Extra class (e.g. primary).
 * @returns {HTMLElement} The button.
 * @private
 */
function button(label, handler, extra) {
  var b = el('button', 'cxb-btn' + (extra ? ' ' + extra : ''));
  b.type = 'button';
  b.textContent = label;
  on(b, 'click', handler);
  return b;
}

/**
 * Create a small icon button for a panel title bar.
 * @param {string} symbol - Icon glyph.
 * @param {string} title - Tooltip.
 * @param {function} handler - Click handler.
 * @returns {HTMLElement} The icon button.
 * @private
 */
function iconBtn(symbol, title, handler) {
  var b = el('span', 'cxb-tool');
  b.textContent = symbol;
  b.setAttribute('title', title);
  on(b, 'click', handler);
  return b;
}

/**
 * Create a select wired to an onchange callback.
 * @param {string[]} options - Option values.
 * @param {string} value - Selected value.
 * @param {function(string): void} onValue - Called with the chosen value.
 * @returns {HTMLElement} The select.
 * @private
 */
function selectField(options, value, onValue) {
  var select = el('select');
  options.forEach(function (opt) {
    var o = document.createElement('option');
    o.value = opt;
    o.textContent = opt === '' ? '(none)' : opt;
    if (opt === value) o.setAttribute('selected', 'selected');
    select.appendChild(o);
  });
  select.value = value;
  on(select, 'change', function () { onValue(select.value); });
  return select;
}

/**
 * Replace a select's option labels with human-readable text (values unchanged).
 * @param {HTMLSelectElement} select - The select.
 * @param {object} labels - value -> display label.
 * @returns {void}
 * @private
 */
function labelOptions(select, labels) {
  for (var i = 0; i < select.options.length; i++) {
    var o = select.options[i];
    if (Object.prototype.hasOwnProperty.call(labels, o.value)) o.textContent = labels[o.value];
  }
}

/**
 * Append many children to a parent.
 * @param {HTMLElement} parent - Parent element.
 * @param {HTMLElement[]} children - Children to append.
 * @returns {void}
 * @private
 */
function append(parent, children) {
  children.forEach(function (c) { parent.appendChild(c); });
}

/**
 * Add an event listener (guarded for environments without addEventListener).
 * @param {HTMLElement} node - Target.
 * @param {string} type - Event type.
 * @param {function} handler - Listener.
 * @returns {void}
 * @private
 */
function on(node, type, handler) {
  if (node && typeof node.addEventListener === 'function') node.addEventListener(type, handler);
}

/**
 * Stop propagation + default for an event, if it supports it.
 * @param {object} ev - The event.
 * @returns {void}
 * @private
 */
function stop(ev) {
  if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
  if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
}

/**
 * Open a modal "Add data source" dialog. Input modes: paste CanvasXpress JSON,
 * upload a `.json`/`.csv` file as inline data, point at a connector URL, or —
 * when a persistence client + configured dataset stores are available — upload a
 * file **to a store** and bind by id (`{kind:"dataset", id, store}`), keeping the
 * spec path- and credential-free. Resolves with `{ name, source }` or `null`.
 *
 * @param {Document} doc - The owning document.
 * @param {string[]} existingNames - Already-used source names (uniqueness check).
 * @param {object} [opts] - Dialog options.
 * @param {object} [opts.client] - Persistence client (enables the store path).
 * @param {object[]} [opts.stores] - Configured dataset stores `[{name, default}]`.
 * @returns {Promise<{name: string, source: object}|null>} The chosen source.
 * @private
 */
function openDataDialog(doc, existingNames, opts) {
  opts = opts || {};
  var client = opts.client;
  var stores = opts.stores || [];
  var datasets = opts.datasets || [];
  var canUseStore = !!(client && typeof client.uploadDataset === 'function' && stores.length);
  var canPickDataset = datasets.length > 0;

  return new Promise(function (resolve) {
    var overlay = el('div', 'cxb-modal-overlay');
    var modal = el('div', 'cxb-modal');

    var heading = el('h3', 'cxb-modal-title');
    heading.textContent = 'Add data source';

    var nameInput = el('input');
    nameInput.type = 'text';
    nameInput.value = 'data' + (existingNames.length + 1);
    nameInput.setAttribute('placeholder', 'Name (e.g. sales)');

    // Existing stored datasets come first so binding to seeded/uploaded data is
    // the default, one-click path.
    var modes = [];
    if (canPickDataset) modes.push(['dataset', 'Use an existing dataset']);
    modes.push(['json', 'Paste CanvasXpress JSON'], ['csv', 'Upload CSV / JSON file (inline)']);
    if (canUseStore) modes.push(['store', 'Upload CSV / JSON to a store']);
    modes.push(['connector', 'Connector URL']);
    var typeSel = el('select');
    modes.forEach(function (pair) {
      var o = doc.createElement('option');
      o.value = pair[0];
      o.textContent = pair[1];
      typeSel.appendChild(o);
    });

    // Per-mode input bodies.
    var jsonArea = el('textarea', 'cxb-modal-json');
    jsonArea.value = '{\n  "y": { "vars": ["V1"], "smps": ["A", "B"], "data": [[1, 2]] }\n}';

    var fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,.csv,application/json,text/csv';

    var storeFileInput = el('input');
    storeFileInput.type = 'file';
    storeFileInput.accept = '.json,.csv,application/json,text/csv';
    var storeSel = el('select');
    stores.forEach(function (s) {
      var o = doc.createElement('option');
      o.value = s.name;
      o.textContent = s.name + (s.default ? ' (default)' : '');
      if (s.default) o.selected = true;
      storeSel.appendChild(o);
    });
    var storeWrap = el('div');
    append(storeWrap, [storeFileInput, field('Store', storeSel)]);

    // Existing-dataset picker: choose one of the datasets already in a store.
    var datasetSel = el('select');
    datasets.forEach(function (d, i) {
      var o = doc.createElement('option');
      o.value = String(i);
      var label = (d.title || d.id);
      var bits = [];
      if (d.rows != null) bits.push(d.rows + '×' + (d.cols != null ? d.cols : '?'));
      if (d.store) bits.push(d.store);
      o.textContent = label + (bits.length ? '  (' + bits.join(' · ') + ')' : '');
      datasetSel.appendChild(o);
    });
    var datasetWrap = el('div');
    append(datasetWrap, [field('Dataset', datasetSel)]);

    var urlInput = el('input');
    urlInput.type = 'text';
    urlInput.setAttribute('placeholder', '/api/data?source=sales');

    var bodies = { dataset: datasetWrap, json: jsonArea, csv: fileInput, store: storeWrap, connector: urlInput };
    var bodyWrap = el('div', 'cxb-modal-body');
    Object.keys(bodies).forEach(function (k) { if (bodies[k]) bodyWrap.appendChild(bodies[k]); });
    function showBody() {
      Object.keys(bodies).forEach(function (k) {
        if (bodies[k]) bodies[k].style.display = k === typeSel.value ? '' : 'none';
      });
    }
    on(typeSel, 'change', showBody);
    showBody();

    // Suggest the dataset's id as the source name until the user types their own.
    var nameEdited = false;
    on(nameInput, 'input', function () { nameEdited = true; });
    function syncDatasetName() {
      if (typeSel.value === 'dataset' && !nameEdited) {
        var picked = datasets[parseInt(datasetSel.value, 10)];
        if (picked) nameInput.value = picked.id;
      }
    }
    on(typeSel, 'change', syncDatasetName);
    on(datasetSel, 'change', syncDatasetName);
    syncDatasetName();

    var errEl = el('div', 'cxb-modal-err');

    var cancelBtn = button('Cancel', function () { close(null); });
    var addBtn = button('Add', function () { onAdd(); }, 'cxb-btn-primary');
    var footer = el('div', 'cxb-modal-footer');
    append(footer, [cancelBtn, addBtn]);

    append(modal, [heading, field('Name', nameInput), field('Source', typeSel), bodyWrap, errEl, footer]);
    overlay.appendChild(modal);
    on(overlay, 'click', function (ev) { if (ev.target === overlay) close(null); });
    (doc.body || doc.documentElement).appendChild(overlay);
    if (typeof nameInput.focus === 'function') nameInput.focus();

    /**
     * Validate + build the source, then resolve.
     * @returns {void}
     */
    function onAdd() {
      var name = (nameInput.value || '').trim();
      if (!name) return fail('Name is required');
      if (existingNames.indexOf(name) !== -1) return fail('A source named "' + name + '" already exists');
      var mode = typeSel.value;

      if (mode === 'dataset') {
        var picked = datasets[parseInt(datasetSel.value, 10)];
        if (!picked) return fail('Choose a dataset');
        var dsrc = { kind: 'dataset', id: picked.id };
        if (picked.store) dsrc.store = picked.store;
        return close({ name: name, source: dsrc });
      }

      if (mode === 'store') {
        var sf = storeFileInput.files && storeFileInput.files[0];
        if (!sf) return fail('Choose a file to upload');
        var storeName = storeSel.value;
        setBusy('Uploading…');
        client.uploadDataset(sf, { store: storeName, title: name }).then(function (summary) {
          var src = { kind: 'dataset', id: summary.id };
          if (summary.store) src.store = summary.store;
          close({ name: name, source: src });
        }, function (e) { setBusy(null); fail('Upload failed: ' + (e && e.message || e)); });
        return;
      }

      if (mode === 'csv') {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return fail('Choose a file');
        f.text().then(function (text) {
          try {
            var isCsv = /\.csv$/i.test(f.name);
            close({ name: name, source: buildDataSource(isCsv ? 'csv' : 'json', text) });
          } catch (e) { fail(e.message); }
        }, function (e) { fail('Could not read file: ' + (e && e.message || e)); });
        return;
      }
      try {
        var text = mode === 'connector' ? urlInput.value : jsonArea.value;
        close({ name: name, source: buildDataSource(mode, text) });
      } catch (e) { fail(e.message); }
    }

    /**
     * Toggle a busy state on the Add button during an async upload.
     * @param {?string} label - Busy label, or null to restore.
     * @returns {void}
     */
    function setBusy(label) {
      addBtn.disabled = !!label;
      addBtn.textContent = label || 'Add';
      if (label) errEl.textContent = '';
    }

    /**
     * Show an error inside the dialog.
     * @param {string} m - Message.
     * @returns {void}
     */
    function fail(m) { errEl.textContent = m; }

    /**
     * Close the dialog with a result.
     * @param {*} result - Resolution value.
     * @returns {void}
     */
    function close(result) {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(result || null);
    }
  });
}

/**
 * Wrap a labeled field for the dialog.
 * @param {string} labelText - Field label.
 * @param {HTMLElement} control - The input control.
 * @returns {HTMLElement} A labeled field group.
 * @private
 */
function field(labelText, control) {
  var wrap = el('div', 'cxb-modal-field');
  var l = el('label');
  l.textContent = labelText;
  wrap.appendChild(l);
  wrap.appendChild(control);
  return wrap;
}
