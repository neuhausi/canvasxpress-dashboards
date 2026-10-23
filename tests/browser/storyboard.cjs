/*
 * Storyboard browser gate: a real cohort dashboard (the wizard's own template) with a storyboard,
 * rendered by the real engine, stepped through the player bar.
 *
 *  - the player mounts above the board and leaves the dashboard alone until used;
 *  - Next applies a filter scheme (state + the panels really re-filter), then a case parameter and
 *    focus (the case card shows that patient); Previous goes back to a state with no filter and the
 *    default case — steps are absolute;
 *  - Play advances on its own and stops on the last step;
 *  - no page errors, no stuck loader.
 *
 * Run: PLAYWRIGHT_MODULE=… node tests/browser/storyboard.cjs   (CX_ENGINE_BUILT=1 for the built engine;
 * CXD_SHOT_DIR=dir to keep screenshots).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch (e) {
  console.log('storyboard: needs playwright — set PLAYWRIGHT_MODULE to an installed copy.');
  process.exit(2);
}

const ENGINE_DIR = process.env.CX_ENGINE_DIR || path.join(os.homedir(), 'git', 'canvas-ai', 'build');
const SHOTS = process.env.CXD_SHOT_DIR || '';
const UMD = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'canvasxpress-dashboards.umd.js'), 'utf8');
const engine = require('./engine-route.cjs');

function cohort() {
  const smps = [], os_months = [], os_event = [], age = [], CD274 = [], arm = [], stage = [];
  for (let i = 0; i < 40; i++) {
    smps.push('P' + String(i + 1).padStart(3, '0'));
    os_months.push(3 + (i * 7) % 40); os_event.push(i % 3 === 0 ? 0 : 1); age.push(40 + (i * 5) % 35);
    CD274.push(+(2 + (i * 3) % 9).toFixed(1)); arm.push(i % 2 ? 'Drug' : 'Placebo'); stage.push(['I', 'II', 'III'][i % 3]);
  }
  return { y: { vars: ['os_months', 'os_event', 'age', 'CD274'], smps: smps, data: [os_months, os_event, age, CD274] },
    x: { arm: arm, stage: stage } };
}

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://www.canvasxpress.org/dist/canvasXpress.css">' +
  '<script src="https://www.canvasxpress.org/dist/canvasXpress.min.js"></script></head><body><div id="dash"></div>' +
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
  await engine.routeEngine(page);
  await page.route('http://cxd.test/', function (route) { route.fulfill({ body: PAGE, contentType: 'text/html' }); });
  await page.goto('http://cxd.test/');
  await page.waitForFunction('window.CanvasXpress && window.CanvasXpressDashboards');

  const first = await page.evaluate(async function (data) {
    const D = window.CanvasXpressDashboards;
    const suggestion = D.suggestDashboard(data);
    const spec = D.dashboardSpec(suggestion, { id: 'sb', title: 'Cohort', source: { kind: 'inline', value: data } });
    spec.filterSchemes = { 'Drug arm': [{ dataRef: 'data', field: 'arm', values: ['Drug'] }] };
    spec.storyboard = { title: 'Cohort tour', seconds: 1.5, steps: [
      { title: 'The whole cohort', narration: 'Forty patients, two arms.' },
      { title: 'Drug arm only', narration: 'Filtering to the drug arm.', scheme: 'Drug arm' },
      { title: 'One patient', narration: 'Patient P007 on the case card.', params: { 'case': 'P007' }, focus: 'case', seconds: 1 }
    ] };
    const v = D.validateSpec(spec);
    window.__handle = await D.renderDashboard(spec, document.getElementById('dash'), { baseUrl: '' });
    await window.__handle.ready;
    window.__player = D.mountStoryboard({ spec: spec, handle: window.__handle, container: document.getElementById('dash') });
    return { errors: v.errors, panels: Object.keys(spec.panels) };
  }, cohort());
  check('the spec with a storyboard validates', first.errors.length === 0, first.errors);
  await page.waitForTimeout(1500);

  const state = function () {
    return page.evaluate(function () {
      const bar = document.querySelector('.cxd-storyboard');
      // The case card: the panel titled "Patient record" (climb from its heading to the cell holding the table).
      let card = Array.prototype.filter.call(document.querySelectorAll('*'), function (n) {
        return n.children.length === 0 && /^Patient record/.test(n.textContent || '');
      })[0];
      while (card && !/os_months/.test(card.textContent)) card = card.parentElement;
      return {
        mounted: !!bar,
        firstChild: !!bar && document.getElementById('dash').firstChild === bar,
        title: bar && bar.querySelector('.cxd-sb-title').textContent,
        count: bar && bar.querySelector('.cxd-sb-count').textContent,
        text: bar && bar.querySelector('.cxd-sb-text').textContent,
        filter: window.__handle.getFilterState(),
        params: window.__handle.getParams(),
        loaders: Array.prototype.filter.call(document.querySelectorAll('.cX-Loader'), function (n) { return n.offsetParent !== null; }).length,
        cardText: card ? card.textContent : ''
      };
    });
  };
  const shot = async function (name) { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'storyboard-' + name + '.png') }); };

  let s = await state();
  check('the player is mounted above the board, before any step', s.mounted && s.firstChild && s.count === '3 steps' && s.title === 'Cohort tour', s);
  check('the dashboard is untouched before the viewer acts', s.filter.length === 0 && s.params['case'] === 'P001', s.params);
  await shot('0-mounted');

  await page.click('.cxd-sb-btn[title="Next step"]');
  await page.waitForTimeout(800);
  s = await state();
  check('Next shows step 1 (title + narration)', s.title === 'The whole cohort' && s.text === 'Forty patients, two arms.', s);

  await page.click('.cxd-sb-btn[title="Next step"]');
  await page.waitForTimeout(1200);
  s = await state();
  check('step 2 applies the Drug arm scheme', s.title === 'Drug arm only' && s.filter.length === 1 && s.filter[0].field === 'arm' &&
    s.filter[0].values[0] === 'Drug', s.filter);
  await shot('2-drug-arm');

  await page.click('.cxd-sb-btn[title="Next step"]');
  await page.waitForTimeout(1500);
  s = await state();
  check('step 3 clears the filter, loads the case and shows it on the card', s.title === 'One patient' && s.filter.length === 0 &&
    s.params['case'] === 'P007' && /P007/.test(s.cardText) && s.loaders === 0, { filter: s.filter, params: s.params, loaders: s.loaders, card: s.cardText.slice(0, 80) });
  await shot('3-case');

  await page.click('.cxd-sb-btn[title="Previous step"]');
  await page.waitForTimeout(1200);
  s = await state();
  check('Previous returns to the Drug-arm state with the default case', s.title === 'Drug arm only' && s.filter.length === 1 &&
    s.params['case'] === 'P001', { filter: s.filter, params: s.params });

  await page.click('.cxd-sb-dot >> nth=0');
  await page.waitForTimeout(1200);
  s = await state();
  check('the first dot goes back to the whole cohort', s.title === 'The whole cohort' && s.filter.length === 0 && s.params['case'] === 'P001', s);

  await page.click('.cxd-sb-play');
  await page.waitForFunction('document.querySelector(".cxd-sb-count").textContent === "3 / 3"', null, { timeout: 15000 }).catch(function () {});
  await page.waitForTimeout(1800);
  s = await state();
  const playLabel = await page.textContent('.cxd-sb-play');
  check('Play walks to the last step on its own and stops there', s.count === '3 / 3' && s.params['case'] === 'P007' && playLabel === '▶', { count: s.count, playLabel });

  check('no page errors', errors.length === 0, errors);
  await browser.close();
  if (failures) { console.log('\nstoryboard gate FAILED: ' + failures); process.exit(1); }
  console.log('\nstoryboard gate holds');
})().catch(function (e) { console.error(e); process.exit(1); });
