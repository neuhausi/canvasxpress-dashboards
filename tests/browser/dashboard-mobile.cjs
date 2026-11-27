/**
 * Mobile layout gate (mobile-experience-plan P3).
 *
 * Loads a multi-panel dashboard with a Filters panel at a 390px phone viewport
 * (touch emulation) from src/ (no build needed) with the engine routed to the
 * sibling canvas-ai checkout, and asserts the mobile ergonomics the plan calls
 * for:
 *   - every interactive control in the filters bar is a >=44px touch target;
 *   - the filters bar does not overflow horizontally (scrollWidth<=clientWidth);
 *   - the grid stacked (container carries .cxd-stacked at this width);
 *   - chart-panel canvases set touch-action:none (in-panel pinch/pan does not
 *     scroll the page).
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser/dashboard-mobile.cjs
 *   (env: CX_ENGINE_DIR default ../canvas-ai)
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ENGINE = path.resolve(process.env.CX_ENGINE_DIR || path.join(ROOT, '..', 'canvas-ai'));
const EXAMPLES = path.join(ROOT, 'examples');
const SPEC = process.argv.slice(2).filter(function (a) { return a.indexOf('--') !== 0; })[0] || 'cohort-explorer';
const VIEWPORT = { width: 390, height: 800 };

function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright',
    path.join(ENGINE, 'tests', 'node_modules', 'playwright')].filter(Boolean);
  for (let i = 0; i < candidates.length; i++) {
    try { return require(candidates[i]).chromium; } catch (e) { /* next */ }
  }
  console.error('dashboard-mobile: needs playwright (set PLAYWRIGHT_MODULE).');
  process.exit(2);
}

function engineCss() {
  const dir = path.join(ENGINE, 'build', 'css', 'widgets');
  return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.css'); }).sort()
    .map(function (f) { return fs.readFileSync(path.join(dir, f), 'utf8'); }).join('');
}

function engineJs() {
  const harness = path.join(ENGINE, 'tests', 'regression', 'render-harness.html');
  if (fs.existsSync(harness)) {
    const list = fs.readFileSync(harness, 'utf8').match(/CX_FILES\s*=\s*\[([\s\S]*?)\]/);
    const files = list ? list[1].match(/canvasXpress\.[\w]+\.js/g) : null;
    if (files && files.length) {
      return files.map(function (f) {
        return fs.readFileSync(path.join(ENGINE, 'build', 'js', f), 'utf8');
      }).join('\n;\n');
    }
  }
  return fs.readFileSync(path.join(ENGINE, 'build', 'js', 'canvasXpress.min.js'), 'utf8');
}

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.html': 'text/html' };

function serve() {
  const harness = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<link rel="stylesheet" href="https://www.canvasxpress.org/dist/canvasXpress.css">' +
    '<script src="https://www.canvasxpress.org/dist/canvasXpress.min.js"></script>' +
    '<script type="module">import * as CXD from "/src/index.js"; window.CXD = CXD; window.cxdReady = true;</script>' +
    '<style>html,body{margin:0}#host{width:100%}</style>' +
    '</head><body><div id="host"></div></body></html>';
  const server = http.createServer(function (req, res) {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/__mobile.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(harness);
    }
    const file = path.join(ROOT, url);
    if (file.indexOf(ROOT) !== 0) { res.writeHead(404); return res.end(); }
    fs.readFile(file, function (err, body) {
      if (err) { res.writeHead(404); return res.end(); }
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

(async function main() {
  const chromium = loadChromium();
  const css = engineCss();
  const js = engineJs();
  const { server, base } = await serve();
  const browser = await chromium.launch();
  let failures = 0;
  function check(name, ok, detail) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
    if (!ok) failures++;
  }
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.route('**/*', function (route) {
      const url = route.request().url();
      if (/canvasxpress\.org\/dist\/canvasXpress\.css/.test(url)) return route.fulfill({ contentType: 'text/css', body: css });
      if (/canvasxpress\.org\/dist\/canvasXpress\.min\.js/.test(url)) return route.fulfill({ contentType: 'text/javascript', body: js });
      if (url.indexOf(base) === 0 || url.indexOf('data:') === 0) return route.continue();
      return route.abort();
    });
    await page.goto(base + '/__mobile.html');
    await page.waitForFunction(function () { return window.cxdReady && window.CanvasXpress; }, null, { timeout: 30000 });
    const spec = JSON.parse(fs.readFileSync(path.join(EXAMPLES, SPEC + '.spec.json'), 'utf8'));
    await page.evaluate(async function (s) {
      const d = window.CXD.renderDashboard(s, document.getElementById('host'), { CanvasXpress: window.CanvasXpress });
      await d.ready;
    }, spec);
    await page.waitForTimeout(1500);

    const out = await page.evaluate(function () {
      function visible(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
      var controls = Array.prototype.slice.call(document.querySelectorAll(
        '.cxd-filters-bar select, .cxd-filters-bar button, .cxd-filters-bar input:not([type=checkbox]):not([type=radio])'
      )).filter(visible);
      var small = controls.filter(function (c) { return Math.round(c.getBoundingClientRect().height) < 44; })
        .map(function (c) { return (c.className || c.tagName) + ':' + Math.round(c.getBoundingClientRect().height); });
      var bars = Array.prototype.slice.call(document.querySelectorAll('.cxd-filters-bar'));
      var overflow = bars.filter(function (b) { return b.scrollWidth > b.clientWidth + 1; }).length;
      var dash = document.querySelector('.cxd-dashboard');
      var canvases = Array.prototype.slice.call(document.querySelectorAll('.cxd-panel canvas'));
      var nonNone = canvases.filter(function (c) {
        return getComputedStyle(c).touchAction !== 'none';
      }).length;
      var pageOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
      return {
        controls: controls.length,
        small: small,
        overflowBars: overflow,
        stacked: !!(dash && dash.classList.contains('cxd-stacked')),
        canvases: canvases.length,
        canvasNonNone: nonNone,
        pageOverflow: pageOverflow
      };
    });

    check('filters-bar controls measured', out.controls >= 1, out.controls + ' controls');
    check('every filters-bar control >=44px', out.small.length === 0, out.small.join(', '));
    check('filters bar does not overflow', out.overflowBars === 0, out.overflowBars + ' overflowing');
    check('grid is stacked at 390px', out.stacked === true);
    check('panel canvases are touch-action:none', out.canvases >= 1 && out.canvasNonNone === 0,
      out.canvasNonNone + ' of ' + out.canvases + ' not none');
    check('no horizontal page overflow at 390px', out.pageOverflow === false);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? failures + ' check(s) failed' : 'dashboard-mobile gate holds');
  process.exit(failures ? 1 : 0);
})().catch(function (err) { console.error(err); process.exit(1); });
