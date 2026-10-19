/**
 * Unit tests for the self-contained HTML export: parameter-aware data snapshot,
 * frozen param controls, and the guardScript neutralization (regression: a
 * blanket </-escape once corrupted the inlined library's regex literals).
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inlineSpecData, buildDashboardHtml, buildBundleFiles, buildReproducibleBundle, dashboardToPng,
  panelToSvg, panelToPdf
} from '../src/exportDashboard.js';

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

test('inlineSpecData bakes a join source (and its inputs) inline', async function () {
  var spec = {
    id: 'blend',
    layout: { cols: 12, items: [{ panel: 'bar', x: 0, y: 0, w: 6, h: 3 }] },
    data: {
      l: { kind: 'inline', value: { y: { vars: ['V'], smps: ['a', 'b'], data: [[1, 2]] } } },
      r: { kind: 'inline', value: { y: { vars: ['W'], smps: ['b'], data: [[9]] } } },
      j: { kind: 'join', left: 'l', right: 'r' }
    },
    panels: { bar: { dataRef: 'j', config: { graphType: 'Bar' } } }
  };
  var out = await inlineSpecData(spec, {});
  assert.equal(out.data.j.kind, 'inline');
  assert.deepEqual(out.data.j.value.y, { vars: ['V', 'W'], smps: ['b'], data: [[2], [9]] });
  assert.equal(spec.data.j.kind, 'join', 'the input spec is not mutated');
});

/**
 * A fake live dashboard handle whose panel instances emit highlighted code, so
 * the bundle writer can be tested without a browser or the engine.
 * @param {object} spec - The dashboard spec.
 * @param {object} params - Current param values.
 * @returns {object} A minimal handle.
 */
function fakeHandle(spec, params) {
  var instances = {};
  Object.keys(spec.panels || {}).forEach(function (id) {
    var p = spec.panels[id];
    if (p && p.type) return;   // only graph panels get an instance
    instances[id] = {
      // Emitters return highlighted HTML with entities, as the engine does.
      dataToR: function () { return '<span class=cX-Code-Key>canvasXpress</span>(data = df, x = <span>"A"</span>) # 1 &lt; 2'; },
      dataToPython: function () { return 'CanvasXpress(data=df, config={<span>"graphType"</span>: "Bar"})'; },
      dataToCxplot: function () { return '<code>// No cxplot spec available for this chart</code>'; }
    };
  });
  return {
    spec: spec,
    getParams: function () { return params || {}; },
    panelInstances: function () { return instances; }
  };
}

var BUNDLE_SPEC = {
  id: 'sales',
  title: 'Sales',
  layout: { cols: 12, items: [{ panel: 'bar', x: 0, y: 0, w: 6, h: 3 }] },
  data: {
    sales: {
      kind: 'connector', url: '/api/data', query: { region: '$region' },
      pushdown: { groupBy: ['Region'], measures: [{ fn: 'sum', column: 'Revenue' }] },
      provenance: { dataVersion: 'q3', asOf: '2026-09-30' }
    }
  },
  params: { region: { value: 'EMEA', type: 'string' } },
  panels: { bar: { title: 'Revenue', dataRef: 'sales', config: { graphType: 'Bar' }, provenance: { show: true } } }
};

test('buildBundleFiles: spec + data snapshot + per-panel R/Python code + methods.md', async function () {
  var handle = fakeHandle(BUNDLE_SPEC, { region: 'APAC' });
  var files = await buildBundleFiles(handle, { fetch: regionFetch(), now: function () { return '2026-10-16T00:00:00Z'; } });
  var byName = {};
  files.forEach(function (f) { byName[f.name] = f.content; });

  // Self-contained spec, baked at the live param.
  assert.ok(byName['spec.json'], 'spec.json present');
  var inlined = JSON.parse(byName['spec.json']);
  assert.equal(inlined.data.sales.kind, 'inline');
  assert.equal(inlined.data.sales.value.y.smps[0], 'APAC', 'baked at live param override');

  // Data snapshot per source.
  assert.ok(byName['data/sales.json'], 'data snapshot present');
  assert.equal(JSON.parse(byName['data/sales.json']).y.smps[0], 'APAC');

  // Per-panel code, span-stripped and entity-decoded; no highlight markup left.
  assert.ok(byName['code/bar.R'], 'R code present');
  assert.ok(byName['code/bar.py'], 'Python code present');
  assert.doesNotMatch(byName['code/bar.R'], /<span|<code|cX-Code-/, 'highlight markup stripped');
  assert.match(byName['code/bar.R'], /canvasXpress\(data = df/);
  assert.match(byName['code/bar.R'], /1 < 2/, 'entities decoded');
  assert.equal(byName['code/bar-cxplot.R'], undefined, 'cxplot stub omitted');

  // methods.md with the auto-derived method line and the source provenance.
  assert.match(byName['methods.md'], /# Sales — reproducible bundle/);
  assert.match(byName['methods.md'], /Generated 2026-10-16T00:00:00Z/);
  assert.match(byName['methods.md'], /aggregated \(sum of Revenue\) grouped by Region; plotted as Bar/);
  assert.match(byName['methods.md'], /version q3; as of 2026-09-30/);
});

test('buildBundleFiles: function-source code comes from the ORIGINAL spec (not the inlined snapshot)', async function () {
  var spec = {
    id: 'fn', title: 'Fn',
    layout: { cols: 12, items: [{ panel: 'p', x: 0, y: 0, w: 6, h: 3 }] },
    data: {
      base: { kind: 'inline', value: { y: { vars: ['V'], smps: ['a'], data: [[1]] } } },
      derived: { kind: 'function', language: 'python', code: 'result = base * 2', inputs: ['base'] }
    },
    panels: { p: { dataRef: 'base', config: { graphType: 'Bar' } } }
  };
  var files = await buildBundleFiles(fakeHandle(spec, {}), {
    fetch: function () { return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve('{"data":{"y":{"vars":["V"],"smps":["a"],"data":[[2]]}}}'); } }); }
  });
  var byName = {};
  files.forEach(function (f) { byName[f.name] = f.content; });
  assert.match(byName['code/source-derived.py'], /result = base \* 2/, 'function snippet preserved');
});

test('buildBundleFiles (P4): manifest, provenance stamping, content hash', async function () {
  var handle = fakeHandle(BUNDLE_SPEC, { region: 'APAC' });
  var files = await buildBundleFiles(handle, {
    fetch: regionFetch(), engineVersion: '71.8', now: function () { return '2026-10-16T00:00:00Z'; }
  });
  var byName = {};
  files.forEach(function (f) { byName[f.name] = f.content; });

  // Source provenance stamped with capture time + params (author dataVersion kept).
  var inlined = JSON.parse(byName['spec.json']);
  assert.equal(inlined.data.sales.provenance.asOf, '2026-10-16T00:00:00Z');
  assert.deepEqual(inlined.data.sales.provenance.params, { region: 'APAC' });
  assert.equal(inlined.data.sales.provenance.dataVersion, 'q3', 'author field preserved');

  // Manifest with version/asOf/engine + content hash + per-file hashes.
  var manifest = JSON.parse(byName['manifest.json']);
  assert.equal(manifest.generated, '2026-10-16T00:00:00Z');
  assert.equal(manifest.engineVersion, '71.8');
  assert.equal(manifest.dashboard.id, 'sales');
  assert.match(manifest.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(manifest.files['spec.json'], /^sha256:[0-9a-f]{64}$/);
  assert.equal(manifest.files['manifest.json'], undefined, 'manifest does not hash itself');

  // methods.md surfaces the engine version and content hash.
  assert.match(byName['methods.md'], /\| Engine \| 71\.8 \|/);
  assert.match(byName['methods.md'], new RegExp('Content hash .*' + manifest.contentHash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('buildBundleFiles (P4): content hash distinguishes different data, ignores capture time', async function () {
  var base = { fetch: regionFetch() };
  var h1 = await buildBundleFiles(fakeHandle(BUNDLE_SPEC, { region: 'APAC' }), Object.assign({ now: function () { return '2026-01-01T00:00:00Z'; } }, base));
  var h2 = await buildBundleFiles(fakeHandle(BUNDLE_SPEC, { region: 'APAC' }), Object.assign({ now: function () { return '2026-12-31T23:59:59Z'; } }, base));
  var h3 = await buildBundleFiles(fakeHandle(BUNDLE_SPEC, { region: 'EMEA' }), Object.assign({ now: function () { return '2026-01-01T00:00:00Z'; } }, base));
  var hash = function (files) { var m = files.find(function (f) { return f.name === 'manifest.json'; }); return JSON.parse(m.content).contentHash; };
  assert.equal(hash(h1), hash(h2), 'same content, different capture time → same hash');
  assert.notEqual(hash(h1), hash(h3), 'different data (region) → different hash');
});

test('dashboardToPng skips screen-reader-only a11y nodes (the "Data table for chart" overlay)', async function () {
  var skipped = {};
  // Stub html2canvas: apply the ignoreElements predicate to representative nodes.
  function h2cStub(container, cfg) {
    function node(id, cls) {
      return { nodeType: 1, id: id || '', getAttribute: function (a) { return a === 'class' ? (cls || '') : null; } };
    }
    skipped.a11yTable = cfg.ignoreElements(node('chart1-cX-a11y-table', ''));
    skipped.liveRegion = cfg.ignoreElements(node('x', 'cX-a11y-live'));
    skipped.canvas = cfg.ignoreElements(node('chart1-canvas', 'cxd-canvas'));
    skipped.textNode = cfg.ignoreElements({ nodeType: 3 });
    return Promise.resolve({ toDataURL: function () { return 'data:image/png;base64,AAAA'; } });
  }
  var url = await dashboardToPng({}, { html2canvas: h2cStub });
  assert.equal(url, 'data:image/png;base64,AAAA');
  assert.equal(skipped.a11yTable, true, 'a11y data table skipped');
  assert.equal(skipped.liveRegion, true, 'a11y live region skipped');
  assert.equal(skipped.canvas, false, 'the chart canvas is kept');
  assert.equal(skipped.textNode, false, 'text nodes are not elements');
});

test('buildReproducibleBundle: produces a valid, non-empty ZIP (PK header)', async function () {
  var bytes = await buildReproducibleBundle(fakeHandle(BUNDLE_SPEC, {}), { fetch: regionFetch(), now: function () { return '2026-10-16T00:00:00Z'; } });
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0);
  assert.equal(bytes[0], 0x50, 'ZIP local-header "P"');
  assert.equal(bytes[1], 0x4b, 'ZIP local-header "K"');
  // EOCD signature present near the end.
  var tail = Array.from(bytes.slice(-22, -18));
  assert.deepEqual(tail, [0x50, 0x4b, 0x05, 0x06], 'End-of-central-directory signature');
});

/**
 * A fake live handle exposing one graph panel whose instance emits vector
 * output via the engine's getSVGString()/getPDFBytes(), so the per-panel vector
 * export can be tested without a browser or the real engine.
 * @param {object} [overrides] - Per-method stubs ({svg, pdf}); omit a method to
 *   simulate an engine that lacks it.
 * @returns {object} A minimal handle with panelInstances().
 */
function fakeVectorHandle(overrides) {
  overrides = overrides || {};
  var instance = {};
  if (overrides.svg !== false) {
    instance.getSVGString = overrides.svg || function () { return '<svg xmlns="http://www.w3.org/2000/svg"><desc>chart</desc></svg>'; };
  }
  if (overrides.pdf !== false) {
    instance.getPDFBytes = overrides.pdf || function () { return Promise.resolve(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' })); };
  }
  return { panelInstances: function () { return { chart: instance }; } };
}

test('panelToSvg: returns the engine getSVGString() document for a panel', function () {
  var svg = panelToSvg(fakeVectorHandle(), 'chart');
  assert.match(svg, /^<svg/, 'a standalone SVG document');
  assert.match(svg, /<desc>chart<\/desc>/, 'carries the a11y description');
});

test('panelToSvg: throws for an unknown panel id', function () {
  assert.throws(function () { panelToSvg(fakeVectorHandle(), 'nope'); }, /no rendered graph panel "nope"/);
});

test('panelToSvg: throws when the engine lacks getSVGString (pre-71.3)', function () {
  assert.throws(function () { panelToSvg(fakeVectorHandle({ svg: false }), 'chart'); }, /no getSVGString/);
});

test('panelToPdf: resolves the engine getPDFBytes() Blob for a panel', async function () {
  var blob = await panelToPdf(fakeVectorHandle(), 'chart');
  assert.ok(blob instanceof Blob, 'a PDF Blob');
  assert.equal(blob.type, 'application/pdf');
});

test('panelToPdf: rejects when the engine lacks getPDFBytes', async function () {
  await assert.rejects(panelToPdf(fakeVectorHandle({ pdf: false }), 'chart'), /no getPDFBytes/);
});
