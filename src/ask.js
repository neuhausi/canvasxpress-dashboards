/**
 * View-time Q&A: an "Ask" box that answers questions about a dashboard's data.
 * It posts to the server `/api/dashboards/{id}/ask` endpoint, which computes the
 * answer with read-only data tools (never hallucinated) and returns the figures
 * it used. Only useful inside the hosted app (needs a session + the endpoint).
 *
 * @module ask
 */

/**
 * Create an element with an optional class and text. (Named `ael` so it does not
 * collide with other modules' top-level `el`/`cel` in the concatenated bundle.)
 * @param {Document} doc - Owning document.
 * @param {string} tag - Tag name.
 * @param {string} [cls] - Class name.
 * @param {string} [text] - Text content.
 * @returns {HTMLElement} The new element.
 */
function ael(doc, tag, cls, text) {
  var node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A short relative time ("just now", "5m", "3h", "2d", or a date). Named
 * distinctly from comments.js's copy so the two don't collide in the bundle.
 * @param {string} iso - ISO-8601 timestamp.
 * @returns {string} The relative label.
 */
function askRelativeTime(iso) {
  var then = Date.parse(iso);
  if (isNaN(then)) return '';
  var secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  if (secs < 3600) return Math.round(secs / 60) + 'm';
  if (secs < 86400) return Math.round(secs / 3600) + 'h';
  if (secs < 7 * 86400) return Math.round(secs / 86400) + 'd';
  return new Date(then).toLocaleDateString();
}

/**
 * A one-line summary of a tool call + its result, for the "figures used" list.
 * @param {object} use - A `{tool, args, result}` entry from the API.
 * @returns {string} A compact human description.
 */
function describeUse(use) {
  var a = use.args || {};
  var r = use.result || {};
  if (use.tool === 'aggregate' && r.groups) {
    return 'aggregate ' + (a.measure || '') + ' by ' + (a.group_by || '') + ': '
      + r.groups.slice(0, 5).map(function (g) { return g.group + '=' + g.value; }).join(', ');
  }
  if (use.tool === 'top_n' && r.top) {
    return 'top ' + (a.measure || '') + ': '
      + r.top.map(function (t) { return t.id + '=' + t.value; }).join(', ');
  }
  if (use.tool === 'filter_count') {
    return 'count where ' + (a.field || '') + ' ' + (a.op || '') + ' ' + a.value + ': ' + r.count;
  }
  if (use.tool === 'describe') {
    return 'described ' + (a.source || '');
  }
  return use.tool;
}

/**
 * Mount the "Ask" box for a dashboard.
 * @param {object} opts - Options.
 * @param {string} opts.baseUrl - API base (no trailing slash).
 * @param {string} opts.dashboardId - The dashboard id.
 * @param {string} [opts.owner] - The dashboard's owner (for a shared dashboard).
 * @param {Document} [opts.doc] - Owning document (defaults to `document`).
 * @param {HTMLElement} [opts.mountInto] - Where to append (defaults to `<body>`).
 * @returns {{destroy: function, open: function}} Handle.
 * @public
 */
export function mountAsk(opts) {
  opts = opts || {};
  var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('mountAsk needs a document');
  var base = opts.baseUrl || '';
  var id = opts.dashboardId;
  var ownerQuery = opts.owner ? ('?owner=' + encodeURIComponent(opts.owner)) : '';
  var mountInto = opts.mountInto || doc.body || doc.documentElement;
  var endpoint = base + '/api/dashboards/' + encodeURIComponent(id) + '/ask' + ownerQuery;

  var toggle = ael(doc, 'button', 'cxd-ask-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Ask about this data');
  toggle.appendChild(doc.createTextNode('✨ Ask'));
  var countBadge = ael(doc, 'span', 'cxd-ask-count');
  countBadge.hidden = true;
  toggle.appendChild(countBadge);

  var panel = ael(doc, 'div', 'cxd-ask-panel');
  panel.hidden = true;
  var head = ael(doc, 'div', 'cxd-ask-head');
  head.appendChild(ael(doc, 'span', 'cxd-ask-title', 'Ask about this data'));
  var closeBtn = ael(doc, 'button', 'cxd-ask-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  head.appendChild(closeBtn);
  panel.appendChild(head);

  var form = ael(doc, 'form', 'cxd-ask-form');
  var input = ael(doc, 'textarea', 'cxd-ask-input');
  input.setAttribute('rows', '2');
  input.setAttribute('placeholder', 'e.g. which region has the highest revenue?');
  var askBtn = ael(doc, 'button', 'cxd-ask-send', 'Ask');
  askBtn.type = 'submit';
  form.appendChild(input);
  form.appendChild(askBtn);
  panel.appendChild(form);

  var status = ael(doc, 'div', 'cxd-ask-status-line');
  status.hidden = true;
  panel.appendChild(status);
  var history = ael(doc, 'div', 'cxd-ask-history');
  panel.appendChild(history);

  mountInto.appendChild(toggle);
  mountInto.appendChild(panel);

  // The ask history endpoints are on /asks (plural); the single question POST is /ask.
  var asksRoot = base + '/api/dashboards/' + encodeURIComponent(id) + '/asks';

  function open() { panel.hidden = false; toggle.classList.add('cxd-ask-open'); input.focus(); }
  function close() { panel.hidden = true; toggle.classList.remove('cxd-ask-open'); }
  toggle.addEventListener('click', function () { if (panel.hidden) open(); else close(); });
  closeBtn.addEventListener('click', close);

  /**
   * Show (or clear) a transient status/error line above the history.
   * @param {string} text - The message, or "" to clear.
   * @param {boolean} [isError] - Style as an error.
   * @returns {void}
   */
  function showStatus(text, isError) {
    status.className = 'cxd-ask-status-line' + (isError ? ' cxd-ask-error' : ' cxd-ask-status');
    status.textContent = text || '';
    status.hidden = !text;
  }

  /**
   * Build one persisted Q&A history entry: the question, the answer, the figures
   * it used, who asked, and a delete control.
   * @param {object} ask - A stored ask `{ask_id, author, question, answer, used, created_at}`.
   * @returns {HTMLElement} The entry element.
   */
  function entryEl(ask) {
    var entry = ael(doc, 'div', 'cxd-ask-entry');
    var q = ael(doc, 'div', 'cxd-ask-q');
    q.appendChild(ael(doc, 'span', 'cxd-ask-qmark', 'Q'));
    q.appendChild(doc.createTextNode(' ' + (ask.question || '')));
    entry.appendChild(q);
    entry.appendChild(ael(doc, 'p', 'cxd-ask-text', ask.answer || 'No answer.'));
    var used = ask.used || [];
    if (used.length) {
      var details = ael(doc, 'details', 'cxd-ask-used');
      details.appendChild(ael(doc, 'summary', null, 'Figures used (' + used.length + ')'));
      var list = ael(doc, 'ul', 'cxd-ask-usedlist');
      used.forEach(function (u) { list.appendChild(ael(doc, 'li', null, describeUse(u))); });
      details.appendChild(list);
      entry.appendChild(details);
    }
    var meta = ael(doc, 'div', 'cxd-ask-entrymeta');
    if (ask.author) meta.appendChild(ael(doc, 'span', 'cxd-ask-author', ask.author));
    if (ask.created_at) meta.appendChild(ael(doc, 'span', 'cxd-ask-time', askRelativeTime(ask.created_at)));
    if (ask.ask_id) {
      // Pin the answer onto the dashboard as a text panel (needs edit access;
      // the server returns 403 otherwise, surfaced as a tooltip).
      var pin = ael(doc, 'button', 'cxd-ask-pin', 'Pin as panel');
      pin.type = 'button';
      pin.addEventListener('click', function () {
        pin.disabled = true;
        fetch(asksRoot + '/' + encodeURIComponent(ask.ask_id) + '/pin' + ownerQuery,
          { method: 'POST', credentials: 'include' })
          .then(function (r) {
            if (r.ok) { pin.textContent = 'Pinned ✓'; return; }
            pin.disabled = false;
            r.json().then(function (d) { pin.title = (d && d.detail) || 'Could not pin'; }, function () {});
          }, function () { pin.disabled = false; });
      });
      meta.appendChild(pin);
    }
    if (ask.ask_id) {
      var del = ael(doc, 'button', 'cxd-ask-del', 'Delete');
      del.type = 'button';
      del.addEventListener('click', function () {
        del.disabled = true;
        fetch(asksRoot + '/' + encodeURIComponent(ask.ask_id) + ownerQuery,
          { method: 'DELETE', credentials: 'include' })
          .then(function (r) { if (r.ok) { if (entry.parentNode) entry.parentNode.removeChild(entry); updateCount(); } else del.disabled = false; },
                function () { del.disabled = false; });
      });
      meta.appendChild(del);
    }
    entry.appendChild(meta);
    return entry;
  }

  /**
   * Replace the history list with these asks (newest first).
   * @param {object[]} asks - Stored asks.
   * @returns {void}
   */
  function renderHistory(asks) {
    history.innerHTML = '';
    (asks || []).forEach(function (a) { history.appendChild(entryEl(a)); });
    updateCount();
  }

  /**
   * Refresh the count badge on the toggle from the number of history entries.
   * @returns {void}
   */
  function updateCount() {
    var n = history.querySelectorAll('.cxd-ask-entry').length;
    countBadge.textContent = String(n);
    countBadge.hidden = n === 0;
  }

  /**
   * Load the persisted ask history for this dashboard.
   * @returns {Promise<void>} Resolves once rendered.
   */
  function loadHistory() {
    return fetch(asksRoot + ownerQuery, { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : { asks: [] }; })
      .then(function (d) { renderHistory((d && d.asks) || []); }, function () {});
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var question = input.value.trim();
    if (!question) return;
    askBtn.disabled = true;
    showStatus('Thinking…');
    fetch(endpoint, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question })
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.detail) || ('HTTP ' + r.status));
        return data;
      });
    }).then(function (ask) {
      askBtn.disabled = false;
      input.value = '';
      showStatus('');
      history.insertBefore(entryEl(ask), history.firstChild);  // newest on top, persisted
      updateCount();
    }, function (err) {
      askBtn.disabled = false;
      showStatus(err && err.message ? err.message : 'Something went wrong.', true);
    });
  });

  loadHistory();

  return {
    open: open,
    refresh: loadHistory,
    destroy: function () {
      if (toggle.parentNode) toggle.parentNode.removeChild(toggle);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }
  };
}
