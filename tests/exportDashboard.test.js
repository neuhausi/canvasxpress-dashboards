/**
 * Unit tests for the self-contained HTML export: parameter-aware data snapshot,
 * frozen param controls, and the guardScript neutralization (regression: a
 * blanket </-escape once corrupted the inlined library's regex literals).
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineSpecData, buildDashboardHtml } from '../src/exportDashboard.js';

/**
 * A fetch stub that echoes the requested URL's region param into the data, so a
 * snapshot can be checked for the value it was resolved at.
 * @returns {function} fetch stub.
 */
function regionFetch() {
  return function (url) {
    var m = /region=([^&]+)/.exec(url);
    var region = m ? decodeURIComponent(m[1]) : 'ALL';
    var body = JSON.stringify({ y: { vars: ['R'], smps: [region], data: [[1]] } });
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(body); } });
  };
}

var PARAM_SPEC = {
  id: 'live',
  params: { region: { value: 'EMEA', type: 'string' } },
  layout: { items: [
    { panel: 'pick', x: 0, y: 0, w: 3, h: 1 },
    { panel: 'bar', x: 0, y: 1, w: 6, h: 3 }
  ] },
  data: { sales: { kind: 'connector', url: '/api/data', query: { region: '$region' } } },
  panels: {
    pick: { type: 'control', mode: 'param', param: 'region', options: ['EMEA', 'APAC'] },
    bar: { dataRef: 'sales', config: { graphType: 'Bar' } }
  }
};

test('inlineSpecData bakes each source at the current params and inlines it', async function () {
  var out = await inlineSpecData(PARAM_SPEC, { fetch: regionFetch() });
  assert.equal(out.data.sales.kind, 'inline');
  assert.equal(out.data.sales.value.y.smps[0], 'EMEA', 'resolved at the declared param default');
  assert.equal(out.data.sales.query, undefined, 'query template dropped once inlined');
});

test('inlineSpecData honors live param overrides for the snapshot', async function () {
  var out = await inlineSpecData(PARAM_SPEC, { fetch: regionFetch(), params: { region: 'APAC' } });
  assert.equal(out.data.sales.value.y.smps[0], 'APAC');
});

test('param controls are frozen (disabled + pinned value) in the export', async function () {
  var out = await inlineSpecData(PARAM_SPEC, { fetch: regionFetch(), params: { region: 'APAC' } });
  assert.equal(out.panels.pick.disabled, true);
  assert.equal(out.panels.pick.value, 'APAC');
});

test('buildDashboardHtml produces a self-contained doc with the frozen spec', async function () {
  var html = await buildDashboardHtml(PARAM_SPEC, {
    fetch: regionFetch(),
    params: { region: 'APAC' },
    cxCssUrl: 'css', cxJsUrl: 'js', umdUrl: 'umd'
  });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /CanvasXpressDashboards\.renderDashboard/);
  assert.match(html, /"disabled":true/, 'exported spec carries the frozen control');
});

test('guardScript neutralizes </script but leaves regex literals intact', async function () {
  // The inlined library carries both a real </script hazard and a legitimate
  // regex literal that a blanket </-escape would corrupt into /<\/g.
  var LIB = 'var re = /</g; var s = "x</script>y";';
  function libFetch(url) {
    var body = url === 'lib' ? LIB : '{}';
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(body); } });
  }
  var html = await buildDashboardHtml(
    { id: 'x', layout: { items: [] }, data: {}, panels: {} },
    { fetch: libFetch, cxCssUrl: 'css', cxJsUrl: 'lib', umdUrl: 'umd' }
  );
  assert.match(html, /var re = \/<\/g;/, 'the regex literal /</g survives unescaped');
  assert.match(html, /x<\\\/script>y/, 'the </script hazard is neutralized to <\\/script');
});
