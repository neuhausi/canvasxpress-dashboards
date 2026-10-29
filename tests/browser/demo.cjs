/*
 * Demo-driver browser gate: a real cohort dashboard (with a Filters panel) rendered by the real
 * engine, then DRIVEN by the dashboard demo driver (src/demo.js).
 *
 *  - demoToStoryboard() compiles an authored storyboard into state steps (the bridge to the tour);
 *  - playDemo() drives the REAL chrome — a filter checkbox is clicked and the panels re-filter, a
 *    parameter is set, the ghost cursor appears — ending in the expected dashboard state;
 *  - dropFile delivers a genuine File to a drop zone (a real OS→browser drag cannot be synthesized,
 *    but the constructed File + DataTransfer is what any drop handler reads).
 *
 * Run: PLAYWRIGHT_MODULE=… node tests/browser/demo.cjs   (CX_ENGINE_DIR must point at an engine
 * build >= 72.8, which carries cx.playDemo; CXD_SHOT_DIR=dir to keep screenshots).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch (e) {
  console.log('demo: needs playwright — set PLAYWRIGHT_MODULE to an installed copy.');
  process.exit(2);
}

const SHOTS = process.env.CXD_SHOT_DIR || '';
const UMD = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'canvasxpress-dashboards.umd.js'), 'utf8');
const engine = require('./engine-route.cjs');

// A 40-patient cohort with a categorical `stage` we can filter via a checkbox.
function cohort() {
  const smps = [], os_months = [], os_event = [], age = [], arm = [], stage = [];
  for (let i = 0; i < 40; i++) {
    smps.push('P' + String(i + 1).padStart(3, '0'));
    os_months.push(3 + (i * 7) % 40); os_event.push(i % 3 === 0 ? 0 : 1); age.push(40 + (i * 5) % 35);
    arm.push(i % 2 ? 'Drug' : 'Placebo'); stage.push(['I', 'II', 'III'][i % 3]);
  }
  return { y: { vars: ['os_months', 'os_event', 'age'], smps: smps, data: [os_months, os_event, age] },
    x: { arm: arm, stage: stage } };
}

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://www.canvasxpress.org/dist/canvasXpress.css">' +
  '<script src="https://www.canvasxpress.org/dist/canvasXpress.min.js"></script></head><body><div id="dash"></div>' +
  '<div id="zone" style="width:200px;height:120px"></div>' +
  '<script>' + UMD.replace(/<\/script/g, '<\\/script') + '</script></body></html>';

(async function main() {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let failures = 0;
  const errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  function check(name, ok, detail) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail === undefined ? '' : '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')'));
    if (!ok) failures++;
  }
  const shot = async function (name) { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'demo-' + name + '.png') }); };

  await engine.routeEngine(page);
  await page.route('http://cxd.test/', function (route) { route.fulfill({ body: PAGE, contentType: 'text/html' }); });
  await page.goto('http://cxd.test/');
  await page.waitForFunction('window.CanvasXpress && window.CanvasXpressDashboards');

  // Fail fast if the routed engine predates the demo driver. The driver methods (playDemo, …) are
  // installed by initDemoEvents() during a chart's async render, so the reliable "compiled in" signal
  // is initDemoEvents on the prototype (the dashboard driver installs the methods when it needs them).
  const hasDriver = await page.evaluate(function () {
    return typeof window.CanvasXpress.prototype.initDemoEvents === 'function';
  });
  check('the routed engine carries the demo driver (>= 72.8)', hasDriver);
  if (!hasDriver) { await browser.close(); process.exit(failures ? 1 : 2); }

  // ── 1. The storyboard bridge (pure compile; no UI needed) ──────────────────────────────────
  const bridge = await page.evaluate(function () {
    const D = window.CanvasXpressDashboards;
    const DEMO = [
      { caption: 'Whole cohort' },
      { caption: 'Drug arm' }, { scheme: 'Drug arm' },
      { caption: 'High-risk' }, { filter: { dataRef: 'data', field: 'stage', values: ['III'] } },
      { panel: { id: 'km', chart: ['caption:inner', 'wait:10'] } }, // chart steps drop; focus:'km' folds in
      { caption: 'One patient' }, { param: { name: 'case', value: 'P007' } }, { panel: 'case' }
    ];
    return D.demoToStoryboard(DEMO);
  });
  check('bridge: a caption starts each storyboard step', bridge.length === 4, bridge.map(function (s) { return s.narration; }));
  check('bridge: the scheme step carries the scheme', bridge[1] && bridge[1].scheme === 'Drug arm', bridge[1]);
  check('bridge: the filter step carries the predicate and the km focus (chart steps dropped)', bridge[2] &&
    bridge[2].filters && bridge[2].filters[0].field === 'stage' && bridge[2].filters[0].values[0] === 'III' &&
    bridge[2].focus === 'km', bridge[2]);
  check('bridge: the last step carries the param and the panel focus', bridge[3] && bridge[3].params && bridge[3].params['case'] === 'P007' &&
    bridge[3].focus === 'case', bridge[3]);

  // ── 2. playDemo drives the REAL chrome into state ───────────────────────────────────────────
  await page.evaluate(async function (data) {
    const D = window.CanvasXpressDashboards;
    const spec = {
      id: 'demo', title: 'Cohort',
      data: { data: { kind: 'inline', value: data } },
      layout: { cols: 12, items: [{ panel: 'filters', x: 0, y: 0, w: 3, h: 8 }, { panel: 'km', x: 3, y: 0, w: 5, h: 8 }, { panel: 'case', x: 8, y: 0, w: 4, h: 8 }] },
      panels: {
        filters: { type: 'filters', dataRef: 'data', fields: ['arm', 'stage', 'age'] },
        km: { type: 'graph', dataRef: 'data', config: { graphType: 'Scatter2D' } },
        case: { type: 'graph', dataRef: 'data', config: { graphType: 'Bar' } }
      },
      params: { 'case': { values: data.y.smps, value: 'P001' } },
      filterSchemes: { 'Drug arm': [{ dataRef: 'data', field: 'arm', values: ['Drug'] }] }
    };
    window.__handle = await D.renderDashboard(spec, document.getElementById('dash'), { baseUrl: '' });
    await window.__handle.ready;
  }, cohort());
  await page.waitForTimeout(600);

  await page.evaluate(function () {
    const D = window.CanvasXpressDashboards;
    // speed 3× keeps the gate quick; the driver still dispatches the real events.
    return D.playDemo(window.__handle, [
      { caption: 'filter to stage III' },
      { filter: { dataRef: 'data', field: 'stage', values: ['III'] } },
      { param: { name: 'case', value: 'P007' } }
    ], { speed: 3 });
  });
  await page.waitForTimeout(800);

  const driven = await page.evaluate(function () {
    return {
      filter: window.__handle.getFilterState(),
      params: window.__handle.getParams(),
      cursor: !!document.querySelector('[id$="-cX-DemoCursor"], .CanvasXpress-DemoCursor'),
      loaders: Array.prototype.filter.call(document.querySelectorAll('.cX-Loader'), function (n) { return n.offsetParent !== null; }).length
    };
  });
  await shot('2-driven');
  // filter {stage: keep ['III']} drives real clicks that uncheck I and II, leaving exactly ['III'].
  check('playDemo drove the real stage filter to keep only III', driven.filter.some(function (p) {
    return p.field === 'stage' && (p.values || []).length === 1 && p.values[0] === 'III';
  }), driven.filter);
  check('playDemo set the case parameter', driven.params['case'] === 'P007', driven.params);
  check('no stuck loader after the run', driven.loaders === 0, driven.loaders);

  // ── 3. dropFile delivers a genuine File a drop handler can read ─────────────────────────────
  const dropped = await page.evaluate(async function () {
    const zone = document.getElementById('zone');
    const seen = {};
    zone.addEventListener('drop', function (ev) {
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      seen.name = f && f.name;
      if (f) { const r = new FileReader(); r.onload = function () { seen.text = r.result; }; r.readAsText(f); }
    }, true);
    // The exact sequence the `dropFile` verb builds — a JS-constructed File on a DataTransfer,
    // dispatched as dragenter → dragover → drop. (The verb also animates a file-ghost + cursor; the
    // mechanics proven here are what the builder's own drop handler reads. End-to-end builder drop
    // is exercised by examples/builder-drop-demo.html.)
    return new Promise(function (resolve) {
      const dt = new DataTransfer();
      dt.items.add(new File(['a,b\n1,2\n'], 'probe.csv', { type: 'text/csv' }));
      ['dragenter', 'dragover', 'drop'].forEach(function (t) {
        zone.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
      });
      setTimeout(function () { resolve(seen); }, 100);
    });
  });
  check('dropFile mechanics: the drop handler receives a readable File with the given name', dropped.name === 'probe.csv', dropped);
  check('dropFile mechanics: the File content is readable', /1,2/.test(dropped.text || ''), dropped.text);

  check('no page errors', errors.length === 0, errors);
  await browser.close();
  if (failures) { console.log('\ndemo gate FAILED: ' + failures); process.exit(1); }
  console.log('\ndemo gate holds');
})().catch(function (e) { console.error(e); process.exit(1); });
