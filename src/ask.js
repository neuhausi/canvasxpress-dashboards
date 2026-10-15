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

  var answer = ael(doc, 'div', 'cxd-ask-answer');
  panel.appendChild(answer);

  mountInto.appendChild(toggle);
  mountInto.appendChild(panel);

  function open() { panel.hidden = false; toggle.classList.add('cxd-ask-open'); input.focus(); }
  function close() { panel.hidden = true; toggle.classList.remove('cxd-ask-open'); }
  toggle.addEventListener('click', function () { if (panel.hidden) open(); else close(); });
  closeBtn.addEventListener('click', close);

  /**
   * Render the answer (and the figures it used) into the answer area.
   * @param {object} result - The `{answer, used}` response.
   * @returns {void}
   */
  function showAnswer(result) {
    answer.innerHTML = '';
    var text = (result && result.answer) || 'No answer.';
    answer.appendChild(ael(doc, 'p', 'cxd-ask-text', text));
    var used = (result && result.used) || [];
    if (used.length) {
      var details = ael(doc, 'details', 'cxd-ask-used');
      details.appendChild(ael(doc, 'summary', null, 'Figures used (' + used.length + ')'));
      var list = ael(doc, 'ul', 'cxd-ask-usedlist');
      used.forEach(function (u) { list.appendChild(ael(doc, 'li', null, describeUse(u))); });
      details.appendChild(list);
      answer.appendChild(details);
    }
  }

  /**
   * Show a transient status/error line in the answer area.
   * @param {string} text - The message.
   * @param {boolean} [isError] - Style as an error.
   * @returns {void}
   */
  function showStatus(text, isError) {
    answer.innerHTML = '';
    answer.appendChild(ael(doc, 'p', isError ? 'cxd-ask-error' : 'cxd-ask-status', text));
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
    }).then(function (result) {
      askBtn.disabled = false;
      showAnswer(result);
    }, function (err) {
      askBtn.disabled = false;
      showStatus(err && err.message ? err.message : 'Something went wrong.', true);
    });
  });

  return {
    open: open,
    destroy: function () {
      if (toggle.parentNode) toggle.parentNode.removeChild(toggle);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }
  };
}
