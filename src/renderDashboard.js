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
import { migrateSpec } from './spec.js';
import { injectStyles } from './styles.js';
import { createDataStore, isEmptyData } from './dataStore.js';
import { gridTemplate, cellArea } from './gridLayout.js';
import { hasRelationships, relationGraph, translateMarks } from './marking.js';
import { sourceAxis, sourceInputs, tableColumn, transposeCxData } from './join.js';
import { resolveFields, rowsPassing, normalizeState, isActive, fieldKey } from './filters.js';

/**
 * A row name no data object carries: marking a related panel with only this
 * name highlights nothing, so the whole panel reads as "no related rows".
 * @type {string}
 */
var NO_MARKED_ROWS = '\u0000cxd-no-marked-rows';

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
 * @param {function} [options.EventSource] - EventSource constructor for
 *   `kind:"live"` (streaming) sources; defaults to the global.
 * @param {function} [options.requestAnimationFrame] - Frame scheduler used to
 *   coalesce live ticks into at most one redraw per frame; defaults to the
 *   global, else a ~16ms timeout (so it also works outside a browser).
 * @param {function} [options.prepareLive] - Called once before live streams
 *   open (only when the spec has a live source); may return a Promise. Hosts use
 *   it to establish the stream server's session (e.g. the connectors bridge).
 * @returns {Promise<DashboardHandle>} A handle exposing the created instances
 *   and a `destroy()` cleanup.
 */
export function renderDashboard(spec, target, options) {
  options = options || {};
  var validate = options.validate !== false;

  // Upgrade an older spec format (and refuse one from a newer MAJOR) before
  // anything reads it; a newer MINOR renders what this version understands.
  var migration = migrateSpec(spec);
  spec = migration.spec;
  if (migration.warnings.length && typeof console !== 'undefined') {
    migration.warnings.forEach(function (w) { console.warn('[canvasxpress-dashboards] ' + w); });
  }

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
    fetch: doFetch, cache: options.cache, ttl: options.ttl, baseUrl: options.baseUrl,
    busyRetryMs: options.busyRetryMs, EventSource: options.EventSource
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

  // Filters panels (type:"filters"): one shared, serializable filter state
  // (predicates per source + field; see filters.js), the named filter schemes
  // (spec.filterSchemes plus any saved at runtime), and the rendered panels to
  // repaint when the state is replaced (scheme pick, reset, setFilterState).
  var filterState = [];
  var filterSchemes = {};
  var activeScheme = null;
  var filterPanelViews = [];
  if (spec.filterSchemes && typeof spec.filterSchemes === 'object') {
    Object.keys(spec.filterSchemes).forEach(function (name) {
      filterSchemes[name] = normalizeState(spec.filterSchemes[name]);
    });
  }

  // Config controls (mode:"config") drive a TARGET panel's live config via
  // updateConfig — not a data filter. Several config controls can target the
  // same panel (e.g. an expiry slider + an IV/Premium metric toggle); on any
  // change their current config fragments are merged (in registration order)
  // and applied together, so independent controls compose. Keyed by target id.
  var configControlsByTarget = {};

  // Live dashboard parameter values, seeded from spec.params. A mode:"param"
  // control writes one of these; sources whose `query` references `$<name>`
  // read them, so changing a control re-queries the backend and live-updates
  // the panels bound to that source (see applyParamChange).
  var paramState = {};
  var paramsSpec = spec.params || {};
  for (var paramName in paramsSpec) {
    if (Object.prototype.hasOwnProperty.call(paramsSpec, paramName)) {
      var paramDef = paramsSpec[paramName];
      paramState[paramName] = paramDef && typeof paramDef === 'object'
        ? paramDef.value : paramDef;
    }
  }

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
      // Picks on an annotation this panel lacks can still narrow it through a
      // relationship: the matching rows of the control's source, translated.
      var ref = refOfInstance(inst);
      var related = markingGraph && ref ? relatedRowFilter(picks.filter(function (w) {
        return applicable.indexOf(w) === -1;
      }), ref) : null;
      // Filters-panel predicates (on this source or, translated, on related ones).
      var panelRows = ref ? filterPanelRows(ref) : null;
      if (panelRows) {
        related = related
          ? { axis: related.axis, ids: related.ids.filter(function (id) { return panelRows.indexOf(id) !== -1; }) }
          : { axis: sourceAxis(ref, spec.data || {}), ids: panelRows };
      }
      var savedGroup = inst.broadcastGroup;
      inst.broadcastGroup = '__cxd_annctl_serial__';
      try {
        if (!applicable.length && !related) {
          if (typeof inst.resetDataFilter === 'function') inst.resetDataFilter(null, false);
        } else if (typeof inst.modifyFilter === 'function') {
          if (typeof inst.resetDataFilter === 'function') inst.resetDataFilter(null, true);
          applicable.forEach(function (w, i) {
            inst.modifyFilter('guess', w.annotation, 'exact', w.value, related ? true : i < applicable.length - 1);
          });
          if (related && typeof inst.filterUserData === 'function') {
            var names = related.ids.length ? related.ids : [NO_MARKED_ROWS];
            var found = bindingOf(inst);
            if (found) related.axis = instanceAxis(found.binding, found.ref);
            if (related.axis === 'vars') inst.filterUserData('filterVarBy', 'vars', 'exact', names, false, true, false);
            else inst.filterUserData('filterSmpBy', 'smps', 'exact', names, false, true, false);
          }
        }
      } catch (e) { /* keep filtering the remaining instances */
      } finally {
        inst.broadcastGroup = savedGroup;
      }
    });
  }

  /**
   * The rows of `targetRef` that survive the Filters-panel state: predicates on
   * `targetRef` itself, and predicates on related sources translated through
   * the relationship graph. Sources the target does not relate to are ignored.
   * @param {string} targetRef - The panel's source ref.
   * @returns {(string[]|null)} Rows to keep, or null when nothing applies.
   */
  function filterPanelRows(targetRef) {
    if (!filterState.length) return null;
    var sources = spec.data || {};
    var refs = [];
    filterState.forEach(function (p) { if (refs.indexOf(p.dataRef) === -1) refs.push(p.dataRef); });
    var keep = null;
    refs.forEach(function (from) {
      var data = refData[from];
      if (!data) return;
      var state = filterState;
      var pushed = false;
      if (pushesFilters(from)) {
        // The database already applied the value lists and ranges; only text
        // search is left to the browser.
        state = [];
        filterState.forEach(function (p) {
          if (p.dataRef !== from) { state.push(p); return; }
          if (Array.isArray(p.values) || typeof p.min === 'number' || typeof p.max === 'number') pushed = true;
          if (typeof p.text === 'string') state.push({ dataRef: p.dataRef, field: p.field, text: p.text });
        });
      }
      var rows = rowsPassing(state, from, data, sourceAxis(from, sources));
      if (rows === null) {
        // Rows the database kept still narrow the sources related to it.
        if (!pushed || from === targetRef) return;
        var idColumn = tableColumn(data, sourceAxis(from, sources), sourceAxis(from, sources));
        rows = idColumn ? idColumn.ids : [];
      }
      var set = rows;
      if (from !== targetRef) {
        if (!markingGraph) return;
        var marks = translateMarks(from, rows, markingGraph, function (r) { return refData[r] || null; });
        if (!Object.prototype.hasOwnProperty.call(marks, targetRef)) return;
        set = marks[targetRef];
      }
      keep = keep === null ? set : keep.filter(function (id) { return set.indexOf(id) !== -1; });
    });
    return keep;
  }

  /**
   * The source ref a live instance is bound to.
   * @param {object} inst - CanvasXpress instance.
   * @returns {(string|null)} Its dataRef, or null for inline-data panels.
   */
  function refOfInstance(inst) {
    for (var ref in refBindings) {
      if (!Object.prototype.hasOwnProperty.call(refBindings, ref)) continue;
      var bound = refBindings[ref];
      for (var i = 0; i < bound.length; i++) {
        if (bound[i].instance === inst) return ref;
      }
    }
    return null;
  }

  /**
   * Turn filter picks on OTHER sources into the rows of `targetRef` they
   * relate to: for each pick, the control source's rows carrying the picked
   * annotation value, translated through the relationship graph; several picks
   * intersect. Picks whose source does not reach `targetRef`, or whose
   * annotation is not a row annotation of that source, are ignored.
   * @param {object[]} picks - Active filter picks (`{annotation, value, dataRef, compartment}`).
   * @param {string} targetRef - The panel's source ref.
   * @returns {({axis: string, ids: string[]}|null)} Rows to keep along the
   *   target's row axis, or null when no pick relates.
   */
  function relatedRowFilter(picks, targetRef) {
    var sources = spec.data || {};
    var keep = null;
    picks.forEach(function (w) {
      var from = w.dataRef;
      if (!from || from === targetRef || !refData[from]) return;
      var axis = sourceAxis(from, sources);
      // An x annotation describes samples, a z annotation variables: it can
      // only select rows when it lies along the source's row axis.
      if ((w.compartment === 'z' ? 'vars' : 'smps') !== axis) return;
      var data = refData[from];
      var values = (axis === 'vars' ? data.z : data.x) || {};
      var column = values[w.annotation];
      var ids = data.y && data.y[axis];
      if (!Array.isArray(column) || !Array.isArray(ids)) return;
      var rows = ids.filter(function (id, i) { return column[i] != null && String(column[i]) === String(w.value); });
      var marks = translateMarks(from, rows, markingGraph, function (r) { return refData[r] || null; });
      if (!Object.prototype.hasOwnProperty.call(marks, targetRef)) return;
      var set = marks[targetRef];
      keep = keep === null ? set : keep.filter(function (id) { return set.indexOf(id) !== -1; });
    });
    return keep === null ? null : { axis: sourceAxis(targetRef, sources), ids: keep };
  }

  /**
   * Snap every annotation-filter control back to "All" (UI + filters), as if
   * All had been clicked. Bound to the Escape key for the dashboard's lifetime.
   * @returns {void}
   */
  function resetAllControls() {
    if (!controlWidgets.length && !filterState.length) return;
    controlWidgets.forEach(function (w) {
      w.value = null;
      if (w.resetUI) w.resetUI();
    });
    if (filterState.length) {
      filterState = [];
      activeScheme = null;
      renderFilterPanels();
    }
    applyFilterChange();
  }
  var doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
  var escListener = null;
  if (doc && typeof doc.addEventListener === 'function') {
    escListener = function (ev) { if (ev.key === 'Escape') resetAllControls(); };
    doc.addEventListener('keydown', escListener);
  }
  var pending = [];        // per-cell settle promises (feed handle.ready)
  var refMemo = {};        // dataRef -> Promise<data> (one resolve per render)
  var refData = {};        // dataRef -> latest resolved data (for marking translation)
  var refDomain = {};      // pushdown dataRef -> its unfiltered data (Filters panel values)
  var pushedWhere = {};    // pushdown dataRef -> JSON of the filters it was last fetched with
  var refBindings = {};    // dataRef -> [{ instance }] (for scheduled refresh)
  var timers = [];         // refresh interval handles
  var subscriptions = [];  // live (SSE) stream handles `{close}`, closed on destroy
  var liveData = {};       // live dataRef -> its current bounded window (CX data object)
  var liveWaiting = {};    // live dataRef -> [build(currentData)] for panels awaiting a first tick
  var observers = [];      // ResizeObservers keeping canvases sized to their cells

  /**
   * Whether a source ref is a streaming (`kind:"live"`) source.
   * @param {string} ref - Source ref name.
   * @returns {boolean} True for a live source.
   */
  function isLiveRef(ref) {
    var source = ref && (spec.data || {})[ref];
    return !!(source && source.kind === 'live');
  }

  /**
   * Apply one (coalesced) live tick to a live source's panels. The dashboard
   * keeps the bounded window itself (`liveData[ref]`, so Filters/table controls
   * and full-data fallbacks see current data), then per bound instance:
   *  - fast path — the engine's `pushData(tick)` (append + evict +
   *    soft redraw) when the instance has it and the panel does not transpose;
   *    `streamWindow` is set from the source's window so the engine evicts too;
   *  - fallback — `updateData(prepare(window))` for an older engine without
   *    `pushData`, or a transposing panel (an increment can't be transposed).
   * Panels still waiting on their first tick are built from the window.
   * @param {string} ref - The live source ref.
   * @param {object} tick - A (possibly merged) tick of new samples.
   * @returns {void}
   */
  /**
   * A live source's stream failed for good (the browser will not reconnect —
   * e.g. the server has no such stream): mark the panels still waiting for a
   * first message as errored instead of leaving them on "Loading…".
   * @param {string} ref - The live source ref.
   * @returns {void}
   */
  function liveStreamClosed(ref) {
    // Panels still waiting for a first message would otherwise say "Loading…"
    // forever; panels that already show data keep it (last good state).
    (liveWaiting[ref] || []).forEach(function (waiter) {
      if (waiter.cell && waiter.cell.setState) waiter.cell.setState('error', 'Live stream unavailable');
    });
  }

  function applyLiveTick(ref, tick) {
    var windowSize = liveWindowSize((spec.data || {})[ref]);
    liveData[ref] = appendTick(liveData[ref] || refData[ref], tick, windowSize);
    refData[ref] = liveData[ref];
    // Panels built right now start from the full window, so they already hold
    // this tick — skip them when pushing to the rest below.
    var justBuilt = [];
    var waiting = liveWaiting[ref];
    if (waiting && waiting.length) {
      delete liveWaiting[ref];
      waiting.forEach(function (build) {
        try {
          var built = build(liveData[ref]);
          if (built) {
            built.streamWindow = windowSize;
            justBuilt.push(built);
          }
        } catch (e) { /* keep the others */ }
      });
    }
    (refBindings[ref] || []).forEach(function (b) {
      var inst = b.instance;
      // Skip panels just built, and instances destroyed since binding (removePanel
      // drops them from `instances` but not from their binding).
      if (!inst || justBuilt.indexOf(inst) !== -1 || instances.indexOf(inst) === -1) return;
      var transposes = !!(b.prepare && b.prepare.transposed);
      try {
        // A tick this instance could not take (it was still initialising — the
        // CanvasXpress constructor is asynchronous — or the call threw) leaves it
        // `liveStale`: resync once from the full window before pushing increments
        // again, or it would keep a gap for as long as the stream runs.
        if (typeof inst.pushData === 'function' && !transposes && !b.liveStale) {
          if (inst.streamWindow !== windowSize) inst.streamWindow = windowSize;
          inst.pushData(tick);
        } else if (typeof inst.updateData === 'function') {
          inst.updateData(b.prepare ? b.prepare(liveData[ref]) : liveData[ref], true, false);
          b.liveStale = false;
        } else {
          b.liveStale = true;
          return;
        }
        if (b.cell && b.cell.setState) b.cell.setState('ready');
      } catch (e) {
        b.liveStale = true;   // keep last good state; resync on the next tick
      }
    });
  }

  /**
   * Resolve a named source once per render (shared object + single request).
   * @param {string} ref - Source ref name.
   * @returns {Promise<object>} Resolved data.
   */
  function resolveRef(ref) {
    if (refMemo[ref]) return refMemo[ref];
    var promise = store.resolve(ref, (spec.data || {})[ref], resolveOptions(false));
    refMemo[ref] = promise;
    promise.then(function (data) {
      if (refMemo[ref] === promise) {
        refData[ref] = data;
        noteDomain(ref, data);
      }
    }, function () { /* surfaced by the panels that render it */ });
    return promise;
  }

  /**
   * Whether a source sends Filters-panel picks to the database: a connector
   * source with a `pushdown` block (unless `pushdown.filters` is false).
   * @param {string} ref - Source ref.
   * @returns {boolean} True when its filters are pushed down.
   */
  function pushesFilters(ref) {
    var source = (spec.data || {})[ref];
    return !!(source && source.kind === 'connector' && source.pushdown &&
      source.pushdown.filters !== false);
  }

  /**
   * The Filters-panel picks on a pushdown source, as database filters: a
   * value list becomes `in`, a range `>=` / `<=`. Text search stays in the
   * browser.
   * @param {string} ref - Source ref.
   * @returns {(object[]|null)} Filters, or null when the source does not push them.
   */
  function pushdownWhere(ref) {
    if (!pushesFilters(ref)) return null;
    var clauses = [];
    filterState.forEach(function (p) {
      if (p.dataRef !== ref) return;
      if (Array.isArray(p.values)) clauses.push({ column: p.field, op: 'in', value: p.values });
      if (typeof p.min === 'number') clauses.push({ column: p.field, op: '>=', value: p.min });
      if (typeof p.max === 'number') clauses.push({ column: p.field, op: '<=', value: p.max });
    });
    return clauses;
  }

  /**
   * Remember a pushdown source's unfiltered data: the Filters panel lists its
   * values from it, so picking one does not hide the others.
   * @param {string} ref - Source ref.
   * @param {object} data - Freshly resolved data.
   * @returns {void}
   */
  function noteDomain(ref, data) {
    if (!pushesFilters(ref)) return;
    var where = pushdownWhere(ref);
    pushedWhere[ref] = JSON.stringify(where);
    if (!where.length) refDomain[ref] = data;
  }

  /**
   * Options for `store.resolve`: the live params, plus the spec's sources and
   * the memoized resolver so a `kind:"join"` source shares its inputs' fetches
   * with the panels bound to them.
   * @param {boolean} force - Bypass a fresh cache entry and refetch.
   * @returns {object} Resolve options.
   */
  function resolveOptions(force) {
    return { params: paramState, force: force, sources: spec.data || {}, resolveInput: resolveRef,
      where: pushdownWhere };
  }

  /**
   * Push fresh data into every instance bound to a ref: rebuild remote-URL
   * panels, `updateData` the rest.
   * @param {string} ref - Source ref name.
   * @param {object} data - The new data.
   * @returns {void}
   */
  function updateBound(ref, data) {
    refData[ref] = data;
    noteDomain(ref, data);
    (refBindings[ref] || []).forEach(function (b) {
      if (b.cell && b.cell.setState) b.cell.setState('ready');
      if (b.rebuild) {
        // Remote (URL) source: rebuild the instance to reload+parse the new URL.
        try { b.instance = b.rebuild(data); } catch (e) { /* keep others */ }
      } else if (b.instance && typeof b.instance.updateData === 'function') {
        try { b.instance.updateData(b.prepare ? b.prepare(data) : data, true, false); } catch (e) { /* keep others */ }
      }
    });
  }

  /**
   * The derived sources (`kind:"join"` / `kind:"function"`) that read any of
   * `refs`, directly or through another derived source, in dependency order
   * (a source after the ones it reads).
   * @param {string[]} refs - Source refs whose data changed.
   * @returns {string[]} Dependent refs, not including `refs` themselves.
   */
  function dependentSources(refs) {
    var sources = spec.data || {};
    var changed = refs.slice();
    var out = [];
    var grew = true;
    while (grew) {
      grew = false;
      for (var ref in sources) {
        if (!Object.prototype.hasOwnProperty.call(sources, ref)) continue;
        var src = sources[ref];
        var inputs = sourceInputs(src);
        if (!inputs.length || changed.indexOf(ref) !== -1) continue;
        if (inputs.some(function (input) { return changed.indexOf(input) !== -1; })) {
          changed.push(ref);
          out.push(ref);
          grew = true;
        }
      }
    }
    return out;
  }

  /**
   * Recompute the joins that read refs whose data just changed (e.g. on a
   * scheduled refresh) and live-update the panels bound to them.
   * @param {string} ref - The refreshed source ref.
   * @param {object} data - Its fresh data.
   * @returns {Promise<void>} Resolves once the dependent joins have updated.
   */
  function refreshJoinsOf(ref, data) {
    refMemo[ref] = Promise.resolve(data);
    refData[ref] = data;
    var joins = dependentSources([ref]);
    joins.forEach(function (join) { refMemo[join] = null; });
    return Promise.all(joins.map(function (join) {
      return resolveRef(join).then(function (joined) {
        updateBound(join, joined);
      }, function (err) {
        refMemo[join] = null;
        (refBindings[join] || []).forEach(function (b) {
          if (b.cell && b.cell.setState) b.cell.setState('error', String(err && err.message || err));
        });
      });
    })).then(function () {});
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
   * Build the CanvasXpress events object for a panel, adding a click handler
   * that sets a dashboard parameter from the clicked mark when the panel opts in
   * via `clickParam` (cross-filter). Any author-supplied `panel.events.click` is
   * preserved and still called. When the panel does not opt in, its own events
   * pass through unchanged.
   * @param {object} panel - The panel definition.
   * @returns {object} The events object to hand to the CanvasXpress instance.
   * @private
   */
  function paramClickEvents(panel) {
    var events = (panel && panel.events) || {};
    var clicks = !!(panel && panel.clickParam);
    // Every bound panel reports its selections: related sources are marked
    // through the relationship graph, and same-source panels shown in the other
    // orientation (transposed) — which the engine's own broadcast cannot reach.
    var marks = !!(panel && panel.dataRef);
    if (!clicks && !marks) return events;
    var merged = {};
    for (var key in events) {
      if (Object.prototype.hasOwnProperty.call(events, key)) merged[key] = events[key];
    }
    if (clicks) {
      var authorClick = events.click;
      merged.click = function (clicked, mouseEvent, target) {
        var value = extractClickValue(clicked, panel.clickField);
        if (value != null) applyParamChange(panel.clickParam, value);
        if (typeof authorClick === 'function') authorClick.call(this, clicked, mouseEvent, target);
      };
    }
    if (marks) {
      // Cross-source marking: a selection here marks the related rows of the
      // panels bound to other, related sources.
      var authorSelect = events.select;
      merged.select = function (selected, mouseEvent, target) {
        applyMarking(panel.dataRef, this);
        if (typeof authorSelect === 'function') authorSelect.call(this, selected, mouseEvent, target);
      };
    }
    return merged;
  }

  // --- cross-source marking (spec.relationships + join sources) ---
  var markingGraph = hasRelationships(spec) ? relationGraph(spec) : null;
  var markingMode = spec.markingMode || 'focus';
  var markedInstances = [];   // [{ instance, highlightSmp, highlightVar, highlightMode }] to restore
  var markingSeq = 0;         // guards against an older async marking landing last

  /**
   * The row ids currently selected in a source, read from CanvasXpress's
   * page-global selector along the source's row axis (samples for most
   * graphs, variables for scatter-oriented data).
   * @param {string} ref - The source the selection was made in.
   * @param {object} [origin] - The instance the selection was made in.
   * @returns {string[]} Selected row ids of that source.
   */
  function selectedRows(ref, origin) {
    var selector = CX.selector || {};
    var axis = sourceAxis(ref, spec.data || {});
    // The engine names the selected rows along the INSTANCE's axis (flipped
    // when the panel transposes); the ids are the source's rows either way.
    var found = origin ? bindingOf(origin) : null;
    var names = selector[found ? instanceAxis(found.binding, ref) : axis] || {};
    var data = refData[ref];
    var ids = data && data.y && Array.isArray(data.y[axis]) ? data.y[axis] : [];
    return ids.filter(function (id) { return Object.prototype.hasOwnProperty.call(names, id); });
  }

  /**
   * Translate the selection just made in `originRef` to every related source
   * and mark those rows on the panels bound to them (a declarative
   * `highlightSmp` / `highlightVar` in `spec.markingMode`, default "focus").
   * An empty selection clears every mark.
   * @param {string} originRef - The source the selection was made in.
   * @param {object} [origin] - The instance the selection was made in.
   * @returns {Promise<void>} Resolves once the marks are drawn.
   */
  function applyMarking(originRef, origin) {
    var seq = ++markingSeq;
    var ids = selectedRows(originRef, origin);
    if (!ids.length) {
      clearMarking();
      return Promise.resolve();
    }
    // Resolve every source the graph can traverse (memoized; normally ready).
    var refs = markingGraph ? Object.keys(markingGraph) : [];
    return Promise.all(refs.map(function (ref) {
      return resolveRef(ref).then(null, function () { return null; });
    })).then(function () {
      if (seq !== markingSeq) return;   // a newer selection superseded this one
      var marks = markingGraph
        ? translateMarks(originRef, ids, markingGraph, function (ref) { return refData[ref] || null; })
        : {};
      clearMarking();
      // Same-source panels in the other orientation: the engine names the rows
      // along the origin's axis, which is the other dimension for them.
      var found = origin ? bindingOf(origin) : null;
      var originFlipped = !!(found && found.binding.prepare && found.binding.prepare.transposed);
      (refBindings[originRef] || []).forEach(function (b) {
        if (b.instance === origin) return;
        if (!!(b.prepare && b.prepare.transposed) !== originFlipped) markInstance(b.instance, instanceAxis(b, originRef), ids);
      });
      Object.keys(marks).forEach(function (ref) {
        (refBindings[ref] || []).forEach(function (b) { markInstance(b.instance, instanceAxis(b, ref), marks[ref]); });
      });
    });
  }

  /**
   * Mark rows on one instance, remembering its own highlight settings first.
   * @param {object} instance - CanvasXpress instance.
   * @param {string} axis - The row axis of its source.
   * @param {string[]} ids - Row ids to mark (empty = nothing related).
   * @returns {void}
   */
  function markInstance(instance, axis, ids) {
    if (!instance) return;
    markedInstances.push({
      instance: instance,
      highlightSmp: instance.highlightSmp,
      highlightVar: instance.highlightVar,
      highlightMode: instance.highlightMode
    });
    var names = ids.length ? ids.slice() : [NO_MARKED_ROWS];
    instance.highlightSmp = axis === 'smps' ? names : [];
    instance.highlightVar = axis === 'vars' ? names : [];
    instance.highlightMode = markingMode;
    if (typeof instance.draw === 'function') {
      try { instance.draw(); } catch (e) { /* keep marking the others */ }
    }
  }

  /**
   * Remove every mark, restoring each instance's own highlight settings.
   * @returns {void}
   */
  function clearMarking() {
    var marked = markedInstances;
    markedInstances = [];
    marked.forEach(function (m) {
      m.instance.highlightSmp = m.highlightSmp;
      m.instance.highlightVar = m.highlightVar;
      m.instance.highlightMode = m.highlightMode;
      if (typeof m.instance.draw === 'function') {
        try { m.instance.draw(); } catch (e) { /* keep restoring the others */ }
      }
    });
  }

  /**
   * Record a rendered instance against its dataRef so scheduled refresh can
   * live-update it.
   * @param {string} ref - Source ref name (may be undefined).
   * @param {object} instance - The CanvasXpress instance.
   * @param {object} [cell] - The cell wrapping the instance (for loading state).
   * @param {function} [rebuild] - For remote (URL) sources whose data CX fetches
   *   itself: a `function(url)` that destroys the old instance and builds a fresh
   *   one for the new URL, returning it. `updateData` cannot re-fetch a URL, so a
   *   refresh calls this instead. Absent for ordinary data-object panels.
   * @param {function} [prepare] - The panel's `data -> data` step (measures
   *   projection + transpose, see {@link panelDataPreparer}), re-applied to
   *   every live update. It reports whether it transposed via `.transposed`.
   * @returns {void}
   */
  function bind(ref, instance, cell, rebuild, prepare) {
    if (!ref) return;
    (refBindings[ref] || (refBindings[ref] = [])).push({
      instance: instance, cell: cell, rebuild: rebuild, prepare: prepare || null
    });
  }

  /**
   * The row axis a bound instance actually shows its source's rows along: the
   * source's axis, flipped when the panel transposes its data.
   * @param {object} binding - A refBindings entry.
   * @param {string} ref - Its source ref.
   * @returns {string} `"smps"` or `"vars"`.
   */
  function instanceAxis(binding, ref) {
    var axis = sourceAxis(ref, spec.data || {});
    if (!binding || !binding.prepare || !binding.prepare.transposed) return axis;
    return axis === 'smps' ? 'vars' : 'smps';
  }

  /**
   * The binding (and source ref) of a live instance.
   * @param {object} inst - CanvasXpress instance.
   * @returns {({ref: string, binding: object}|null)} Or null for inline-data panels.
   */
  function bindingOf(inst) {
    for (var ref in refBindings) {
      if (!Object.prototype.hasOwnProperty.call(refBindings, ref)) continue;
      var bound = refBindings[ref];
      for (var i = 0; i < bound.length; i++) {
        if (bound[i].instance === inst) return { ref: ref, binding: bound[i] };
      }
    }
    return null;
  }

  /**
   * Refs whose source `query` references `$<param>` (or lists it in `dependsOn`)
   * — the panels to re-fetch and live-update when that parameter changes —
   * followed by the joins that read them (inputs before the joins that use them).
   * @param {string} param - The parameter name that changed.
   * @returns {string[]} Affected source ref names.
   */
  function refsForParam(param) {
    var sources = spec.data || {};
    var affected = [];
    for (var ref in sources) {
      if (!Object.prototype.hasOwnProperty.call(sources, ref)) continue;
      var source = sources[ref];
      if (!source) continue;
      var uses = false;
      if (Array.isArray(source.dependsOn) && source.dependsOn.indexOf(param) !== -1) uses = true;
      var query = source.query || {};
      for (var qk in query) {
        if (query[qk] === '$' + param) { uses = true; break; }
      }
      // A pushdown filter reads a param through its value ("$name").
      var clauses = source.kind === 'connector' && source.pushdown && Array.isArray(source.pushdown.where)
        ? source.pushdown.where : [];
      for (var wi = 0; wi < clauses.length; wi++) {
        if (clauses[wi] && clauses[wi].value === '$' + param) { uses = true; break; }
      }
      // A data function's `args` template reads params the same way.
      var args = source.kind === 'function' ? (source.args || {}) : {};
      for (var ak in args) {
        if (args[ak] === '$' + param) { uses = true; break; }
      }
      if (uses) affected.push(ref);
    }
    return affected.concat(dependentSources(affected));
  }

  /**
   * Apply a parameter change from a `mode:"param"` control: record the new value,
   * then for every source that consumes the parameter, re-fetch with the current
   * params and live-update the bound instances via `updateData`. Bound cells show
   * a loading state while in flight and keep their prior data on error.
   * @param {string} param - The parameter name being set.
   * @param {*} value - The new value (null clears the param → widens the query).
   * @returns {Promise<void>} Resolves once all affected panels have updated.
   */
  function applyParamChange(param, value) {
    paramState[param] = value;
    return refetchRefs(refsForParam(param));
  }

  /**
   * Re-fetch sources (inputs first) and live-update the panels bound to them.
   * Bound cells show a loading state while in flight and keep their prior
   * data on error.
   * @param {string[]} refs - Source refs, inputs before the sources derived from them.
   * @returns {Promise<void>} Resolves once all affected panels have updated.
   */
  function refetchRefs(refs) {
    // Refs come inputs-first, so a join's memoized inputs are already the
    // fresh fetches by the time it resolves them.
    var work = refs.map(function (ref) {
      var source = (spec.data || {})[ref];
      var bound = refBindings[ref] || [];
      bound.forEach(function (b) { if (b.cell && b.cell.setState) b.cell.setState('loading'); });
      // Memoize the fresh resolve so later renderers (and joins) of this ref share it.
      var promise = store.resolve(ref, source, resolveOptions(true));
      refMemo[ref] = promise;
      return promise
        .then(function (data) {
          updateBound(ref, data);
        }, function (err) {
          if (refMemo[ref] === promise) refMemo[ref] = null;   // let a later renderer retry
          // Keep last-good data; surface the failure on the affected cells.
          bound.forEach(function (b) {
            if (b.cell && b.cell.setState) b.cell.setState('error', String(err && err.message || err));
          });
        });
    });
    return Promise.all(work).then(function () {});
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
    // A Filters panel is titled "Filters" unless it names itself.
    var title = panel && (panel.title || (panel.type === 'filters' ? 'Filters' : ''));
    var showTitle = panel && panel.type !== 'text' && panel.type !== 'control' &&
      panel.type !== 'image' && !panel.hideTitle && title;
    var cell = buildCell(showTitle ? title : null);
    placeCell(cell.root, item);
    grid.appendChild(cell.root);
    cellByPanel[item.panel] = { cell: cell, item: item, instance: null };

    // Text elements carry free-form text instead of a graph — no data or canvas.
    if (panel && panel.type === 'text') {
      renderTextPanel(cell, item, panel);
      return Promise.resolve(null);
    }

    // Image elements carry a picture (URL or data: URI) instead of a graph.
    if (panel && panel.type === 'image') {
      renderImagePanel(cell, item, panel);
      return Promise.resolve(null);
    }

    // Annotation-filter controls render native inputs, not a graph.
    if (panel && panel.type === 'control') {
      return renderControlWidget(cell, item, panel);
    }

    // The Filters panel: a multi-field filter inspector over one or more sources.
    if (panel && panel.type === 'filters') {
      return renderFiltersPanel(cell, item, panel);
    }

    var canvasId = makeCanvasId(spec.id, 'panel', item.panel, panelIdCounter.n++);
    cell.canvas.id = canvasId;

    // A chart fed (directly or through a join) by a data function gets a
    // "Code" button showing its recipe: the function code and the chart config.
    if (cell.header && panel && panel.showCode !== false && typeof panel.dataRef === 'string') {
      var lineage = sourceLineage(spec.data || {}, panel.dataRef);
      if (lineage.some(function (ref) { return (spec.data[ref] || {}).kind === 'function'; })) {
        addCodeButton(cell.header, container, title, panel, lineage, spec.data);
      }
    }

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
        // Remote CanvasXpress source: a bare URL string (e.g. the WikiPathways
        // Explorer's GPML). CX fetches+parses it itself (GPML → Network), so we
        // hand the URL straight through rather than treating it as a data object.
        // `updateData` cannot re-fetch a URL, so a param change REBUILDS the
        // instance (destroy + new CX) via `buildRemote` — the same dance the
        // standalone WikiPathways page did on each pathway switch.
        if (typeof data === 'string') {
          var remoteInstance = null;
          var remoteObserver = null;
          function buildRemote(url) {
            if (remoteInstance) {
              try { remoteInstance.destroy(false, true); } catch (e) { /* rebuild regardless */ }
              var priorIdx = instances.indexOf(remoteInstance);
              if (priorIdx !== -1) instances.splice(priorIdx, 1);
            }
            if (remoteObserver) {
              try { remoteObserver.disconnect(); } catch (e) { /* noop */ }
              var obsIdx = observers.indexOf(remoteObserver);
              if (obsIdx !== -1) observers.splice(obsIdx, 1);
              remoteObserver = null;
            }
            sizeCanvasToCell(cell, canvasInset);
            var remoteConfig = mergeConfig(panel && panel.config, broadcastGroup, panel);
            applyDashboardChartStyle(remoteConfig, spec);
            remoteInstance = new CX(canvasId, url, remoteConfig, paramClickEvents(panel));
            instances.push(remoteInstance);
            if (cellByPanel[item.panel]) cellByPanel[item.panel].instance = remoteInstance;
            if (autoResize) {
              observeResize(cell, remoteInstance, observers, canvasInset);
              remoteObserver = observers[observers.length - 1];
            }
            return remoteInstance;
          }
          buildRemote(data);
          bind(panel && panel.dataRef, remoteInstance, cell, buildRemote);
          cell.setState('ready');
          notify(remoteInstance, 'ready');
          return remoteInstance;
        }
        var prepare = panelDataPreparer(panel);
        /**
         * Instantiate CanvasXpress on already-prepared data and bind it to the
         * panel's source (so refresh / live ticks can update it).
         * @param {object} prepared - Prepared (projected/transposed) data.
         * @returns {object} The new instance.
         */
        function buildInstance(prepared) {
          sizeCanvasToCell(cell, canvasInset);
          var config = mergeConfig(panel && panel.config, broadcastGroup, panel);
          applyDashboardChartStyle(config, spec);   // dashboard-wide font/theme/colors (Settings)
          var instance = new CX(canvasId, prepared, config, paramClickEvents(panel));
          instances.push(instance);
          if (cellByPanel[item.panel]) cellByPanel[item.panel].instance = instance;
          bind(panel && panel.dataRef, instance, cell, undefined, prepare);
          if (autoResize) observeResize(cell, instance, observers, canvasInset);
          cell.setState('ready');
          notify(instance, 'ready');
          return instance;
        }
        data = prepare(data);
        if (isEmptyData(data)) {
          // A live (streaming) panel starts with no samples: instead of settling
          // as "No data", wait for its first tick and build the instance then.
          if (isLiveRef(panel && panel.dataRef)) {
            cell.setState('loading');
            var waiter = function (current) {
              var ready = prepare(current);
              return isEmptyData(ready) ? null : buildInstance(ready);
            };
            waiter.cell = cell;
            (liveWaiting[panel.dataRef] || (liveWaiting[panel.dataRef] = [])).push(waiter);
            notify(null, 'loading');
            return null;
          }
          cell.setState('empty'); notify(null, 'empty'); return null;
        }
        return buildInstance(data);
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
   * Render an image element into a cell (no data / canvas). The picture fills the
   * cell and is scaled per `fit` (contain | cover | fill | none — CSS object-fit);
   * `align`/`valign` set object-position, so a `cover`/`none` image can be pinned
   * to an edge. An optional `href` wraps the image in a new-tab link (only safe
   * http/https/relative/mailto schemes; a `javascript:`/`data:` href is dropped).
   * The image itself resizes with the cell — the builder's resize handle changes
   * the cell's grid span like any other panel. An empty `src` renders a
   * placeholder so a freshly added image is visible and selectable.
   *
   * @param {object} cell - A cell from {@link buildCell}.
   * @param {object} item - The layout item.
   * @param {object} panel - The image panel (`{type:'image', src, fit, alt, href, bg}`).
   * @returns {void}
   * @private
   */
  function renderImagePanel(cell, item, panel) {
    cell.canvas.style.display = 'none';
    cell.root.classList.add('cxd-image-cell');
    if (panel && panel.bg) cell.root.style.background = panel.bg;

    var src = (panel && panel.src) || '';
    if (!src) {
      cell.root.classList.add('cxd-image-empty');
      var placeholder = document.createElement('div');
      placeholder.className = 'cxd-image-ph';
      placeholder.textContent = 'No image — set a URL or upload a file';
      cell.body.appendChild(placeholder);
    } else {
      var img = document.createElement('img');
      img.className = 'cxd-image';
      img.style.objectFit = imageFit(panel && panel.fit);
      if (panel && panel.alt != null) img.alt = String(panel.alt);
      if (panel && (panel.align || panel.valign)) {
        var hx = { left: 'left', center: 'center', right: 'right' }[panel.align] || 'center';
        var vy = { top: 'top', middle: 'center', bottom: 'bottom' }[panel.valign] || 'center';
        img.style.objectPosition = hx + ' ' + vy;
      }
      img.src = src;
      var host = img;
      var safeHref = panel && panel.href ? safeUrl(panel.href) : '';
      if (safeHref) {
        var link = document.createElement('a');
        link.className = 'cxd-image-link';
        link.href = safeHref;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.appendChild(img);
        host = link;
      }
      cell.body.appendChild(host);
    }

    cell.setState('ready');
    if (typeof options.onPanelRendered === 'function') {
      options.onPanelRendered({
        panelId: item.panel, item: item, cell: cell.root,
        canvas: cell.canvas, body: cell.body, instance: null, type: 'image'
      });
    }
  }

  /**
   * Replace the whole filter state (scheme pick, reset, API), repaint every
   * Filters panel, and re-filter the bound panels.
   * @param {object[]} state - New predicates.
   * @param {(string|null)} scheme - The scheme it came from, if any.
   * @returns {void}
   */
  function replaceFilterState(state, scheme) {
    filterState = normalizeState(state);
    activeScheme = scheme;
    renderFilterPanels();
    applyFilterChange();
  }

  /**
   * Apply a Filters-panel change: re-query the pushdown sources whose database
   * filters changed (and what derives from them), then filter in the browser.
   * @returns {Promise<void>} Resolves once panels are updated.
   */
  function applyFilterChange() {
    var changed = [];
    Object.keys(spec.data || {}).forEach(function (ref) {
      if (!pushesFilters(ref) || !Object.prototype.hasOwnProperty.call(pushedWhere, ref)) return;
      if (pushedWhere[ref] !== JSON.stringify(pushdownWhere(ref))) changed.push(ref);
    });
    if (!changed.length) {
      applyControlFilters();
      return Promise.resolve();
    }
    return refetchRefs(changed.concat(dependentSources(changed))).then(applyControlFilters);
  }

  /**
   * Set (or clear, with `null`) the predicate of one source + field, then
   * re-filter. The edit leaves any active scheme ("custom" state).
   * @param {string} dataRef - Source ref.
   * @param {string} field - Field name.
   * @param {(object|null)} predicate - `{values}` | `{min, max}` | `{text}` | null.
   * @returns {void}
   */
  function setFilterPredicate(dataRef, field, predicate) {
    var key = fieldKey(dataRef, field);
    var next = filterState.filter(function (p) { return fieldKey(p.dataRef, p.field) !== key; });
    if (predicate && isActive(predicate)) {
      var entry = { dataRef: dataRef, field: field };
      for (var k in predicate) {
        if (Object.prototype.hasOwnProperty.call(predicate, k)) entry[k] = predicate[k];
      }
      next.push(entry);
    }
    filterState = normalizeState(next);
    if (activeScheme !== null) {
      activeScheme = null;
      filterPanelViews.forEach(function (v) { v.syncScheme(); });
    }
    applyFilterChange();
  }

  /**
   * Repaint every Filters panel from the current state.
   * @returns {void}
   */
  function renderFilterPanels() {
    filterPanelViews.forEach(function (v) { v.render(); });
  }

  /**
   * Render a Filters panel (`type:"filters"`): a scheme bar (pick / save /
   * reset) and one widget per field — a checkbox list with counts, a min/max
   * range, or a search box. Its fields come from `panel.fields` or, when
   * absent, every row annotation and numeric column of `panel.dataRef`.
   * @param {object} cell - The cell from {@link buildCell}.
   * @param {object} item - The layout item.
   * @param {object} panel - The Filters panel spec.
   * @returns {Promise<null>} Resolves once its sources are resolved and it is drawn.
   */
  function renderFiltersPanel(cell, item, panel) {
    cell.canvas.style.display = 'none';
    cell.root.classList.add('cxd-filters-cell');
    var sources = spec.data || {};
    var refs = [];
    if (panel.dataRef) refs.push(panel.dataRef);
    (Array.isArray(panel.fields) ? panel.fields : []).forEach(function (f) {
      if (f && typeof f === 'object' && f.dataRef && refs.indexOf(f.dataRef) === -1) refs.push(f.dataRef);
    });

    function notify(state) {
      if (typeof options.onPanelRendered === 'function') {
        options.onPanelRendered({
          panelId: item.panel, item: item, cell: cell.root,
          canvas: cell.canvas, body: cell.body, instance: null,
          type: 'filters', state: state
        });
      }
    }

    return Promise.all(refs.map(function (ref) {
      return resolveRef(ref).then(null, function () { return null; });
    })).then(function () {
      var fields = resolveFields(panel,
        function (ref) { return refDomain[ref] || refData[ref] || null; },
        function (ref) { return sourceAxis(ref, sources); });
      var schemeSelect = null;
      var view = {
        panelId: item.panel,
        render: function () {
          cell.body.innerHTML = '';
          var root = document.createElement('div');
          root.className = 'cxd-filters';
          root.appendChild(buildSchemeBar());
          if (!fields.length) {
            var hint = document.createElement('div');
            hint.className = 'cxd-filters-hint';
            hint.textContent = 'No fields to filter';
            root.appendChild(hint);
          }
          fields.forEach(function (f) { root.appendChild(buildField(f)); });
          cell.body.appendChild(root);
        },
        syncScheme: function () {
          if (schemeSelect) schemeSelect.value = activeScheme === null ? '' : activeScheme;
        }
      };

      /**
       * The scheme bar: a scheme picker, a name box + Save, and Reset.
       * @returns {HTMLElement} The bar.
       */
      function buildSchemeBar() {
        var bar = document.createElement('div');
        bar.className = 'cxd-filters-bar';
        schemeSelect = null;
        var names = Object.keys(filterSchemes);
        if (names.length) {
          schemeSelect = document.createElement('select');
          schemeSelect.className = 'cxd-filters-scheme';
          var custom = document.createElement('option');
          custom.value = '';
          custom.textContent = 'Current filters';
          schemeSelect.appendChild(custom);
          names.forEach(function (name) {
            var opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            schemeSelect.appendChild(opt);
          });
          schemeSelect.value = activeScheme === null ? '' : activeScheme;
          schemeSelect.addEventListener('change', function () {
            var name = schemeSelect.value;
            if (name && Object.prototype.hasOwnProperty.call(filterSchemes, name)) {
              replaceFilterState(filterSchemes[name], name);
            }
          });
          bar.appendChild(schemeSelect);
        }
        if (panel.saveSchemes !== false) {
          var nameInput = document.createElement('input');
          nameInput.className = 'cxd-filters-scheme-name';
          nameInput.type = 'text';
          nameInput.placeholder = 'Scheme name';
          var save = document.createElement('button');
          save.className = 'cxd-filters-save';
          save.type = 'button';
          save.textContent = 'Save';
          save.addEventListener('click', function () {
            var name = String(nameInput.value || '').trim();
            if (!name) return;
            filterSchemes[name] = normalizeState(filterState);
            activeScheme = name;
            if (typeof options.onFilterSchemesChange === 'function') {
              options.onFilterSchemesChange(JSON.parse(JSON.stringify(filterSchemes)));
            }
            renderFilterPanels();
          });
          bar.appendChild(nameInput);
          bar.appendChild(save);
        }
        var reset = document.createElement('button');
        reset.className = 'cxd-filters-reset';
        reset.type = 'button';
        reset.textContent = 'Reset';
        reset.addEventListener('click', function () { replaceFilterState([], null); });
        bar.appendChild(reset);
        return bar;
      }

      /**
       * One field's section: its label and widget, seeded from the state.
       * @param {object} f - Resolved field (see filters.resolveFields).
       * @returns {HTMLElement} The section.
       */
      function buildField(f) {
        var current = null;
        filterState.forEach(function (p) {
          if (p.dataRef === f.dataRef && p.field === f.field) current = p;
        });
        var section = document.createElement('div');
        section.className = 'cxd-filters-field';
        var label = document.createElement('div');
        label.className = 'cxd-filters-label';
        label.textContent = f.label;
        section.appendChild(label);
        if (f.kind === 'values') section.appendChild(buildValues(f, current));
        else if (f.kind === 'range') section.appendChild(buildRange(f, current));
        else section.appendChild(buildSearch(f, current));
        return section;
      }

      /**
       * Checkbox list: every value (with its row count), all checked = no filter.
       * @param {object} f - Resolved field.
       * @param {(object|null)} current - Its current predicate.
       * @returns {HTMLElement} The list.
       */
      function buildValues(f, current) {
        var list = document.createElement('div');
        list.className = 'cxd-filters-values';
        var boxes = [];
        f.summary.values.forEach(function (entry) {
          var row = document.createElement('label');
          row.className = 'cxd-filters-check';
          var box = document.createElement('input');
          box.type = 'checkbox';
          box.className = 'cxd-filters-cb';
          box.value = entry.value;
          box.checked = !current || !Array.isArray(current.values) || current.values.indexOf(entry.value) !== -1;
          box.addEventListener('change', function () {
            var checked = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
            setFilterPredicate(f.dataRef, f.field, checked.length === boxes.length ? null : { values: checked });
          });
          boxes.push(box);
          var text = document.createElement('span');
          // A pushdown source's rows are groups the database made, so a row
          // count per value would mislead; show the value alone.
          text.textContent = pushesFilters(f.dataRef) ? String(entry.value) : entry.value + ' (' + entry.count + ')';
          row.appendChild(box);
          row.appendChild(text);
          list.appendChild(row);
        });
        return list;
      }

      /**
       * A dual-thumb range slider styled like the CanvasXpress Data Filter
       * range: editable min / max values on top, a track with two thumbs, and
       * a tick ruler over the "pretty" extent of the data. A thumb at its end
       * (or a blank value) is unbounded; with both unbounded there is no filter.
       * Dragging updates the values live and filters on release.
       * @param {object} f - Resolved field.
       * @param {(object|null)} current - Its current predicate.
       * @returns {HTMLElement} The range widget.
       */
      function buildRange(f, current) {
        var curMin = current && typeof current.min === 'number' ? current.min : null;
        var curMax = current && typeof current.max === 'number' ? current.max : null;
        var dataMin = typeof f.summary.min === 'number' ? f.summary.min : curMin;
        var dataMax = typeof f.summary.max === 'number' ? f.summary.max : curMax;
        if (dataMin === null || dataMax === null) return buildRangeInputs(f, current);
        if (curMin !== null) dataMin = Math.min(dataMin, curMin);
        if (curMax !== null) dataMax = Math.max(dataMax, curMax);
        var ticks = prettyTicks(dataMin, dataMax, 4);
        var lo = ticks.values[0];
        var hi = ticks.values[ticks.values.length - 1];
        var decimals = Math.max(0, -Math.floor(Math.log(ticks.step / 10) / Math.LN10 + 1e-9));
        var step = Math.pow(10, -decimals);

        var wrap = document.createElement('div');
        wrap.className = 'cxd-filters-range';
        var values = document.createElement('div');
        values.className = 'cxd-range-values';
        var minBox = document.createElement('input');
        var maxBox = document.createElement('input');
        var slider = document.createElement('div');
        slider.className = 'cxd-range-slider';
        var track = document.createElement('div');
        track.className = 'cxd-range-track';
        var fill = document.createElement('div');
        fill.className = 'cxd-range-fill';
        var thumbLo = document.createElement('div');
        thumbLo.className = 'cxd-range-thumb';
        var thumbHi = document.createElement('div');
        thumbHi.className = 'cxd-range-thumb';
        var minRange = document.createElement('input');
        var maxRange = document.createElement('input');
        [[minBox, 'min', curMin === null ? lo : curMin], [maxBox, 'max', curMax === null ? hi : curMax]].forEach(function (s) {
          s[0].type = 'number';
          s[0].className = 'cxd-filters-' + s[1];
          s[0].step = 'any';
          s[0].value = formatBound(s[2]);
          s[0].setAttribute('aria-label', f.label + ' ' + s[1]);
        });
        [minRange, maxRange].forEach(function (r, i) {
          r.type = 'range';
          r.className = 'cxd-range-input';
          r.min = String(lo);
          r.max = String(hi);
          r.step = String(step);
          r.tabIndex = -1;                 // the number boxes are the keyboard path
          r.value = i === 0 ? minBox.value : maxBox.value;
        });

        function formatBound(v) {
          return String(Number(Number(v).toFixed(decimals)));
        }
        function pct(v) {
          return hi === lo ? 0 : (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * 100;
        }
        // Mirror the two values onto the fill and thumbs; keep min <= max.
        function paint() {
          var a = Number(minRange.value);
          var b = Number(maxRange.value);
          fill.style.left = pct(a) + '%';
          fill.style.right = (100 - pct(b)) + '%';
          thumbLo.style.left = pct(a) + '%';
          thumbHi.style.left = pct(b) + '%';
          // Past halfway the min thumb must sit on top, or it cannot leave the max.
          minRange.style.zIndex = pct(a) > 50 ? '4' : '3';
        }
        function apply() {
          var a = parseBound(minBox.value);
          var b = parseBound(maxBox.value);
          if (a !== null && b !== null && a > b) { var t = a; a = b; b = t; }
          var pred = {};
          if (a !== null && a > lo) pred.min = a;
          if (b !== null && b < hi) pred.max = b;
          setFilterPredicate(f.dataRef, f.field,
            pred.min === undefined && pred.max === undefined ? null : pred);
        }
        minRange.addEventListener('input', function () {
          if (Number(minRange.value) > Number(maxRange.value)) minRange.value = maxRange.value;
          minBox.value = formatBound(minRange.value);
          paint();
        });
        maxRange.addEventListener('input', function () {
          if (Number(maxRange.value) < Number(minRange.value)) maxRange.value = minRange.value;
          maxBox.value = formatBound(maxRange.value);
          paint();
        });
        minRange.addEventListener('change', apply);
        maxRange.addEventListener('change', apply);
        [[minBox, minRange, lo], [maxBox, maxRange, hi]].forEach(function (s) {
          s[0].addEventListener('change', function () {
            if (parseBound(s[0].value) === null) s[0].value = formatBound(s[2]);   // blank = unbounded
            s[1].value = s[0].value;
            paint();
            apply();
          });
        });

        values.appendChild(minBox);
        values.appendChild(maxBox);
        slider.appendChild(track);
        slider.appendChild(fill);
        slider.appendChild(thumbLo);
        slider.appendChild(thumbHi);
        slider.appendChild(minRange);
        slider.appendChild(maxRange);
        var ruler = document.createElement('div');
        ruler.className = 'cxd-range-ticks';
        ticks.values.forEach(function (v, i) {
          var major = document.createElement('span');
          major.className = 'cxd-range-tick cxd-range-tick-major';
          major.style.left = pct(v) + '%';
          var text = document.createElement('span');
          text.className = 'cxd-range-tick-label';
          text.textContent = String(v);
          major.appendChild(text);
          ruler.appendChild(major);
          if (i === ticks.values.length - 1) return;
          for (var k = 1; k < 5; k++) {
            var minor = document.createElement('span');
            minor.className = 'cxd-range-tick';
            minor.style.left = pct(v + ticks.step * k / 5) + '%';
            ruler.appendChild(minor);
          }
        });
        wrap.appendChild(values);
        wrap.appendChild(slider);
        wrap.appendChild(ruler);
        paint();
        return wrap;
      }

      /**
       * Fallback for a range field without a numeric extent: min / max number
       * inputs (blank = unbounded).
       * @param {object} f - Resolved field.
       * @param {(object|null)} current - Its current predicate.
       * @returns {HTMLElement} The range widget.
       */
      function buildRangeInputs(f, current) {
        var wrap = document.createElement('div');
        wrap.className = 'cxd-filters-range cxd-filters-range-plain';
        var min = document.createElement('input');
        var max = document.createElement('input');
        [[min, 'min'], [max, 'max']].forEach(function (spec3) {
          var input = spec3[0];
          input.type = 'number';
          input.className = 'cxd-filters-' + spec3[1];
          input.placeholder = spec3[1];
          input.value = current && typeof current[spec3[1]] === 'number' ? String(current[spec3[1]]) : '';
          input.addEventListener('change', function () {
            var lo = parseBound(min.value);
            var hi = parseBound(max.value);
            var pred = {};
            if (lo !== null) pred.min = lo;
            if (hi !== null) pred.max = hi;
            setFilterPredicate(f.dataRef, f.field, lo === null && hi === null ? null : pred);
          });
        });
        var dash = document.createElement('span');
        dash.textContent = '\u2013';
        wrap.appendChild(min);
        wrap.appendChild(dash);
        wrap.appendChild(max);
        return wrap;
      }

      /**
       * A search box (case-insensitive "contains"), applied after a short pause.
       * @param {object} f - Resolved field.
       * @param {(object|null)} current - Its current predicate.
       * @returns {HTMLElement} The input.
       */
      function buildSearch(f, current) {
        var input = document.createElement('input');
        input.type = 'search';
        input.className = 'cxd-filters-text';
        input.placeholder = 'Contains\u2026';
        input.value = current && typeof current.text === 'string' ? current.text : '';
        var timer = null;
        var delayMs = typeof panel.debounce === 'number' ? panel.debounce : 250;
        input.addEventListener('input', function () {
          if (timer) clearTimeout(timer);
          var apply = function () {
            timer = null;
            var text = String(input.value || '');
            setFilterPredicate(f.dataRef, f.field, text.trim() ? { text: text } : null);
          };
          if (delayMs > 0) timer = setTimeout(apply, delayMs);
          else apply();
        });
        return input;
      }

      filterPanelViews.push(view);
      view.render();
      notify('ready');
      return null;
    });
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
    var isParam = panel.mode === 'param';

    // A config control drives a target panel's config (updateConfig), not a data
    // filter — it needs no data of its own, so short-circuit here.
    if (panel.mode === 'config') {
      return Promise.resolve(buildConfigControl(cell, item, panel, notify));
    }

    /**
     * Build the control's DOM from a list of choices and wire its change handler
     * (param mode → applyParamChange; filter mode → applyControlFilters).
     * @param {Array} values - The choices to offer (empty renders a hint).
     * @returns {null} Always null (a control renders no CanvasXpress instance).
     * @private
     */
    function buildWidget(values) {
      var widget = document.createElement('div');
      widget.className = 'cxd-annctl';
      applyAlignment(cell.body, panel);
      if (panel.title && !panel.hideTitle) {
        var label = document.createElement('span');
        label.className = 'cxd-annctl-label';
        label.textContent = panel.title;
        widget.appendChild(label);
      }
      var configured = isParam ? !!panel.param : !!panel.annotation;
      if (!configured || !values.length) {
        var hint = document.createElement('span');
        hint.className = 'cxd-annctl-hint';
        hint.textContent = !configured
          ? (isParam ? 'Choose a parameter…' : 'Choose an annotation…')
          : (isParam ? 'No values' : 'No "' + panel.annotation + '" values');
        widget.appendChild(hint);
      } else if (isParam) {
        // A param control re-queries the backend on change; "All" → null clears
        // the param so the source's query widens back to everything. A disabled
        // control (e.g. in a self-contained export, where no server is reachable)
        // renders read-only and shows a "snapshot" note instead of re-querying.
        var paramInput = buildAnnotationInput(panel, values, function (value) {
          if (panel.disabled) return;
          applyParamChange(panel.param, value);
        });
        if (panel.disabled) disableControlInput(widget, paramInput, panel);
        widget.appendChild(paramInput);
      } else {
        var entry = { annotation: panel.annotation, value: null, resetUI: null, dataRef: panel.dataRef, compartment: comp };
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
    }

    /**
     * Build a debounced free-text search control that writes the typed value
     * into the parameter (empty clears it). Used for `style:"search"`. When
     * `suggestions` are supplied (from the control's `optionsFrom` source), a
     * native `<datalist>` is attached so the user gets type-ahead autocomplete
     * and can pick a value from the dropdown — while free text is still allowed
     * (so a value outside the suggestion list can be typed).
     * @param {Array} [suggestions] - Candidate values for autocomplete.
     * @returns {null} Always null (a control renders no CanvasXpress instance).
     * @private
     */
    function buildSearchWidget(suggestions) {
      var widget = document.createElement('div');
      widget.className = 'cxd-annctl';
      applyAlignment(cell.body, panel);
      if (panel.title && !panel.hideTitle) {
        var label = document.createElement('span');
        label.className = 'cxd-annctl-label';
        label.textContent = panel.title;
        widget.appendChild(label);
      }
      if (!panel.param) {
        var hint = document.createElement('span');
        hint.className = 'cxd-annctl-hint';
        hint.textContent = 'Choose a parameter…';
        widget.appendChild(hint);
      } else {
        var input = document.createElement('input');
        input.type = 'search';
        input.className = 'cxd-annctl-search';
        if (panel.placeholder) input.setAttribute('placeholder', panel.placeholder);
        if (paramState[panel.param] != null) input.value = String(paramState[panel.param]);
        if (panel.disabled) { input.disabled = true; input.setAttribute('disabled', 'disabled'); }
        // Type-ahead: a <datalist> gives native autocomplete + a pick list.
        if (suggestions && suggestions.length) {
          var listId = makeCanvasId(spec.id, 'suggest', panel.param, 0);
          var datalist = document.createElement('datalist');
          datalist.id = listId;
          for (var s = 0; s < suggestions.length; s++) {
            var opt = document.createElement('option');
            opt.value = String(suggestions[s]);
            datalist.appendChild(opt);
          }
          input.setAttribute('list', listId);
          widget.appendChild(datalist);
        }
        var fire = debounce(function () {
          if (panel.disabled) return;
          var text = input.value.trim();
          applyParamChange(panel.param, text === '' ? null : text);
        }, panel.debounce != null ? panel.debounce : 250);
        listen(input, 'input', fire);
        listen(input, 'change', fire);
        // ESC in a native type=search clears the field, which would blank the
        // param and tear down its bound viz — and it would also bubble to the
        // dashboard-wide Escape reset. Neither is wanted here: swallow ESC so the
        // current entry (and its visualization) survives.
        listen(input, 'keydown', function (ev) {
          if (ev.key === 'Escape' || ev.keyCode === 27) { ev.preventDefault(); ev.stopPropagation(); }
        });
        widget.appendChild(input);
        if (panel.disabled) disableControlInput(widget, input, panel);
      }
      cell.body.appendChild(widget);
      cell.setState('ready');
      notify('ready');
      return null;
    }

    // A free-text search param control. With `optionsFrom`, its candidate values
    // are resolved from that source and offered as type-ahead autocomplete; the
    // typed (or picked) text becomes the parameter value (debounced).
    if (isParam && panel.style === 'search') {
      if (!panel.optionsFrom) {
        return Promise.resolve(buildSearchWidget());
      }
      var suggestComp = panel.optionsFrom.compartment || 'x';
      var suggestAnn = panel.optionsFrom.annotation || panel.optionsFrom.field;
      return resolveRef(panel.optionsFrom.dataRef)
        .then(function (data) {
          var values = annotationValues(data, suggestComp, suggestAnn);
          if (!values.length) {
            var other2 = suggestComp === 'x' ? 'z' : 'x';
            values = annotationValues(data, other2, suggestAnn);
          }
          return buildSearchWidget(values);
        })
        .catch(function () { return buildSearchWidget(); });
    }

    // A param control with a static option list needs no data at all.
    if (isParam && Array.isArray(panel.options)) {
      return Promise.resolve(buildWidget(panel.options));
    }

    // A param control can source its choices from a DIFFERENT dataset's distinct
    // annotation values (`optionsFrom: {dataRef, annotation, compartment?}`) —
    // e.g. a small "list of regions" query feeding a big "sales" query.
    var optionsFrom = isParam ? panel.optionsFrom : null;
    var choiceRef = optionsFrom ? optionsFrom.dataRef : panel.dataRef;
    var choiceAnnotation = optionsFrom ? (optionsFrom.annotation || optionsFrom.field) : panel.annotation;
    var choiceComp = optionsFrom && optionsFrom.compartment ? optionsFrom.compartment : comp;

    var choiceData = choiceRef && choiceRef !== panel.dataRef
      ? resolveRef(choiceRef)
      : resolveOwnerData(panel);

    return choiceData
      .then(function (data) {
        var values = annotationValues(data, choiceComp, choiceAnnotation);
        if (!values.length) {
          // Auto-detect: the name may be a variable annotation ('z') instead.
          var other = choiceComp === 'x' ? 'z' : 'x';
          var alt = annotationValues(data, other, choiceAnnotation);
          if (alt.length) { comp = other; values = alt; }
        }
        return buildWidget(values);
      })
      .catch(function (err) {
        cell.setState('error', String(err && err.message || err));
        notify('error');
        return null;
      });
  }

  /**
   * Render a config control (`mode:"config"`): a native input whose options each
   * carry a config fragment. Changing the selection merges the current fragment
   * from every config control targeting the same panel and calls `updateConfig`
   * on that panel's live instance. Styles: `slider` (an ordered range over the
   * options), `buttons` (a segmented toggle), or `dropdown`. The initial UI
   * position comes from `panel.value` (an option `value` or a 0-based index) and
   * is NOT applied on load — the target panel already carries the matching config
   * from the spec, so applying only happens on user change.
   *
   * @param {object} cell - The cell from {@link buildCell}.
   * @param {object} item - The layout item.
   * @param {object} panel - The control panel (`{mode:'config', target, options,
   *   style, value, title}`).
   * @param {function} notify - renderControlWidget's onPanelRendered notifier.
   * @returns {null} Always null (a control renders no CanvasXpress instance).
   * @private
   */
  function buildConfigControl(cell, item, panel, notify) {
    var options = panel.options || [];
    var target = panel.target;
    var entry = { current: {} };
    if (!configControlsByTarget[target]) configControlsByTarget[target] = [];
    configControlsByTarget[target].push(entry);

    // Resolve the initial option: match panel.value against option.value, else
    // treat it as a 0-based index, else fall back to the first option.
    var initIdx = 0;
    if (panel.value != null) {
      for (var vi = 0; vi < options.length; vi++) {
        if (options[vi].value === panel.value) { initIdx = vi; break; }
      }
      if (initIdx === 0 && options[0].value !== panel.value &&
          typeof panel.value === 'number' && panel.value >= 0 && panel.value < options.length) {
        initIdx = panel.value;
      }
    }
    entry.current = (options[initIdx] && options[initIdx].config) || {};

    /**
     * Merge every config control's current fragment for this target and push it
     * onto the target panel's live instance.
     * @param {number} idx - The chosen option index for THIS control.
     * @returns {void}
     * @private
     */
    function apply(idx) {
      entry.current = (options[idx] && options[idx].config) || {};
      var merged = {};
      var siblings = configControlsByTarget[target];
      for (var s = 0; s < siblings.length; s++) {
        var frag = siblings[s].current;
        for (var k in frag) { if (Object.prototype.hasOwnProperty.call(frag, k)) merged[k] = frag[k]; }
      }
      var slot = cellByPanel[target];
      var inst = slot && slot.instance;
      if (inst && typeof inst.updateConfig === 'function') inst.updateConfig(merged);
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

    var style = panel.style || 'buttons';
    if (style === 'slider') {
      var slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'cxd-slider';
      slider.min = '0';
      slider.max = String(Math.max(0, options.length - 1));
      slider.step = '1';
      slider.value = String(initIdx);
      var readout = document.createElement('span');
      readout.className = 'cxd-slider-readout';
      readout.textContent = options.length ? String(options[initIdx].label) : '';
      listen(slider, 'input', function () {
        var idx = parseInt(slider.value, 10) || 0;
        readout.textContent = options[idx] ? String(options[idx].label) : '';
        apply(idx);
      });
      widget.appendChild(slider);
      widget.appendChild(readout);
    } else if (style === 'dropdown') {
      var select = document.createElement('select');
      select.className = 'cxd-annctl-select';
      options.forEach(function (opt, i) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = String(opt.label);
        if (i === initIdx) o.selected = true;
        select.appendChild(o);
      });
      listen(select, 'change', function () { apply(parseInt(select.value, 10) || 0); });
      widget.appendChild(select);
    } else {
      // Segmented buttons.
      var seg = document.createElement('span');
      seg.className = 'cxd-annctl-seg';
      var buttons = [];
      options.forEach(function (opt, i) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cxd-annctl-segbtn' + (i === initIdx ? ' cxd-annctl-on' : '');
        btn.textContent = String(opt.label);
        listen(btn, 'click', function () {
          buttons.forEach(function (b) { b.classList.remove('cxd-annctl-on'); });
          btn.classList.add('cxd-annctl-on');
          apply(i);
        });
        buttons.push(btn);
        seg.appendChild(btn);
      });
      widget.appendChild(seg);
    }

    cell.body.appendChild(widget);
    cell.setState('ready');
    notify('ready');
    return null;
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
        bind(control.dataRef, instance, cell);
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
  scheduleRefreshes(spec, store, refBindings, timers, CX, refreshJoinsOf);

  // --- live streams: push (SSE) sources, coalesced to <=1 redraw per frame ---
  subscriptions.push(subscribeLive(spec, store, applyLiveTick,
    frameScheduler(options.requestAnimationFrame), options.prepareLive, liveStreamClosed));

  var handle = {
    spec: spec,
    container: container,
    grid: grid,
    instances: instances,
    broadcastGroup: broadcastGroup,
    store: store,
    /**
     * The live dashboard parameter values (name -> value), reflecting the
     * current mode:"param" control selections. Pass to the HTML export so the
     * snapshot captures the active view.
     * @returns {object} A copy of the current parameter values.
     */
    getParams: function () {
      var copy = {};
      for (var name in paramState) {
        if (Object.prototype.hasOwnProperty.call(paramState, name)) copy[name] = paramState[name];
      }
      return copy;
    },
    /**
     * Set a dashboard parameter programmatically (re-queries dependent sources
     * and live-updates their panels), exactly as a param control would.
     * @param {string} name - Parameter name (should exist in spec.params).
     * @param {*} value - New value (null clears it, widening the query).
     * @returns {Promise<void>} Resolves once affected panels have updated.
     */
    setParam: function (name, value) {
      return applyParamChange(name, value);
    },
    /**
     * The Filters-panel state: a serializable list of predicates
     * `{dataRef, field, values? | min? / max? | text?}` (see filters.js).
     * @returns {object[]} A copy of the current state.
     */
    getFilterState: function () {
      return JSON.parse(JSON.stringify(filterState));
    },
    /**
     * Replace the Filters-panel state (e.g. to restore a saved view): the
     * panels repaint and every bound panel is re-filtered.
     * @param {object[]} state - Predicates, as from {@link getFilterState}.
     * @returns {void}
     */
    setFilterState: function (state) {
      replaceFilterState(state, null);
    },
    /**
     * The named filter schemes: `spec.filterSchemes` plus any saved at runtime.
     * @returns {object} name -> filter state (a copy).
     */
    getFilterSchemes: function () {
      return JSON.parse(JSON.stringify(filterSchemes));
    },
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
      // A removed Filters panel stops repainting (its state stays shared).
      filterPanelViews = filterPanelViews.filter(function (v) { return v.panelId !== panelId; });
      renderedItems = allItems ? allItems.slice()
        : renderedItems.filter(function (it) { return it.panel !== panelId; });
      refreshTemplate();
    },
    /**
     * Tear down the dashboard: stop refresh timers, close live streams, destroy
     * CanvasXpress instances, and clear the DOM.
     * @returns {void}
     */
    destroy: function () {
      if (escListener && doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('keydown', escListener);
        escListener = null;
      }
      timers.forEach(function (t) { clearInterval(t); });
      timers.length = 0;
      subscriptions.forEach(function (s) { try { s.close(); } catch (e) { /* noop */ } });
      subscriptions.length = 0;
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
 * @param {function} [onRefreshed] - `function(ref, data)` called with each
 *   refreshed source's fresh data, so joins that read it can be recomputed.
 * @returns {void}
 * @private
 */
function scheduleRefreshes(spec, store, refBindings, timers, CX, onRefreshed) {
  var sources = spec.data || {};
  Object.keys(sources).forEach(function (ref) {
    var source = sources[ref];
    if (!source || source.kind !== 'connector' || !(source.refresh > 0)) return;
    var handle = setInterval(function () {
      store.invalidate(ref, source);
      store.resolve(ref, source, { force: true }).then(function (data) {
        var bound = refBindings[ref] || [];
        bound.forEach(function (binding) {
          if (binding.rebuild) {
            try { binding.instance = binding.rebuild(data); } catch (e) { /* keep polling */ }
            return;
          }
          var instance = binding.instance;
          if (instance && typeof instance.updateData === 'function') {
            var prepared = binding.prepare ? binding.prepare(data) : data;
            try { instance.updateData(prepared, true, false); } catch (e) { /* keep polling */ }
          }
        });
        if (typeof onRefreshed === 'function') return onRefreshed(ref, data);
      }).catch(function () { /* transient error: keep polling */ });
    }, source.refresh * 1000);
    timers.push(handle);
  });
}

/**
 * Samples a live source keeps when its spec sets no `window`. Eviction is never
 * optional for a stream (an unbounded window grows memory forever), so an unset
 * window still gets this bound.
 * @type {number}
 */
var DEFAULT_LIVE_WINDOW = 1000;

/**
 * The bounded window (samples kept) for a live source.
 * @param {object} source - The `kind:"live"` source spec.
 * @returns {number} Its positive-integer `window`, else {@link DEFAULT_LIVE_WINDOW}.
 * @private
 */
function liveWindowSize(source) {
  return source && source.window > 0 ? source.window : DEFAULT_LIVE_WINDOW;
}

/**
 * Subscribe every `kind:"live"` source (the push counterpart of
 * {@link scheduleRefreshes}): each SSE tick is buffered per source and flushed on
 * the next frame, where the ticks that arrived in between are merged into ONE
 * tick — so a burst costs one redraw per frame, not one per message
 * (backpressure). Reconnection is native to EventSource; a dropped stream keeps
 * the panel's last good data.
 * @param {object} spec - The dashboard spec.
 * @param {DataStore} store - The data store (owns the SSE transport).
 * @param {function} apply - `function(ref, tick)` applying a merged tick.
 * @param {function} schedule - `function(fn)` running `fn` on the next frame.
 * @param {function} [prepare] - Called once, only when the spec has a live
 *   source, before any stream opens; may return a Promise (e.g. establishing the
 *   stream server's session). Streams open once it settles, even if it fails —
 *   a stream that is still refused reports that itself.
 * @param {function} [onClosed] - `function(ref)` when a stream fails for good
 *   (the browser will not reconnect — e.g. the server has no such stream).
 * @returns {{close: function}} Handle closing every stream and dropping any
 *   buffered ticks (so a pending frame flushes nothing after destroy).
 * @private
 */
function subscribeLive(spec, store, apply, schedule, prepare, onClosed) {
  var sources = spec.data || {};
  var liveRefs = Object.keys(sources).filter(function (ref) {
    return sources[ref] && sources[ref].kind === 'live';
  });
  var streams = [];
  var pending = {};      // ref -> [tick] received since the last frame
  var scheduled = false;
  var stopped = false;

  function flush() {
    scheduled = false;
    if (stopped) return;
    var batch = pending;
    pending = {};
    Object.keys(batch).forEach(function (ref) {
      var ticks = batch[ref];
      if (!ticks.length) return;
      var merged = ticks.length === 1 ? ticks[0]
        : ticks.reduce(function (acc, tick) { return appendTick(acc, tick, 0); }, null);
      try { apply(ref, merged); } catch (e) { /* keep streaming */ }
    });
  }

  function open() {
    if (stopped) return;   // destroyed while `prepare` was pending
    liveRefs.forEach(function (ref) {
      streams.push(store.subscribe(ref, sources[ref], {
        onError: function (err, errRef, closed) {
          if (closed && !stopped && typeof onClosed === 'function') onClosed(ref);
        },
        onTick: function (tick) {
          if (stopped || !tick || !tick.y) return;
          (pending[ref] || (pending[ref] = [])).push(tick);
          if (!scheduled) {
            scheduled = true;
            schedule(flush);
          }
        }
      }));
    });
  }

  if (liveRefs.length && typeof prepare === 'function') {
    var ready;
    try { ready = Promise.resolve(prepare()); } catch (e) { ready = Promise.resolve(); }
    ready.then(open, open);
  } else if (liveRefs.length) {
    open();
  }

  return {
    close: function () {
      stopped = true;
      pending = {};
      streams.forEach(function (s) { try { s.close(); } catch (e) { /* noop */ } });
      streams.length = 0;
    }
  };
}

/**
 * A "run on the next frame" scheduler: the given (or global)
 * requestAnimationFrame, else a ~16ms timeout so coalescing also works outside a
 * browser (tests, SSR).
 * @param {function} [raf] - An injected requestAnimationFrame.
 * @returns {function} `function(fn)` scheduling `fn` once.
 * @private
 */
function frameScheduler(raf) {
  var host = typeof globalThis !== 'undefined' ? globalThis : undefined;
  var impl = raf || (host && host.requestAnimationFrame);
  if (typeof impl === 'function') {
    return function (fn) { impl.call(host, fn); };
  }
  return function (fn) { setTimeout(fn, 16); };
}

/**
 * Append a live tick's new samples onto a CanvasXpress data object and trim it
 * to a window — without mutating `base` (it may be the spec's `initial` seed).
 * Rows align by variable name when the tick names its vars (positionally
 * otherwise); a variable new in the tick gets a row back-filled with nulls, and
 * annotation (`x`) columns stay length-aligned (null-padded). Also merges
 * several ticks into one (pass `null` as base and `0` as window).
 * @param {object|null} base - The current data (or null to start empty).
 * @param {object} tick - `{y:{vars?, smps, data}, x?}` — the new samples.
 * @param {number} windowSize - Samples to keep (the newest); `0` keeps all.
 * @returns {object} A new CanvasXpress data object.
 * @private
 */
function appendTick(base, tick, windowSize) {
  var baseY = (base && base.y) || {};
  var vars = (baseY.vars || []).slice();
  var smps = (baseY.smps || []).slice();
  var rows = (baseY.data || []).map(function (row) { return row.slice(); });
  var oldCount = smps.length;
  var tickY = tick.y || {};
  var newSmps = tickY.smps || [];
  var tickVars = Array.isArray(tickY.vars) && tickY.vars.length ? tickY.vars : null;
  var tickRows = tickY.data || [];

  // Adopt tick variables the base doesn't know yet (back-filled with nulls).
  (tickVars || []).forEach(function (name) {
    if (vars.indexOf(name) === -1) {
      vars.push(name);
      rows.push(new Array(oldCount).fill(null));
    }
  });

  rows.forEach(function (row, r) {
    var source = tickVars ? tickRows[tickVars.indexOf(vars[r])] : tickRows[r];
    for (var j = 0; j < newSmps.length; j++) {
      row.push(source && source[j] !== undefined ? source[j] : null);
    }
  });
  smps = smps.concat(newSmps);

  var x = null;
  var baseX = base && base.x;
  var tickX = tick.x || {};
  if (baseX || tick.x) {
    x = {};
    var keys = Object.keys(baseX || {});
    Object.keys(tickX).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); });
    keys.forEach(function (k) {
      var column = baseX && baseX[k] ? baseX[k].slice() : new Array(oldCount).fill(null);
      for (var j = 0; j < newSmps.length; j++) {
        column.push(tickX[k] && tickX[k][j] !== undefined ? tickX[k][j] : null);
      }
      x[k] = column;
    });
  }

  var excess = windowSize > 0 ? smps.length - windowSize : 0;
  if (excess > 0) {
    smps = smps.slice(excess);
    rows = rows.map(function (row) { return row.slice(excess); });
    if (x) Object.keys(x).forEach(function (k) { x[k] = x[k].slice(excess); });
  }

  var out = { y: { vars: vars, smps: smps, data: rows } };
  if (x) out.x = x;
  return out;
}

/**
 * Graph types that plot one point per VARIABLE, with samples as the axes.
 * @type {RegExp}
 */
var ROW_POINT_GRAPHS = /^(Scatter2D|Scatter3D|ScatterBubble2D|KaplanMeier|Pie)$/;

/**
 * Whether a graph panel's data should be transposed before CanvasXpress sees
 * it. An explicit `panel.transpose` (true / false) wins. Otherwise a
 * scatter-type chart (Scatter2D / Scatter3D / ScatterBubble2D / KaplanMeier)
 * or a Pie whose `xAxis` / `yAxis` name only VARIABLES of the data — and no
 * sample — is transposed: those graphs take samples as axes (a Pie: one slice
 * per variable) and plot one mark per variable, so axes named after table
 * columns (one row per sample, as uploads, connectors and joins arrive) mean
 * "one point / slice per row". A Pie with no axis named, one variable and
 * several samples is transposed too (it would otherwise be a single slice).
 * @param {object} panel - The panel spec.
 * @param {object} data - The panel's resolved data.
 * @returns {boolean} True to transpose.
 */
export function shouldTranspose(panel, data) {
  if (!panel) return false;
  if (panel.transpose === true || panel.transpose === false) return panel.transpose;
  var config = panel.config || {};
  if (!ROW_POINT_GRAPHS.test(config.graphType || '') || !data || !data.y) return false;
  var names = [].concat(config.xAxis || [], config.yAxis || []).filter(function (n) { return typeof n === 'string'; });
  var vars = data.y.vars || [];
  var smps = data.y.smps || [];
  // A Pie of a single column with several rows (and no axis named) would draw
  // one 100% slice — one slice per variable — so its rows become the slices.
  if (!names.length) return config.graphType === 'Pie' && vars.length === 1 && smps.length > 1;
  return names.every(function (n) { return vars.indexOf(n) !== -1; }) &&
    !names.some(function (n) { return smps.indexOf(n) !== -1; });
}

/**
 * The `data -> data` step a graph panel applies to its source's data, at
 * render and on every live update: project to `panel.measures`, then
 * transpose when {@link shouldTranspose} says so. The returned function
 * records its last decision as `.transposed`.
 * @param {object} panel - The panel spec.
 * @returns {function} The preparer.
 * @private
 */
function panelDataPreparer(panel) {
  var prepare = function (data) {
    var projected = projectMeasures(data, panel && panel.measures);
    prepare.transposed = shouldTranspose(panel, projected);
    return prepare.transposed ? transposeCxData(projected) : projected;
  };
  prepare.transposed = false;
  return prepare;
}

/**
 * Parse a range-filter bound typed into a number input.
 * @param {string} text - The input's value.
 * @returns {(number|null)} The number, or null when blank / not a number.
 * @private
 */
function parseBound(text) {
  if (text == null || String(text).trim() === '') return null;
  var n = Number(text);
  return isFinite(n) ? n : null;
}

/**
 * "Pretty" tick values covering [min, max] (like R's pretty(), which the
 * CanvasXpress range slider uses): a 1 / 2 / 5 x 10^k step near
 * (max - min) / n, with the ends rounded outward to it.
 * @param {number} min - Data minimum.
 * @param {number} max - Data maximum.
 * @param {number} n - Desired number of intervals.
 * @returns {{values: number[], step: number}} Ticks (ascending) and their step.
 * @private
 */
function prettyTicks(min, max, n) {
  if (!(max > min)) {
    var pad = min === 0 ? 1 : Math.abs(min) / 10;
    min -= pad;
    max += pad;
  }
  var raw = (max - min) / n;
  var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
  var step = mag;
  [1, 2, 5, 10].forEach(function (m) {
    if (Math.abs(m * mag - raw) < Math.abs(step - raw)) step = m * mag;
  });
  var lo = Math.floor(min / step + 1e-9) * step;
  var hi = Math.ceil(max / step - 1e-9) * step;
  var values = [];
  for (var v = lo; v <= hi + step / 2; v += step) values.push(Number(v.toPrecision(12)));
  return { values: values, step: step };
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
 * Render a control input read-only. Used for a `mode:"param"` control in a
 * self-contained export, where no backend is reachable: the widget still shows
 * (pre-selected to the snapshot value when `panel.value` is set) but ignores
 * input and carries a muted "snapshot" note so the state is honest.
 * @param {HTMLElement} widget - The control's wrapper element.
 * @param {HTMLElement} input - The built input (select / radios / buttons).
 * @param {object} panel - The control panel (reads `value`).
 * @returns {void}
 * @private
 */
function disableControlInput(widget, input, panel) {
  widget.classList.add('cxd-annctl-disabled');
  var controls = [];
  if (input.tagName === 'SELECT' || input.tagName === 'BUTTON') controls.push(input);
  if (typeof input.querySelectorAll === 'function') {
    var nested = input.querySelectorAll('select,input,button');
    for (var i = 0; i < nested.length; i++) controls.push(nested[i]);
  }
  controls.forEach(function (node) {
    node.disabled = true;
    node.setAttribute('disabled', 'disabled');
  });
  // Pre-select the snapshot value on a <select> so the frozen state is visible.
  if (input.tagName === 'SELECT' && panel && panel.value != null) {
    for (var o = 0; o < input.options.length; o++) {
      if (input.options[o].textContent === String(panel.value)) { input.value = input.options[o].value; break; }
    }
  }
  var note = document.createElement('span');
  note.className = 'cxd-annctl-hint';
  note.textContent = panel && panel.value != null ? '· ' + panel.value + ' (snapshot)' : '· snapshot';
  widget.appendChild(note);
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
 * Normalize an image panel's `fit` to a valid CSS object-fit keyword.
 * @param {string} fit - Requested fit (contain | cover | fill | none | scale-down).
 * @returns {string} A valid object-fit value ('contain' when unset/unknown).
 * @private
 */
function imageFit(fit) {
  return ['contain', 'cover', 'fill', 'none', 'scale-down'].indexOf(fit) !== -1 ? fit : 'contain';
}

/**
 * Return a URL only when it uses a safe scheme, else ''. Blocks `javascript:`,
 * `data:`, `vbscript:` and similar so an image's `href` cannot smuggle script
 * (shared dashboards are opened by other people). Relative URLs and the common
 * navigable schemes (http/https/mailto/tel) pass through unchanged.
 * @param {string} url - Candidate URL.
 * @returns {string} The URL if safe, otherwise ''.
 * @private
 */
function safeUrl(url) {
  var value = String(url).trim();
  // A scheme is letters/digits/+/-/. before the first ':' that precedes any '/',
  // '?' or '#'. No such scheme → relative URL → safe.
  var scheme = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!scheme) return value;
  var allowed = { http: 1, https: 1, mailto: 1, tel: 1 };
  return allowed[scheme[1].toLowerCase()] ? value : '';
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
 * Best-effort extraction of a value from a CanvasXpress click payload, for the
 * chart-click cross-filter. The payload shape varies by graph type, so this
 * tries, in order: an explicit annotation field the panel named (`field`), the
 * clicked sample name(s), then the clicked variable name(s). Returns null when
 * nothing usable is found (the click then sets no parameter).
 * @param {object} clicked - The object CanvasXpress passes to a click handler.
 * @param {string} [field] - An annotation/field name to prefer, when the payload
 *   carries per-point annotations (`clicked.x[field]` / `clicked[field]`).
 * @returns {*} The extracted value, or null.
 * @private
 */
function extractClickValue(clicked, field) {
  if (!clicked || typeof clicked !== 'object') return null;
  function first(v) { return Array.isArray(v) ? (v.length ? v[0] : null) : v; }
  if (field) {
    if (clicked.x && clicked.x[field] != null) return first(clicked.x[field]);
    if (clicked[field] != null) return first(clicked[field]);
    if (clicked.y && clicked.y[field] != null) return first(clicked.y[field]);
  }
  if (clicked.smps != null) return first(clicked.smps);
  if (clicked.y && clicked.y.smps != null) return first(clicked.y.smps);
  if (clicked.vars != null) return first(clicked.vars);
  if (clicked.y && clicked.y.vars != null) return first(clicked.y.vars);
  return null;
}

/**
 * Wrap a function so rapid calls collapse into one, firing `wait` ms after the
 * last call. Used to keep a search param control from refetching on every
 * keystroke. `wait <= 0` disables debouncing (fires synchronously).
 * @param {function} fn - The function to debounce.
 * @param {number} wait - Quiet period in ms before firing.
 * @returns {function} The debounced wrapper.
 * @private
 */
function debounce(fn, wait) {
  if (!(wait > 0)) return fn;
  var timer = null;
  return function () {
    var cx = this;
    var args = arguments;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; fn.apply(cx, args); }, wait);
  };
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
 * Every source a ref is computed from, itself included, in dependency order
 * (a source after the ones it reads). Unknown refs and cycles are skipped.
 * @param {object} sources - The spec's `data` map.
 * @param {string} ref - The source a panel reads.
 * @returns {string[]} Refs, inputs first.
 */
export function sourceLineage(sources, ref) {
  var out = [];
  var visiting = {};
  (function visit(r) {
    if (!Object.prototype.hasOwnProperty.call(sources, r) || visiting[r] || out.indexOf(r) !== -1) return;
    visiting[r] = true;
    sourceInputs(sources[r]).forEach(visit);
    visiting[r] = false;
    out.push(r);
  })(ref);
  return out;
}

/**
 * Add a "Code" button to a panel title that opens the panel's recipe.
 * @param {HTMLElement} header - The panel title bar.
 * @param {HTMLElement} container - Dashboard container (hosts the dialog, carries the theme).
 * @param {string} title - Panel title.
 * @param {object} panel - Panel definition.
 * @param {string[]} lineage - The panel's sources, inputs first (see sourceLineage).
 * @param {object} sources - The spec's `data` map.
 * @returns {void}
 * @private
 */
function addCodeButton(header, container, title, panel, lineage, sources) {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'cxd-code-btn';
  button.textContent = '</> Code';
  button.title = 'How this chart is built: the data-function code and the chart config';
  button.addEventListener('click', function (ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    showCodeDialog(container, title, panel, lineage, sources);
  });
  // The title bar is a drag handle in the builder: a press on the button is not a drag.
  button.addEventListener('pointerdown', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); });
  // Keep the title as the first child (the builder renames it through childNodes[0])
  // in its own span so it can still ellipsize beside the button.
  var text = document.createElement('span');
  text.className = 'cxd-panel-title-text';
  text.textContent = header.textContent;
  header.textContent = '';
  header.appendChild(text);
  header.classList.add('cxd-panel-title-actions');
  header.appendChild(button);
}

/**
 * Open a dialog with a chart's recipe, step by step: each source it reads
 * (data functions with their full code), then the CanvasXpress config that
 * draws it. Closes on the close button, the backdrop, or Escape. With
 * `opts.editable` (the builder) the function code and the chart config are
 * editable, each with an Apply button handing the new text to a callback.
 * @param {HTMLElement} container - Element hosting the dialog (carries the theme).
 * @param {string} title - Panel title.
 * @param {object} panel - Panel definition.
 * @param {string[]} lineage - The panel's sources, inputs first.
 * @param {object} sources - The spec's `data` map.
 * @param {object} [opts] - `{editable, lockedReason, onApplyCode(ref, code), onApplyConfig(config)}`;
 *   the callbacks return an error message, or a falsy value on success. With a
 *   `lockedReason` the editors are read-only and Apply is disabled (the reason
 *   is shown) — the user can read and copy how the chart is built, not change it.
 * @returns {HTMLElement} The dialog backdrop (removed on close).
 */
export function showCodeDialog(container, title, panel, lineage, sources, opts) {
  opts = opts || {};
  var editable = !!opts.editable;
  var locked = editable && !!opts.lockedReason;
  var backdrop = document.createElement('div');
  backdrop.className = 'cxd-code-backdrop';
  var dialog = document.createElement('div');
  dialog.className = 'cxd-code-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'How this chart is built');

  var head = document.createElement('div');
  head.className = 'cxd-code-head';
  var heading = document.createElement('div');
  heading.className = 'cxd-code-heading';
  heading.textContent = (editable && !locked ? 'Edit how this chart is built' : 'How this chart is built') +
    (title ? ' — ' + title : '');
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'cxd-code-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  head.appendChild(heading);
  head.appendChild(close);
  dialog.appendChild(head);

  var body = document.createElement('div');
  body.className = 'cxd-code-body';
  var n = 0;
  function step(label, detail) {
    var section = document.createElement('div');
    section.className = 'cxd-code-step';
    var h = document.createElement('div');
    h.className = 'cxd-code-step-title';
    h.textContent = (++n) + '. ' + label;
    section.appendChild(h);
    if (detail) {
      var d = document.createElement('div');
      d.className = 'cxd-code-step-detail';
      d.textContent = detail;
      section.appendChild(d);
    }
    body.appendChild(section);
    return section;
  }
  // A read-only code block with Copy, or (with `apply`) an editable one with Apply.
  function codeBlock(section, text, apply) {
    var wrap = document.createElement('div');
    wrap.className = 'cxd-code-block';
    if (apply) {
      var area = document.createElement('textarea');
      area.className = 'cxd-code-edit';
      area.spellcheck = false;
      area.value = text;
      area.readOnly = locked;
      area.rows = Math.min(18, Math.max(4, text.split('\n').length + 1));
      area.addEventListener('keydown', function (ev) {
        if (ev.key === 'Tab') {                       // indent instead of leaving the box
          ev.preventDefault();
          var at = area.selectionStart;
          area.value = area.value.slice(0, at) + '  ' + area.value.slice(area.selectionEnd);
          area.selectionStart = area.selectionEnd = at + 2;
        }
      });
      var bar = document.createElement('div');
      bar.className = 'cxd-code-actions';
      var status = document.createElement('span');
      status.className = 'cxd-code-status';
      var applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'cxd-code-apply';
      applyBtn.textContent = 'Apply';
      if (locked) {
        applyBtn.disabled = true;
        applyBtn.title = opts.lockedReason;
        status.textContent = opts.lockedReason;
      }
      applyBtn.addEventListener('click', function () {
        if (locked) return;
        var error = apply(area.value);
        status.textContent = error ? String(error) : 'Applied — the chart is re-rendering';
        status.className = 'cxd-code-status' + (error ? ' cxd-code-error' : '');
      });
      bar.appendChild(status);
      bar.appendChild(applyBtn);
      wrap.appendChild(area);
      wrap.appendChild(bar);
      section.appendChild(wrap);
      return;
    }
    var pre = document.createElement('pre');
    pre.textContent = text;
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cxd-code-copy';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    });
    wrap.appendChild(copy);
    wrap.appendChild(pre);
    section.appendChild(wrap);
  }

  lineage.forEach(function (ref) {
    var src = sources[ref] || {};
    if (src.kind === 'function') {
      var language = src.language === 'r' ? 'R' : src.language === 'python' ? 'Python' : String(src.language);
      var inputs = sourceInputs(src);
      var section = step('“' + ref + '” — computed by a ' + language + ' data function',
        (inputs.length ? 'Receives ' + inputs.join(', ') + ' as ' +
          (src.language === 'python' ? 'pandas DataFrames' : 'data frames') + '. ' : '') +
        'Runs on the server; the table it assigns to result is the chart data.');
      codeBlock(section, String(src.code || ''), editable && opts.onApplyCode ? (function (fnRef) {
        return function (code) { return opts.onApplyCode(fnRef, code); };
      })(ref) : null);
    } else if (src.kind === 'join') {
      var on = src.on || {};
      step('“' + ref + '” — ' + (src.how || 'inner') + ' join of ' + src.left + ' and ' + src.right,
        on.left || on.right ? 'Matched on ' + src.left + '.' + on.left + ' = ' + src.right + '.' + on.right + '.' : '');
    } else {
      step('“' + ref + '” — ' + (src.kind || 'inline') + ' data');
    }
  });
  var chart = step('The chart — CanvasXpress config',
    'Drawn with new CanvasXpress(canvasId, data, config), where data is “' + panel.dataRef + '”.');
  codeBlock(chart, JSON.stringify(panel.config || {}, null, 2), editable && opts.onApplyConfig ? function (text) {
    var config;
    try { config = JSON.parse(text); } catch (e) { return 'Invalid JSON: ' + e.message; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return 'The config must be a JSON object';
    return opts.onApplyConfig(config);
  } : null);
  dialog.appendChild(body);
  backdrop.appendChild(dialog);

  var canListen = typeof document.addEventListener === 'function';
  function dismiss() {
    if (canListen) document.removeEventListener('keydown', onKey, true);
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  }
  // Capture Escape so it closes the dialog without also resetting the dashboard.
  // In an editor box Escape only stops there (no accidental loss of edits).
  function onKey(ev) {
    if (ev.key === 'Escape' || ev.keyCode === 27) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!(ev.target && ev.target.tagName === 'TEXTAREA')) dismiss();
    }
  }
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', function (ev) { if (ev.target === backdrop) dismiss(); });
  if (canListen) document.addEventListener('keydown', onKey, true);
  container.appendChild(backdrop);
  if (typeof close.focus === 'function') close.focus();
  return backdrop;
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

  var header = null;
  if (title) {
    header = document.createElement('div');
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
    header: header,
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
 * Look up a CanvasXpress library theme's background color from the loaded library
 * (`CanvasXpress.themeDef`). Prefers the outer canvas fill (`plot.background.fill`),
 * then the inner panel fill (`panel.background.fill`), then the base rectangle fill
 * (`rect.fill`) that both inherit from in the ggplot theme model. Returns a CSS
 * color string, or '' when the theme, the library, or an explicit fill can't be
 * resolved (transparent).
 * @param {string} theme - A CanvasXpress theme name (e.g. 'cxdark', 'stata').
 * @returns {string} The theme background color, or '' if none/transparent.
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
  // Prefer the outer canvas fill (`plot.background.fill`) — that is the colour the
  // chart paints around its panels and what the dashboard should blend with. Some
  // themes (e.g. `stata`) have a white inner panel but a tinted outer canvas
  // (#eaf2f3), so reading the panel fill first would wrongly report white. Fall
  // back to the panel fill, then to the base `rect.fill` — themes like `wsj` define
  // neither plot nor panel fill and inherit their background (#f8f2e4) from `rect`.
  var fill = def['plot.background.fill'];
  if (!fill || fill === 'element_blank') fill = def['panel.background.fill'];
  if (!fill || fill === 'element_blank') fill = def['rect.fill'];
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
  var explicitHeight = sizeValue(spec.height);
  container.style.height = explicitHeight;
  // Cap the dashboard width on wide screens and center it. Unset defaults to
  // 1400px; 0/false/'none' removes the cap so the dashboard fills its parent.
  // A background image is painted on this container, so the cap (and centering)
  // keeps the backdrop within the max width too — unless it is 'auto'/none, where
  // the backdrop fills the parent's full width.
  var maxWidth = maxWidthValue(spec.maxWidth);
  container.style.maxWidth = maxWidth;
  container.style.marginLeft = maxWidth ? 'auto' : '';
  container.style.marginRight = maxWidth ? 'auto' : '';
  // A background image should fill the available vertical space (object-fit
  // 'cover' already keeps its aspect ratio) instead of collapsing to the panels'
  // height, which leaves only a short band of the picture. With no explicit
  // height, stretch the container from its top to the viewport bottom.
  if (spec.backgroundImage && !explicitHeight) {
    var offsetTop = typeof container.offsetTop === 'number' ? container.offsetTop : 0;
    container.style.minHeight = 'calc(100vh - ' + Math.max(0, offsetTop) + 'px)';
  } else {
    container.style.minHeight = '';
  }
  container.style.overflow = (sizeValue(spec.width) || explicitHeight) ? 'auto' : '';
}

/**
 * Resolve the dashboard max-width setting to a CSS length. Unset (null/undefined)
 * defaults to '1400px'; 0, false, '', or 'none' disable the cap (return '').
 * @param {(number|string|boolean)} value - The spec.maxWidth setting.
 * @returns {string} A CSS max-width length, or '' for no cap.
 * @private
 */
function maxWidthValue(value) {
  if (value == null) return '1400px';
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
