/*
 * Publish & embed browser gate (Datawrapper-parity P8).
 *
 * Starts a throwaway server (embed-server.py, port 8899) holding one published
 * two-panel dashboard, then loads a host page from another origin with BOTH
 * embed codes — the auto-resizing <iframe> snippet for panel "tall" and the
 * <cxd-embed> web component for panel "short" — and asserts:
 *   - each iframe grows/shrinks from its initial height to its own content
 *     height (postMessage resize, matched by event.source, no cross-talk);
 *   - each embed renders exactly one panel (?panel= pruning).
 * The CanvasXpress engine is routed to the local canvas-ai build so the test
 * runs offline.
 *
 * Run: PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser/embed.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch (e) {
  console.log('embed: needs playwright — set PLAYWRIGHT_MODULE to an installed copy.');
  process.exit(2);
}

const PORT = 8899;
const HOST_PORT = 8898;
let hostServer = null;
const BASE = 'http://127.0.0.1:' + PORT;
const PYTHON = process.env.CXD_PYTHON || 'python3';
const ENGINE_DIR = process.env.CX_ENGINE_DIR || path.join(os.homedir(), 'git', 'canvas-ai', 'build');
const INITIAL = 200;

function startServer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cxd-embed-'));
  const proc = spawn(PYTHON, [path.join(__dirname, 'embed-server.py'), String(PORT), tmp],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(function (resolve, reject) {
    let buf = '';
    proc.stdout.on('data', function (chunk) {
      buf += chunk;
      const line = buf.split('\n')[0];
      if (line.trim().startsWith('{')) {
        const token = JSON.parse(line).token;
        // wait for uvicorn to accept connections
        const until = Date.now() + 15000;
        (function poll() {
          fetch(BASE + '/embed.js').then(function () { resolve({ proc: proc, token: token }); },
            function () { Date.now() < until ? setTimeout(poll, 200) : reject(new Error('server did not start')); });
        })();
      }
    });
    proc.on('exit', function (code) { reject(new Error('server exited ' + code)); });
  });
}

(async function main() {
  const { proc, token } = await startServer();
  let failures = 0;
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await page.route('https://www.canvasxpress.org/dist/canvasXpress.min.js', function (route) {
      route.fulfill({ path: path.join(ENGINE_DIR, 'js', 'canvasXpress.min.js'), contentType: 'text/javascript' });
    });
    await page.route('https://www.canvasxpress.org/dist/canvasXpress.css', function (route) {
      route.fulfill({ path: path.join(ENGINE_DIR, 'css', 'canvasXpress.min.css'), contentType: 'text/css' });
    });
    // The server's own embed codes, exactly as a user would copy them.
    const tall = (await (await fetch(BASE + '/api/shared/' + token + '/embed?panel=tall&height=' + INITIAL)).json()).embed;
    const short = (await (await fetch(BASE + '/api/shared/' + token + '/embed?panel=short&height=' + INITIAL)).json()).embed;
    const host = '<!doctype html><html><body style="margin:0">' +
      '<div id="a" style="width:700px">' + tall.iframe + '</div>' +
      '<div id="b" style="width:700px">' + short.script.replace('<cxd-embed ', '<cxd-embed height="' + INITIAL + '" ') + '</div>' +
      '</body></html>';
    // Serve the host page from a real local server on ANOTHER port, i.e. a
    // different origin than the embed server. Both stay in the local address
    // space: Chromium's Local Network Access check blocks a public (or
    // route-fulfilled) origin from framing 127.0.0.1, which a real public
    // deployment never hits.
    hostServer = http.createServer(function (req, res) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(host);
    });
    await new Promise(function (resolve) { hostServer.listen(HOST_PORT, '127.0.0.1', resolve); });
    await page.goto('http://127.0.0.1:' + HOST_PORT + '/');

    async function frameHeight(sel) {
      return page.evaluate(function (s) {
        const f = document.querySelector(s);
        return f ? Math.round(f.getBoundingClientRect().height) : -1;
      }, sel);
    }
    // Wait until both frames have reported (height changed from the initial value)
    await page.waitForFunction(function (initial) {
      const frames = document.querySelectorAll('iframe');
      if (frames.length !== 2) return false;
      return Array.prototype.every.call(frames, function (f) {
        return Math.round(f.getBoundingClientRect().height) !== initial;
      });
    }, INITIAL, { timeout: 30000 });
    await page.waitForTimeout(1200); // let the last resize settle

    const hA = await frameHeight('#a iframe');
    const hB = await frameHeight('#b iframe');
    const content = [];
    for (const f of page.frames().slice(1)) {
      content.push(await f.evaluate(function () {
        return {
          height: Math.ceil(document.documentElement.getBoundingClientRect().height),
          panels: document.querySelectorAll('canvas').length,
          url: location.search
        };
      }));
    }
    const byPanel = {};
    content.forEach(function (c) { byPanel[/panel=([^&]+)/.exec(c.url)[1]] = c; });

    function check(name, ok, detail) {
      console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
      if (!ok) failures++;
    }
    check('iframe snippet resized to content', hA === byPanel.tall.height, 'frame ' + hA + ' vs content ' + byPanel.tall.height);
    check('<cxd-embed> resized to content', hB === byPanel.short.height, 'frame ' + hB + ' vs content ' + byPanel.short.height);
    check('no cross-talk between embeds', hA !== hB, hA + ' vs ' + hB);
    check('taller panel gives taller embed', hA > hB, hA + ' > ' + hB);
    check('iframe embed renders one chart', byPanel.tall.panels >= 1);
    check('cxd-embed renders one chart', byPanel.short.panels >= 1);
  } finally {
    await browser.close();
    if (hostServer) hostServer.close();
    proc.kill();
  }
  console.log(failures ? failures + ' check(s) failed' : 'embed gate holds');
  process.exit(failures ? 1 : 0);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
