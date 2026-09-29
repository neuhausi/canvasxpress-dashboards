/**
 * Widget-chrome gate for the dashboards UI: every view's look, pinned against the shared
 * CanvasXpress design tokens.
 *
 * Opens every dashboards UI surface we can reach without a server -- the viewer (filters panel,
 * annotation controls, code dialog), the builder (toolbar, selected cell, every builder modal),
 * the gallery, an example page and the app shell's login view -- in light AND dark colour
 * schemes, and compares two snapshots per case against tests/browser/ui-chrome-snapshots/:
 *
 *   <case>.<scheme>.styles.txt  exact computed-style fingerprint of every rendered element except
 *                               chart canvases (colour, border, radius, shadow, font, padding,
 *                               z-index, rounded box). Keep fingerprint() in sync with
 *                               canvas-ai/tests/regression/ui-chrome.spec.js.
 *   <case>.<scheme>.png         viewport screenshot (<= MAX_DIFF_PIXELS differing; canvases hidden)
 *
 * The engine comes from the sibling canvas-ai checkout, NOT the CDN, so the gate is
 * deterministic and an engine edit shows up here too: canvasXpress.css is served as
 * build/css/widgets/*.css concatenated in name order (what build.py's collate step writes), and
 * canvasXpress.min.js as the engine SOURCE files in render-harness order (CX_ENGINE_BUILT=1:
 * the built build/js/canvasXpress.min.js). Every other external request is blocked.
 *
 * Library cases load src/ (no build needed). Page cases (gallery, example page, app shell) load
 * dist/canvasxpress-dashboards.umd.js, so run `npm run build` first when src changed.
 *
 *   node tests/browser/ui-chrome.cjs              # gate: exit 1 on any difference
 *   node tests/browser/ui-chrome.cjs --update     # re-baseline (deliberate only)
 *   node tests/browser/ui-chrome.cjs builder      # cases whose name contains "builder"
 *
 * Env: CX_ENGINE_DIR (default ../canvas-ai), PLAYWRIGHT_MODULE (path to playwright if not
 * resolvable).
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ENGINE = path.resolve(process.env.CX_ENGINE_DIR || path.join(ROOT, '..', 'canvas-ai'));
const SNAP_DIR = path.join(__dirname, 'ui-chrome-snapshots');
const OUT_DIR = path.join(__dirname, 'ui-chrome-results');
const EXAMPLES = path.join(ROOT, 'examples');
const UPDATE = process.argv.indexOf('--update') !== -1;
const FILTER = process.argv.slice(2).filter(function (a) { return a.indexOf('--') !== 0; })[0] || '';
const SCHEMES = ['light', 'dark'];
// Page cases (gallery, example page, app shell) load the UMD bundle. Serve one built from src/
// NOW (scripts/build.mjs with CXD_BUILD_OUT, which leaves dist/ and server/static untouched), so
// the gate tests the source like the library cases do. CX_DASH_DIST=1: use the committed dist/.
const os = require('os');
const cp = require('child_process');
function buildBundle() {
  if (process.env.CX_DASH_DIST === '1') {
    return path.join(ROOT, 'dist', 'canvasxpress-dashboards.umd.js');
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cxd-ui-'));
  cp.execFileSync('node', [path.join(ROOT, 'scripts', 'build.mjs')],
    { env: Object.assign({}, process.env, { CXD_BUILD_OUT: out }), stdio: 'ignore' });
  return path.join(out, 'canvasxpress-dashboards.umd.js');
}
const BUNDLE = buildBundle();
const SHELL_FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'ui-chrome-shell-fixtures.json'), 'utf8'));
const VIEWPORT = { width: 1400, height: 900 };

function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright',
    path.join(ENGINE, 'tests', 'node_modules', 'playwright'),
    path.join(ROOT, '..', 'canvas-ai', 'tests', 'node_modules', 'playwright')].filter(Boolean);
  for (let i = 0; i < candidates.length; i++) {
    try {
      return require(candidates[i]).chromium;
    } catch (e) { /* try the next */ }
  }
  console.error('ui-chrome: needs playwright (npm i -D playwright, or set PLAYWRIGHT_MODULE).');
  process.exit(2);
}

function engineCss() {
  const dir = path.join(ENGINE, 'build', 'css', 'widgets');
  return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.css'); }).sort()
    .map(function (f) { return fs.readFileSync(path.join(dir, f), 'utf8'); }).join('');
}

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** Serve the repo root plus a library harness page. */
function serve() {
  const harness = '<!doctype html><html><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="https://www.canvasxpress.org/dist/canvasXpress.css">' +
    '<script src="https://www.canvasxpress.org/dist/canvasXpress.min.js"></script>' +
    '<script type="module">import * as CXD from "/src/index.js"; window.CXD = CXD; window.cxdReady = true;</script>' +
    '<style>body{margin:0;font-family:system-ui,sans-serif}</style>' +
    '</head><body><div id="host" style="width:1360px;margin:20px"></div></body></html>';
  const server = http.createServer(function (req, res) {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/__ui-chrome.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(harness);
    }
    // Every page loads the UMD bundle (the app shell relative to itself, the others from ../dist):
    // serve the one built from src/ for this run.
    const file = /canvasxpress-dashboards\.umd\.js$/.test(url) ? BUNDLE : path.join(ROOT, url);
    if (file === BUNDLE) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(fs.readFileSync(BUNDLE));
    }
    if (file.indexOf(ROOT) !== 0) {
      res.writeHead(404);
      return res.end();
    }
    fs.readFile(file, function (err, body) {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
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
 * The engine JS. Default: the engine SOURCE files, concatenated in the order the engine's own
 * render harness loads them (tests/regression/render-harness.html CX_FILES), so an engine JS
 * edit is tested here without a build -- the same promise the engine gates make. CX_ENGINE_BUILT=1
 * uses the built build/js/canvasXpress.min.js instead (what a release ships).
 */
function engineJs() {
  const harness = path.join(ENGINE, 'tests', 'regression', 'render-harness.html');
  if (process.env.CX_ENGINE_BUILT !== '1' && fs.existsSync(harness)) {
    const list = fs.readFileSync(harness, 'utf8').match(/CX_FILES\s*=\s*\[([\s\S]*?)\]/);
    const files = list ? list[1].match(/canvasXpress\.[\w]+\.js/g) : null;
    if (files && files.length) {
      return files.map(function (f) {
        return fs.readFileSync(path.join(ENGINE, 'build', 'js', f), 'utf8');
      }).join('\n;\n');
    }
  }
  return fs.readFileSync(path.join(ENGINE, 'build', 'js', 'canvasXpress.min.js'));
}

/** Route the CDN engine to the local checkout and block every other external request. */
async function routeEngine(page, base) {
  const css = engineCss();
  const js = ENGINE_JS;
  await page.route('**/*', function (route) {
    const url = route.request().url();
    if (/canvasxpress\.org\/dist\/canvasXpress\.css/.test(url)) {
      return route.fulfill({ contentType: 'text/css', body: css });
    }
    if (/canvasxpress\.org\/dist\/canvasXpress\.min\.js/.test(url)) {
      return route.fulfill({ contentType: 'text/javascript', body: js });
    }
    if (url.indexOf(base) === 0 || url.indexOf('data:') === 0) {
      return route.continue();
    }
    return route.abort();
  });
}

function spec(name) {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, name + '.spec.json'), 'utf8'));
}

/** Library harness: render a dashboard with renderDashboard(). */
function viewer(specName) {
  return async function (page, base) {
    await page.goto(base + '/__ui-chrome.html');
    await page.waitForFunction(function () { return window.cxdReady && window.CanvasXpress; }, null, { timeout: 30000 });
    await page.evaluate(async function (s) {
      const d = window.CXD.renderDashboard(s, document.getElementById('host'), { CanvasXpress: window.CanvasXpress });
      await d.ready;
    }, spec(specName));
  };
}

/** Library harness: open the builder, optionally click a toolbar button by its label. */
function builder(specName, buttonText) {
  return async function (page, base) {
    await page.goto(base + '/__ui-chrome.html');
    await page.waitForFunction(function () { return window.cxdReady && window.CanvasXpress; }, null, { timeout: 30000 });
    await page.evaluate(async function (s) {
      const b = window.CXD.createBuilder(document.getElementById('host'), { spec: s, CanvasXpress: window.CanvasXpress });
      await b.whenReady();
    }, spec(specName));
    await settle(page);
    if (buttonText) {
      await page.locator('button', { hasText: buttonText }).first().click();
    } else {
      // Select the first cell so the selection chrome (grip, tools, resize handles) shows.
      await page.locator('.cxb-cell').first().click({ position: { x: 30, y: 60 } });
    }
  };
}

/**
 * Answer the app shell's backend calls from ui-chrome-shell-fixtures.json: an exact
 * 'METHOD /path?query' key first, then the longest matching 'METHOD /prefix*' key; anything else
 * gets {}. signedOut overlays the __signedOut set (no session, so protected views show Login).
 */
async function mockApi(page, base, signedOut) {
  const table = Object.assign({}, SHELL_FIXTURES, signedOut ? SHELL_FIXTURES.__signedOut : {});
  const keys = Object.keys(table).filter(function (k) { return /^(GET|POST|PUT|DELETE) \//.test(k); });
  await page.route(function (url) {
    return url.origin === base && /\/(api|auth|connectors)\//.test(url.pathname);
  }, function (route) {
    const req = route.request();
    const u = new URL(req.url());
    // A page served from a subpath (server/.../static/view.html) calls <subpath>/api/...
    const apiPath = u.pathname.slice(u.pathname.search(/\/(api|auth|connectors)\//));
    const want = req.method() + ' ' + apiPath + u.search;
    let body = table[want] !== undefined ? table[want] : table[req.method() + ' ' + apiPath];
    if (body === undefined) {
      const hit = keys.filter(function (k) {
        return k.slice(-1) === '*' && want.indexOf(k.slice(0, -1)) === 0;
      }).sort(function (a, b) { return b.length - a.length; })[0];
      body = hit ? table[hit] : {};
    }
    const status = body && body.__status ? body.__status : 200;
    return route.fulfill({ status: status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

/** Open the app shell (builder.html), signed in as the fixture admin unless signedOut. */
function shell(action, signedOut) {
  return async function (page, base) {
    await mockApi(page, base, signedOut);
    await page.addInitScript(function () {
      try { localStorage.setItem('cxd-admin-tab', 'people'); } catch (e) { /* ignore */ }
    });
    await page.goto(base + '/examples/builder.html');
    await page.waitForFunction(function () { return typeof window.activate === 'function' && document.querySelector('.rail'); },
      null, { timeout: 30000 });
    await settle(page);
    if (action) {
      await action(page);
    }
  };
}
const SCHED = SHELL_FIXTURES['GET /api/schedules*'].schedules[0];

const CASES = [
  { name: 'viewer-filters', open: viewer('cohort-explorer') },
  { name: 'viewer-filters-sales', open: viewer('sales-model') },
  { name: 'viewer-controls', open: viewer('genomics-oncology') },
  { name: 'viewer-code-dialog', open: async function (page, base) {
    await viewer('cohort-explorer')(page, base);
    await settle(page);
    await page.locator('.cxd-code-btn').first().click();
  } },
  { name: 'builder', open: builder('quality-metrics') },
  { name: 'builder-data-modal', open: builder('quality-metrics', '+ Data') },
  { name: 'builder-links-modal', open: builder('quality-metrics', 'Links') },
  { name: 'builder-fields-modal', open: builder('quality-metrics', 'Fields') },
  { name: 'builder-shape-modal', open: builder('quality-metrics', 'Shape data') },
  { name: 'page-gallery', open: async function (page, base) { await page.goto(base + '/examples/index.html'); } },
  { name: 'page-example', open: async function (page, base) { await page.goto(base + '/examples/cohort-explorer.html'); } },
  // The app shell (examples/builder.html == server/static/index.html), every view, with the backend
  // mocked (ui-chrome-shell-fixtures.json). Views are switched with the page's own activate().
  // The shared viewer (both copies: the examples page and the server's share-link page), with its
  // download menu open -- the .cxd-tb-* toolbar CSS both used to carry.
  { name: 'page-view', open: async function (page, base) {
    await mockApi(page, base, false);
    await page.goto(base + '/examples/view.html?id=sales-overview');
    await page.waitForSelector('#cxd-download-btn', { timeout: 30000 });
    await settle(page);
    await page.click('#cxd-download-btn');
  } },
  { name: 'page-view-server', open: async function (page, base) {
    await mockApi(page, base, false);
    await page.goto(base + '/server/src/cxd_server/static/view.html?id=sales-overview');
    await page.waitForSelector('#cxd-download-btn', { timeout: 30000 });
    await settle(page);
    await page.click('#cxd-download-btn');
  } },
  { name: 'shell-home', open: shell(null) },
  { name: 'shell-builder', open: shell(function (p) { return p.evaluate('activate("Builder")'); }) },
  { name: 'shell-dashboards', open: shell(function (p) { return p.evaluate('activate("Dashboards")'); }) },
  { name: 'shell-dashboard-history', open: shell(async function (p) {
    await p.evaluate('activate("Dashboards")');
    await settle(p);
    await p.evaluate('showHistory({ id: "sales-overview", title: "Sales Overview", owner: "alice" })');
  }) },
  { name: 'shell-data', open: shell(function (p) { return p.evaluate('activate("Data")'); }) },
  { name: 'shell-people', open: shell(async function (p) {
    await p.evaluate('activate("Data")');
    await settle(p);
    await p.evaluate('showPeople({ kind: "dataset", id: "regional-sales", title: "Regional Sales", owner: "alice" })');
  }) },
  { name: 'shell-security', open: shell(async function (p) {
    await p.evaluate('activate("Data")');
    await settle(p);
    await p.evaluate('showSecurity({ id: "regional-sales", title: "Regional Sales", owner: "alice" })');
  }) },
  { name: 'shell-schedules', open: shell(function (p) { return p.evaluate('activate("Schedules")'); }) },
  { name: 'shell-schedule-runs', open: shell(async function (p) {
    await p.evaluate('activate("Schedules")');
    await settle(p);
    await p.evaluate(function (sc) { window.showScheduleRuns(sc); }, SCHED);
  }) },
  { name: 'shell-settings', open: shell(function (p) { return p.evaluate('activate("Settings")'); }) },
  { name: 'shell-admin-people', open: shell(function (p) { return p.evaluate('activate("Admin")'); }) },
  { name: 'shell-admin-lineage', open: shell(async function (p) {
    await p.evaluate('activate("Admin")'); await settle(p); await p.click('button.admin-tab[data-tab="lineage"]');
  }) },
  { name: 'shell-admin-examples', open: shell(async function (p) {
    await p.evaluate('activate("Admin")'); await settle(p); await p.click('button.admin-tab[data-tab="examples"]');
  }) },
  { name: 'shell-admin-audit', open: shell(async function (p) {
    await p.evaluate('activate("Admin")'); await settle(p); await p.click('button.admin-tab[data-tab="audit"]');
  }) },
  { name: 'shell-logs', open: shell(function (p) { return p.evaluate('activate("Logs")'); }) },
  { name: 'shell-login', open: shell(function (p) { return p.evaluate('activate("Settings")'); }, true) }
];

/** Wait for engine renders, then for the layout to stop moving (4 quiet polls, cap 6s). */
async function settle(page) {
  await page.waitForTimeout(400);
  await page.evaluate(function () {
    function signature() {
      const all = document.body.querySelectorAll('*');
      const parts = [];
      for (let i = 0; i < all.length; i++) {
        const r = all[i].getBoundingClientRect();
        parts.push(Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' +
          Math.round(r.height) + ',' + getComputedStyle(all[i]).opacity);
      }
      return parts.join('|');
    }
    return new Promise(function (resolve) {
      let last = signature();
      let quiet = 0;
      const start = Date.now();
      const poll = function () {
        const now = signature();
        quiet = now === last ? quiet + 1 : 0;
        last = now;
        if (quiet >= 4 || Date.now() - start > 6000) {
          return resolve();
        }
        setTimeout(poll, 150);
      };
      setTimeout(poll, 150);
    });
  });
}

/**
 * (Keep in sync with canvas-ai tests/regression/ui-chrome.spec.js contrastAudit().)
 * Text that does not read against its background: every visible element with its own text, its
 * colour against the first opaque background up its ancestors (then the page canvas). Returns
 * "<ratio> <selector> "<text>" <fg> on <bg>" lines under `min`. The dark theme breaks where a
 * widget mixes a literal colour with a role, so this is how the dark matrix finds them.
 */
function contrastAudit(min) {
  function rgba(c) {
    var m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) {
      return null;
    }
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  function lum(c) {
    var l = [0, 1, 2].map(function (i) {
      var v = c[i] / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  }
  function over(top, under) {
    var a = top[3];
    return [0, 1, 2].map(function (i) { return top[i] * a + under[i] * (1 - a); }).concat([1]);
  }
  function background(el) {
    var layers = [];
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      var b = rgba(getComputedStyle(e).backgroundColor);
      if (b && b[3] > 0) {
        layers.push(b);
        if (b[3] >= 1) {
          break;
        }
      }
    }
    // Below everything is the canvas: white, or the browser's dark canvas under color-scheme: dark
    var c = /dark/.test(getComputedStyle(document.documentElement).colorScheme) ? [18, 18, 18, 1] : [255, 255, 255, 1];
    for (var i = layers.length - 1; i >= 0; i--) {
      c = over(layers[i], c);
    }
    return c;
  }
  var out = [];
  var all = document.body.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var own = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        own += n.nodeValue;
      }
    }
    own = own.trim();
    var st = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    if (!own || st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0 || r.width < 1 || r.height < 1) {
      continue;
    }
    // Visually hidden: screen-reader-only content (clipped, 1px, off-screen) or a faded-out box
    var hidden = false;
    for (var a = el; a && a.nodeType === 1; a = a.parentElement) {
      var ar = a.getBoundingClientRect();
      if (ar.width <= 1 || ar.height <= 1 || ar.right <= 0 || ar.bottom <= 0 ||
        ar.left >= innerWidth || ar.top >= innerHeight || /rect\(0(px)?,? 0/.test(getComputedStyle(a).clip) ||
        +getComputedStyle(a).opacity === 0) {
        hidden = true;
        break;
      }
    }
    // Decorative glyphs drawn as text (the workflow player's | ticks, faint by design in every theme)
    if (hidden || /cX-Workflow-List-Tick/.test(el.className)) {
      continue;
    }
    var bg = background(el);
    var fg = over(rgba(st.color), bg);
    var l1 = lum(fg);
    var l2 = lum(bg);
    var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (ratio < min) {
      out.push(ratio.toFixed(2) + ' ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') +
        ' "' + own.slice(0, 24) + '" ' + st.color + ' on rgb(' + bg.slice(0, 3).map(Math.round).join(', ') + ')');
    }
  }
  return out;
}

/** Keep in sync with canvas-ai tests/regression/ui-chrome.spec.js fingerprint(). */
function fingerprint() {
  var INHERITED = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'accent-color'];
  var SIDES = {
    'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
    'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
    'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
    'radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius',
      'border-bottom-left-radius'],
    'padding': ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']
  };
  function sided(cs, key) {
    var v = SIDES[key].map(function (k) { return cs.getPropertyValue(k); });
    return v[0] === v[1] && v[1] === v[2] && v[2] === v[3] ? v[0] : v.join(' ');
  }
  function styleOf(el, cs) {
    var out = [];
    var pcs = el.parentElement && el.parentElement !== document.body ?
      getComputedStyle(el.parentElement) : null;
    INHERITED.forEach(function (k) {
      var v = cs.getPropertyValue(k);
      if (!pcs || pcs.getPropertyValue(k) !== v) {
        out.push(k + '=' + v);
      }
    });
    var bw = sided(cs, 'border-width');
    if (bw !== '0px') {
      out.push('border=' + bw + ' / ' + sided(cs, 'border-style') + ' / ' + sided(cs, 'border-color'));
    }
    var rad = sided(cs, 'radius');
    if (rad !== '0px') {
      out.push('radius=' + rad);
    }
    var pad = sided(cs, 'padding');
    if (pad !== '0px') {
      out.push('padding=' + pad);
    }
    var bg = cs.getPropertyValue('background-color');
    if (bg !== 'rgba(0, 0, 0, 0)') {
      out.push('bg=' + bg);
    }
    ['background-image', 'box-shadow'].forEach(function (k) {
      var v = cs.getPropertyValue(k);
      if (v !== 'none') {
        out.push(k + '=' + v);
      }
    });
    if (cs.getPropertyValue('z-index') !== 'auto') {
      out.push('z=' + cs.getPropertyValue('z-index'));
    }
    if (cs.getPropertyValue('opacity') !== '1') {
      out.push('opacity=' + cs.getPropertyValue('opacity'));
    }
    if (cs.getPropertyValue('outline-style') !== 'none') {
      out.push('outline=' + cs.getPropertyValue('outline-width') + ' ' +
        cs.getPropertyValue('outline-style') + ' ' + cs.getPropertyValue('outline-color'));
    }
    if (el.tagName.toLowerCase() === 'svg') {
      out.push('fill=' + cs.getPropertyValue('fill'));
      if (cs.getPropertyValue('stroke') !== 'none') {
        out.push('stroke=' + cs.getPropertyValue('stroke'));
      }
    }
    return out.join('; ');
  }
  var lines = [];
  var seen = {};
  function stepOf(el) {
    var step = el.tagName.toLowerCase();
    if (el.id) {
      return step + '#' + el.id;
    }
    var cls = (typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''))
      .trim().split(/\s+/).filter(Boolean).sort().join('.');
    if (cls) {
      step += '.' + cls;
    }
    var parent = el.parentElement;
    if (parent) {
      var same = 0;
      var idx = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === el.tagName) {
          same++;
          if (parent.children[i] === el) {
            idx = same;
          }
        }
      }
      if (same > 1) {
        step += ':' + idx;
      }
    }
    return step;
  }
  function pathOf(el) {
    var parts = [];
    while (el && el !== document.body) {
      parts.unshift(stepOf(el));
      if (el.id) {
        break;
      }
      el = el.parentElement;
    }
    return parts.join('>');
  }
  var all = document.body.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var tag = el.tagName.toLowerCase();
    if (tag === 'canvas' || tag === 'script' || tag === 'style' || el.ownerSVGElement) {
      continue;
    }
    // The version box's contents are the engine version text, which moves with every release; the
    // box itself (its themed background and border) is still fingerprinted.
    var vbox = el.parentElement && el.parentElement.closest ?
      el.parentElement.closest('[id$="-cX-Version-Info-Container"]') : null;
    if (vbox) {
      continue;
    }
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') {
      continue;
    }
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      continue;
    }
    var p = pathOf(el);
    if (seen[p]) {
      seen[p]++;
      p += '~' + seen[p];
    } else {
      seen[p] = 1;
    }
    lines.push(p + ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
      Math.round(r.width) + 'x' + Math.round(r.height) + '] ' + styleOf(el, cs));
  }
  return lines.join('\n') + '\n';
}

/**
 * Pixels that differ between two PNGs, decoded by the browser itself (no PNG dependency here).
 * Scaled raster images (the app shell's how-to screenshots) resample a few dozen pixels
 * differently run to run, so screenshots allow MAX_DIFF_PIXELS; the computed-style fingerprint
 * is the exact check.
 */
const MAX_DIFF_PIXELS = 150;
async function pixelDiff(page, a, b) {
  return page.evaluate(async function (pair) {
    async function pixels(b64) {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height);
    }
    const x = await pixels(pair[0]);
    const y = await pixels(pair[1]);
    if (x.width !== y.width || x.height !== y.height) {
      return Infinity;
    }
    let n = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) {
        n++;
      }
    }
    return n;
  }, [a.toString('base64'), b.toString('base64')]);
}

/** First differing lines of two fingerprints, for the failure message. */
function firstDiff(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(la.length, lb.length) && out.length < 6; i++) {
    if (la[i] !== lb[i]) {
      // Paths are long; the changed property is at the end of the line.
      out.push('- …' + (la[i] || '').slice(-220));
      out.push('+ …' + (lb[i] || '').slice(-220));
    }
  }
  return out.join('\n      ');
}

const ENGINE_JS = engineJs();

(async function main() {
  const chromium = loadChromium();
  const { server, base } = await serve();
  const browser = await chromium.launch();
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  let failures = 0;
  let written = 0;
  try {
    for (const c of CASES.filter(function (x) { return x.name.indexOf(FILTER) !== -1; })) {
      for (const scheme of SCHEMES) {
        const id = c.name + '.' + scheme;
        const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', function (e) { errors.push(String(e)); });
        await routeEngine(page, base);
        let problem = '';
        try {
          await c.open(page, base);
          await settle(page);
          // Chart pixels belong to the engine's canvas suite; hide every canvas so only the
          // surrounding chrome is compared.
          await page.addStyleTag({ content: 'canvas{visibility:hidden !important}' });
          // CX_UI_CONTRAST=<ratio>: report text below that contrast (the dark-theme audit)
          if (process.env.CX_UI_CONTRAST) {
            const low = await page.evaluate(contrastAudit, parseFloat(process.env.CX_UI_CONTRAST));
            if (low.length) {
              console.log('CONTRAST ' + id + '\n  ' + low.join('\n  '));
            }
          }
          const styles = await page.evaluate(fingerprint);
          const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
          const sFile = path.join(SNAP_DIR, id + '.styles.txt');
          const pFile = path.join(SNAP_DIR, id + '.png');
          if (errors.length) {
            problem = 'page errors: ' + errors.slice(0, 3).join(' | ');
          } else if (UPDATE || !fs.existsSync(sFile)) {
            fs.writeFileSync(sFile, styles);
            fs.writeFileSync(pFile, png);
            written++;
          } else {
            const wantS = fs.readFileSync(sFile, 'utf8');
            const wantP = fs.readFileSync(pFile);
            if (wantS !== styles) {
              problem = 'computed styles differ:\n      ' + firstDiff(wantS, styles);
            } else if (!wantP.equals(png)) {
              const differing = await pixelDiff(page, wantP, png);
              if (differing > MAX_DIFF_PIXELS) {
                problem = 'screenshot differs by ' + differing + ' px (styles identical)';
              }
            }
            if (problem) {
              fs.mkdirSync(OUT_DIR, { recursive: true });
              fs.writeFileSync(path.join(OUT_DIR, id + '.styles-actual.txt'), styles);
              fs.writeFileSync(path.join(OUT_DIR, id + '-actual.png'), png);
            }
          }
        } catch (e) {
          problem = 'error: ' + (e && e.message ? e.message.split('\n')[0] : e);
        }
        await ctx.close();
        console.log((problem ? 'FAIL ' : 'ok   ') + id + (problem ? '\n    ' + problem : ''));
        failures += problem ? 1 : 0;
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (written) {
    console.log('wrote ' + written + ' baseline(s) to ' + path.relative(ROOT, SNAP_DIR));
  }
  if (failures) {
    console.log(failures + ' case(s) differ; actuals in ' + path.relative(ROOT, OUT_DIR));
    process.exit(1);
  }
})();
