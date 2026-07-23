/**
 * Client renderer: turn a dashboard spec into a responsive CSS-grid of
 * coordinated CanvasXpress instances.
 *
 * Data binding (Phase 2): panels resolve inline values or authenticated
 * `canvasxpress-connectors` endpoints through a shared {@link createDataStore}.
 * Panels sharing a source issue a single request; a source may declare a `ttl`
 * (serve from cache) and a `refresh` interval (poll + live-update the panels
 * bound to it). Per-panel loading / empty / error states are shown as overlays.
 *
 * @module renderDashboard
 */

import { validateSpec } from './validateSpec.js';
import { injectStyles } from './styles.js';
import { createDataStore, isEmptyData } from './dataStore.js';
import { gridTemplate, cellArea } from './gridLayout.js';

/**
 * Render a dashboard into a target element.
 *
 * @param {object} spec - The dashboard spec (see schema/dashboard.schema.json).
 * @param {(HTMLElement|string)} target - Container element or its id.
 * @param {object} [options] - Renderer options.
 * @param {*} [options.CanvasXpress] - CanvasXpress constructor; defaults to the
 *   global `CanvasXpress`.
 * @param {function} [options.fetch] - fetch implementation for connector data;
 *   defaults to the global `fetch`.
 * @param {Map} [options.cache] - Cache map for connector sources; defaults to a
 *   process-wide shared cache. Pass `new Map()` to isolate this dashboard.
 * @param {number} [options.ttl] - Default cache lifetime (ms) for connector
 *   sources without their own `ttl`.
 * @param {boolean} [options.validate=true] - Validate the spec before rendering.
 * @param {function} [options.onPanelRendered] - Called after each panel's
 *   instance is created, with `{ panelId, item, cell, canvas, body, instance }`.
 *   Used by the builder to attach editing chrome (drag/resize/customize) to
 *   live panels.
 * @returns {Promise<DashboardHandle>} A handle exposing the created instances
 *   and a `destroy()` cleanup.
 */
export function renderDashboard(spec, target, options) {
  options = options || {};
  var validate = options.validate !== false;

  if (validate) {
    var result = validateSpec(spec);
    if (!result.valid) {
      throw new Error('Invalid dashboard spec:\n  - ' + result.errors.join('\n  - '));
    }
  }

  var CX = options.CanvasXpress || (typeof globalThis !== 'undefined' ? globalThis.CanvasXpress : undefined);
  if (typeof CX !== 'function') {
    throw new Error('CanvasXpress constructor not found. Load canvasXpress.min.js or pass options.CanvasXpress.');
  }

  var container = resolveElement(target);
  if (!container) {
    throw new Error('Dashboard target element not found.');
  }

  var doFetch = options.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
  var broadcastGroup = spec.broadcastGroup || spec.id;
  // Margin (px) left around each panel's graph. A spec-level `canvasInset`
  // (a dashboard setting) wins; otherwise the caller's option; otherwise 0.
  var canvasInset = typeof spec.canvasInset === 'number' ? spec.canvasInset
    : (options.canvasInset > 0 ? options.canvasInset : 0);
  var store = createDataStore({ fetch: doFetch, cache: options.cache, ttl: options.ttl });

  // Build the grid scaffold.
  injectStyles(container.ownerDocument || document);
  container.innerHTML = '';
  container.classList.add('cxd-dashboard');
  applyTheme(container, spec.theme);
  var cols = (spec.layout && spec.layout.cols) || 12;
  var rowHeight = (spec.layout && spec.layout.rowHeight) || 120;
  var gap = (spec.layout && spec.layout.gap != null) ? spec.layout.gap : 12;

  // Dashboard background (colour + optional image) fills the WHOLE container,
  // including a margin around the grid so the background shows on all sides —
  // not just in the gutters between panels.
  applyBackground(container, spec, gap);
  // Optional explicit dashboard size (px or any CSS length); unset = fill width,
  // content height.
  applySize(container, spec);

  // When a canvas margin is reserved, the graph is smaller than its cell — this
  // class centres it (see styles) so the margin is even, not all top-left.
  if (canvasInset > 0) container.classList.add('cxd-inset');
  else container.classList.remove('cxd-inset');

  var grid = document.createElement('div');
  grid.className = 'cxd-grid';
  // Gutters live only between adjacent panels (interleaved gap tracks); see
  // gridLayout. A panel's size is always h*rowHeight, independent of the gap.
  var items = (spec.layout && spec.layout.items) || [];
  var tpl = gridTemplate(items, cols, rowHeight, gap);
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = tpl.columns;
  grid.style.gridTemplateRows = tpl.rows;
  grid.style.gap = '0';
  container.appendChild(grid);

  var instances = [];
  var pending = [];        // per-cell settle promises (feed handle.ready)
  var refMemo = {};        // dataRef -> Promise<data> (one resolve per render)
  var refBindings = {};    // dataRef -> [{ instance }] (for scheduled refresh)
  var timers = [];         // refresh interval handles
  var observers = [];      // ResizeObservers keeping canvases sized to their cells

  /**
   * Resolve a named source once per render (shared object + single request).
   * @param {string} ref - Source ref name.
   * @returns {Promise<object>} Resolved data.
   */
  function resolveRef(ref) {
    if (refMemo[ref]) return refMemo[ref];
    var promise = store.resolve(ref, (spec.data || {})[ref]);
    refMemo[ref] = promise;
    return promise;
  }

  /**
   * Resolve the data a panel/control needs: inline `data`, else its `dataRef`.
   * @param {object} owner - Panel or control spec.
   * @returns {Promise<object>} Resolved data.
   */
  function resolveOwnerData(owner) {
    if (owner && owner.data != null) return Promise.resolve(owner.data);
    if (owner && owner.dataRef) return resolveRef(owner.dataRef);
    return Promise.reject(new Error('no data or dataRef for panel/control'));
  }

  /**
   * Record a rendered instance against its dataRef so scheduled refresh can
   * live-update it.
   * @param {string} ref - Source ref name (may be undefined).
   * @param {object} instance - The CanvasXpress instance.
   * @returns {void}
   */
  function bind(ref, instance) {
    if (!ref) return;
    (refBindings[ref] || (refBindings[ref] = [])).push({ instance: instance });
  }

  // --- panels laid out in the grid ---
  var renderedItems = items.slice();   // the live set of laid-out items
  var cellByPanel = {};                // panelId -> { cell, item, instance }
  var panelIdCounter = { n: 0 };       // monotonic id counter (survives add/remove)

  /**
   * Recompute the grid track template from the current item set (gutters only
   * between adjacent panels).
   * @returns {void}
   */
  function refreshTemplate() {
    var t = gridTemplate(renderedItems, cols, rowHeight, gap);
    grid.style.gridTemplateColumns = t.columns;
    grid.style.gridTemplateRows = t.rows;
  }

  /**
   * Render a single panel item into the grid (build cell, resolve data,
   * instantiate CanvasXpress, wire resize + onPanelRendered).
   * @param {object} item - Layout item.
   * @param {object} panel - Panel definition.
   * @returns {Promise<object|null>} The instance (or null on empty/error).
   */
  function renderPanelItem(item, panel) {
    var cell = buildCell(panel && panel.title);
    placeCell(cell.root, item);
    grid.appendChild(cell.root);
    cellByPanel[item.panel] = { cell: cell, item: item, instance: null };

    var canvasId = makeCanvasId(spec.id, 'panel', item.panel, panelIdCounter.n++);
    cell.canvas.id = canvasId;

    return resolveOwnerData(panel)
      .then(function (data) {
        data = projectMeasures(data, panel && panel.measures);
        if (isEmptyData(data)) { cell.setState('empty'); return null; }
        sizeCanvasToCell(cell, canvasInset);
        var config = mergeConfig(panel && panel.config, broadcastGroup, panel);
        var instance = new CX(canvasId, data, config, panel && panel.events || {});
        instances.push(instance);
        if (cellByPanel[item.panel]) cellByPanel[item.panel].instance = instance;
        bind(panel && panel.dataRef, instance);
        observeResize(cell, instance, observers, canvasInset);
        cell.setState('ready');
        if (typeof options.onPanelRendered === 'function') {
          options.onPanelRendered({
            panelId: item.panel, item: item, cell: cell.root,
            canvas: cell.canvas, body: cell.body, instance: instance
          });
        }
        return instance;
      })
      .catch(function (err) {
        cell.setState('error', String(err && err.message || err));
        return null;
      });
  }

  items.forEach(function (item) {
    pending.push(renderPanelItem(item, spec.panels[item.panel]));
  });

  // --- optional dashboard-wide controls (filter / table) ---
  var controls = spec.controls || [];
  controls.forEach(function (control, index) {
    var cell = buildCell(control.title || defaultControlTitle(control.kind));
    cell.root.classList.add('cxd-control');
    grid.appendChild(cell.root);

    var canvasId = makeCanvasId(spec.id, 'control', control.kind, index);
    cell.canvas.id = canvasId;

    pending.push(resolveOwnerData(control)
      .then(function (data) {
        if (isEmptyData(data)) { cell.setState('empty'); return; }
        sizeCanvasToCell(cell, canvasInset);
        var config = mergeConfig(controlConfig(control), broadcastGroup, control);
        var instance = new CX(canvasId, data, config, {});
        instances.push(instance);
        bind(control.dataRef, instance);
        observeResize(cell, instance, observers, canvasInset);
        cell.setState('ready');
      })
      .catch(function (err) {
        cell.setState('error', String(err && err.message || err));
      }));
  });

  // --- scheduled refresh: poll connector sources, live-update bound panels ---
  scheduleRefreshes(spec, store, refBindings, timers, CX);

  var handle = {
    spec: spec,
    container: container,
    grid: grid,
    instances: instances,
    broadcastGroup: broadcastGroup,
    store: store,
    /**
     * Resolves once every panel and control has settled (rendered, empty, or
     * errored). Useful for tests and for knowing the first paint is complete.
     * @type {Promise<void>}
     */
    ready: Promise.all(pending).then(function () {}),
    /**
     * Add one panel to the live grid without touching the existing instances
     * (so their state — e.g. customizer edits — is preserved). The builder uses
     * this instead of a full re-render when a panel is added.
     * @param {object} item - The new layout item (`{panel, x, y, w, h}`).
     * @param {object} panel - The new panel definition.
     * @param {object[]} [allItems] - The full current item set (for the grid
     *   template); defaults to the previously-rendered set plus the new item.
     * @returns {Promise<object|null>} The created instance.
     */
    addPanel: function (item, panel, allItems) {
      renderedItems = allItems ? allItems.slice() : renderedItems.concat([item]);
      refreshTemplate();
      return renderPanelItem(item, panel);
    },
    /**
     * Remove one panel from the live grid, destroying only its instance.
     * @param {string} panelId - The panel id to remove.
     * @param {object[]} [allItems] - The full remaining item set (for the grid
     *   template); defaults to the rendered set minus this panel.
     * @returns {void}
     */
    removePanel: function (panelId, allItems) {
      var entry = cellByPanel[panelId];
      if (entry) {
        if (entry.instance) {
          try { if (typeof entry.instance.destroy === 'function') entry.instance.destroy(); } catch (e) { /* noop */ }
          var i = instances.indexOf(entry.instance);
          if (i >= 0) instances.splice(i, 1);
        }
        if (entry.cell.root.parentNode) entry.cell.root.parentNode.removeChild(entry.cell.root);
        delete cellByPanel[panelId];
      }
      renderedItems = allItems ? allItems.slice()
        : renderedItems.filter(function (it) { return it.panel !== panelId; });
      refreshTemplate();
    },
    /**
     * Tear down the dashboard: stop refresh timers, destroy CanvasXpress
     * instances, and clear the DOM.
     * @returns {void}
     */
    destroy: function () {
      timers.forEach(function (t) { clearInterval(t); });
      timers.length = 0;
      observers.forEach(function (o) { try { o.disconnect(); } catch (e) { /* noop */ } });
      observers.length = 0;
      instances.forEach(function (instance) {
        try {
          if (instance && typeof instance.destroy === 'function') instance.destroy();
        } catch (e) { /* best-effort cleanup */ }
      });
      instances.length = 0;
      container.innerHTML = '';
    }
  };
  return Promise.resolve(handle);
}

/**
 * Start a polling timer for every connector source that declares a `refresh`
 * interval (seconds). On each tick the source is invalidated and refetched, and
 * every bound instance is live-updated via `updateData`.
 * @param {object} spec - The dashboard spec.
 * @param {DataStore} store - The data store.
 * @param {object} refBindings - dataRef -> [{ instance }].
 * @param {number[]} timers - Array collecting interval handles for cleanup.
 * @param {*} CX - CanvasXpress constructor (unused; reserved for re-instantiation).
 * @returns {void}
 * @private
 */
function scheduleRefreshes(spec, store, refBindings, timers, CX) {
  var sources = spec.data || {};
  Object.keys(sources).forEach(function (ref) {
    var source = sources[ref];
    if (!source || source.kind !== 'connector' || !(source.refresh > 0)) return;
    var handle = setInterval(function () {
      store.invalidate(ref, source);
      store.resolve(ref, source, { force: true }).then(function (data) {
        var bound = refBindings[ref] || [];
        bound.forEach(function (binding) {
          var instance = binding.instance;
          if (instance && typeof instance.updateData === 'function') {
            try { instance.updateData(data, true, false); } catch (e) { /* keep polling */ }
          }
        });
      }).catch(function () { /* transient error: keep polling */ });
    }, source.refresh * 1000);
    timers.push(handle);
  });
}

/**
 * Resolve a target that may be an element or an element id.
 * @param {(HTMLElement|string)} target - Element or id.
 * @returns {HTMLElement|null} The resolved element.
 * @private
 */
function resolveElement(target) {
  if (typeof target === 'string') return document.getElementById(target);
  return target || null;
}

/**
 * Merge a panel/control config with the dashboard's broadcast wiring.
 * User config wins; broadcast defaults are only filled when unset.
 * @param {object} config - The panel's own config (passed straight to CanvasXpress).
 * @param {string} broadcastGroup - The dashboard coordination domain.
 * @param {object} owner - Panel or control (may carry an explicit broadcast flag).
 * @returns {object} A new merged config object.
 * @private
 */
function mergeConfig(config, broadcastGroup, owner) {
  var merged = {};
  if (config) {
    for (var k in config) {
      if (Object.prototype.hasOwnProperty.call(config, k)) merged[k] = config[k];
    }
  }
  if (!Object.prototype.hasOwnProperty.call(merged, 'broadcastGroup')) {
    merged.broadcastGroup = broadcastGroup;
  }
  // Per-panel opt-out: `broadcast: false` on the panel disables coordination.
  if (owner && owner.broadcast === false && !Object.prototype.hasOwnProperty.call(merged, 'broadcast')) {
    merged.broadcast = false;
  }
  return merged;
}

/**
 * Default CanvasXpress config for a control widget.
 * @param {object} control - The control spec.
 * @returns {object} Config to pass to CanvasXpress.
 * @private
 */
function controlConfig(control) {
  var base = control.config ? shallowClone(control.config) : {};
  if (control.kind === 'table') {
    if (base.view == null) base.view = 'table';
  } else if (control.kind === 'filter') {
    if (base.view == null) base.view = 'table';
    if (base.showFilter == null) base.showFilter = true;
  }
  return base;
}

/**
 * Human-readable default title for a control.
 * @param {string} kind - Control kind.
 * @returns {string} A title.
 * @private
 */
function defaultControlTitle(kind) {
  return kind === 'filter' ? 'Filter' : kind === 'table' ? 'Data' : kind;
}

/**
 * Project a CanvasXpress data object down to a chosen set of numeric variables
 * (the panel's "measures"). This implements the BI metrics/dimensions model:
 * a panel bound to a shared source can plot just the columns it cares about,
 * while the source stays shared (single fetch, one broadcast domain).
 *
 * Returns the data unchanged when no measures are specified or none match, so
 * "no selection" means "all variables". Samples (`smps`) and annotations
 * (`x`) are preserved; variable annotations (`z`) are sliced in step.
 *
 * @param {object} data - A CanvasXpress data object (`{y:{vars,smps,data}, x?, z?}`).
 * @param {string[]} [measures] - Variable names to keep, in the given order.
 * @returns {object} A new data object with only the selected variables, or the
 *   original when there's nothing to project.
 * @private
 */
function projectMeasures(data, measures) {
  if (!measures || !measures.length) return data;
  if (!data || !data.y || !Array.isArray(data.y.vars)) return data;

  var indices = [];
  var keptVars = [];
  measures.forEach(function (name) {
    var idx = data.y.vars.indexOf(name);
    if (idx !== -1) { indices.push(idx); keptVars.push(name); }
  });
  if (!keptVars.length) return data;

  var y = {};
  for (var k in data.y) { if (Object.prototype.hasOwnProperty.call(data.y, k)) y[k] = data.y[k]; }
  y.vars = keptVars;
  y.data = indices.map(function (i) { return data.y.data ? data.y.data[i] : undefined; });

  var out = {};
  for (var j in data) { if (Object.prototype.hasOwnProperty.call(data, j)) out[j] = data[j]; }
  out.y = y;

  // Slice per-variable annotations (z) to match, when present.
  if (data.z && typeof data.z === 'object') {
    var z = {};
    Object.keys(data.z).forEach(function (key) {
      var col = data.z[key];
      z[key] = Array.isArray(col) ? indices.map(function (i) { return col[i]; }) : col;
    });
    out.z = z;
  }
  return out;
}

/**
 * Size a cell's `<canvas>` drawing buffer to its laid-out pixel box.
 *
 * CanvasXpress falls back to a fixed 500×500 buffer when the canvas has no
 * width/height *attributes* — CSS `100%` only stretches that buffer, so graphs
 * would not fill the panel. Setting the attributes to the measured box makes the
 * graph render at the cell's real size. No-op in non-browser/unlaid-out contexts.
 *
 * @param {object} cell - A cell from {@link buildCell} (has `canvas` + `body`).
 * @param {number} [inset=0] - Px to subtract from width/height (right+bottom margin).
 * @returns {void}
 * @private
 */
function sizeCanvasToCell(cell, inset) {
  inset = inset || 0;
  // Measure the body (the stable available area); the canvas itself becomes
  // smaller once CanvasXpress sizes it, so measuring it would compound the inset.
  var box = measureBox(cell.body) || measureBox(cell.canvas);
  if (!box) return;
  var w = box.w - inset;
  var h = box.h - inset;
  if (w < 5 || h < 5) return;
  cell.canvas.width = w;
  cell.canvas.height = h;
}

/**
 * Keep an instance's canvas sized to its cell as the container reflows
 * (window resize, grid changes). Uses ResizeObserver where available.
 *
 * @param {object} cell - The cell (has `body`).
 * @param {object} instance - The CanvasXpress instance (has `setDimensions`).
 * @param {Array} observers - Collector for created observers (for cleanup).
 * @param {number} [inset=0] - Px to subtract from width/height (right+bottom margin).
 * @returns {void}
 * @private
 */
function observeResize(cell, instance, observers, inset) {
  if (typeof ResizeObserver === 'undefined') return;
  if (typeof instance.setDimensions !== 'function') return;
  inset = inset || 0;
  var last = { w: cell.canvas.width, h: cell.canvas.height };
  var ro = new ResizeObserver(function () {
    var box = measureBox(cell.body) || measureBox(cell.canvas);
    if (!box) return;
    var w = box.w - inset;
    var h = box.h - inset;
    if (w < 5 || h < 5) return;
    if (w === last.w && h === last.h) return;
    last = { w: w, h: h };
    try { instance.setDimensions(w, h); } catch (e) { /* keep observing */ }
  });
  ro.observe(cell.body);
  observers.push(ro);
}

/**
 * Measure an element's pixel box, rounding down. Returns null when measurement
 * isn't possible (no layout / non-browser).
 * @param {HTMLElement} el - Element to measure.
 * @returns {{w:number, h:number}|null} The integer box, or null.
 * @private
 */
function measureBox(el) {
  if (!el) return null;
  if (typeof el.getBoundingClientRect === 'function') {
    var rect = el.getBoundingClientRect();
    if (rect && rect.width) return { w: Math.floor(rect.width), h: Math.floor(rect.height) };
  }
  if (el.clientWidth) return { w: el.clientWidth, h: el.clientHeight };
  return null;
}

/**
 * Position a grid cell using its layout item.
 * @param {HTMLElement} el - The cell element.
 * @param {object} item - Layout item with x/y/w/h.
 * @returns {void}
 * @private
 */
function placeCell(el, item) {
  var area = cellArea(item);
  el.style.gridColumn = area.column;
  el.style.gridRow = area.row;
}

/**
 * Build a panel cell (title bar, canvas, state overlay).
 * @param {string} [title] - Optional panel title.
 * @returns {{root: HTMLElement, canvas: HTMLElement, setState: function, pending: (Promise|null)}}
 *   The cell parts.
 * @private
 */
function buildCell(title) {
  var root = document.createElement('div');
  root.className = 'cxd-panel';

  if (title) {
    var header = document.createElement('div');
    header.className = 'cxd-panel-title';
    header.textContent = title;
    root.appendChild(header);
  }

  var body = document.createElement('div');
  body.className = 'cxd-panel-body';
  root.appendChild(body);

  var canvas = document.createElement('canvas');
  canvas.className = 'cxd-canvas';
  body.appendChild(canvas);

  var overlay = document.createElement('div');
  overlay.className = 'cxd-panel-overlay';
  overlay.textContent = 'Loading…';
  body.appendChild(overlay);

  return {
    root: root,
    canvas: canvas,
    body: body,
    pending: null,
    /**
     * Update the cell's visual state.
     * @param {('loading'|'ready'|'empty'|'error')} state - New state.
     * @param {string} [message] - Message for the error state.
     * @returns {void}
     */
    setState: function (state, message) {
      root.setAttribute('data-state', state);
      overlay.classList.remove('cxd-error');
      if (state === 'ready') {
        overlay.style.display = 'none';
      } else if (state === 'error') {
        overlay.style.display = 'flex';
        overlay.textContent = message || 'Error';
        overlay.classList.add('cxd-error');
      } else if (state === 'empty') {
        overlay.style.display = 'flex';
        overlay.textContent = 'No data';
      } else {
        overlay.style.display = 'flex';
        overlay.textContent = 'Loading…';
      }
    }
  };
}

/**
 * Apply a theme class to the container.
 * @param {HTMLElement} container - Dashboard container.
 * @param {('light'|'dark'|'auto')} [theme] - Theme; defaults to auto.
 * @returns {void}
 * @private
 */
function applyTheme(container, theme) {
  container.classList.remove('cxd-theme-light', 'cxd-theme-dark', 'cxd-theme-auto');
  container.classList.add('cxd-theme-' + (theme || 'auto'));
}

/**
 * Apply the dashboard background (colour and/or image) to the container so it
 * fills the entire area, and inset the grid by `gap` so the background is
 * visible as a margin around the panels (top/right/bottom/left) — matching the
 * gutters between them.
 * @param {HTMLElement} container - Dashboard container.
 * @param {object} spec - The dashboard spec (`background`, `backgroundImage`).
 * @param {number} gap - The inter-panel gap (px), reused as the outer margin.
 * @returns {void}
 * @private
 */
function applyBackground(container, spec, gap) {
  var s = container.style;
  s.boxSizing = 'border-box';
  s.padding = (gap > 0 ? gap : 0) + 'px';
  s.backgroundColor = spec.background ? spec.background : '';
  if (spec.backgroundImage) {
    s.backgroundImage = 'url("' + String(spec.backgroundImage).replace(/"/g, '\\"') + '")';
    s.backgroundSize = 'cover';
    s.backgroundPosition = 'center';
    s.backgroundRepeat = 'no-repeat';
  } else {
    s.backgroundImage = '';
  }
}

/**
 * Apply an explicit dashboard size when the spec sets `width`/`height`. A number
 * is treated as px; a string is used verbatim (e.g. "100%", "40rem"). When set,
 * the container scrolls if its content overflows. Unset = fill width, auto height.
 * @param {HTMLElement} container - Dashboard container.
 * @param {object} spec - The dashboard spec (`width`, `height`).
 * @returns {void}
 * @private
 */
function applySize(container, spec) {
  container.style.width = sizeValue(spec.width);
  container.style.height = sizeValue(spec.height);
  container.style.overflow = (sizeValue(spec.width) || sizeValue(spec.height)) ? 'auto' : '';
}

/**
 * Coerce a size setting to a CSS length string ('' when unset).
 * @param {(number|string)} value - Size value.
 * @returns {string} A CSS length, or '' when unset.
 * @private
 */
function sizeValue(value) {
  if (value == null || value === '') return '';
  return typeof value === 'number' ? value + 'px' : String(value);
}

/**
 * Build a stable, DOM-safe canvas id.
 * @param {string} dashboardId - Dashboard id.
 * @param {string} role - 'panel' or 'control'.
 * @param {string} name - Panel/control name.
 * @param {number} index - Position index (disambiguates repeats).
 * @returns {string} A sanitized element id.
 * @private
 */
function makeCanvasId(dashboardId, role, name, index) {
  var raw = 'cxd-' + dashboardId + '-' + role + '-' + name + '-' + index;
  return raw.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Shallow-clone a plain object.
 * @param {object} obj - Source object.
 * @returns {object} A new object with the same own enumerable keys.
 * @private
 */
function shallowClone(obj) {
  var out = {};
  for (var k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}
