/**
 * Render a dashboard from a language wrapper's payload: the one boot routine the R widget, the Python
 * package and any other thin wrapper share, so none of them re-implements it.
 *
 * A payload is plain JSON strings plus a few flags, because that is what a wrapper can produce without
 * a JavaScript engine:
 *
 *   { suggest: false, specJson: "<a dashboard spec>" }            render the spec as written
 *   { suggest: true,  dataJson: "<a CanvasXpress data object>" }  suggest a dashboard for the data
 *   title, theme                                                   optional overrides
 *
 * Failures never leave a blank page: an invalid spec, data no template fits, or an engine that did not
 * load are each reported inside the container, in words.
 *
 * @module renderPayload
 */

/**
 * Show a message in the container in place of a dashboard.
 * @param {HTMLElement} el - The container.
 * @param {string} text - What to say.
 * @returns {void}
 * @private
 */
function rpMessage(el, text) {
  var doc = el.ownerDocument;
  el.innerHTML = '';
  var note = doc.createElement('div');
  note.className = 'cxdashboard-message';
  note.style.cssText = 'padding:16px;color:var(--cx-ui-text-muted,inherit);font:14px var(--cx-font-sans,system-ui,sans-serif);white-space:pre-wrap';
  note.textContent = text;
  el.appendChild(note);
}

/**
 * Wait (bounded) until something is ready. A wrapper's engine may still be arriving when it first
 * renders — a Shiny app injects its dependencies dynamically, a notebook may load a CDN script late.
 * @param {function} ready - `function(): boolean`.
 * @param {number} limitMs - How long to wait.
 * @param {function} done - Called with true when ready, false when the wait ran out.
 * @returns {void}
 * @private
 */
function rpWhen(ready, limitMs, done) {
  var waited = 0;
  (function poll() {
    if (ready()) { done(true); return; }
    if (waited >= limitMs) { done(false); return; }
    waited += 50;
    setTimeout(poll, 50);
  })();
}

/**
 * Build the spec a payload describes.
 * @param {object} api - The dashboards API (`suggestDashboard`, `dashboardSpec`).
 * @param {object} payload - The payload.
 * @param {string} idPrefix - A prefix for a suggested dashboard's id.
 * @param {function} [onTemplate] - Called with the matched template name.
 * @returns {({spec: object}|{message: string})} The spec, or what to tell the user.
 * @private
 */
function rpSpec(api, payload, idPrefix, onTemplate) {
  var spec;
  try {
    if (payload.suggest) {
      var data = JSON.parse(payload.dataJson);
      var suggestion = api.suggestDashboard(data);
      if (!suggestion) {
        return { message: 'No dashboard template matched these data (a survival cohort, or a sequencing run-QC ' +
          'table, with records as rows). Pass a spec instead.' };
      }
      spec = api.dashboardSpec(suggestion, {
        id: idPrefix, title: payload.title || suggestion.label, source: { kind: 'inline', value: data }
      });
      if (typeof onTemplate === 'function') onTemplate(suggestion.template);
    } else {
      spec = JSON.parse(payload.specJson);
      if (payload.title) spec.title = payload.title;
    }
    if (payload.theme) spec.theme = payload.theme;
  } catch (e) {
    return { message: 'Could not read the dashboard: ' + (e && e.message || e) };
  }
  return { spec: spec };
}

/**
 * Render a payload into a container.
 * @param {HTMLElement} el - The container (it gets a fresh dashboard, or a message).
 * @param {object} payload - `{suggest, specJson?, dataJson?, title?, theme?}`.
 * @param {object} [opts] - Options.
 * @param {object} [opts.api] - The dashboards API (default: `window.CanvasXpressDashboards`).
 * @param {function} [opts.isEngineReady] - `function(): boolean` (default: `window.CanvasXpress` exists).
 * @param {number} [opts.timeoutMs=20000] - How long to wait for the bundle and engine.
 * @param {string} [opts.idPrefix] - Prefix for a suggested dashboard's id.
 * @param {function} [opts.onTemplate] - Called with `"cohort"` / `"ngs-qc"` when a template matched.
 * @param {function} [opts.onParamChange] - `function(name, value, done, handle)`, called when a dashboard
 *   parameter changes; `done` resolves once the panels hold the new data.
 * @param {function} [opts.isCurrent] - `function(): boolean`; false once a newer render superseded this one
 *   (the result is then discarded).
 * @param {object} [opts.renderOptions] - Extra options for `renderDashboard`.
 * @returns {Promise<(object|null)>} The dashboard handle, or null when a message was shown instead.
 * @public
 */
export function renderPayload(el, payload, opts) {
  opts = opts || {};
  var win = typeof window !== 'undefined' ? window : {};
  var current = typeof opts.isCurrent === 'function' ? opts.isCurrent : function () { return true; };
  var handle = null;
  el.innerHTML = '';
  return new Promise(function (resolve) {
    rpWhen(function () {
      var api = opts.api || win.CanvasXpressDashboards;
      var engine = typeof opts.isEngineReady === 'function' ? opts.isEngineReady() : !!win.CanvasXpress;
      return !!(api && engine);
    }, opts.timeoutMs == null ? 20000 : opts.timeoutMs, function (ready) {
      if (!current()) { resolve(null); return; }
      var api = opts.api || win.CanvasXpressDashboards;
      if (!ready) {
        rpMessage(el, api
          ? 'The CanvasXpress engine did not load (check the network).'
          : 'canvasxpress-dashboards did not load.');
        resolve(null);
        return;
      }
      var built = rpSpec(api, payload, opts.idPrefix || ('cxdashboard-' + (el.id || 'x')), opts.onTemplate);
      if (built.message) { rpMessage(el, built.message); resolve(null); return; }
      // renderDashboard THROWS (synchronously) for an invalid spec and rejects for a data failure:
      // either way say what is wrong instead of leaving a blank page.
      var rendering;
      try {
        var renderOptions = {};
        var extra = opts.renderOptions || {};
        for (var key in extra) { if (Object.prototype.hasOwnProperty.call(extra, key)) renderOptions[key] = extra[key]; }
        if (typeof opts.onParamChange === 'function') {
          renderOptions.onParamChange = function (name, value, done) {
            opts.onParamChange(name, value, done, handle);
          };
        }
        rendering = api.renderDashboard(built.spec, el, renderOptions);
      } catch (e) {
        rpMessage(el, 'Could not render the dashboard: ' + (e && e.message || e));
        resolve(null);
        return;
      }
      rendering.then(function (h) {
        if (!current()) { if (h && typeof h.destroy === 'function') h.destroy(); resolve(null); return; }
        handle = h;
        // A spec with a storyboard gets its player above the board (nothing mounts otherwise).
        if (typeof api.mountStoryboard === 'function') {
          try { api.mountStoryboard({ spec: built.spec, handle: h, container: el }); } catch (e) { /* optional chrome */ }
        }
        resolve(h);
      }, function (e) {
        rpMessage(el, 'Could not render the dashboard: ' + (e && e.message || e));
        resolve(null);
      });
    });
  });
}
