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
  // `baseUrl` lets `kind:"dataset"` sources resolve against a cxd_server on a
  // different origin than the page (else same-origin `/api/datasets/{id}`).
  var store = createDataStore({
    fetch: doFetch, cache: options.cache, ttl: options.ttl, baseUrl: options.baseUrl
  });
  // Auto-resize each graph to its cell (via setDimensions) when the container
  // reflows. The builder disables this and re-renders panels itself on resize,
  // which places the graph correctly where setDimensions currently offsets it.
  var autoResize = options.observeResize !== false;

  // Build the grid scaffold.
  injectStyles(container.ownerDocument || document);
  container.innerHTML = '';
  container.classList.add('cxd-dashboard');
  applyTheme(container, spec.theme);
  applyPanelColor(container, spec);
  applyDashboardFont(container, spec);
  var cols = (spec.layout && spec.layout.cols) || 12;
  var rowHeight = (spec.layout && spec.layout.rowHeight) || 30;
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
  // Uniform-gap grid (see gridLayout): equal `w` => equal width, equal `h` =>
  // equal height, with a single gutter between every track.
  var items = (spec.layout && spec.layout.items) || [];
  var tpl = gridTemplate(items, cols, rowHeight, gap);
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = tpl.columns;
  grid.style.gridTemplateRows = tpl.rows;
  grid.style.gap = tpl.gap;
  container.appendChild(grid);

  var instances = [];
  // Annotation-filter widgets: one entry per control, carrying its current
  // pick and a reset-to-All UI hook. Applying re-plays every active pick, so
  // controls combine; "All" in any control clears everything.
  var controlWidgets = [];

  /**
   * True when an instance's bound data actually carries the annotation —
   * as a sample annotation (data.x) or a variable annotation (data.z).
   * Filtering an instance on an annotation it doesn't have corrupts its
   * rendering (meters/lines on unrelated datasets), so such picks are
   * skipped per instance.
   * @param {object} inst - Live CanvasXpress instance.
   * @param {string} annotation - Annotation name.
   * @returns {boolean} Whether the annotation exists in the instance's data.
   */
  function instanceHasAnnotation(inst, annotation) {
    var d = inst && inst.data;
    if (!d || !annotation) return false;
    return !!((d.x && d.x[annotation] != null) || (d.z && d.z[annotation] != null));
  }

  /**
   * Re-apply the CURRENT set of control picks serially to every instance:
   * clear all filters, then modifyFilter('guess', annotation, 'exact', value)
   * for each control whose pick's annotation exists in that instance's data —
   * panels on unrelated datasets are left untouched (just reset). Broadcasting
   * is suppressed per call — each instance is filtered directly — and only the
   * last call redraws.
   *
   * EXACT (not 'like') is deliberate: a control pick is always one full
   * annotation category value, so it must match that value exactly. The 'like'
   * operator does a substring search, which silently over-matches whenever one
   * category value is contained in another — e.g. picking "Male" also keeps
   * "Female" ("female" contains "male"), so the filter appears to do nothing.
   * 'exact' compares the whole string, removing that whole class of bug and the
   * "annotation values must be prefix-free" authoring rule it forced on specs.
   * @returns {void}
   */
  function applyControlFilters() {
    var picks = controlWidgets.filter(function (w) { return w.value != null; });
    instances.slice().forEach(function (inst) {
      if (!inst) return;
      var applicable = picks.filter(function (w) {
        return instanceHasAnnotation(inst, w.annotation);
      });
      var savedGroup = inst.broadcastGroup;
      inst.broadcastGroup = '__cxd_annctl_serial__';
      try {
        if (!applicable.length) {
          if (typeof inst.resetDataFilter === 'function') inst.resetDataFilter(null, false);
        } else if (typeof inst.modifyFilter === 'function') {
          if (typeof inst.resetDataFilter === 'function') inst.resetDataFilter(null, true);
          applicable.forEach(function (w, i) {
            inst.modifyFilter('guess', w.annotation, 'exact', w.value, i < applicable.length - 1);
          });
        }
      } catch (e) { /* keep filtering the remaining instances */
      } finally {
        inst.broadcastGroup = savedGroup;
      }
    });
  }

  /**
   * Snap every annotation-filter control back to "All" (UI + filters), as if
   * All had been clicked. Bound to the Escape key for the dashboard's lifetime.
   * @returns {void}
   */
  function resetAllControls() {
    if (!controlWidgets.length) return;
    controlWidgets.forEach(function (w) {
      w.value = null;
      if (w.resetUI) w.resetUI();
    });
    applyControlFilters();
  }
  var doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
  var escListener = null;
  if (doc && typeof doc.addEventListener === 'function') {
    escListener = function (ev) { if (ev.key === 'Escape') resetAllControls(); };
    doc.addEventListener('keydown', escListener);
  }
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
    grid.style.gap = t.gap;
  }

  /**
   * Render a single panel item into the grid (build cell, resolve data,
   * instantiate CanvasXpress, wire resize + onPanelRendered).
   * @param {object} item - Layout item.
   * @param {object} panel - Panel definition.
   * @returns {Promise<object|null>} The instance (or null on empty/error).
   */
  function renderPanelItem(item, panel) {
    // Text/control elements never show a title bar (a control carries its own
    // inline label); graph panels can opt out via hideTitle.
    var showTitle = panel && panel.type !== 'text' && panel.type !== 'control' &&
      !panel.hideTitle && panel.title;
    var cell = buildCell(showTitle ? panel.title : null);
    placeCell(cell.root, item);
    grid.appendChild(cell.root);
    cellByPanel[item.panel] = { cell: cell, item: item, instance: null };

    // Text elements carry free-form text instead of a graph — no data or canvas.
    if (panel && panel.type === 'text') {
      renderTextPanel(cell, item, panel);
      return Promise.resolve(null);
    }

    // Annotation-filter controls render native inputs, not a graph.
    if (panel && panel.type === 'control') {
      return renderControlWidget(cell, item, panel);
    }

    var canvasId = makeCanvasId(spec.id, 'panel', item.panel, panelIdCounter.n++);
    cell.canvas.id = canvasId;

    // The host (e.g. the builder) must hear about EVERY settled panel — empty
    // and errored ones included — or it cannot decorate them (select/move/
    // delete chrome). `instance` is null and `state` says why.
    function notify(instance, state) {
      if (typeof options.onPanelRendered === 'function') {
        options.onPanelRendered({
          panelId: item.panel, item: item, cell: cell.root,
          canvas: cell.canvas, body: cell.body, instance: instance, state: state
        });
      }
    }

    return resolveOwnerData(panel)
      .then(function (data) {
        data = projectMeasures(data, panel && panel.measures);
        if (isEmptyData(data)) { cell.setState('empty'); notify(null, 'empty'); return null; }
        sizeCanvasToCell(cell, canvasInset);
        var config = mergeConfig(panel && panel.config, broadcastGroup, panel);
        applyDashboardChartStyle(config, spec);   // dashboard-wide font/theme/colors (Settings)
        var instance = new CX(canvasId, data, config, panel && panel.events || {});
        instances.push(instance);
        if (cellByPanel[item.panel]) cellByPanel[item.panel].instance = instance;
        bind(panel && panel.dataRef, instance);
        if (autoResize) observeResize(cell, instance, observers, canvasInset);
        cell.setState('ready');
        notify(instance, 'ready');
        return instance;
      })
      .catch(function (err) {
        cell.setState('error', String(err && err.message || err));
        notify(null, 'error');
        return null;
      });
  }

  /**
   * Render a text element into a cell (no data / canvas).
   * @param {object} cell - A cell from {@link buildCell}.
   * @param {object} item - The layout item.
   * @param {object} panel - The text panel (`{type:'text', text}`).
   * @returns {void}
   * @private
   */
  function renderTextPanel(cell, item, panel) {
    cell.canvas.style.display = 'none';
    // Chrome-free by default (transparent → shows the dashboard background); an
    // explicit panel.bg fills the cell.
    cell.root.classList.add('cxd-text-cell');
    if (panel && panel.bg) cell.root.style.background = panel.bg;
    var textEl = document.createElement('div');
    textEl.className = 'cxd-text';
    // Prefer rich HTML (sanitized — text renders via innerHTML and shared
    // dashboards are viewed by others); fall back to plain text.
    if (panel && panel.html != null) textEl.innerHTML = sanitizeHtml(panel.html);
    else textEl.textContent = (panel && panel.text) || '';
    if (panel && (panel.align || panel.valign)) {
      applyAlignment(cell.body, panel);
      // The text block shrinks to content height so valign can place it, but
      // keeps full width so text-align works across the cell.
      textEl.style.height = 'auto';
      textEl.style.width = '100%';
      textEl.style.textAlign = panel.align || 'left';
    }
    cell.body.appendChild(textEl);
    cell.setState('ready');
    if (typeof options.onPanelRendered === 'function') {
      options.onPanelRendered({
        panelId: item.panel, item: item, cell: cell.root,
        canvas: cell.canvas, body: cell.body, instance: null, type: 'text'
      });
    }
  }

  /**
   * Render an annotation-filter control panel: native inputs (dropdown / radio /
   * segmented buttons) whose entries are the unique values of one annotation of
   * the bound dataset. Choosing a value FILTERS the data: it calls
   * `modifyFilter('guess', annotation, 'exact', value)` on a live instance bound
   * to the same source — a registered UPDATE_FILTER action, so the dashboard's
   * shared broadcastGroup propagates it to every panel. "All" clears via
   * `resetDataFilter()` (also broadcast).
   *
   * @param {object} cell - The cell from {@link buildCell}.
   * @param {object} item - The layout item.
   * @param {object} panel - The control panel (`{type:'control', dataRef,
   *   compartment, annotation, style, title}`).
   * @returns {Promise<null>} Resolves when the widget has settled.
   */
  function renderControlWidget(cell, item, panel) {
    cell.canvas.style.display = 'none';
    cell.root.classList.add('cxd-annctl-cell');

    function notify(state) {
      if (typeof options.onPanelRendered === 'function') {
        options.onPanelRendered({
          panelId: item.panel, item: item, cell: cell.root,
          canvas: cell.canvas, body: cell.body, instance: null,
          type: 'control', state: state
        });
      }
    }

    // The compartment the annotation actually lives in; re-detected below in
    // case the spec's stored value (or its 'x' default) doesn't match the data.
    var comp = panel.compartment || 'x';

    return resolveOwnerData(panel)
      .then(function (data) {
        var values = annotationValues(data, comp, panel.annotation);
        if (!values.length) {
          // Auto-detect: the name may be a variable annotation ('z') instead.
          var other = comp === 'x' ? 'z' : 'x';
          var alt = annotationValues(data, other, panel.annotation);
          if (alt.length) { comp = other; values = alt; }
        }
        var widget = document.createElement('div');
        widget.className = 'cxd-annctl';
        applyAlignment(cell.body, panel);
        if (panel.title && !panel.hideTitle) {
          var label = document.createElement('span');
          label.className = 'cxd-annctl-label';
          label.textContent = panel.title;
          widget.appendChild(label);
        }
        if (!panel.annotation || !values.length) {
          var hint = document.createElement('span');
          hint.className = 'cxd-annctl-hint';
          hint.textContent = !panel.annotation
            ? 'Choose an annotation…'
            : 'No "' + panel.annotation + '" values';
          widget.appendChild(hint);
        } else {
          var entry = { annotation: panel.annotation, value: null, resetUI: null };
          controlWidgets.push(entry);
          var input = buildAnnotationInput(panel, values, function (value) {
            entry.value = value;
            if (value == null) {
              // "All" clears EVERY control's filter — snap the others to All
              // too. A value pick touches only this control; the other picks
              // stay and combine.
              controlWidgets.forEach(function (w) {
                w.value = null;
                if (w !== entry && w.resetUI) w.resetUI();
              });
            }
            applyControlFilters();
          });
          entry.resetUI = input._cxdResetToAll;
          widget.appendChild(input);
        }
        cell.body.appendChild(widget);
        cell.setState('ready');
        notify('ready');
        return null;
      })
      .catch(function (err) {
        cell.setState('error', String(err && err.message || err));
        notify('error');
        return null;
      });
  }

  items.forEach(function (item) {
    pending.push(renderPanelItem(item, spec.panels[item.panel]));
  });

  // --- optional dashboard-wide controls (filter / table) ---
  var controls = spec.controls || [];
  // Controls live OUTSIDE the grid: panels are placed explicitly by span, and
  // CSS auto-placement cannot be trusted to slot an un-placed item around them
  // (it can overlap a panel's row, rendering as a sliver). A plain full-width
  // strip below the grid sidesteps the grid math entirely.
  var controlsHost = null;
  if (controls.length) {
    controlsHost = document.createElement('div');
    controlsHost.className = 'cxd-controls';
    container.appendChild(controlsHost);
  }
  controls.forEach(function (control, index) {
    var cell = buildCell(control.title || defaultControlTitle(control.kind));
    cell.root.classList.add('cxd-control');
    // A control's height comes from its own spec entry when set (the builder's
    // resize handle persists it there); otherwise it scales with the grid's
    // row height, floored at 400px — table chrome plus at least six data rows,
    // even when the dataset itself has fewer.
    var ctlHeight = (typeof control.height === 'number' && control.height >= 80)
      ? control.height
      : Math.max(rowHeight * 2, 400);
    cell.root.style.height = ctlHeight + 'px';
    cell.root.style.marginTop = gap + 'px';
    controlsHost.appendChild(cell.root);

    var canvasId = makeCanvasId(spec.id, 'control', control.kind, index);
    cell.canvas.id = canvasId;

    // Hosts (e.g. the builder) hear about every settled control so they can
    // decorate it (delete/resize chrome), mirroring onPanelRendered.
    function notifyControl(instance, state) {
      if (typeof options.onControlRendered === 'function') {
        options.onControlRendered({
          control: control, index: index, cell: cell.root,
          canvas: cell.canvas, body: cell.body, instance: instance, state: state
        });
      }
    }

    pending.push(resolveOwnerData(control)
      .then(function (data) {
        if (isEmptyData(data)) { cell.setState('empty'); notifyControl(null, 'empty'); return; }
        sizeCanvasToCell(cell, canvasInset);
        var config = mergeConfig(controlConfig(control), broadcastGroup, control);
        applyDashboardChartStyle(config, spec);   // dashboard-wide font/theme/colors (Settings)
        var instance = new CX(canvasId, data, config, {});
        instances.push(instance);
        bind(control.dataRef, instance);
        if (autoResize) observeResize(cell, instance, observers, canvasInset);
        cell.setState('ready');
        notifyControl(instance, 'ready');
      })
      .catch(function (err) {
        cell.setState('error', String(err && err.message || err));
        notifyControl(null, 'error');
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
      if (escListener && doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('keydown', escListener);
        escListener = null;
      }
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
/**
 * Config keys that are session state, not authored intent. A spec can carry
 * them anyway (an old builder save, a hand-edited JSON, an imported spec) and
 * CanvasXpress applies them at construction — a serialized broadcast filter
 * (filterSmpBy/filterVarBy) then crashes init ("Cannot read properties of
 * null") and bricks the whole page. Stripped defensively on EVERY render, so
 * a polluted spec degrades to "renders unfiltered" instead of "renders
 * nothing".
 * @type {Object<string, boolean>}
 * @private
 */
var UNSAFE_CONFIG_KEYS = { filterSmpBy: true, filterVarBy: true };

function mergeConfig(config, broadcastGroup, owner) {
  var merged = {};
  if (config) {
    for (var k in config) {
      if (Object.prototype.hasOwnProperty.call(config, k) && !UNSAFE_CONFIG_KEYS[k]) {
        merged[k] = config[k];
      }
    }
  }
  if (!Object.prototype.hasOwnProperty.call(merged, 'broadcastGroup')) {
    merged.broadcastGroup = broadcastGroup;
  }
  // Per-panel opt-out: `broadcast: false` on the panel disables coordination.
  if (owner && owner.broadcast === false && !Object.prototype.hasOwnProperty.call(merged, 'broadcast')) {
    merged.broadcast = false;
  }
  // The dashboard coordinates cross-panel filtering itself via the annotation
  // "+ Control" (applyControlFilters -> modifyFilter on a private broadcastGroup),
  // so disable CanvasXpress's own DataFilter-UI filter broadcast (broadcastFilter,
  // default true in the engine) to avoid double-applying / fighting the control.
  // A panel/control config may still re-enable it explicitly.
  if (!Object.prototype.hasOwnProperty.call(merged, 'broadcastFilter')) {
    merged.broadcastFilter = false;
  }
  // Every dashboard graph is sized by its cell, never by CanvasXpress's own
  // interactive resizer — that native corner-drag handle conflicts with the
  // builder's resize handle. Panels resize via an explicit setDimensions() call
  // when their cell changes (see resizeInstance). A panel may still override.
  if (!Object.prototype.hasOwnProperty.call(merged, 'resizable')) {
    merged.resizable = false;
  }
  // Dashboard panels are viewed at a distance — scale CanvasXpress's canvas
  // text (axes, legends, ticks) up from its compact default. A panel/control
  // config may override or reset with its own fontScaleFontFactor.
  if (!Object.prototype.hasOwnProperty.call(merged, 'fontScaleFontFactor')) {
    merged.fontScaleFontFactor = 1.3;
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
    if (base.dataTableToolbarShow == null) base.dataTableToolbarShow = false;
  } else if (control.kind === 'filter') {
    if (base.view == null) base.view = 'table';
    if (base.showFilter == null) base.showFilter = true;
    if (base.dataTableToolbarShow == null) base.dataTableToolbarShow = false;
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
  if (!data || Array.isArray(data) || !data.y || !Array.isArray(data.y.vars)) return data;

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
 * The unique values of one annotation of a data object, in first-appearance
 * order. Null/undefined entries are skipped; values keep their type (they are
 * compared with `==` by `selectVarsSmpsWithAnnotationValue`).
 *
 * @param {object} data - A CanvasXpress data object (`{y, x?, z?}`).
 * @param {('x'|'z')} compartment - 'x' = sample annotations, 'z' = variable annotations.
 * @param {string} annotation - The annotation name.
 * @returns {Array} Unique values (empty when the annotation is absent).
 */
export function annotationValues(data, compartment, annotation) {
  var col;
  if (Array.isArray(data)) {
    // Tabular 2D array (header row + data rows) — the shape stored datasets
    // keep. Its columns are sample-scoped, so 'z' has nothing to offer.
    if (compartment === 'z' || !data.length) return [];
    var idx = data[0].indexOf(annotation);
    if (idx < 0) return [];
    col = data.slice(1).map(function (row) { return row[idx]; });
  } else {
    col = data && data[compartment] && data[compartment][annotation];
  }
  if (!Array.isArray(col)) return [];
  var seen = {};
  var out = [];
  col.forEach(function (v) {
    if (v == null || String(v).trim() === '') return;
    var key = typeof v + ':' + String(v);
    if (seen[key]) return;
    seen[key] = true;
    out.push(v);
  });
  return out;
}

/**
 * The annotation names available on a data object for a compartment. For a
 * tabular 2D array (header + rows), the sample annotations are the non-numeric
 * columns after the first (id) column — mirroring the `csvToCx` reshape that
 * CanvasXpress applies when it parses the array.
 * @param {(object|Array)} data - A CanvasXpress data object or tabular array.
 * @param {('x'|'z')} compartment - 'x' (samples) or 'z' (variables).
 * @returns {string[]} Annotation names (empty when none).
 */
export function annotationNames(data, compartment) {
  if (Array.isArray(data)) {
    if (compartment === 'z' || data.length < 2) return [];
    var header = data[0];
    var rows = data.slice(1);
    var names = [];
    for (var c = 1; c < header.length; c++) {
      if (!isNumericColumn(rows, c)) names.push(header[c]);
    }
    return names;
  }
  var comp = data && data[compartment];
  return comp && typeof comp === 'object' ? Object.keys(comp) : [];
}

/**
 * Whether every non-blank cell of a tabular column is numeric (and at least
 * one is) — the same rule `csvToCx` uses to split measures from annotations.
 * @param {Array<Array>} rows - Tabular data rows (no header).
 * @param {number} col - Column index.
 * @returns {boolean} True for a numeric measure column.
 * @private
 */
function isNumericColumn(rows, col) {
  var sawNumber = false;
  for (var i = 0; i < rows.length; i++) {
    var cell = rows[i][col];
    if (cell == null || String(cell).trim() === '') continue;
    var n = Number(cell);
    if (isNaN(n) || !isFinite(n)) return false;
    sawNumber = true;
  }
  return sawNumber;
}

/**
 * Build the input element for an annotation-filter control. `style: 'auto'`
 * picks segmented buttons for up to 4 values and a dropdown above that. Every
 * variant leads with an "All" choice that clears the selection (apply(null)).
 *
 * @param {object} panel - The control panel (reads `style`, `annotation`).
 * @param {Array} values - Unique annotation values.
 * @param {function(*): void} apply - Called with the chosen value (null = All).
 * @returns {HTMLElement} The input element.
 * @private
 */
function buildAnnotationInput(panel, values, apply) {
  var style = panel.style || 'auto';
  if (style === 'auto') style = values.length <= 4 ? 'buttons' : 'dropdown';

  if (style === 'dropdown') {
    var select = document.createElement('select');
    select.className = 'cxd-annctl-select';
    ['All'].concat(values.map(String)).forEach(function (label, i) {
      var o = document.createElement('option');
      o.value = String(i);   // index; 0 = All (values may repeat as strings)
      o.textContent = label;
      select.appendChild(o);
    });
    listen(select, 'change', function () {
      var idx = parseInt(select.value, 10);
      apply(idx > 0 ? values[idx - 1] : null);
    });
    select._cxdResetToAll = function () { select.value = '0'; };
    return select;
  }

  if (style === 'radio') {
    var group = document.createElement('span');
    group.className = 'cxd-annctl-radios';
    // Radios group by name; scope it to this element so two controls bound to
    // the same annotation stay independent.
    var name = 'cxd-annctl-' + Math.random().toString(36).slice(2, 8);
    [null].concat(values).forEach(function (value) {
      var label = document.createElement('label');
      label.className = 'cxd-annctl-radio';
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      if (value === null) input.checked = true;
      listen(input, 'change', function () { if (input.checked) apply(value); });
      var text = document.createElement('span');
      text.textContent = value === null ? 'All' : String(value);
      label.appendChild(input);
      label.appendChild(text);
      group.appendChild(label);
    });
    group._cxdResetToAll = function () {
      var first = group.querySelector('input');
      if (first) first.checked = true;
    };
    return group;
  }

  // Segmented buttons.
  var seg = document.createElement('span');
  seg.className = 'cxd-annctl-seg';
  var buttons = [];
  [null].concat(values).forEach(function (value) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cxd-annctl-segbtn' + (value === null ? ' cxd-annctl-on' : '');
    btn.textContent = value === null ? 'All' : String(value);
    listen(btn, 'click', function () {
      buttons.forEach(function (b) { b.classList.remove('cxd-annctl-on'); });
      btn.classList.add('cxd-annctl-on');
      apply(value);
    });
    buttons.push(btn);
    seg.appendChild(btn);
  });
  seg._cxdResetToAll = function () {
    buttons.forEach(function (b) { b.classList.remove('cxd-annctl-on'); });
    if (buttons[0]) buttons[0].classList.add('cxd-annctl-on');   // "All" is first
  };
  return seg;
}

/**
 * Position a text/control panel's content within its grid cell per the panel's
 * `align` (left|center|right) and `valign` (top|middle|bottom). The body
 * becomes a flex column so the content block sits anywhere in the cell.
 * @param {HTMLElement} body - The `.cxd-panel-body` element.
 * @param {object} panel - The panel (reads `align`, `valign`).
 * @returns {void}
 * @private
 */
function applyAlignment(body, panel) {
  var h = { left: 'flex-start', center: 'center', right: 'flex-end' };
  var v = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.alignItems = h[panel.align] || 'flex-start';
  body.style.justifyContent = v[panel.valign] || 'flex-start';
}

/**
 * Add an event listener when the element supports it (the test DOM stub does
 * not), mirroring the builder's `on()` guard.
 * @param {HTMLElement} node - Target element.
 * @param {string} type - Event type.
 * @param {function} handler - Listener.
 * @returns {void}
 * @private
 */
function listen(node, type, handler) {
  if (node && typeof node.addEventListener === 'function') node.addEventListener(type, handler);
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
  var timer = null;

  // Apply the current cell size to the graph. This triggers a full CanvasXpress
  // redraw, so it's debounced below rather than run on every reflow tick.
  function applySize() {
    timer = null;
    var box = measureBox(cell.body) || measureBox(cell.canvas);
    if (!box) return;
    var w = box.w - inset;
    var h = box.h - inset;
    if (w < 5 || h < 5) return;
    if (w === last.w && h === last.h) return;
    last = { w: w, h: h };
    resizeInstance(instance, w, h);
  }

  var ro = new ResizeObserver(function () {
    // Debounce: during a builder drag-resize (or a window drag) the cell reflows
    // continuously — wait ~180ms for it to settle, then do the one redraw. This
    // is what makes the graph resize "after a moment" instead of thrashing.
    if (timer) clearTimeout(timer);
    timer = setTimeout(applySize, RESIZE_DEBOUNCE_MS);
  });
  ro.observe(cell.body);
  // Cleanup must also drop any pending timer so it can't fire post-destroy.
  observers.push({ disconnect: function () {
    if (timer) { clearTimeout(timer); timer = null; }
    ro.disconnect();
  } });
}

/** Debounce window (ms) for reflowing a graph to its resized cell. */
var RESIZE_DEBOUNCE_MS = 180;

/**
 * Resize a CanvasXpress instance to (w, h) by calling `setDimensions`.
 *
 * Instances are built with `resizable: false` (mergeConfig), so CanvasXpress's
 * native corner-drag resizer stays off and never fights the builder's handle;
 * the graph follows its cell purely through this explicit call.
 *
 * @param {object} instance - The CanvasXpress instance.
 * @param {number} w - Target width (px).
 * @param {number} h - Target height (px).
 * @returns {void}
 */
export function resizeInstance(instance, w, h) {
  if (!instance || typeof instance.setDimensions !== 'function') return;
  if (w < 5 || h < 5) return;
  // Instances are built with `resizable: false` so CanvasXpress's native
  // corner-drag resizer never arms (it checks the flag live at mousedown). But
  // the published `setDimensions` also gates on that same flag (`if
  // (!this.resizable) return`), so we enable it only for this synchronous call
  // and restore it immediately — the native resizer never sees it true during
  // user interaction. (Once the library's setDimensions no longer gates on
  // `resizable`, this toggle can be removed.)
  var wasResizable = instance.resizable;
  var wasResizableX = instance.resizableX;
  var wasResizableY = instance.resizableY;
  instance.resizable = true;
  instance.resizableX = true;
  instance.resizableY = true;
  try { instance.setDimensions(w, h); } catch (e) { /* keep observing */ }
  instance.resizable = wasResizable;
  instance.resizableX = wasResizableX;
  instance.resizableY = wasResizableY;
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
 * Apply dashboard-wide chart styling (font, theme, color scheme) onto a single
 * chart/control config as defaults — only when the dashboard sets them and the
 * chart hasn't already specified its own. Mutates `config` in place.
 * @param {object} config - The chart's merged CanvasXpress config.
 * @param {object} spec - The dashboard spec (`fontName`, `theme`, `colorScheme`).
 * @returns {void}
 * @private
 */
function applyDashboardChartStyle(config, spec) {
  if (spec.fontName && !Object.prototype.hasOwnProperty.call(config, 'fontName')) {
    config.fontName = spec.fontName;
  }
  // Theme and color scheme are dashboard-WIDE controls: when the dashboard sets
  // one it OVERRIDES any per-panel value, so selecting a theme restyles every
  // graph. (Saved/AI-generated specs commonly bake theme:'auto' into each panel
  // config; without the override that baked value would win and the dashboard
  // theme would silently no-op.) 'auto' is a valid value — the engine resolves
  // it to its light/dark pair.
  if (spec.theme) {
    config.theme = spec.theme;
  }
  if (spec.colorScheme) {
    config.colorScheme = spec.colorScheme;
  }
}

/**
 * Apply the dashboard shell (chrome) theme class to the container. The chrome is
 * only light or dark; we derive which from the chosen CanvasXpress library
 * theme's panel background luminance (read from the library), so e.g. `cxdark`
 * and `cxblue` yield the dark chrome. The literal `auto` keeps the old
 * OS-following behavior via the `cxd-theme-auto` class.
 * @param {HTMLElement} container - Dashboard container.
 * @param {string} [theme] - A CanvasXpress theme name, or `auto` (default).
 * @returns {void}
 * @private
 */
function applyTheme(container, theme) {
  container.classList.remove('cxd-theme-light', 'cxd-theme-dark', 'cxd-theme-auto');
  if (!theme || theme === 'auto') {
    container.classList.add('cxd-theme-auto');
    return;
  }
  var bg = themeBackground(theme);
  container.classList.add(isDarkColor(bg) ? 'cxd-theme-dark' : 'cxd-theme-light');
}

/**
 * Look up a CanvasXpress library theme's panel background color from the loaded
 * library (`CanvasXpress.themeDef`). Returns a CSS color string, or '' when the
 * theme, the library, or an explicit fill can't be resolved (transparent panel).
 * @param {string} theme - A CanvasXpress theme name (e.g. 'cxdark', 'economist').
 * @returns {string} The panel background color, or '' if none/transparent.
 * @private
 */
function themeBackground(theme) {
  var CanvasXpress = (typeof window !== 'undefined' && window.CanvasXpress) || null;
  if (!CanvasXpress || !CanvasXpress.themeDef) return '';
  var key = String(theme).toLowerCase().replace(/[\s_]+/g, '');
  if (key === 'auto') {
    // Follow the OS like the engine does: resolve to the cx light/dark pair.
    var prefersDark = typeof window !== 'undefined' && window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    key = prefersDark ? 'cxdark' : 'cx';
  }
  var def = CanvasXpress.themeDef[key];
  if (!def) return '';
  var fill = def['panel.background.fill'];
  if (!fill || fill === 'element_blank') fill = def['plot.background.fill'];
  return (fill && fill !== 'element_blank') ? fill : '';
}

/**
 * Decide whether a CSS hex color reads as "dark" (so the shell chrome should use
 * its dark variant). Non-hex or empty inputs are treated as light.
 * @param {string} color - A `#rgb`/`#rrggbb` color string.
 * @returns {boolean} True when the color's perceived luminance is low.
 * @private
 */
function isDarkColor(color) {
  var m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(color || '').trim());
  if (!m) return false;
  var hex = m[1];
  if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
  var r = parseInt(hex.substr(0, 2), 16);
  var g = parseInt(hex.substr(2, 2), 16);
  var b = parseInt(hex.substr(4, 2), 16);
  // Rec. 601 luma; < 128 is dark.
  return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

/**
 * Resolve the dashboard's effective background colour: the theme's panel
 * background when `coordinateBackground` is set (read from the library), else
 * the spec's own `background`, else '' (transparent — the container shows
 * through to the theme chrome).
 * @param {object} spec - The dashboard spec.
 * @returns {string} A CSS colour, or '' for none.
 * @private
 */
function effectiveBackground(spec) {
  var coordinated = spec.coordinateBackground ? themeBackground(spec.theme) : '';
  return coordinated || (spec.background ? spec.background : '');
}

/**
 * Resolve the dashboard's panel-chrome colour: the effective background when
 * `coordinatePanel` is set (so the panels blend into the background and read as
 * borderless), else the spec's own `panelColor`, else '' (keep the theme's
 * chrome).
 * @param {object} spec - The dashboard spec.
 * @returns {string} A CSS colour, or '' for none.
 * @private
 */
function effectivePanelColor(spec) {
  if (spec.coordinatePanel) return effectiveBackground(spec);
  return spec.panelColor ? spec.panelColor : '';
}

/**
 * Paint the panel chrome (title bar, panel background, and border) a single
 * colour by overriding the theme's CSS custom properties on the container. When
 * that colour equals the dashboard background, panels blend in and look
 * borderless. Clearing it restores the theme's chrome.
 * @param {HTMLElement} container - Dashboard container.
 * @param {object} spec - The dashboard spec (`panelColor`, `coordinatePanel`).
 * @returns {void}
 * @private
 */
function applyPanelColor(container, spec) {
  var style = container.style;
  // The test DOM stub omits setProperty/removeProperty; skip when unavailable.
  if (!style || typeof style.setProperty !== 'function' || typeof style.removeProperty !== 'function') return;
  var color = effectivePanelColor(spec);
  var vars = ['--cxd-panel-bg', '--cxd-title-bg', '--cxd-border'];
  for (var i = 0; i < vars.length; i++) {
    if (color) style.setProperty(vars[i], color);
    else style.removeProperty(vars[i]);
  }
  // Control boxes get a border that always CONTRASTS with whatever they sit on
  // (the panel colour, else the background) — so coordinating the chrome to the
  // background can't make the control border vanish. When the backdrop is
  // unknown/unparseable, fall back to the theme border (var not set).
  var backdrop = color || effectiveBackground(spec);
  var ctrlBorder = contrastingBorder(backdrop);
  if (ctrlBorder) style.setProperty('--cxd-ctrl-border', ctrlBorder);
  else style.removeProperty('--cxd-ctrl-border');
}

/**
 * Pick a border colour that contrasts with a backdrop: a translucent light line
 * on a dark backdrop, a translucent dark line on a light one. Returns '' when
 * the backdrop isn't a parseable hex colour (caller then keeps the theme border).
 * @param {string} backdrop - The colour the control sits on.
 * @returns {string} An rgba() border colour, or '' if undecidable.
 * @private
 */
function contrastingBorder(backdrop) {
  if (!/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(backdrop || '').trim())) return '';
  return isDarkColor(backdrop) ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.35)';
}

/**
 * Apply the dashboard-wide font to the DOM chrome (panel titles) by setting the
 * `--cxd-font` custom property on the container. The graphs themselves get the
 * font via each chart's `fontName` config; this covers the HTML titles, which
 * are not drawn by CanvasXpress. A fallback stack keeps text legible if the
 * named font is unavailable. Clearing it restores the default system font.
 * @param {HTMLElement} container - Dashboard container.
 * @param {object} spec - The dashboard spec (`fontName`).
 * @returns {void}
 * @private
 */
function applyDashboardFont(container, spec) {
  var style = container.style;
  if (!style || typeof style.setProperty !== 'function' || typeof style.removeProperty !== 'function') return;
  if (spec.fontName) style.setProperty('--cxd-font', '"' + spec.fontName + '", system-ui, sans-serif');
  else style.removeProperty('--cxd-font');
}

/**
 * Apply the dashboard background (colour and/or image) to the container so it
 * fills the entire area, and inset the grid by `gap` so the background is
 * visible as a margin around the panels (top/right/bottom/left) — matching the
 * gutters between them.
 * When `coordinateBackground` is set, the background colour is taken from the
 * chosen theme's panel background (read from the library) instead of the spec's
 * own `background`, keeping the dashboard surface in step with the charts.
 * @param {HTMLElement} container - Dashboard container.
 * @param {object} spec - The dashboard spec (`background`, `backgroundImage`, `coordinateBackground`, `theme`).
 * @param {number} gap - The inter-panel gap (px), reused as the outer margin.
 * @returns {void}
 * @private
 */
function applyBackground(container, spec, gap) {
  var s = container.style;
  s.boxSizing = 'border-box';
  s.padding = (gap > 0 ? gap : 0) + 'px';
  s.backgroundColor = effectiveBackground(spec);
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
  // Cap the dashboard width on wide screens and center it. Unset defaults to
  // 1600px; 0/false/'none' removes the cap so the dashboard fills its parent.
  var maxWidth = maxWidthValue(spec.maxWidth);
  container.style.maxWidth = maxWidth;
  container.style.marginLeft = maxWidth ? 'auto' : '';
  container.style.marginRight = maxWidth ? 'auto' : '';
  container.style.overflow = (sizeValue(spec.width) || sizeValue(spec.height)) ? 'auto' : '';
}

/**
 * Resolve the dashboard max-width setting to a CSS length. Unset (null/undefined)
 * defaults to '1600px'; 0, false, '', or 'none' disable the cap (return '').
 * @param {(number|string|boolean)} value - The spec.maxWidth setting.
 * @returns {string} A CSS max-width length, or '' for no cap.
 * @private
 */
function maxWidthValue(value) {
  if (value == null) return '1600px';
  if (value === 0 || value === false || value === 'none' || value === '') return '';
  return sizeValue(value);
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

// ------------------------------------------------------------------ sanitizer

var CXD_ALLOWED_TAGS = {
  b: 1, strong: 1, i: 1, em: 1, u: 1, s: 1, strike: 1, span: 1, br: 1, p: 1,
  div: 1, ul: 1, ol: 1, li: 1, a: 1, font: 1, sub: 1, sup: 1, blockquote: 1,
  h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1
};
var CXD_ALLOWED_ATTRS = { style: 1, href: 1, color: 1, size: 1, face: 1, title: 1, target: 1 };
var CXD_ALLOWED_STYLE = {
  color: 1, 'background-color': 1, 'font-size': 1, 'font-weight': 1,
  'font-style': 1, 'text-decoration': 1, 'text-align': 1, 'font-family': 1
};

/**
 * Sanitize user HTML for safe rendering via innerHTML. Allowlist-based: keeps a
 * small set of formatting tags and safe attributes/styles, drops everything else
 * (scripts, event handlers, javascript: URLs, unknown tags/attrs). Text content
 * inside dropped tags is preserved.
 *
 * This is a pragmatic regex sanitizer for a simple rich-text editor — not a
 * full HTML parser. Inputs come from our own contenteditable and pasted content.
 * @param {string} html - Untrusted HTML.
 * @returns {string} Sanitized HTML.
 */
export function sanitizeHtml(html) {
  if (html == null) return '';
  var s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Remove dangerous elements together with their content.
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|svg|math)\b[\s\S]*?(<\/\1\s*>|$)/gi, '');
  // Process the remaining tags: keep allowed ones (with filtered attributes),
  // drop the rest (their inner text stays).
  return s.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)\/?\s*>/g,
    function (match, close, tag, attrs) {
      tag = tag.toLowerCase();
      if (!CXD_ALLOWED_TAGS[tag]) return '';
      if (close) return '</' + tag + '>';
      if (tag === 'br') return '<br>';
      return '<' + tag + sanitizeAttrs(tag, attrs) + '>';
    });
}

/**
 * Keep only allowlisted attributes on a tag (filtering style + href).
 * @param {string} tag - Lowercased tag name.
 * @param {string} attrs - Raw attribute text.
 * @returns {string} A safe leading-space attribute string.
 * @private
 */
function sanitizeAttrs(tag, attrs) {
  var out = '';
  var re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  var m;
  while ((m = re.exec(attrs))) {
    var name = m[1].toLowerCase();
    var value = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] || ''));
    if (name.indexOf('on') === 0) continue;              // event handlers
    if (!CXD_ALLOWED_ATTRS[name]) continue;
    if (name === 'href' && !/^\s*(https?:|mailto:|#|\/)/i.test(value)) continue;
    if (name === 'style') { value = sanitizeStyle(value); if (!value) continue; }
    if (name === 'target' && tag === 'a') value = '_blank';
    out += ' ' + name + '="' + escapeAttr(value) + '"';
  }
  return out;
}

/**
 * Keep only safe CSS declarations from a style attribute.
 * @param {string} style - Raw style value.
 * @returns {string} A filtered `prop: val; …` string.
 * @private
 */
function sanitizeStyle(style) {
  var out = [];
  String(style).split(';').forEach(function (decl) {
    var idx = decl.indexOf(':');
    if (idx < 0) return;
    var prop = decl.slice(0, idx).trim().toLowerCase();
    var val = decl.slice(idx + 1).trim();
    if (!CXD_ALLOWED_STYLE[prop]) return;
    if (/url\s*\(|expression\s*\(|javascript:/i.test(val)) return;
    out.push(prop + ': ' + val);
  });
  return out.join('; ');
}

/**
 * Escape a value for a double-quoted HTML attribute.
 * @param {string} v - Raw value.
 * @returns {string} Escaped value.
 * @private
 */
function escapeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
