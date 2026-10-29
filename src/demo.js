/**
 * Automated demo driver for a *whole dashboard* — the dashboard-level analogue of the engine's
 * per-chart demo driver (CanvasXpress 72.8: `cx.playDemo`, `canvasXpress.demoInput/Targets/Verbs`).
 *
 * A declarative storyboard of semantic steps is performed on the REAL dashboard UI by a synthetic
 * human: a single ghost cursor glides across the page and dispatches the genuine pointer / mouse /
 * click / drag / wheel / key events a device would produce, at the dashboard's own chrome (filters,
 * panels, builder, insights, storyboard bar). Chart-internal steps are delegated to that panel's
 * engine driver (`panelCx.playDemo(...)`), so the committed engine driver is reused verbatim — this
 * module adds only the dashboard-chrome vocabulary and the cross-panel orchestration.
 *
 * Two outputs from ONE authored storyboard:
 *   - `playDemo(handle, steps, opts)` drives the UI like a person, for screen-recorded videos;
 *   - `demoToStoryboard(steps)` compiles the pure-state subset into `storyboard.js` steps, so the
 *     same script also plays as the in-product, state-based guided tour (handle.applyView).
 *
 * The driver NEVER calls a dashboard action directly on the video path — it operates the actual
 * controls, exactly like the engine driver's "mimic 100% the reality" principle. State mutation is
 * only used on the storyboard/tour path, where fidelity is the dashboard's own state, not a cursor.
 *
 * Reuse seam: the "synthetic human" (ghost cursor + event dispatch) lives on every CanvasXpress
 * instance and is element-generic (operates on any element / absolute page coords). We borrow one
 * live panel as the page-wide input host; where no panel exists yet (empty builder) we spin up a
 * hidden throwaway instance purely to borrow those methods.
 *
 * @module demo
 */

// NOTE: top-level names are inlined into one bundle scope (see scripts/build.mjs collision guard),
// so every helper here is prefixed `dmo` to stay unique across modules.

/** Engine input methods we borrow from a host CanvasXpress instance (all element/coord-generic). */
var DMO_HOST_METHODS = [
  'demoGlide', 'demoClick', 'demoGlideDrag', 'demoWheel', 'demoKeyEvent',
  'demoPlaceCursor', 'demoHideCursor', 'demoDelay', 'demoDuration', 'demoElementPoint'
];

/**
 * Find a CanvasXpress instance that carries the engine demo driver, to act as the page-wide input
 * host. Prefers a live graph panel; falls back to a hidden throwaway instance.
 *
 * @param {object} handle - The renderDashboard handle.
 * @param {object} [opts] - `{CanvasXpress?}` constructor override (defaults to window global).
 * @returns {object|null} A CanvasXpress instance with the demo methods, or null if unavailable.
 */
function dmoAcquireHost(handle, opts) {
  // The driver methods (playDemo, demoGlide, …) are installed by initDemoEvents(), which the engine
  // runs during a chart's async render. A rendered panel already has them; a just-constructed host
  // does not, so install them explicitly when the instance exposes initDemoEvents but not yet playDemo.
  var ensure = function (cx) {
    if (cx && typeof cx.playDemo !== 'function' && typeof cx.initDemoEvents === 'function') {
      try { cx.initDemoEvents(); } catch (e) { /* leave uninstalled; hasDriver() will reject it */ }
    }
    return cx;
  };
  var hasDriver = function (cx) {
    if (!cx || typeof cx.playDemo !== 'function') return false;
    for (var i = 0; i < DMO_HOST_METHODS.length; i++) {
      if (typeof cx[DMO_HOST_METHODS[i]] !== 'function') return false;
    }
    return true;
  };
  var list = (handle && handle.instances) || [];
  for (var i = 0; i < list.length; i++) {
    if (hasDriver(ensure(list[i]))) return list[i];
  }
  // Fallback: a hidden instance just for its input methods (engine >= 72.8 required).
  var CX = (opts && opts.CanvasXpress) || (typeof window !== 'undefined' && window.CanvasXpress);
  var doc = (handle && handle.container && handle.container.ownerDocument) ||
    (typeof document !== 'undefined' && document);
  if (!CX || !doc) return null;
  var host = doc.createElement('canvas');
  host.id = 'cxd-demo-host-' + Math.floor(Math.random() * 1e9);
  host.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;';
  doc.body.appendChild(host);
  var cx = new CX(host.id, { y: { vars: ['v'], smps: ['s'], data: [[0]] } }, { graphType: 'Scatter2D' });
  return hasDriver(ensure(cx)) ? cx : null;
}

// ── Target locators (dashboard chrome) ────────────────────────────────────────────────────────
// Each returns the element a step should act on, resolved lazily at run time (the chrome re-renders
// on filter / builder changes, so locators must never be cached across steps). `root` is the
// dashboard container. VERIFIED selectors are read from the current src; TODO-VERIFY ones are a
// best read of the live DOM and must be confirmed against a rendered dashboard before first use.

var dmoTargets = {
  /** The Filters panel root (VERIFIED: filters cell `.cxd-filters-cell`, inner root `.cxd-filters`). */
  filtersPanel: function (root) {
    return root.querySelector('.cxd-filters');
  },
  /** The scheme `<select>` in the Filters panel (VERIFIED: `.cxd-filters-scheme`). */
  schemeSelect: function (root) {
    return root.querySelector('.cxd-filters-scheme');
  },
  /** A filter field section by its visible label (VERIFIED: `.cxd-filters-field` / `.cxd-filters-label`). */
  filterField: function (root, fieldName) {
    var fields = root.querySelectorAll('.cxd-filters-field');
    for (var i = 0; i < fields.length; i++) {
      var label = fields[i].querySelector('.cxd-filters-label');
      if (label && dmoTextEq(label.textContent, fieldName)) return fields[i];
    }
    return null;
  },
  /** One value checkbox row within a field, by its label (VERIFIED: `.cxd-filters-check/.cb/.name`). */
  filterValue: function (fieldSection, valueName) {
    if (!fieldSection) return null;
    var rows = fieldSection.querySelectorAll('.cxd-filters-check');
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i].querySelector('.cxd-filters-name');
      if (name && dmoTextEq(name.textContent, valueName)) {
        return rows[i].querySelector('.cxd-filters-cb') || rows[i];
      }
    }
    return null;
  },
  /** The Filters reset chip (VERIFIED: `.cxd-filters-reset`). */
  filtersReset: function (root) {
    return root.querySelector('.cxd-filters-reset');
  },
  /** A builder tool tab (VERIFIED tokens: `cxb-tool-data`, `cxb-tool-code`). `which` ∈ data|code. */
  builderTool: function (root, which) {
    return root.querySelector('.cxb-tool-' + which);
  },
  /** A builder grid cell by index (VERIFIED: `cxb-cell`; selected state `cxb-selected`). */
  builderCell: function (root, idx) {
    var cells = root.querySelectorAll('.cxb-cell');
    return cells[idx || 0] || null;
  },
  /** A storyboard dot by index (VERIFIED: `.cxd-sb-dot`). */
  storyboardDot: function (root, idx) {
    var dots = root.querySelectorAll('.cxd-sb-dot');
    return dots[idx || 0] || null;
  },
  /** Storyboard transport button (VERIFIED: `.cxd-storyboard` holds `.cxd-sb-btn`, play = `.cxd-sb-play`). */
  storyboardButton: function (root, which) {
    var bar = root.querySelector('.cxd-storyboard');
    if (!bar) return null;
    if (which === 'play') return bar.querySelector('.cxd-sb-play');
    var btns = bar.querySelectorAll('.cxd-sb-btn');          // order: prev, play, next
    if (which === 'prev') return btns[0] || null;
    if (which === 'next') return btns[btns.length - 1] || null;
    return null;
  },
  /** An insight row by its id, else by index (VERIFIED: `li.cxd-insight[data-insight]` in `.cxd-insights-list`). */
  insight: function (root, idOrIdx) {
    if (typeof idOrIdx === 'string') return root.querySelector('.cxd-insight[data-insight="' + idOrIdx + '"]');
    var rows = root.querySelectorAll('.cxd-insights-list .cxd-insight');
    return rows[idOrIdx || 0] || null;
  },
  /** A drill id-button inside an insight row (VERIFIED: `.cxd-insight-id`). */
  insightDrill: function (insightRow, idx) {
    if (!insightRow) return null;
    var ids = insightRow.querySelectorAll('.cxd-insight-id');
    return ids[idx || 0] || null;
  },
  /** A builder toolbar add button by its label (VERIFIED: `button(label)` sets textContent; classes `cxb-bt-add`/`cxb-bt-interact`). */
  builderAddButton: function (root, label) {
    var btns = root.querySelectorAll('.cxb-bt-add, .cxb-bt-interact, .cxb-btn');
    for (var i = 0; i < btns.length; i++) {
      if (dmoTextEq(btns[i].textContent, label)) return btns[i];
    }
    return null;
  },
  /** A builder "flow" stepper link by its title text, else by index (VERIFIED: `.cxb-flow-link`, current = `.cxb-flow-current`). */
  flowLink: function (root, titleOrIdx) {
    var links = root.querySelectorAll('.cxb-flow-link');
    if (typeof titleOrIdx === 'number') return links[titleOrIdx] || null;
    for (var i = 0; i < links.length; i++) {
      // Link text is "📊 <title>" / "🎛 <title>"; match on a trailing contains.
      if (String(links[i].textContent).toLowerCase().indexOf(String(titleOrIdx).toLowerCase()) !== -1) return links[i];
    }
    return null;
  }
  // The builder's dataset drag-drop source is provided by the HOST app's data list (renderDashboard:3636),
  // not by this package, so the `builder:drop` verb below takes an explicit source selector rather than
  // guessing one. The `.cxd-range-thumb` filter-range drag is likewise left to the author (value→x mapping
  // is spec-dependent); use a `param` or a `filter` values step for deterministic range changes.
};

/** Case/space-insensitive text match for label lookups. */
function dmoTextEq(a, b) {
  return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
}

// ── Verb registry ─────────────────────────────────────────────────────────────────────────────
// A verb expands its argument into one or more ops. Each op is { run(ctx): Promise, state?: view }.
//  - `run` performs the real UI interaction via the host's input methods (the video path);
//  - `state` (optional) is the equivalent dashboard view for demoToStoryboard / the tour path.
// ctx = { handle, host, root, speed }.

var dmoVerbs = {};

/**
 * Register a demo verb.
 * @param {string} name - Verb name (storyboard step key).
 * @param {Function} expander - function(arg, ctx) -> op | op[].
 * @returns {void}
 */
export function demoDefineVerb(name, expander) {
  dmoVerbs[name] = expander;
}

/**
 * Build the File a `dropFile` verb will drop — from inline `content`, a fetched `url`, or empty.
 * @param {object} arg - `{name, content?, url?, type?}`.
 * @returns {Promise<File>} The constructed file.
 */
function dmoMakeFile(arg) {
  var name = arg.name || 'data.csv';
  var type = arg.type || (/\.json$|\.cx$/i.test(name) ? 'application/json' : 'text/csv');
  var mk = function (text) { return new File([text != null ? text : ''], name, { type: type }); };
  if (arg.content != null) return Promise.resolve(mk(arg.content));
  if (arg.url && typeof fetch === 'function') {
    return fetch(arg.url).then(function (r) { return r.text(); }).then(mk, function () { return mk(''); });
  }
  return Promise.resolve(mk(''));
}

/**
 * Resolve a `dropFile` target to a real drop zone. Valid zones are the Data page import pane and
 * any visualization (`.cxb-cell`); the builder stage is NOT a file zone (dataset/connector only).
 * @param {Element} root - The dashboard/builder container.
 * @param {number|string|object} [onto] - Target selector (see the dropFile verb docs).
 * @returns {Element|null} The drop zone, or null when none is present.
 */
function dmoDropTarget(root, onto) {
  var doc = root.ownerDocument || document;
  var dataZone = function () { return doc.querySelector('#data-dropzone') || doc.querySelector('.data-dropzone'); };
  var firstViz = function () { return dmoTargets.builderCell(root, 0) || root.querySelector('.cxb-cell'); };
  if (onto == null) return dataZone() || firstViz();
  if (onto === 'data') return dataZone();
  if (typeof onto === 'number') return dmoTargets.builderCell(root, onto);
  if (typeof onto === 'string') return /^[.#\[]/.test(onto) ? doc.querySelector(onto) : (doc.querySelector(onto) || null);
  if (onto && onto.selector) return doc.querySelector(onto.selector);
  return null;
}

/** Dispatch one HTML5 drag event carrying a DataTransfer at an element. */
function dmoFireDrag(el, typeName, dataTransfer, x, y) {
  var ev;
  var init = { bubbles: true, cancelable: true, composed: true, clientX: x || 0, clientY: y || 0 };
  try {
    init.dataTransfer = dataTransfer;
    ev = new DragEvent(typeName, init);
  } catch (e) {
    // Some engines reject dataTransfer in the DragEvent ctor — fall back and attach it after.
    ev = new Event(typeName, { bubbles: true, cancelable: true });
    try { Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer }); } catch (e2) { /* best effort */ }
    ev.clientX = x || 0; ev.clientY = y || 0;
  }
  el.dispatchEvent(ev);
}

/**
 * Animate a file-ghost tile from a page edge to the drop target while the cursor travels there,
 * then dispatch the genuine dragenter → dragover → drop sequence carrying the File.
 * @param {object} ctx - Run context `{host, root, ...}`.
 * @param {File} file - The file to drop.
 * @param {Element} target - The drop zone element.
 * @returns {Promise<void>} Resolves once the drop has been dispatched and the ghost removed.
 */
function dmoAnimateFileDrop(ctx, file, target) {
  var host = ctx.host;
  var doc = target.ownerDocument;
  var dt = new DataTransfer();
  try { dt.items.add(file); } catch (e) { /* older engines: dt.files is read-only, drop still fires */ }
  try { dt.effectAllowed = 'copy'; dt.dropEffect = 'copy'; } catch (e) { /* read-only in some engines */ }

  var box = target.getBoundingClientRect();
  var cx = box.left + box.width / 2;
  var cy = box.top + box.height / 2;

  // File-ghost tile: a labelled document chip that starts off the top edge and glides to the zone.
  var ghost = doc.createElement('div');
  ghost.className = 'cxd-demo-file-ghost';
  ghost.textContent = '📄 ' + (file.name || 'data');
  ghost.style.cssText =
    'position:fixed;z-index:2147483646;left:' + Math.round(cx) + 'px;top:-40px;' +
    'transform:translate(-50%,-50%);padding:6px 12px;border-radius:8px;pointer-events:none;' +
    'font:13px system-ui,sans-serif;background:var(--cx-ui-surface,#fff);color:var(--cx-ui-text,#222);' +
    'box-shadow:0 6px 20px rgba(0,0,0,.25);border:1px solid var(--cx-ui-border,#ccc);opacity:.96;' +
    'transition:left ' + host.demoDuration(700) + 'ms ease,top ' + host.demoDuration(700) + 'ms ease;';
  doc.body.appendChild(ghost);

  return new Promise(function (resolve) {
    // Start the cursor glide to the zone centre (a POINT), and the tile glide, together.
    host.demoGlide({ x: cx, y: cy }, {}, function () { /* cursor arrival handled below via delay */ });
    // Kick the tile transition on the next frame so the transition actually animates.
    var raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
    raf(function () { ghost.style.left = Math.round(cx) + 'px'; ghost.style.top = Math.round(cy) + 'px'; });

    host.demoDelay(host.demoDuration(760), function () {
      // Genuine drop sequence. dragover is where the handler sets dropEffect='copy'.
      dmoFireDrag(target, 'dragenter', dt, cx, cy);
      dmoFireDrag(target, 'dragover', dt, cx, cy);
      dmoFireDrag(target, 'drop', dt, cx, cy);
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
      host.demoDelay(host.demoDuration(300), resolve);
    });
  });
}

/**
 * Glide the ghost cursor to a DOM element's hit-tested point and invoke a callback on arrival.
 * (demoGlide takes a POINT {x,y}; demoElementPoint resolves the element to one and scrolls it in.)
 * @param {object} ctx - Run context `{host, ...}`.
 * @param {Element} el - The element to glide to.
 * @param {Function} done - Called once the cursor arrives.
 * @returns {void}
 */
function dmoGlideTo(ctx, el, done) {
  var host = ctx.host;
  var point = host.demoElementPoint(el);
  host.demoGlide(point, {}, done);
}

/** Glide the ghost cursor to an element and click it (video path primitive). */
function dmoClickEl(ctx, el) {
  if (!el) return Promise.resolve();
  var host = ctx.host;
  return new Promise(function (resolve) {
    dmoGlideTo(ctx, el, function () {
      host.demoClick({}, function () { resolve(); });
    });
  });
}

// filter: { field, values: [...], dataRef?, min?, max?, text? }
//   Narrow a field to KEEP only `values`. The Filters panel starts all-checked, so the drive path
//   clicks the checkboxes of the values NOT listed (unchecking them) until only `values` remain —
//   which yields exactly the predicate the bridge/tour path applies. So drive and tour agree.
//   (Low-cardinality fields only; high-cardinality fields would mean many clicks — use the tour.)
demoDefineVerb('filter', function (arg, ctx) {
  var root = ctx.root;
  return [{
    run: function () {
      var section = dmoTargets.filterField(root, arg.field);
      if (!section || !arg.values || !arg.values.length) return Promise.resolve();
      var keep = {};
      for (var k = 0; k < arg.values.length; k++) { keep[String(arg.values[k])] = true; }
      var rows = section.querySelectorAll('.cxd-filters-check');
      var toClick = [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].classList && rows[i].classList.contains('cxd-filters-all')) continue; // not the All toggle
        var nameEl = rows[i].querySelector('.cxd-filters-name');
        var label = nameEl ? String(nameEl.textContent).trim() : '';
        if (label && !keep[label]) toClick.push(rows[i].querySelector('.cxd-filters-cb') || rows[i]);
      }
      var chain = Promise.resolve();
      toClick.forEach(function (el) { chain = chain.then(function () { return dmoClickEl(ctx, el); }); });
      // NOTE: range (min/max) would drive the `.cxd-filters-range` thumbs; that value→x mapping is
      // spec-dependent, so for a deterministic range use the tour (state) path.
      return chain;
    },
    // Tour/state equivalent: the kept-set as a filters.js predicate (see normalizeState).
    state: { filters: [dmoFilterPredicate(arg)] }
  }];
});

/** Build a filters.js predicate from a `filter` verb argument. */
function dmoFilterPredicate(arg) {
  var p = { field: arg.field };
  if (arg.dataRef) p.dataRef = arg.dataRef;
  if (arg.values) p.values = arg.values;
  if (arg.min != null) p.min = arg.min;
  if (arg.max != null) p.max = arg.max;
  if (arg.text != null) p.text = arg.text;
  return p;
}

// scheme: "<name>" — choose a named filter scheme from the select.
demoDefineVerb('scheme', function (arg, ctx) {
  var name = typeof arg === 'string' ? arg : arg.name;
  return [{
    run: function () {
      var sel = dmoTargets.schemeSelect(ctx.root);
      if (!sel) return Promise.resolve();
      // Drive the native <select> (glide, set value, dispatch change) via the host cursor.
      return new Promise(function (resolve) {
        dmoGlideTo(ctx, sel, function () {
          sel.value = name;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          ctx.host.demoDelay(ctx.host.demoDuration(250), resolve);
        });
      });
    },
    state: { scheme: name }
  }];
});

// param: { name, value } — a dashboard parameter. No universal control DOM, so the video path
// uses the handle (acceptable: param controls vary by spec); the tour path is identical.
demoDefineVerb('param', function (arg) {
  return [{
    run: function (ctx) { return Promise.resolve(ctx.handle.setParam(arg.name, arg.value)); },
    state: { params: dmoKv(arg.name, arg.value) }
  }];
});

// panel: "<id>"  or  { id, chart: [ ...engine demo steps... ] }
//   - focuses/scrolls the panel into view, then
//   - delegates chart-internal steps to that panel's OWN engine driver (panelCx.playDemo).
demoDefineVerb('panel', function (arg, ctx) {
  var id = typeof arg === 'string' ? arg : arg.id;
  var chart = (typeof arg === 'object' && arg.chart) || null;
  return [{
    run: function () {
      ctx.handle.focusPanel(id);
      if (!chart) return ctx.host.demoDelay
        ? new Promise(function (r) { ctx.host.demoDelay(ctx.host.demoDuration(400), r); })
        : Promise.resolve();
      var panelCx = ctx.handle.panelInstances()[id];
      if (!panelCx || typeof panelCx.playDemo !== 'function') return Promise.resolve();
      // Reuse the committed engine driver verbatim for everything inside the chart.
      return new Promise(function (resolve) {
        panelCx.playDemo(chart, { speed: ctx.speed, reset: false, onDone: function () { resolve(); } });
      });
    },
    state: { focus: id } // the tour can focus the panel, but not replay chart-internal steps
  }];
});

// caption: "<text>"  or  { text, seconds?, at? } — on-screen narration.
// VERIFIED: the engine exposes cx.showDemoCaption({text, ms, at}) / cx.hideDemoCaption().
demoDefineVerb('caption', function (arg, ctx) {
  var text = typeof arg === 'string' ? arg : arg.text;
  var seconds = (typeof arg === 'object' && arg.seconds) || 2;
  return [{
    run: function () {
      var ms = ctx.host.demoDuration(seconds * 1000);
      if (typeof ctx.host.showDemoCaption === 'function') {
        ctx.host.showDemoCaption({ text: text, ms: ms, at: (typeof arg === 'object' && arg.at) || 'bottom' });
      }
      return new Promise(function (r) { ctx.host.demoDelay(ms, r); });
    },
    state: { narration: text }
  }];
});

// wait: <ms> — a pause.
demoDefineVerb('wait', function (arg, ctx) {
  var ms = typeof arg === 'number' ? arg : (arg && arg.ms) || 500;
  return [{ run: function () {
    return ctx.host.demoDelay
      ? new Promise(function (r) { ctx.host.demoDelay(ctx.host.demoDuration(ms), r); })
      : Promise.resolve();
  } }];
});

// insights: <idx>  or  { id?, index?, drill? } — click an Insights-strip row, optionally a drill id.
//   VERIFIED: li.cxd-insight[data-insight] in .cxd-insights-list; drill buttons .cxd-insight-id.
demoDefineVerb('insights', function (arg, ctx) {
  var key = typeof arg === 'number' ? arg : (arg && (arg.id != null ? arg.id : arg.index)) || 0;
  var drillIdx = (typeof arg === 'object' && arg.drill != null) ? arg.drill : null;
  return [{
    run: function () {
      var row = dmoTargets.insight(ctx.root, key);
      if (!row) return Promise.resolve();
      var target = drillIdx != null ? (dmoTargets.insightDrill(row, drillIdx) || row) : row;
      return dmoClickEl(ctx, target);
    }
    // No state equivalent: an insight drill is an exploratory click, not a stored view.
  }];
});

// builder: { tool?: "data"|"code", cell?: <idx>, add?: "Panel"|"Filters"|"Code", flow?: <title|idx>,
//            drop?: { from: "<css selector of a host dataset pill>" } } — operate the Builder chrome.
//   VERIFIED: .cxb-cell, .cxb-tool-data/.cxb-tool-code, add buttons by label, .cxb-flow-link.
demoDefineVerb('builder', function (arg, ctx) {
  var ops = [];
  if (arg.cell != null) {
    ops.push({ run: function () { return dmoClickEl(ctx, dmoTargets.builderCell(ctx.root, arg.cell)); } });
  }
  if (arg.tool) {
    ops.push({ run: function () { return dmoClickEl(ctx, dmoTargets.builderTool(ctx.root, arg.tool)); } });
  }
  if (arg.add) {
    ops.push({ run: function () { return dmoClickEl(ctx, dmoTargets.builderAddButton(ctx.root, arg.add)); } });
  }
  if (arg.flow != null) {
    ops.push({ run: function () { return dmoClickEl(ctx, dmoTargets.flowLink(ctx.root, arg.flow)); } });
  }
  if (arg.drop && arg.drop.from) {
    ops.push({ run: function () {
      var source = ctx.root.ownerDocument.querySelector(arg.drop.from);
      var stage = ctx.root.querySelector('.cxb-stage') || ctx.root;   // builderRoot is the drop target
      if (!source) return Promise.resolve();
      return new Promise(function (resolve) { ctx.host.demoGlideDrag(source, stage, {}, resolve); });
    } });
  }
  return ops;
});

// dropFile: { name, content?: "<text>", url?, type?, onto? }
//   Drop a FILE where the app accepts one, exactly as dragging a CSV/JSON from the desktop would.
//   Valid drop zones (all read `ev.dataTransfer.files[0]` in capture phase):
//     • the Data page   — `#data-dropzone` / `.data-dropzone` (the app shell's import pane);
//     • any visualization — a `.cxb-cell` panel, which rebinds that panel to the dropped data.
//   NOTE: the builder *stage* accepts only dataset/connector drags, NOT files, so it is not a target.
//   `onto`:  omitted → the Data page if present, else the first visualization;
//            <number> → the Nth visualization (`.cxb-cell`);  "data" → the Data page;
//            a "#id"/".class"/"[attr]" string or {selector} → that element exactly.
//
//   A real OS→browser file drag CANNOT be synthesized (it originates outside the page), but a drop
//   handler only cares that `dataTransfer.files[0]` is a File. So we construct the File in JS (from
//   inline `content`, a fetched `url`, or empty), attach it to a DataTransfer, and dispatch
//   dragenter → dragover → drop on the real zone — a genuine import. For the video a file-ghost tile
//   glides from the page edge to the zone while the cursor travels there; there is deliberately no
//   fake "Finder window" (it would read as fake and is not needed).
demoDefineVerb('dropFile', function (arg) {
  return [{
    run: function (ctx) {
      if (typeof DataTransfer === 'undefined' || typeof File === 'undefined') return Promise.resolve();
      return dmoMakeFile(arg).then(function (file) {
        var target = dmoDropTarget(ctx.root, arg.onto);
        return target ? dmoAnimateFileDrop(ctx, file, target) : Promise.resolve();
      });
    }
    // No state equivalent: a file import is an action, not a stored dashboard view.
  }];
});

// storyboard: "next" | "prev" | "play" | { go: <idx> } — operate the in-page storyboard transport.
//   VERIFIED: .cxd-storyboard { .cxd-sb-btn (prev,next), .cxd-sb-play, .cxd-sb-dot }.
demoDefineVerb('storyboard', function (arg, ctx) {
  return [{
    run: function () {
      if (arg && typeof arg === 'object' && arg.go != null) {
        return dmoClickEl(ctx, dmoTargets.storyboardDot(ctx.root, arg.go));
      }
      return dmoClickEl(ctx, dmoTargets.storyboardButton(ctx.root, arg));
    }
  }];
});

/** Expand a storyboard into a flat op list. A string step is shorthand `"verb:arg"`. */
function dmoCompile(steps, ctx) {
  var ops = [];
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    var verb, arg;
    if (typeof step === 'string') {
      var c = step.indexOf(':');
      verb = c < 0 ? step : step.slice(0, c);
      arg = c < 0 ? null : step.slice(c + 1);
    } else {
      verb = step.verb || Object.keys(step)[0];
      arg = step.verb ? step.arg : step[verb];
    }
    var expander = dmoVerbs[verb];
    if (!expander) { continue; } // unknown verb: skip (parity with engine demoCompile)
    var out = expander(arg, ctx);
    ops = ops.concat(Array.isArray(out) ? out : [out]);
  }
  return ops;
}

var dmoKv = function (k, v) { var o = {}; o[k] = v; return o; };

/**
 * Drive a rendered dashboard through a storyboard on the REAL UI (the video path).
 *
 * @param {object} handle - The `renderDashboard` handle.
 * @param {Array} steps - The storyboard (verb objects or `"verb:arg"` strings).
 * @param {object} [opts] - `{speed?, CanvasXpress?, onDone?}`.
 * @returns {Promise<void>} Resolves when the run completes.
 */
export function playDemo(handle, steps, opts) {
  opts = opts || {};
  var host = dmoAcquireHost(handle, opts);
  if (!host || !steps || !steps.length) return Promise.resolve();
  var ctx = {
    handle: handle,
    host: host,
    root: handle.container,
    speed: opts.speed && opts.speed > 0 ? opts.speed : 1
  };
  // Seed the ghost cursor at a finite start point — the first demoGlide reads the current cursor
  // position, and without a seed it is NaN (→ document.elementFromPoint throws on the first move).
  if (typeof host.demoPlaceCursor === 'function') {
    var r = (ctx.root && ctx.root.getBoundingClientRect) ? ctx.root.getBoundingClientRect() : null;
    var sx = r && isFinite(r.left) ? r.left + 24 : 24;
    var sy = r && isFinite(r.top) ? r.top + 24 : 24;
    host.demoPlaceCursor(sx, sy);
  }
  var ops = dmoCompile(steps, ctx);
  var chain = Promise.resolve();
  ops.forEach(function (op) {
    chain = chain.then(function () { return op.run(ctx); });
  });
  return chain.then(function () {
    if (host.demoHideCursor) host.demoHideCursor();
    if (typeof opts.onDone === 'function') opts.onDone();
  });
}

/**
 * Compile the pure-state subset of a demo storyboard into `storyboard.js` steps, so one authored
 * script also plays as the in-product state-based tour (mountStoryboard → handle.applyView).
 * Steps with no state equivalent (chart-internal `panel.chart`, builder drags) collapse to their
 * nearest view (panel focus, filters) and carry their caption as narration.
 *
 * @param {Array} steps - The demo storyboard.
 * @returns {object[]} Steps shaped `{scheme?, filters?, params?, focus?, title?, narration?, seconds?}`.
 */
export function demoToStoryboard(steps) {
  var ctx = { handle: null, host: null, root: null, speed: 1 };
  var ops = dmoCompile(steps, ctx);
  var out = [];
  var current = null;
  ops.forEach(function (op) {
    if (!op.state) return;
    // A caption begins a new storyboard step; other state folds into the step in progress.
    if (op.state.narration != null) {
      if (current) out.push(current);
      current = { narration: op.state.narration, title: op.state.title };
      return;
    }
    if (!current) current = {};
    if (op.state.scheme != null) current.scheme = op.state.scheme;
    if (op.state.focus != null) current.focus = op.state.focus;
    if (op.state.filters) current.filters = (current.filters || []).concat(op.state.filters);
    if (op.state.params) {
      current.params = current.params || {};
      for (var k in op.state.params) {
        if (Object.prototype.hasOwnProperty.call(op.state.params, k)) current.params[k] = op.state.params[k];
      }
    }
  });
  if (current) out.push(current);
  return out;
}
