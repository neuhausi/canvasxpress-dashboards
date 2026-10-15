/**
 * Dashboard comments rail: a collapsible side panel where signed-in viewers of a
 * dashboard leave comments, reply in threads, @mention teammates, and resolve a
 * thread. It talks to the server comment API
 * (`/api/dashboards/{id}/comments`), so it is only useful inside the hosted app
 * (the standalone example pages have no session). Mount it after the dashboard
 * renders; it adds a floating toggle button and a slide-in rail.
 *
 * @module comments
 */

/**
 * Create an element with an optional class and text.
 * @param {Document} doc - Owning document.
 * @param {string} tag - Tag name.
 * @param {string} [cls] - Class name.
 * @param {string} [text] - Text content.
 * @returns {HTMLElement} The new element.
 */
function cel(doc, tag, cls, text) {
  var node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A short relative time ("just now", "5m", "3h", "2d", or a date).
 * @param {string} iso - ISO-8601 timestamp.
 * @returns {string} The relative label.
 */
function relativeTime(iso) {
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
 * Append a comment body to a node, bolding @mentions of known users.
 * @param {Document} doc - Owning document.
 * @param {HTMLElement} into - Target node.
 * @param {string} body - The comment text.
 * @param {object} knownUsers - Set-like map of valid usernames.
 * @returns {void}
 */
function renderBody(doc, into, body, knownUsers) {
  var re = /(^|[^\w@])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  var last = 0;
  var m;
  while ((m = re.exec(body)) !== null) {
    var lead = m[1];
    var name = m[2];
    into.appendChild(doc.createTextNode(body.slice(last, m.index) + lead));
    if (Object.prototype.hasOwnProperty.call(knownUsers, name)) {
      into.appendChild(cel(doc, 'b', 'cxd-cmt-mention', '@' + name));
    } else {
      into.appendChild(doc.createTextNode('@' + name));
    }
    last = m.index + m[0].length;
  }
  into.appendChild(doc.createTextNode(body.slice(last)));
}

/**
 * Mount the comments rail for a dashboard.
 * @param {object} opts - Options.
 * @param {string} opts.baseUrl - API base (no trailing slash), e.g. "/dashboards".
 * @param {string} opts.dashboardId - The dashboard id.
 * @param {string} [opts.owner] - The dashboard's owner, when it is not the viewer's own.
 * @param {string} [opts.currentUser] - The signed-in username (for permission hints).
 * @param {string[]} [opts.users] - Usernames to recognize in @mentions.
 * @param {Document} [opts.doc] - Owning document (defaults to `document`).
 * @param {HTMLElement} [opts.mountInto] - Where to append the UI (defaults to `<body>`).
 * @returns {{destroy: function, refresh: function, open: function}} Handle.
 * @public
 */
export function mountComments(opts) {
  opts = opts || {};
  var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('mountComments needs a document');
  var base = opts.baseUrl || '';
  var id = opts.dashboardId;
  var owner = opts.owner || null;
  var currentUser = opts.currentUser || null;
  var knownUsers = {};
  (opts.users || []).forEach(function (u) { knownUsers[u] = true; });
  if (currentUser) knownUsers[currentUser] = true;
  var mountInto = opts.mountInto || doc.body || doc.documentElement;

  var ownerQuery = owner ? ('?owner=' + encodeURIComponent(owner)) : '';
  var apiRoot = base + '/api/dashboards/' + encodeURIComponent(id) + '/comments';

  /**
   * Call the comment API.
   * @param {string} method - HTTP method.
   * @param {string} path - Path appended to the comments root (may be "").
   * @param {object} [body] - JSON body for writes.
   * @returns {Promise<object>} The parsed response.
   */
  function api(method, path, body) {
    var opt = { method: method, credentials: 'include', headers: {} };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(apiRoot + path + (path.indexOf('?') === -1 ? ownerQuery : ''), opt).then(function (r) {
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.status === 204 ? {} : r.json();
    });
  }

  // --- UI skeleton -------------------------------------------------------
  var toggle = cel(doc, 'button', 'cxd-comments-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Comments');
  toggle.appendChild(doc.createTextNode('💬 Comments'));
  var countBadge = cel(doc, 'span', 'cxd-comments-count');
  countBadge.hidden = true;
  toggle.appendChild(countBadge);

  var rail = cel(doc, 'aside', 'cxd-comments-rail');
  rail.hidden = true;
  rail.setAttribute('aria-label', 'Dashboard comments');
  var head = cel(doc, 'div', 'cxd-comments-head');
  head.appendChild(cel(doc, 'h2', 'cxd-comments-title', 'Comments'));
  var closeBtn = cel(doc, 'button', 'cxd-comments-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close comments');
  head.appendChild(closeBtn);
  rail.appendChild(head);

  var list = cel(doc, 'div', 'cxd-comments-list');
  rail.appendChild(list);

  var composer = cel(doc, 'form', 'cxd-comments-composer');
  var textarea = cel(doc, 'textarea', 'cxd-comments-input');
  textarea.setAttribute('rows', '2');
  textarea.setAttribute('placeholder', 'Add a comment…  use @name to mention');
  var sendBtn = cel(doc, 'button', 'cxd-comments-send', 'Comment');
  sendBtn.type = 'submit';
  composer.appendChild(textarea);
  composer.appendChild(sendBtn);
  rail.appendChild(composer);

  mountInto.appendChild(toggle);
  mountInto.appendChild(rail);

  // --- behavior ----------------------------------------------------------
  function open() { rail.hidden = false; toggle.classList.add('cxd-comments-open'); textarea.focus(); }
  function close() { rail.hidden = true; toggle.classList.remove('cxd-comments-open'); }
  toggle.addEventListener('click', function () { if (rail.hidden) open(); else close(); });
  closeBtn.addEventListener('click', close);

  /**
   * Count every comment in a threaded list (roots + replies).
   * @param {object[]} threads - Threaded comments.
   * @returns {number} The total.
   */
  function totalCount(threads) {
    var n = 0;
    threads.forEach(function (t) { n += 1 + ((t.replies && t.replies.length) || 0); });
    return n;
  }

  /**
   * Build one comment card (root or reply).
   * @param {object} comment - The comment.
   * @param {boolean} isReply - Whether it is a reply (indented, no own reply box).
   * @returns {HTMLElement} The card element.
   */
  function card(comment, isReply) {
    var root = cel(doc, 'div', 'cxd-cmt' + (isReply ? ' cxd-cmt-reply' : '') + (comment.resolved ? ' cxd-cmt-resolved' : ''));
    var meta = cel(doc, 'div', 'cxd-cmt-meta');
    meta.appendChild(cel(doc, 'span', 'cxd-cmt-author', comment.author));
    meta.appendChild(cel(doc, 'span', 'cxd-cmt-time', relativeTime(comment.created_at)));
    if (comment.resolved) meta.appendChild(cel(doc, 'span', 'cxd-cmt-badge', 'resolved'));
    root.appendChild(meta);

    var bodyEl = cel(doc, 'div', 'cxd-cmt-body');
    renderBody(doc, bodyEl, comment.body, knownUsers);
    root.appendChild(bodyEl);

    var actions = cel(doc, 'div', 'cxd-cmt-actions');
    if (!isReply) {
      var replyBtn = cel(doc, 'button', 'cxd-cmt-link', 'Reply');
      replyBtn.type = 'button';
      replyBtn.addEventListener('click', function () { toggleReply(root, comment); });
      actions.appendChild(replyBtn);
    }
    var resolveBtn = cel(doc, 'button', 'cxd-cmt-link', comment.resolved ? 'Reopen' : 'Resolve');
    resolveBtn.type = 'button';
    resolveBtn.addEventListener('click', function () {
      resolveBtn.disabled = true;
      api('POST', '/' + encodeURIComponent(comment.comment_id) + '/resolve', { resolved: !comment.resolved })
        .then(refresh, function (e) { resolveBtn.disabled = false; reportError(e); });
    });
    actions.appendChild(resolveBtn);
    // The author / dashboard owner / an admin may delete; others get a 403 we surface.
    if (!currentUser || comment.author === currentUser || owner === currentUser || owner == null) {
      var delBtn = cel(doc, 'button', 'cxd-cmt-link cxd-cmt-del', 'Delete');
      delBtn.type = 'button';
      delBtn.addEventListener('click', function () {
        delBtn.disabled = true;
        api('DELETE', '/' + encodeURIComponent(comment.comment_id))
          .then(refresh, function (e) { delBtn.disabled = false; reportError(e); });
      });
      actions.appendChild(delBtn);
    }
    root.appendChild(actions);
    return root;
  }

  /**
   * Toggle an inline reply composer under a root comment.
   * @param {HTMLElement} rootCard - The root card element.
   * @param {object} comment - The root comment.
   * @returns {void}
   */
  function toggleReply(rootCard, comment) {
    var existing = rootCard.querySelector('.cxd-cmt-replybox');
    if (existing) { existing.parentNode.removeChild(existing); return; }
    var box = cel(doc, 'form', 'cxd-cmt-replybox');
    var input = cel(doc, 'textarea', 'cxd-comments-input');
    input.setAttribute('rows', '2');
    input.setAttribute('placeholder', 'Reply…');
    var send = cel(doc, 'button', 'cxd-comments-send', 'Reply');
    send.type = 'submit';
    box.appendChild(input);
    box.appendChild(send);
    box.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      api('POST', '', { body: text, parentId: comment.comment_id })
        .then(refresh, function (err) { send.disabled = false; reportError(err); });
    });
    rootCard.appendChild(box);
    input.focus();
  }

  /**
   * Show an error line at the top of the list.
   * @param {Error} e - The error.
   * @returns {void}
   */
  function reportError(e) {
    var msg = e && e.status === 403 ? 'You are not allowed to do that.'
      : e && e.status === 401 ? 'Sign in to comment.'
      : 'Something went wrong.';
    var line = cel(doc, 'div', 'cxd-comments-error', msg);
    list.insertBefore(line, list.firstChild);
    setTimeout(function () { if (line.parentNode) line.parentNode.removeChild(line); }, 4000);
  }

  /**
   * Re-fetch and re-render every comment.
   * @returns {Promise<void>} Resolves once rendered.
   */
  function refresh() {
    return api('GET', '').then(function (res) {
      var threads = (res && res.comments) || [];
      list.innerHTML = '';
      var n = totalCount(threads);
      countBadge.textContent = String(n);
      countBadge.hidden = n === 0;
      if (!threads.length) {
        list.appendChild(cel(doc, 'div', 'cxd-comments-empty', 'No comments yet. Start the conversation.'));
        return;
      }
      threads.forEach(function (t) {
        var c = card(t, false);
        (t.replies || []).forEach(function (r) { c.appendChild(card(r, true)); });
        list.appendChild(c);
      });
    }, function (e) {
      // 401/404 (not signed in / no such board) just hide the feature quietly.
      if (e && (e.status === 401 || e.status === 404)) { toggle.hidden = true; return; }
      reportError(e);
    });
  }

  composer.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = textarea.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    api('POST', '', { body: text }).then(function () {
      textarea.value = '';
      sendBtn.disabled = false;
      return refresh();
    }, function (err) { sendBtn.disabled = false; reportError(err); });
  });

  refresh();

  return {
    open: open,
    refresh: refresh,
    destroy: function () {
      if (toggle.parentNode) toggle.parentNode.removeChild(toggle);
      if (rail.parentNode) rail.parentNode.removeChild(rail);
    }
  };
}
