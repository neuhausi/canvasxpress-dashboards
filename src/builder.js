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
import { renderDashboard } from './renderDashboard.js';
import { gridTemplate, cellArea } from './gridLayout.js';
import { addPanel, removePanel, movePanel, resizePanel, updatePanel, setDataSource, blankSpec, DEFAULT_COLS }
  from './builderModel.js';

/**
 * Parse CSV text into a CanvasXpress data object, mirroring the
 * `canvasxpress-connectors` reshape: the first column becomes sample ids
 * (`y.smps`), fully-numeric columns become variables (`y.vars` + `y.data`), and
 * the remaining columns become per-sample string annotations (`x`).
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
  var numeric = [];
  for (var c = 0; c < ncols; c++) {
    numeric[c] = bodyRows.every(function (r) { return isNumeric(r[c]); });
  }

  var smps = bodyRows.map(function (r) { return String(r[0]); });
  var vars = [];
  var data = [];
  var x = {};
  for (var col = 1; col < ncols; col++) {
    if (numeric[col]) {
      vars.push(header[col]);
      data.push(bodyRows.map(function (r) { return parseFloat(r[col]); }));
    } else {
      x[header[col]] = bodyRows.map(function (r) { return r[col]; });
    }
  }
  var out = { y: { vars: vars, smps: smps, data: data } };
  if (Object.keys(x).length) out.x = x;
  return out;
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
  var CX = options.CanvasXpress || (typeof globalThis !== 'undefined' ? globalThis.CanvasXpress : undefined);
  var selectedId = null;
  var liveHandle = null;    // the current renderDashboard handle (live instances)
  var lastRender = Promise.resolve();
  var gridEl = null;        // the live grid element (stable during a drag)
  var cellEls = {};         // panelId -> panel cell element
  var instByPanel = {};     // panelId -> CanvasXpress instance

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
    var left = el('div', 'cxb-tgroup');
    append(left, [
      titleInput,
      button('+ Panel', function () { doAddPanel(); }),
      button('+ Data', function () { doAddDataSource(); })
    ]);
    var right = el('div', 'cxb-tgroup');
    append(right, [button('Save', function () { doSave(); }, 'cxb-btn-primary')]);
    append(toolbarHost, [left, propsGroup, el('div', 'cxb-spacer'), right]);
  }
  buildToolbar();

  var msg = el('div', 'cxb-msg');
  root.appendChild(msg);

  var stage = el('div', 'cxb-stage');
  root.appendChild(stage);

  rebuild();

  // ---------------------------------------------------------------- actions
  /**
   * Add a panel bound to the first data source, then re-render live.
   * @returns {void}
   */
  function doAddPanel() {
    var id = uniquePanelId(spec);
    var firstRef = Object.keys(spec.data || {})[0];
    commit(addPanel(spec, { id: id, title: 'Panel ' + id.replace(/\D/g, ''), dataRef: firstRef, w: 6, h: 4, config: { graphType: 'Bar' } }), false);
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
   * Open the "Add data source" dialog and register the chosen source. Adding a
   * source doesn't touch existing panels, so no re-render is needed.
   * @returns {void}
   */
  function doAddDataSource() {
    var doc = container.ownerDocument || document;
    // Offer the "upload to a store" path only when a client can list stores.
    var storesPromise = (client && typeof client.listStores === 'function')
      ? client.listStores('dataset').then(function (s) { return s; }, function () { return []; })
      : Promise.resolve([]);
    storesPromise.then(function (stores) {
      openDataDialog(doc, Object.keys(spec.data || {}), { client: client, stores: stores }).then(function (result) {
        if (!result) return;
        commit(setDataSource(spec, result.name, result.source), false);
        renderProps();
      });
    });
  }

  /**
   * Persist the current spec via the client.
   * @returns {void}
   */
  function doSave() {
    if (!client) return showError('No persistence client configured.');
    setMsg('Saving…');
    client.save(getSpec()).then(function () { setMsg('Saved “' + spec.id + '”.'); }, showError);
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
      var hint = el('div', 'cxb-msg');
      hint.textContent = 'Empty dashboard — click “+ Data” then “+ Panel” to begin.';
      stage.appendChild(hint);
      lastRender = Promise.resolve();
      return;
    }

    var host = el('div');
    stage.appendChild(host);
    // Inset the canvas so the corner resize handle sits in a margin, not on the
    // graph. A spec-level canvasInset (Settings) wins; 18 is the editing default.
    var opts = { CanvasXpress: CX, validate: false, canvasInset: 18 };
    opts.onPanelRendered = decorate;
    lastRender = renderDashboard(rawSpec(), host, opts).then(function (handle) {
      liveHandle = handle;
      gridEl = host.querySelector('.cxd-grid');
      return handle.ready;
    }).catch(showError);
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
    cell.classList.add('cxb-cell');
    if (info.panelId === selectedId) cell.classList.add('cxb-selected');
    cellEls[info.panelId] = cell;
    instByPanel[info.panelId] = info.instance;

    var cols = gridCols(spec);
    var rowHeight = (spec.layout && spec.layout.rowHeight) || 130;
    var gap = (spec.layout && spec.layout.gap != null) ? spec.layout.gap : 12;

    var title = cell.querySelector('.cxd-panel-title');
    if (title) {
      on(title, 'pointerdown', function (ev) { startDrag(ev, info.panelId, cols, rowHeight, gap); });
      on(title, 'click', function () { selectPanel(info.panelId); });

      var tools = el('span', 'cxb-tools');
      var gear = iconBtn('⚙', 'Customize graph', function (ev) {
        stop(ev);
        var inst = instByPanel[info.panelId];
        if (inst && typeof inst.showCustomizer === 'function') inst.showCustomizer(ev);
      });
      var del = iconBtn('×', 'Delete panel', function (ev) { stop(ev); removePanelById(info.panelId); });
      on(gear, 'pointerdown', stop);
      on(del, 'pointerdown', stop);
      append(tools, [gear, del]);
      title.appendChild(tools);
    }

    var resize = el('div', 'cxb-resize');
    resize.setAttribute('title', 'Resize');
    on(resize, 'pointerdown', function (ev) { startResize(ev, info.panelId, cols, rowHeight, gap); });
    cell.appendChild(resize);
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

    var dataLabel = el('span', 'cxb-tlabel');
    dataLabel.textContent = 'Data';

    var dsField = selectField([''].concat(refs), panel.dataRef || '',
      // Changing the source re-instantiates this panel's graph.
      function (v) { commit(updatePanel(spec, selectedId, { dataRef: v || undefined }), false); rerenderPanel(selectedId); });
    dsField.setAttribute('title', 'Data source');

    // No Delete here — the panel frame already carries a × delete control.
    append(propsGroup, [titleLabel, titleField, dataLabel, dsField]);
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
    dragLoop(ev, function (moveEv) {
      if (!gridEl) return;
      var rect = gridEl.getBoundingClientRect();
      var cell = pointerToCell(moveEv.clientX, moveEv.clientY, rect, cols, rowHeight, gap);
      var current = itemFor(panelId);
      if (current && (current.x !== cell.x || current.y !== cell.y)) {
        commit(movePanel(spec, panelId, cell.x, cell.y), false);
        applyCellRect(panelId);
      }
    });
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
    dragLoop(ev, function (moveEv) {
      if (!gridEl) return;
      var rect = gridEl.getBoundingClientRect();
      var item = itemFor(panelId);
      if (!item) return;
      var far = pointerToCell(moveEv.clientX, moveEv.clientY, rect, cols, rowHeight, gap);
      var w = far.x - item.x + 1;
      var h = far.y - item.y + 1;
      if (w !== item.w || h !== item.h) {
        commit(resizePanel(spec, panelId, w, h), false);
        applyCellRect(panelId);
      }
    });
  }

  /**
   * Update one cell's grid placement from the current spec, in place — the grid
   * (and any live instance) stays intact; a ResizeObserver in the renderer keeps
   * the graph sized to the cell.
   * @param {string} panelId - Panel to reposition.
   * @returns {void}
   * @private
   */
  function applyCellRect(panelId) {
    var cell = cellEls[panelId];
    var item = itemFor(panelId);
    if (!cell || !item) return;
    var area = cellArea(item);
    cell.style.gridColumn = area.column;
    cell.style.gridRow = area.row;
    // Panel edges moved, so which boundaries carry a gutter may have changed —
    // restyle the grid tracks in place (placement lines are unaffected).
    if (gridEl) {
      var cols = gridCols(spec);
      var rowHeight = (spec.layout && spec.layout.rowHeight) || 130;
      var gap = (spec.layout && spec.layout.gap != null) ? spec.layout.gap : 12;
      var tpl = gridTemplate(spec.layout.items || [], cols, rowHeight, gap);
      gridEl.style.gridTemplateColumns = tpl.columns;
      gridEl.style.gridTemplateRows = tpl.rows;
    }
  }

  /**
   * Attach transient pointermove/up listeners for a drag gesture.
   * @param {object} startEv - The initiating pointerdown event.
   * @param {function(object): void} onMove - Called on each pointermove.
   * @returns {void}
   * @private
   */
  function dragLoop(startEv, onMove) {
    var doc = container.ownerDocument || document;
    function move(e) { onMove(e); }
    function up() {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
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
    if (liveHandle && liveHandle.removePanel && liveHandle.addPanel && gridEl) {
      liveHandle.removePanel(panelId, spec.layout.items);
      delete cellEls[panelId];
      delete instByPanel[panelId];
      lastRender = liveHandle.addPanel(itemFor(panelId), spec.panels[panelId], spec.layout.items).then(renderProps);
    } else {
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
        // MERGE over the existing config, skipping undefined values.
        var merged = {};
        var existing = spec.panels[id].config || {};
        var k;
        for (k in existing) {
          if (Object.prototype.hasOwnProperty.call(existing, k)) merged[k] = existing[k];
        }
        for (k in live) {
          if (Object.prototype.hasOwnProperty.call(live, k) && live[k] !== undefined) merged[k] = live[k];
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
    if (options.onChange) { try { options.onChange(getSpec()); } catch (e) { /* noop */ } }
    if (rerenderEditor) renderProps();
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
function stripDerived(config) {
  var out = {};
  for (var k in config) {
    if (Object.prototype.hasOwnProperty.call(config, k) && !hasFactorSentinel(config[k])) {
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
  var canUseStore = !!(client && typeof client.uploadDataset === 'function' && stores.length);

  return new Promise(function (resolve) {
    var overlay = el('div', 'cxb-modal-overlay');
    var modal = el('div', 'cxb-modal');

    var heading = el('h3', 'cxb-modal-title');
    heading.textContent = 'Add data source';

    var nameInput = el('input');
    nameInput.type = 'text';
    nameInput.value = 'data' + (existingNames.length + 1);
    nameInput.setAttribute('placeholder', 'Name (e.g. sales)');

    var modes = [['json', 'Paste CanvasXpress JSON'], ['csv', 'Upload CSV / JSON file (inline)']];
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

    var urlInput = el('input');
    urlInput.type = 'text';
    urlInput.setAttribute('placeholder', '/api/data?source=sales');

    var bodies = { json: jsonArea, csv: fileInput, store: storeWrap, connector: urlInput };
    var bodyWrap = el('div', 'cxb-modal-body');
    Object.keys(bodies).forEach(function (k) { if (bodies[k]) bodyWrap.appendChild(bodies[k]); });
    function showBody() {
      Object.keys(bodies).forEach(function (k) {
        if (bodies[k]) bodies[k].style.display = k === typeSel.value ? '' : 'none';
      });
    }
    on(typeSel, 'change', showBody);
    showBody();

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
