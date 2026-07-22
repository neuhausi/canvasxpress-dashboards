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
  var store = createDataStore({ fetch: doFetch, cache: options.cache, ttl: options.ttl });

  // Build the grid scaffold.
  injectStyles(container.ownerDocument || document);
  container.innerHTML = '';
  container.classList.add('cxd-dashboard');
  applyTheme(container, spec.theme);

  var grid = document.createElement('div');
  grid.className = 'cxd-grid';
  var cols = (spec.layout && spec.layout.cols) || 12;
  var rowHeight = (spec.layout && spec.layout.rowHeight) || 120;
  var gap = (spec.layout && spec.layout.gap != null) ? spec.layout.gap : 12;
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
  grid.style.gridAutoRows = rowHeight + 'px';
  grid.style.gap = gap + 'px';
  container.appendChild(grid);

  var instances = [];
  var pending = [];        // per-cell settle promises (feed handle.ready)
  var refMemo = {};        // dataRef -> Promise<data> (one resolve per render)
  var refBindings = {};    // dataRef -> [{ instance }] (for scheduled refresh)
  var timers = [];         // refresh interval handles

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
  var items = (spec.layout && spec.layout.items) || [];
  items.forEach(function (item, index) {
    var panel = spec.panels[item.panel];
    var cell = buildCell(panel && panel.title);
    placeCell(cell.root, item);
    grid.appendChild(cell.root);

    var canvasId = makeCanvasId(spec.id, 'panel', item.panel, index);
    cell.canvas.id = canvasId;

    pending.push(resolveOwnerData(panel)
      .then(function (data) {
        if (isEmptyData(data)) { cell.setState('empty'); return null; }
        var config = mergeConfig(panel && panel.config, broadcastGroup, panel);
        var instance = new CX(canvasId, data, config, panel && panel.events || {});
        instances.push(instance);
        bind(panel && panel.dataRef, instance);
        cell.setState('ready');
        return instance;
      })
      .catch(function (err) {
        cell.setState('error', String(err && err.message || err));
        return null;
      }));
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
        var config = mergeConfig(controlConfig(control), broadcastGroup, control);
        var instance = new CX(canvasId, data, config, {});
        instances.push(instance);
        bind(control.dataRef, instance);
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
     * Tear down the dashboard: stop refresh timers, destroy CanvasXpress
     * instances, and clear the DOM.
     * @returns {void}
     */
    destroy: function () {
      timers.forEach(function (t) { clearInterval(t); });
      timers.length = 0;
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
 * Position a grid cell using its layout item.
 * @param {HTMLElement} el - The cell element.
 * @param {object} item - Layout item with x/y/w/h.
 * @returns {void}
 * @private
 */
function placeCell(el, item) {
  el.style.gridColumn = (item.x + 1) + ' / span ' + item.w;
  el.style.gridRow = (item.y + 1) + ' / span ' + item.h;
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
