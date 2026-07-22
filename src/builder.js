/**
 * No-code dashboard builder (Phase 4): a drag/move/resize grid + a per-panel
 * editor form that reads and writes the same Phase-1 spec. Every gesture routes
 * through the pure {@link module:builderModel} operations, so the builder can
 * never produce anything unexpressible in the spec. Live preview reuses
 * {@link renderDashboard}; Save/Share/Export reuse the Phase-3 client + helpers.
 *
 * Vanilla + zero-dependency: no framework, no drag-grid library — it ships in
 * the same ESM/UMD bundle and works as a `<script>` drop-in.
 *
 * @module builder
 */

import { injectStyles } from './styles.js';
import { renderDashboard } from './renderDashboard.js';
import { exportSpec, importSpecFromFile } from './persistence.js';
import {
  addPanel, removePanel, movePanel, resizePanel, updatePanel, setDataSource, blankSpec, DEFAULT_COLS
} from './builderModel.js';

/** Chart types offered in the panel editor dropdown. */
var GRAPH_TYPES = ['Bar', 'Line', 'Area', 'Scatter2D', 'Pie', 'Dotplot', 'Boxplot', 'Heatmap', 'Stacked'];

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
 * @param {*} [options.CanvasXpress] - CanvasXpress constructor (for preview); defaults to global.
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
  var previewing = false;
  var previewHandle = null;
  var gridEl = null;       // the persistent edit-grid element (stable during a drag)
  var cellEls = {};        // panelId -> cell element (for in-place position updates)

  container.innerHTML = '';
  var root = el('div', 'cxb');
  container.appendChild(root);

  // --- toolbar ---
  var toolbar = el('div', 'cxb-toolbar');
  var titleInput = el('input');
  titleInput.type = 'text';
  titleInput.value = spec.title || spec.id;
  titleInput.setAttribute('aria-label', 'Dashboard title');
  on(titleInput, 'input', function () { commit(updateTitle(spec, titleInput.value), false); });

  var addBtn = button('+ Panel', function () { doAddPanel(); });
  var srcBtn = button('+ Data', function () { doAddDataSource(); });
  var previewBtn = button('Preview', function () { togglePreview(); });
  var saveBtn = button('Save', function () { doSave(); }, 'cxb-btn-primary');
  var shareBtn = button('Share', function () { doShare(); });
  var exportBtn = button('Export', function () { exportSpec(getSpec()); });
  var importInput = el('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.style.display = 'none';
  on(importInput, 'change', function () {
    var file = importInput.files && importInput.files[0];
    if (file) importSpecFromFile(file).then(function (loaded) { setSpec(loaded); }, showError);
  });
  var importBtn = button('Import', function () { importInput.click(); });

  append(toolbar, [titleInput, addBtn, srcBtn, previewBtn, saveBtn, shareBtn, exportBtn, importBtn, importInput]);
  root.appendChild(toolbar);

  var msg = el('div', 'cxb-msg');
  root.appendChild(msg);

  var body = el('div', 'cxb-body');
  var stage = el('div', 'cxb-stage');
  var editor = el('div', 'cxb-editor');
  append(body, [stage, editor]);
  root.appendChild(body);

  rebuild();

  // ---------------------------------------------------------------- actions
  /**
   * Add a new panel with an auto-generated id and select it.
   * @returns {void}
   */
  function doAddPanel() {
    var id = uniquePanelId(spec);
    var firstRef = Object.keys(spec.data || {})[0];
    commit(addPanel(spec, { id: id, title: 'Panel ' + id.replace(/\D/g, ''), dataRef: firstRef, config: { graphType: 'Bar' } }), true);
    selectedId = id;
    rebuild();
  }

  /**
   * Prompt for an inline data source (name + JSON) and add it.
   * @returns {void}
   */
  function doAddDataSource() {
    var name = safePrompt('Data source name:', 'data' + (Object.keys(spec.data || {}).length + 1));
    if (!name) return;
    var raw = safePrompt('Inline CanvasXpress data as JSON (e.g. {"y":{"vars":[],"smps":[],"data":[]}}):', '{"y":{"vars":["V"],"smps":["A","B"],"data":[[1,2]]}}');
    if (raw == null) return;
    var value;
    try { value = JSON.parse(raw); } catch (e) { return showError('Invalid JSON: ' + e.message); }
    commit(setDataSource(spec, name, { kind: 'inline', value: value }), true);
    rebuild();
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

  /**
   * Publish a public share link via the client and show it.
   * @returns {void}
   */
  function doShare() {
    if (!client) return showError('No persistence client configured.');
    setMsg('Sharing…');
    client.save(getSpec())
      .then(function () { return client.share(spec.id, 'public'); })
      .then(function (info) { setMsg('Public link: ' + (info.share_url || info.share_token)); }, showError);
  }

  // ---------------------------------------------------------------- render
  /**
   * Rebuild the stage (edit grid or live preview) and the editor drawer.
   * @returns {void}
   */
  function rebuild() {
    titleInput.value = spec.title || spec.id;
    if (previewing) { renderPreview(); }
    else { renderEditGrid(); }
    renderEditor();
  }

  /**
   * Render the editable grid of placeholder cells with move/resize/delete.
   * @returns {void}
   */
  function renderEditGrid() {
    teardownPreview();
    stage.innerHTML = '';
    var grid = el('div', 'cxd-grid cxb-grid');
    var cols = gridCols(spec);
    var rowHeight = (spec.layout && spec.layout.rowHeight) || 130;
    var gap = (spec.layout && spec.layout.gap != null) ? spec.layout.gap : 12;
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    grid.style.gridAutoRows = rowHeight + 'px';
    grid.style.gap = gap + 'px';

    cellEls = {};
    gridEl = grid;
    (spec.layout.items || []).forEach(function (item) {
      var cell = buildEditCell(item, grid, cols, rowHeight, gap);
      cellEls[item.panel] = cell;
      grid.appendChild(cell);
    });
    stage.appendChild(grid);
    if (!(spec.layout.items || []).length) {
      var hint = el('div', 'cxb-msg');
      hint.textContent = 'Empty dashboard — click “+ Data” then “+ Panel” to begin.';
      stage.appendChild(hint);
    }
  }

  /**
   * Build one editable cell for a layout item.
   * @param {object} item - Layout item.
   * @param {HTMLElement} grid - The grid element (for pointer geometry).
   * @param {number} cols - Column count.
   * @param {number} rowHeight - Row height px.
   * @param {number} gap - Grid gap px.
   * @returns {HTMLElement} The cell element.
   * @private
   */
  function buildEditCell(item, grid, cols, rowHeight, gap) {
    var panel = spec.panels[item.panel] || {};
    var cell = el('div', 'cxd-panel cxb-cell' + (item.panel === selectedId ? ' cxb-selected' : ''));
    cell.style.gridColumn = (item.x + 1) + ' / span ' + item.w;
    cell.style.gridRow = (item.y + 1) + ' / span ' + item.h;

    var header = el('div', 'cxd-panel-title');
    header.textContent = panel.title || item.panel;
    on(header, 'pointerdown', function (ev) { startDrag(ev, item.panel, grid, cols, rowHeight, gap); });
    on(header, 'click', function () { selectedId = item.panel; rebuild(); });

    var fill = el('div', 'cxb-body-fill');
    fill.textContent = (panel.config && panel.config.graphType) || 'Bar';

    var del = el('div', 'cxb-del');
    del.textContent = '×';
    del.setAttribute('title', 'Delete panel');
    on(del, 'click', function (ev) {
      stop(ev);
      commit(removePanel(spec, item.panel), true);
      if (selectedId === item.panel) selectedId = null;
      rebuild();
    });

    var resize = el('div', 'cxb-resize');
    resize.setAttribute('title', 'Resize');
    on(resize, 'pointerdown', function (ev) { startResize(ev, item.panel, grid, cols, rowHeight, gap); });

    append(cell, [header, fill, del, resize]);
    return cell;
  }

  /**
   * Render a live, read-only preview of the current spec.
   * @returns {void}
   */
  function renderPreview() {
    teardownPreview();
    stage.innerHTML = '';
    var host = el('div');
    stage.appendChild(host);
    renderDashboard(getSpec(), host, { CanvasXpress: CX }).then(function (h) {
      previewHandle = h;
    }, showError);
  }

  /**
   * Destroy any live preview instances.
   * @returns {void}
   * @private
   */
  function teardownPreview() {
    if (previewHandle) { try { previewHandle.destroy(); } catch (e) { /* noop */ } previewHandle = null; }
  }

  /**
   * Toggle between edit and preview modes.
   * @returns {void}
   */
  function togglePreview() {
    previewing = !previewing;
    previewBtn.textContent = previewing ? 'Edit' : 'Preview';
    rebuild();
  }

  /**
   * Render the editor drawer for the selected panel (or a data-source list).
   * @returns {void}
   */
  function renderEditor() {
    editor.innerHTML = '';
    var refs = Object.keys(spec.data || {});
    if (!selectedId || !spec.panels[selectedId]) {
      editor.appendChild(fieldLabel('Data sources'));
      var list = el('div');
      list.textContent = refs.length ? refs.join(', ') : 'none yet';
      list.className = 'cxb-msg';
      editor.appendChild(list);
      var tip = el('div', 'cxb-msg');
      tip.textContent = 'Select a panel to edit it.';
      editor.appendChild(tip);
      return;
    }
    var panel = spec.panels[selectedId];

    editor.appendChild(labeled('Title', textField(panel.title || '', function (v) {
      commit(updatePanel(spec, selectedId, { title: v }), false); refreshCellTitles();
    })));

    editor.appendChild(labeled('Data source', selectField(
      [''].concat(refs), panel.dataRef || '',
      function (v) { commit(updatePanel(spec, selectedId, { dataRef: v || undefined }), false); }
    )));

    var cfg = panel.config || {};
    editor.appendChild(labeled('Chart type', selectField(
      GRAPH_TYPES, cfg.graphType || 'Bar',
      function (v) { commit(updatePanel(spec, selectedId, { config: withKey(cfg, 'graphType', v) }), true); }
    )));

    editor.appendChild(labeled('Color by', textField(cfg.colorBy || '', function (v) {
      commit(updatePanel(spec, selectedId, { config: withKey(spec.panels[selectedId].config || {}, 'colorBy', v || undefined) }), false);
    })));

    editor.appendChild(labeled('Raw config (JSON)', rawConfigField(panel.config || {}, function (parsed) {
      commit(updatePanel(spec, selectedId, { config: parsed }), true);
    })));

    var delBtn = button('Delete panel', function () {
      commit(removePanel(spec, selectedId), true); selectedId = null; rebuild();
    });
    editor.appendChild(delBtn);
  }

  /**
   * Update just the visible cell titles without a full rebuild (keeps focus).
   * @returns {void}
   * @private
   */
  function refreshCellTitles() {
    if (previewing) return;
    var titles = stage.querySelectorAll('.cxd-panel-title');
    var items = spec.layout.items || [];
    for (var i = 0; i < items.length && i < titles.length; i++) {
      var p = spec.panels[items[i].panel] || {};
      titles[i].textContent = p.title || items[i].panel;
    }
  }

  // ---------------------------------------------------------------- drag/resize
  /**
   * Begin a move drag on a panel header.
   * @param {object} ev - pointerdown event.
   * @param {string} panelId - Panel being moved.
   * @param {HTMLElement} grid - Grid element.
   * @param {number} cols - Columns.
   * @param {number} rowHeight - Row height px.
   * @param {number} gap - Gap px.
   * @returns {void}
   * @private
   */
  function startDrag(ev, panelId, grid, cols, rowHeight, gap) {
    stop(ev);
    selectedId = panelId;
    markSelected(panelId);
    dragLoop(ev, function (moveEv) {
      var rect = (gridEl || grid).getBoundingClientRect();
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
   * @param {HTMLElement} grid - Grid element.
   * @param {number} cols - Columns.
   * @param {number} rowHeight - Row height px.
   * @param {number} gap - Gap px.
   * @returns {void}
   * @private
   */
  function startResize(ev, panelId, grid, cols, rowHeight, gap) {
    stop(ev);
    selectedId = panelId;
    markSelected(panelId);
    dragLoop(ev, function (moveEv) {
      var rect = (gridEl || grid).getBoundingClientRect();
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
   * Update a single cell's grid placement from the current spec, in place — no
   * full rebuild, so the grid element (and its measured rect) stays stable
   * throughout a drag.
   * @param {string} panelId - Panel to reposition.
   * @returns {void}
   * @private
   */
  function applyCellRect(panelId) {
    var cell = cellEls[panelId];
    var item = itemFor(panelId);
    if (!cell || !item) return;
    cell.style.gridColumn = (item.x + 1) + ' / span ' + item.w;
    cell.style.gridRow = (item.y + 1) + ' / span ' + item.h;
  }

  /**
   * Reflect the selected panel's outline without a full rebuild.
   * @param {string} panelId - Newly selected panel.
   * @returns {void}
   * @private
   */
  function markSelected(panelId) {
    Object.keys(cellEls).forEach(function (id) {
      var c = cellEls[id];
      if (!c) return;
      if (id === panelId) c.classList.add('cxb-selected');
      else c.classList.remove('cxb-selected');
    });
    renderEditor();
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
   * Apply a new spec, notify, and optionally re-render the editor.
   * @param {object} nextSpec - The edited spec.
   * @param {boolean} rerenderEditor - Whether to re-render the editor drawer.
   * @returns {void}
   * @private
   */
  function commit(nextSpec, rerenderEditor) {
    spec = nextSpec;
    if (options.onChange) { try { options.onChange(getSpec()); } catch (e) { /* noop */ } }
    if (rerenderEditor) renderEditor();
  }

  /** @returns {object} A deep copy of the current spec. */
  function getSpec() { return JSON.parse(JSON.stringify(spec)); }

  /**
   * Replace the current spec and re-render everything.
   * @param {object} nextSpec - The new spec.
   * @returns {void}
   */
  function setSpec(nextSpec) {
    spec = nextSpec;
    selectedId = null;
    if (options.onChange) { try { options.onChange(getSpec()); } catch (e) { /* noop */ } }
    rebuild();
  }

  /**
   * Find the layout item for a panel in the current spec.
   * @param {string} panelId - Panel id.
   * @returns {object|undefined} The layout item.
   * @private
   */
  function itemFor(panelId) {
    return (spec.layout.items || []).filter(function (i) { return i.panel === panelId; })[0];
  }

  /**
   * Show a transient message.
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
    /** @returns {object} A copy of the current spec. */
    getSpec: getSpec,
    setSpec: setSpec,
    /**
     * Add a panel programmatically (same path as the toolbar button).
     * @param {object} descriptor - Panel descriptor for {@link addPanel}.
     * @returns {void}
     */
    addPanel: function (descriptor) {
      commit(addPanel(spec, descriptor), false);
      selectedId = descriptor.id;
      rebuild();
    },
    /**
     * Select a panel (opens its editor).
     * @param {string} panelId - Panel id.
     * @returns {void}
     */
    selectPanel: function (panelId) { selectedId = panelId; rebuild(); },
    /** @returns {string} The container element. */
    container: container,
    /**
     * Tear down the builder and any preview.
     * @returns {void}
     */
    destroy: function () { teardownPreview(); container.innerHTML = ''; }
  };
}

// -------------------------------------------------------------------- utils

/**
 * Return a new dashboard-title spec (kept out of builderModel — it's UI chrome).
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
 * Return a shallow copy of a config with one key set (or deleted if undefined).
 * @param {object} config - Source config.
 * @param {string} key - Key to set.
 * @param {*} value - New value (undefined deletes the key).
 * @returns {object} A new config object.
 * @private
 */
function withKey(config, key, value) {
  var out = {};
  for (var k in config) { if (Object.prototype.hasOwnProperty.call(config, k)) out[k] = config[k]; }
  if (value === undefined) delete out[key];
  else out[key] = value;
  return out;
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
 * Wrap a control with an uppercase label.
 * @param {string} labelText - Label.
 * @param {HTMLElement} control - The control element.
 * @returns {HTMLElement} A labeled group.
 * @private
 */
function labeled(labelText, control) {
  var wrap = el('div');
  wrap.appendChild(fieldLabel(labelText));
  wrap.appendChild(control);
  return wrap;
}

/**
 * Create a field label.
 * @param {string} text - Label text.
 * @returns {HTMLElement} The label.
 * @private
 */
function fieldLabel(text) {
  var l = el('label');
  l.textContent = text;
  return l;
}

/**
 * Create a text input wired to an onchange callback.
 * @param {string} value - Initial value.
 * @param {function(string): void} onValue - Called with the new value on input.
 * @returns {HTMLElement} The input.
 * @private
 */
function textField(value, onValue) {
  var input = el('input');
  input.type = 'text';
  input.value = value;
  on(input, 'input', function () { onValue(input.value); });
  return input;
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
 * Create a raw-config JSON textarea that commits only when the JSON is valid.
 * @param {object} config - Initial config object.
 * @param {function(object): void} onValid - Called with parsed config on valid edit.
 * @returns {HTMLElement} The textarea.
 * @private
 */
function rawConfigField(config, onValid) {
  var ta = el('textarea');
  ta.value = JSON.stringify(config, null, 2);
  on(ta, 'change', function () {
    try {
      var parsed = JSON.parse(ta.value);
      onValid(parsed);
    } catch (e) { /* keep the invalid text; ignore until valid */ }
  });
  return ta;
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
 * A prompt() that returns null when unavailable (non-browser).
 * @param {string} message - Prompt text.
 * @param {string} [preset] - Default value.
 * @returns {(string|null)} The entered value or null.
 * @private
 */
function safePrompt(message, preset) {
  if (typeof globalThis !== 'undefined' && typeof globalThis.prompt === 'function') {
    return globalThis.prompt(message, preset);
  }
  return null;
}
