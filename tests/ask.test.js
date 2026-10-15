/**
 * Client "Ask" box: mounting, loading persisted history, posting a question,
 * and prepending the stored answer. DOM + fetch stubbed; the server loop is
 * covered by server/tests/test_ask*.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/dom-stub.js';

installDom();

var { mountAsk } = await import('../src/ask.js');

function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }

/** A fetch stub: GET /asks returns `history`, POST /ask returns `posted`, records calls. */
function fakeFetch(history, posted, calls) {
  return function (url, opt) {
    opt = opt || {};
    var method = opt.method || 'GET';
    calls.push({ method: method, url: url, body: opt.body ? JSON.parse(opt.body) : null });
    var payload = method === 'GET' ? { asks: history }
      : /\/ask(\?|$)/.test(url) ? posted
      : { asks: history };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(payload); } });
  };
}

test('mountAsk loads persisted history on open and renders each Q&A', async function () {
  var history = [{
    ask_id: 'a1', author: 'demo', question: 'top region?', answer: 'West, 1296.',
    used: [{ tool: 'aggregate', args: {}, result: { groups: [] } }],
    created_at: new Date().toISOString()
  }];
  var calls = [];
  global.fetch = fakeFetch(history, null, calls);
  var h = mountAsk({ baseUrl: '/d', dashboardId: 'x' });
  await flush();
  // the history endpoint (plural) was fetched on mount
  assert.ok(calls.some(function (c) { return c.method === 'GET' && /\/d\/api\/dashboards\/x\/asks/.test(c.url); }));
  assert.equal(document.body.querySelectorAll('.cxd-ask-entry').length, 1, 'one history entry');
  assert.ok(document.body.querySelectorAll('.cxd-ask-text')[0].textContent.indexOf('West, 1296') !== -1);
  h.destroy();
});

test('mountAsk posts a question and prepends the persisted answer', async function () {
  var calls = [];
  var posted = { ask_id: 'a2', author: 'demo', question: 'which region leads?',
    answer: 'West leads with 1296.', used: [], created_at: new Date().toISOString() };
  global.fetch = fakeFetch([], posted, calls);
  var h = mountAsk({ baseUrl: '/d', dashboardId: 'x' });
  await flush();
  document.body.querySelectorAll('.cxd-ask-input')[0].value = 'which region leads?';
  document.body.querySelectorAll('.cxd-ask-form')[0].dispatchEvent('submit', { preventDefault: function () {} });
  await flush();
  var post = calls.filter(function (c) { return c.method === 'POST'; })[0];
  assert.ok(/\/d\/api\/dashboards\/x\/ask(\?|$)/.test(post.url), 'POST to /ask');
  assert.equal(post.body.question, 'which region leads?');
  var entries = document.body.querySelectorAll('.cxd-ask-entry');
  assert.equal(entries.length, 1, 'the new answer is added to history');
  assert.ok(document.body.querySelectorAll('.cxd-ask-text')[0].textContent.indexOf('West leads') !== -1);
  h.destroy();
});

test('mountAsk shows the server error detail', async function () {
  global.fetch = function (url, opt) {
    if ((opt && opt.method) === 'POST') {
      return Promise.resolve({ ok: false, status: 503, json: function () {
        return Promise.resolve({ detail: 'AI is not configured on this server' }); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ asks: [] }); } });
  };
  var h = mountAsk({ baseUrl: '/d', dashboardId: 'x' });
  await flush();
  document.body.querySelectorAll('.cxd-ask-input')[0].value = 'hi';
  document.body.querySelectorAll('.cxd-ask-form')[0].dispatchEvent('submit', { preventDefault: function () {} });
  await flush();
  assert.ok(document.body.querySelectorAll('.cxd-ask-error')[0].textContent.indexOf('not configured') !== -1);
  h.destroy();
});
