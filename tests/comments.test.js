/**
 * Client comments rail: mounting, threaded rendering, posting, and the API
 * calls it makes. The DOM + fetch are stubbed; the full UI (and the server) are
 * covered by the browser e2e and server/tests/test_comments.py respectively.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/dom-stub.js';

installDom();

var { mountComments } = await import('../src/comments.js');

/**
 * A fetch stub that serves a canned comment list and records writes.
 * @param {object[]} threads - Threaded comments the GET returns.
 * @param {object[]} calls - Array to record {method, url, body} into.
 * @returns {function} A fetch implementation.
 */
function fakeFetch(threads, calls) {
  return function (url, opt) {
    opt = opt || {};
    calls.push({ method: opt.method || 'GET', url: url, body: opt.body ? JSON.parse(opt.body) : null });
    var payload = (opt.method === 'GET' || !opt.method) ? { comments: threads } : { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(payload); } });
  };
}

function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }

test('mountComments renders a toggle + rail and lists threaded comments', async function () {
  var threads = [{
    comment_id: 'a', author: 'alice', body: 'Looks off cc @bob', created_at: new Date().toISOString(),
    mentions: ['bob'], resolved: false, panel_id: null, parent_id: null,
    replies: [{ comment_id: 'b', author: 'bob', body: 'agreed', created_at: new Date().toISOString(),
      mentions: [], resolved: false, parent_id: 'a' }]
  }];
  var calls = [];
  global.fetch = fakeFetch(threads, calls);
  var h = mountComments({ baseUrl: '/d', dashboardId: 'x', currentUser: 'alice', users: ['bob'] });
  await flush();

  assert.ok(document.body.querySelectorAll('.cxd-comments-toggle').length, 'a toggle button is added');
  assert.ok(document.body.querySelectorAll('.cxd-comments-rail').length, 'a rail is added');
  assert.equal(document.body.querySelectorAll('.cxd-cmt').length, 2, 'root + reply render');
  assert.equal(document.body.querySelectorAll('.cxd-cmt-reply').length, 1, 'the reply is nested');
  assert.equal(document.body.querySelectorAll('.cxd-comments-count')[0].textContent, '2', 'badge counts all');
  // the GET used the comments endpoint
  assert.match(calls[0].url, /\/d\/api\/dashboards\/x\/comments/);
  h.destroy();
  assert.equal(document.body.querySelectorAll('.cxd-comments-toggle').length, 0, 'destroy removes the UI');
});

test('mountComments posts a new comment to the API', async function () {
  var calls = [];
  global.fetch = fakeFetch([], calls);
  var h = mountComments({ baseUrl: '/d', dashboardId: 'x', currentUser: 'alice', users: [] });
  await flush();
  var input = document.body.querySelectorAll('.cxd-comments-input')[0];
  input.value = 'hello';
  document.body.querySelectorAll('.cxd-comments-composer')[0].dispatchEvent('submit', { preventDefault: function () {} });
  await flush();
  var posts = calls.filter(function (c) { return c.method === 'POST'; });
  assert.equal(posts.length, 1, 'one POST');
  assert.equal(posts[0].body.body, 'hello', 'the body is sent');
  h.destroy();
});

test('mountComments anchors a comment to a chosen panel and shows the badge', async function () {
  var threads = [{
    comment_id: 'a', author: 'alice', body: 'on the chart', created_at: new Date().toISOString(),
    mentions: [], resolved: false, panel_id: 'p2', parent_id: null, replies: []
  }];
  var calls = [];
  global.fetch = fakeFetch(threads, calls);
  var h = mountComments({
    baseUrl: '/d', dashboardId: 'x', currentUser: 'alice', users: [],
    panels: [{ id: 'p1', title: 'Revenue' }, { id: 'p2', title: 'Attainment' }]
  });
  await flush();
  // the anchored comment shows an "on <title>" badge resolved from the panel map
  var anchor = document.body.querySelectorAll('.cxd-cmt-anchor')[0];
  assert.ok(anchor && anchor.textContent.indexOf('Attainment') !== -1, 'anchor badge names the panel');
  // posting with a chosen panel sends panelId
  var sel = document.body.querySelectorAll('.cxd-comments-anchor')[0];
  assert.ok(sel, 'the composer has a panel picker');
  sel.value = 'p1';
  document.body.querySelectorAll('.cxd-comments-input')[0].value = 'look here';
  document.body.querySelectorAll('.cxd-comments-composer')[0].dispatchEvent('submit', { preventDefault: function () {} });
  await flush();
  var post = calls.filter(function (c) { return c.method === 'POST'; })[0];
  assert.equal(post.body.panelId, 'p1', 'the chosen panel id is sent');
  h.destroy();
});

test('mountComments hides itself when the API says 401/404', async function () {
  global.fetch = function () { return Promise.resolve({ ok: false, status: 401, json: function () { return Promise.resolve({}); } }); };
  var h = mountComments({ baseUrl: '/d', dashboardId: 'x', currentUser: 'alice', users: [] });
  await flush();
  assert.equal(document.body.querySelectorAll('.cxd-comments-toggle')[0].hidden, true, 'toggle hidden when not permitted');
  h.destroy();
});
