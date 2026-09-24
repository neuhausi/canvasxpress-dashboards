/**
 * Round-trip guarantee for dashboard specs, in a real browser with the real
 * CanvasXpress engine. For every `examples/*.spec.json`:
 *
 *  1. builder round-trip — load the spec into the builder and save with no
 *     edits: `getSpec()` must equal the original (the format stamp aside);
 *  2. file round-trip — migrate + canonical serialize + parse must equal it;
 *
 * and once, on a sample dashboard:
 *
 *  3. edit capture — a customizer-style change (`updateConfig`) must be the
 *     ONLY difference in the saved spec.
 *
 * It loads the library from `src/` (ES modules, no build needed) and
 * CanvasXpress from `CX_LIB_DIR` (a folder with canvasXpress.min.js/.css) or,
 * by default, the canvasxpress.org CDN. Needs `playwright` (resolved normally,
 * or from `PLAYWRIGHT_MODULE`, a path to the package).
 *
 *   npm run test:roundtrip                      # all examples
 *   npm run test:roundtrip -- sales             # examples whose file name contains "sales"
 *
 * Exits 1 on any difference.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');
const CX_LIB_DIR = process.env.CX_LIB_DIR || '';
const CDN = 'https://www.canvasxpress.org/dist';
const EDIT_EXAMPLE = 'quality-metrics.spec.json';

/**
 * Load Playwright's chromium.
 * @returns {object} The chromium launcher.
 */
function loadChromium() {
  try {
    return require(process.env.PLAYWRIGHT_MODULE || 'playwright').chromium;
  } catch (e) {
    console.error('roundtrip: needs playwright — `npm i -D playwright && npx playwright install chromium`,\n' +
      'or set PLAYWRIGHT_MODULE to an installed copy.');
    process.exit(2);
  }
}

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' };

/**
 * Serve the repo (and CX_LIB_DIR under /__cx/) plus the harness page.
 * @returns {Promise<{server: http.Server, base: string}>} The server and its base URL.
 */
function serve() {
  const cxBase = CX_LIB_DIR ? '/__cx' : CDN;
  const page = '<!doctype html><html><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="' + cxBase + '/canvasXpress.css">' +
    '<script src="' + cxBase + '/canvasXpress.min.js"></script>' +
    '<script type="module">import * as CXD from "/src/index.js"; window.CXD = CXD; window.cxdReady = true;</script>' +
    '</head><body style="width:1400px"></body></html>';
  const server = http.createServer(function (req, res) {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/__roundtrip.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(page);
    }
    const file = url.indexOf('/__cx/') === 0
      ? path.join(CX_LIB_DIR, url.slice('/__cx/'.length))
      : path.join(ROOT, url);
    const within = file.indexOf(CX_LIB_DIR && url.indexOf('/__cx/') === 0 ? path.resolve(CX_LIB_DIR) : ROOT) === 0;
    fs.readFile(file, function (err, body) {
      if (err || !within) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

/**
 * Open a fresh harness page.
 * @param {object} browser - Playwright browser.
 * @param {string} base - Server base URL.
 * @returns {Promise<{page: object, errors: string[]}>} The page and its error log.
 */
async function openPage(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await page.goto(base + '/__roundtrip.html');
  await page.waitForFunction(function () { return window.cxdReady && window.CanvasXpress; }, null, { timeout: 30000 });
  return { page: page, errors: errors };
}

(async function main() {
  const chromium = loadChromium();
  const filter = process.argv[2] || '';
  const files = fs.readdirSync(EXAMPLES).filter(function (f) { return /\.spec\.json$/.test(f) && f.indexOf(filter) !== -1; }).sort();
  const { server, base } = await serve();
  const browser = await chromium.launch();
  let failures = 0;
  try {
    for (const file of files) {
      const spec = JSON.parse(fs.readFileSync(path.join(EXAMPLES, file), 'utf8'));
      const { page } = await openPage(browser, base);
      const result = await page.evaluate(async function (spec) {
        const CXD = window.CXD;
        const host = document.createElement('div');
        document.body.appendChild(host);
        const builder = CXD.createBuilder(host, { spec: spec, CanvasXpress: window.CanvasXpress });
        await builder.whenReady();
        // Save the way a person would: a moment after the charts settle (the
        // engine attaches getConfig() asynchronously, after the render).
        await new Promise(function (r) { setTimeout(r, 1500); });
        const saved = builder.getSpec();
        const file = JSON.parse(CXD.serializeSpec(CXD.migrateSpec(spec).spec));
        return {
          builder: CXD.dashboardDiff(spec, saved).summary,
          stamped: saved.schemaVersion === CXD.DASHBOARD_SCHEMA_VERSION,
          file: CXD.dashboardDiff(spec, file).summary
        };
      }, spec);
      await page.close();
      const problems = [];
      if (result.builder.length) problems.push('builder round-trip changed the spec:\n      ' + result.builder.slice(0, 10).join('\n      '));
      if (!result.stamped) problems.push('saved spec is not stamped with the current format version');
      if (result.file.length) problems.push('file round-trip changed the spec:\n      ' + result.file.slice(0, 10).join('\n      '));
      console.log((problems.length ? 'FAIL ' : 'ok   ') + file + (problems.length ? '\n    ' + problems.join('\n    ') : ''));
      failures += problems.length ? 1 : 0;
    }

    if (!filter || EDIT_EXAMPLE.indexOf(filter) !== -1) {
      const spec = JSON.parse(fs.readFileSync(path.join(EXAMPLES, EDIT_EXAMPLE), 'utf8'));
      const { page } = await openPage(browser, base);
      const edit = await page.evaluate(async function (spec) {
        const CXD = window.CXD;
        const host = document.createElement('div');
        document.body.appendChild(host);
        const builder = CXD.createBuilder(host, { spec: spec, CanvasXpress: window.CanvasXpress });
        await builder.whenReady();
        const panelId = Object.keys(spec.panels).filter(function (id) { return !spec.panels[id].type; })[0];
        const inst = window.CanvasXpress.instances.filter(function (i) { return i.target.indexOf('-panel-' + panelId + '-') !== -1; })[0];
        const before = spec.panels[panelId].config.graphType;
        const next = before === 'Area' ? 'Line' : 'Area';
        inst.updateConfig({ graphType: next });
        await new Promise(function (r) { setTimeout(r, 500); });
        return { panelId: panelId, next: next, diff: CXD.dashboardDiff(spec, builder.getSpec()) };
      }, spec);
      await page.close();
      const expected = 'panels.' + edit.panelId + '.config.graphType';
      const ok = edit.diff.changed.length === 1 && edit.diff.changed[0] === expected &&
        !edit.diff.added.length && !edit.diff.removed.length;
      console.log((ok ? 'ok   ' : 'FAIL ') + 'edit capture (' + EDIT_EXAMPLE + ': graphType -> ' + edit.next + ')' +
        (ok ? '' : '\n    ' + edit.diff.summary.join('\n    ')));
      failures += ok ? 0 : 1;
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? failures + ' round-trip failure(s)' : 'round-trip guarantee holds');
  process.exit(failures ? 1 : 0);
})();
