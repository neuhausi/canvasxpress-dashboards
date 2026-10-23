/**
 * Proactive insights: a strip above the dashboard that shows what the server's fixed, deterministic
 * checks found in the data (outliers, group differences, declared threshold failures). Every caption
 * carries its figures (expand "Figures") and names the records involved; clicking a record loads it
 * into the dashboard's case card when it has one.
 *
 * The statistics are computed server-side (`cxd_server/insights.py`) with the viewer's row/column
 * security, from fixed templates — nothing here, or there, is free-form narration. A dashboard opts
 * in with a top-level `insights` block; without one this mounts nothing.
 *
 * @module insights
 */

import { sourceUsesParam } from './spec.js';

/**
 * Create an element with an optional class and text (named `insEl` so it does not collide with the
 * other modules' helpers in the concatenated bundle).
 * @param {Document} doc - Owning document.
 * @param {string} tag - Tag name.
 * @param {string} [cls] - Class name.
 * @param {string} [text] - Text content.
 * @returns {HTMLElement} The new element.
 * @private
 */
function insEl(doc, tag, cls, text) {
  var node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A figure value as it reads: numbers to 5 significant digits, the rest as text.
 * @param {*} value - A figure value.
 * @returns {string} The text.
 * @private
 */
function insValue(value) {
  return typeof value === 'number' && isFinite(value) ? String(+value.toPrecision(5)) : String(value);
}

/**
 * The figures behind an insight as readable lines: its scalar figures, and each list of records or
 * groups as `key=value` entries (capped), so the caption's numbers can be checked.
 * @param {object} figures - An insight's `figures`.
 * @returns {string[]} Lines of text.
 * @private
 */
function insFigureLines(figures) {
  var lines = [];
  Object.keys(figures || {}).forEach(function (key) {
    var value = figures[key];
    if (value == null) return;
    if (Array.isArray(value)) {
      if (!value.length) return;
      lines.push(key + ':');
      value.slice(0, 12).forEach(function (item) {
        lines.push('  ' + (item && typeof item === 'object'
          ? Object.keys(item).map(function (k) { return k + '=' + insValue(item[k]); }).join(' ')
          : insValue(item)));
      });
    } else if (typeof value !== 'object') {
      lines.push(key + ': ' + insValue(value));
    }
  });
  return lines;
}

/**
 * Where a click on a record should go: the dashboard's `case` param and the panel (the case card)
 * whose source reads it. Null when the spec has no such drill.
 * @param {object} spec - The dashboard spec.
 * @returns {({param: string, panel: (string|null)}|null)} The drill target, or null.
 * @public
 */
export function insightsDrill(spec) {
  var param = 'case';
  if (!spec || !spec.params || !Object.prototype.hasOwnProperty.call(spec.params, param)) return null;
  var panel = null;
  Object.keys(spec.panels || {}).forEach(function (id) {
    var ref = spec.panels[id] && spec.panels[id].dataRef;
    if (!panel && ref && spec.data && spec.data[ref] && sourceUsesParam(spec.data[ref], param)) panel = id;
  });
  return { param: param, panel: panel };
}

/**
 * Where the insights come from: the share link's endpoint, or the signed-in dashboard's.
 * @param {object} opts - `{baseUrl?, token?, dashboardId?, owner?}`.
 * @returns {string} The URL.
 * @private
 */
function insightsUrl(opts) {
  var base = (opts.baseUrl || '').replace(/\/$/, '');
  if (opts.token) return base + '/api/shared/' + encodeURIComponent(opts.token) + '/insights';
  return base + '/api/dashboards/' + encodeURIComponent(opts.dashboardId) + '/insights' +
    (opts.owner ? '?owner=' + encodeURIComponent(opts.owner) : '');
}

/**
 * Fetch a dashboard's insights and show them in a strip. Resolves to the strip's element, or null
 * when there is nothing to show (not opted in, nothing found, or the request failed — insights are
 * optional chrome and never get in the way of the dashboard).
 * @param {object} opts - Options.
 * @param {string} [opts.baseUrl] - The app root the API lives under.
 * @param {string} [opts.token] - A share token (public/shared view).
 * @param {string} [opts.dashboardId] - The dashboard id (signed-in view).
 * @param {string} [opts.owner] - The owner, for a dashboard shared with the viewer.
 * @param {object} [opts.spec] - The dashboard spec, to find the case card.
 * @param {object} [opts.handle] - The `renderDashboard` handle (`setParam`, `focusPanel`).
 * @param {HTMLElement} [opts.before] - The element to insert the strip before (default: the end of
 *   `document.body`).
 * @param {function} [opts.fetch] - A fetch implementation (tests).
 * @param {Document} [opts.document] - The owning document.
 * @returns {Promise<(HTMLElement|null)>} The strip, or null.
 * @public
 */
export function mountInsights(opts) {
  var doc = opts.document || (typeof document !== 'undefined' ? document : null);
  var doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doc || !doFetch) return Promise.resolve(null);
  return doFetch(insightsUrl(opts), { credentials: 'include' }).then(function (response) {
    return response && response.ok ? response.json() : null;
  }).then(function (body) {
    if (!body || !body.enabled || !body.insights || !body.insights.length) return null;
    var drill = opts.handle ? insightsDrill(opts.spec) : null;
    var strip = insEl(doc, 'section', 'cxd-insights');
    strip.setAttribute('aria-label', 'Insights');
    var head = insEl(doc, 'div', 'cxd-insights-head');
    head.appendChild(insEl(doc, 'span', 'cxd-insights-title', 'Insights'));
    head.appendChild(insEl(doc, 'span', 'cxd-insights-note',
      'computed from the data by fixed checks' + (body.checked && body.checked.tests
        ? ' (' + body.checked.tests + ' group comparisons, corrected for multiple testing)' : '')));
    strip.appendChild(head);
    var list = insEl(doc, 'ul', 'cxd-insights-list');
    body.insights.forEach(function (insight) {
      var item = insEl(doc, 'li', 'cxd-insight cxd-insight--' + (insight.severity || 'info'));
      item.setAttribute('data-insight', insight.id);
      item.appendChild(insEl(doc, 'span', 'cxd-insight-dot'));
      var text = insEl(doc, 'div', 'cxd-insight-body');
      text.appendChild(insEl(doc, 'span', 'cxd-insight-caption', insight.caption));
      if (drill && insight.ids && insight.ids.length) {
        var ids = insEl(doc, 'span', 'cxd-insight-ids');
        insight.ids.slice(0, 5).forEach(function (id) {
          var button = insEl(doc, 'button', 'cxd-insight-id', id);
          button.type = 'button';
          button.title = 'Load ' + id + ' into the case card';
          button.addEventListener('click', function () {
            var done = opts.handle.setParam(drill.param, id);
            if (drill.panel && typeof opts.handle.focusPanel === 'function') opts.handle.focusPanel(drill.panel);
            return done;
          });
          ids.appendChild(button);
        });
        text.appendChild(ids);
      }
      var lines = insFigureLines(insight.figures);
      if (lines.length) {
        var details = insEl(doc, 'details');
        details.appendChild(insEl(doc, 'summary', null, 'Figures'));
        details.appendChild(insEl(doc, 'pre', 'cxd-insight-figures', lines.join('\n')));
        text.appendChild(details);
      }
      item.appendChild(text);
      list.appendChild(item);
    });
    strip.appendChild(list);
    if (body.more > 0) strip.appendChild(insEl(doc, 'div', 'cxd-insights-note', '+' + body.more + ' more not shown'));
    var parent = (opts.before && opts.before.parentNode) || doc.body;
    parent.insertBefore(strip, opts.before || null);
    return strip;
  }).catch(function () { return null; });
}
