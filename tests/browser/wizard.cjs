/*
 * Data-first wizard browser gate (Datawrapper-parity P9).
 *
 * Drives the real app shell against a throwaway server (wizard-server.py,
 * port 8899): sign up, open the wizard, paste a CSV (parsed by the CanvasXpress
 * engine's loadFile), check the column profile flags the bad cell, take the
 * chart suggestion (the /api/wizard/suggest response is stubbed — the server
 * side is covered by server/tests/test_wizard.py), publish, and verify the
 * published one-chart dashboard over the public share API.
 * The engine is routed to the local canvas-ai build so the test runs offline.
 *
 * Run: CXD_PYTHON=… PLAYWRIGHT_MODULE=… node tests/browser/wizard.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch (e) {
  console.log('wizard: needs playwright — set PLAYWRIGHT_MODULE to an installed copy.');
  process.exit(2);
}

const PORT = 8899;
const BASE = 'http://127.0.0.1:' + PORT;
const PYTHON = process.env.CXD_PYTHON || 'python3';
const ENGINE_DIR = process.env.CX_ENGINE_DIR || path.join(os.homedir(), 'git', 'canvas-ai', 'build');
const CSV = 'Country,Region,GDP,LifeExp\nUSA,Americas,65000,79\nJapan,Asia,42000,84\nIndia,Asia,2100,70\nNigeria,Africa,oops,55\n';

function startServer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cxd-wizard-'));
  const proc = spawn(PYTHON, [path.join(__dirname, 'wizard-server.py'), String(PORT), tmp],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(function (resolve, reject) {
    proc.stdout.once('data', function () {
      const until = Date.now() + 15000;
      (function poll() {
        fetch(BASE + '/auth/me').then(function () { resolve(proc); },
          function () { Date.now() < until ? setTimeout(poll, 200) : reject(new Error('server did not start')); });
      })();
    });
    proc.on('exit', function (code) { reject(new Error('server exited ' + code)); });
  });
}

let serverProc = null;
process.on('exit', function () { if (serverProc) { try { serverProc.kill(); } catch (e) { /* gone */ } } });
(async function main() {
  const proc = await startServer();
  serverProc = proc;
  let failures = 0;
  function check(name, ok, detail) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
    if (!ok) failures++;
  }
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', function (e) { console.log('PAGEERROR', e.message); });
    await page.route('https://www.canvasxpress.org/dist/canvasXpress.min.js', function (route) {
      route.fulfill({ path: path.join(ENGINE_DIR, 'js', 'canvasXpress.min.js'), contentType: 'text/javascript' });
    });
    await page.route('https://www.canvasxpress.org/dist/canvasXpress.css', function (route) {
      route.fulfill({ path: path.join(ENGINE_DIR, 'css', 'canvasXpress.min.css'), contentType: 'text/css' });
    });
    let suggestBody = null;
    await page.route(BASE + '/api/wizard/suggest', function (route) {
      suggestBody = JSON.parse(route.request().postData() || '{}');
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        source: 'mcp',
        suggestions: [
          { graphType: 'Scatter2D', score: 0.9, reason: 'Two measures against each other.',
            config: { graphType: 'Scatter2D', xAxis: ['GDP'], yAxis: ['LifeExp'] } },
          { graphType: 'Bar', score: 0.7, reason: 'Compare across categories.', config: { graphType: 'Bar' } }
        ] }) });
    });
    await page.goto(BASE + '/');
    await page.waitForFunction('typeof window.showWizard === "function" && !!window.CanvasXpress', null, { timeout: 30000 });
    const signup = await page.evaluate(function () {
      return fetch('/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'wiz', password: 'secret1' }) }).then(function (r) { return r.status; });
    });
    check('signed up', signup === 200, 'status ' + signup);
    await page.evaluate(function () { return refreshUser().then(function () { showWizard(); }); });

    // 1 Upload: paste a CSV
    await page.fill('.cX-Modal textarea', CSV);
    await page.fill('.cX-Modal input[type=text]', 'Wealth and health');
    await page.click('.cX-Modal button:has-text("Next: check data")');
    // 2 Check: profile table drawn from the engine-parsed data
    await page.waitForSelector('.cxd-wizard-profile', { timeout: 20000 });
    const profile = await page.$$eval('.cxd-wizard-profile tbody tr', function (rows) {
      return rows.map(function (r) { return Array.prototype.map.call(r.children, function (c) { return c.textContent; }); });
    });
    const gdp = profile.filter(function (r) { return r[0] === 'GDP'; })[0];
    check('engine parse → profile lists columns', profile.length >= 3, JSON.stringify(profile.map(function (r) { return r[0]; })));
    check('bad cell flagged in GDP', gdp && gdp[1] === 'numeric' && /^1 /.test(gdp[3]), JSON.stringify(gdp));
    await page.click('.cX-Modal button:has-text("Next: pick a chart")');
    // 3 Visualize: suggestions rendered as live previews
    await page.waitForSelector('.cxd-wizard-card canvas', { timeout: 20000 });
    const cards = await page.$$eval('.cxd-wizard-card', function (els) {
      return els.map(function (e) { return { text: e.textContent, chosen: e.className.indexOf('--chosen') > -1, canvases: e.querySelectorAll('canvas').length }; });
    });
    check('suggest called with the table', suggestBody && suggestBody.rows && suggestBody.rows[0].indexOf('GDP') > -1,
      suggestBody ? JSON.stringify(suggestBody.rows[0]) : 'not called');
    check('two suggestion cards with previews', cards.length === 2 && cards.every(function (c) { return c.canvases > 0; }));
    check('top suggestion preselected', cards[0] && cards[0].chosen);
    await page.click('.cX-Modal button:has-text("Next: publish")');
    // 4 Publish
    await page.click('.cX-Modal button:has-text("Save & publish")');
    await page.waitForFunction(function () {
      return Array.prototype.some.call(document.querySelectorAll('.cX-Modal .cxd-wizard-note'),
        function (n) { return /Published\.|not published/.test(n.textContent); });
    }, null, { timeout: 30000 });
    const shareUrl = await page.$eval('.cX-Modal .cxd-wizard-field input[readonly]', function (i) { return i.value; });
    const token = (/token=([^&]+)/.exec(shareUrl) || [])[1];
    check('share link shown', !!token, shareUrl);
    await page.waitForSelector('.cxd-embed-codes textarea', { timeout: 20000 });
    check('embed codes shown', (await page.$$('.cxd-embed-codes textarea')).length === 3);
    // Verify what was published, through the public API
    const shared = await (await fetch(BASE + '/api/shared/' + token)).json();
    const spec = shared.spec || {};
    const panels = Object.keys(spec.panels || {});
    check('published one chart', panels.length === 1, JSON.stringify(panels));
    check('chart uses the suggestion', panels.length && spec.panels[panels[0]].config.graphType === 'Scatter2D');
    check('editorial theme preselected', spec.theme === 'editorial', spec.theme);
    const source = (spec.data || {})[spec.panels[panels[0]].dataRef] || {};
    check('data stored and inlined for viewers', source.kind === 'inline' && source.value, JSON.stringify(source).slice(0, 80));
  } finally {
    await browser.close();
    proc.kill();
  }
  console.log(failures ? failures + ' check(s) failed' : 'wizard gate holds');
  process.exit(failures ? 1 : 0);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
