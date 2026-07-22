/**
 * Client renderer: turn a dashboard spec into a responsive CSS-grid of
 * coordinated CanvasXpress instances.
 *
 * Phase 1 scope: inline data + a live grid + broadcast wiring + optional
 * filter/table controls. `kind: "connector"` data sources are fetched with a
 * shared request per dataRef (the richer cache/scheduled-sync story is Phase 2).
 *
 * @module renderDashboard
 */

import { validateSpec } from './validateSpec.js';
import { injectStyles } from './styles.js';

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
  var cells = [];
  var dataCache = {}; // dataRef -> Promise<data>

  // --- panels laid out in the grid ---
  var items = (spec.layout && spec.layout.items) || [];
  items.forEach(function (item, index) {
    var panel = spec.panels[item.panel];
    var cell = buildCell(panel && panel.title);
    placeCell(cell.root, item);
    grid.appendChild(cell.root);
    cells.push(cell.root);

    var canvasId = makeCanvasId(spec.id, 'panel', item.panel, index);
    cell.canvas.id = canvasId;

    var pending = resolvePanelData(spec, panel, dataCache, doFetch)
      .then(function (data) {
        var config = mergeConfig(panel && panel.config, broadcastGroup, panel);
        var instance = new CX(canvasId, data, config, panel && panel.events || {});
        instances.push(instance);
        cell.setState('ready');
        return instance;
      })
      .catch(function (err) {
        cell.setState('error', String(err && err.message || err));
        return null;
      });
    cell.pending = pending;
  });

  // --- optional dashboard-wide controls (filter / table) ---
  var controls = spec.controls || [];
  controls.forEach(function (control, index) {
    var cell = buildCell(control.title || defaultControlTitle(control.kind));
    cell.root.classList.add('cxd-control');
    grid.appendChild(cell.root);
    cells.push(cell.root);

    var canvasId = makeCanvasId(spec.id, 'control', control.kind, index);
    cell.canvas.id = canvasId;

    var refSpec = control.dataRef ? spec.data[control.dataRef] : null;
    resolveDataSource(control.dataRef, refSpec, dataCache, doFetch)
      .then(function (data) {
        var config = mergeConfig(controlConfig(control), broadcastGroup, control);
        var instance = new CX(canvasId, data, config, {});
        instances.push(instance);
        cell.setState('ready');
      })
      .catch(function (err) {
        cell.setState('error', String(err && err.message || err));
      });
  });

  var handle = {
    spec: spec,
    container: container,
    grid: grid,
    instances: instances,
    broadcastGroup: broadcastGroup,
    /**
     * Tear down the dashboard: destroy CanvasXpress instances and clear the DOM.
     * @returns {void}
     */
    destroy: function () {
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
 * Resolve the data for a panel, using inline panel data, a shared dataRef, or a
 * connector fetch. Panels that share a dataRef share a single request/object.
 * @param {object} spec - The full dashboard spec.
 * @param {object} panel - The panel definition.
 * @param {object} cache - Per-render dataRef -> Promise cache.
 * @param {function} doFetch - fetch implementation.
 * @returns {Promise<object>} The resolved CanvasXpress data.
 * @private
 */
function resolvePanelData(spec, panel, cache, doFetch) {
  if (!panel) return Promise.reject(new Error('missing panel definition'));
  if (panel.data != null) return Promise.resolve(panel.data);
  var refSpec = panel.dataRef ? (spec.data || {})[panel.dataRef] : null;
  return resolveDataSource(panel.dataRef, refSpec, cache, doFetch);
}

/**
 * Resolve a named data source (inline or connector), memoized by ref so shared
 * refs issue a single fetch.
 * @param {string} ref - The data source name (may be null for anonymous).
 * @param {object} sourceSpec - The data source spec.
 * @param {object} cache - Per-render ref -> Promise cache.
 * @param {function} doFetch - fetch implementation.
 * @returns {Promise<object>} The resolved data.
 * @private
 */
function resolveDataSource(ref, sourceSpec, cache, doFetch) {
  if (!sourceSpec) return Promise.reject(new Error('data source "' + ref + '" not found'));
  if (ref && cache[ref]) return cache[ref];

  var promise;
  if (sourceSpec.kind === 'inline') {
    promise = Promise.resolve(sourceSpec.value);
  } else if (sourceSpec.kind === 'connector') {
    if (typeof doFetch !== 'function') {
      promise = Promise.reject(new Error('no fetch available for connector source'));
    } else {
      promise = doFetch(sourceSpec.url).then(function (res) {
        if (!res || !res.ok) throw new Error('connector fetch failed: ' + (res && res.status));
        return res.json();
      });
    }
  } else {
    promise = Promise.reject(new Error('unknown data source kind "' + sourceSpec.kind + '"'));
  }

  if (ref) cache[ref] = promise;
  return promise;
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
     * @param {('loading'|'ready'|'error')} state - New state.
     * @param {string} [message] - Message for the error state.
     * @returns {void}
     */
    setState: function (state, message) {
      root.setAttribute('data-state', state);
      if (state === 'ready') {
        overlay.style.display = 'none';
      } else if (state === 'error') {
        overlay.style.display = 'flex';
        overlay.textContent = message || 'Error';
        overlay.classList.add('cxd-error');
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
