/**
 * Client "Ask" box: mounting, posting a question, rendering the answer + figures.
 * DOM + fetch are stubbed; the server loop is covered by server/tests/test_ask*.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/dom-stub.js';

installDom();

var { mountAsk } = await import('../src/ask.js');

function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }

test('mountAsk adds a toggle and posts a question, rendering the answer + figures', async function () {
  var calls = [];
  global.fetch = function (url, opt) {
    calls.push({ url: url, body: JSON.parse(opt.body) });
    return Promise.resolve({ ok: true, status: 200, json: function () {
      return Promise.resolve({ answer: 'North leads with 350.',
        used: [{ tool: 'aggregate', args: { measure: 'Revenue', group_by: 'Region' },
                 result: { groups: [{ group: 'North', value: 350 }] } }] });
    } });
  };
  var h = mountAsk({ baseUrl: '/d', dashboardId: 'x' });
  assert.ok(document.body.querySelectorAll('.cxd-ask-toggle').length, 'toggle added');

  var input = document.body.querySelectorAll('.cxd-ask-input')[0];
  input.value = 'which region leads?';
  document.body.querySelectorAll('.cxd-ask-form')[0].dispatchEvent('submit', { preventDefault: function () {} });
  await flush();

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/d\/api\/dashboards\/x\/ask/);
  assert.equal(calls[0].body.question, 'which region leads?');
  assert.ok(document.body.querySelectorAll('.cxd-ask-text')[0].textContent.indexOf('North leads') !== -1);
  assert.ok(document.body.querySelectorAll('.cxd-ask-used').length, 'figures-used section rendered');
  h.destroy();
  assert.equal(document.body.querySelectorAll('.cxd-ask-toggle').length, 0, 'destroy removes it');
});

test('mountAsk shows the server error detail', async function () {
  global.fetch = function () {
    return Promise.resolve({ ok: false, status: 503, json: function () {
      return Promise.resolve({ detail: 'AI is not configured on this server' });
    } });
  };
  var h = mountAsk({ baseUrl: '/d', dashboardId: 'x' });
  document.body.querySelectorAll('.cxd-ask-input')[0].value = 'hi';
  document.body.querySelectorAll('.cxd-ask-form')[0].dispatchEvent('submit', { preventDefault: function () {} });
  await flush();
  assert.ok(document.body.querySelectorAll('.cxd-ask-error')[0].textContent.indexOf('not configured') !== -1);
  h.destroy();
});
