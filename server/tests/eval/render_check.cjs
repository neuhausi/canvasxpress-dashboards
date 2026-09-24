/**
 * Render check for the NL -> dashboard eval: render each generated spec in a
 * real browser with the real CanvasXpress engine and verify the charts plot
 * what the spec asked for. Free to run (no LLM calls) — it re-uses the specs a
 * results file already holds.
 *
 * Per graph panel it checks that:
 *  - the panel rendered (no error overlay, no page error) and drew data;
 *  - the engine kept the axes the config names (`xAxis` / `yAxis`) — the engine
 *    silently substitutes others when a name is not valid for the data's
 *    orientation (e.g. variable names on a Scatter2D of sample rows);
 *  - the annotations the config groups / colours / segregates by exist in the
 *    panel's data;
 *  - a Pie is not a single 100% slice (one variable over several rows).
 *
 *   node render_check.cjs --results results.json --url http://127.0.0.1:8899 \
 *        --user evaluser --password evalpass [--out render.json]
 *
 * Needs a RUNNING dashboards server (dataset / function sources resolve through
 * it, as the eval user), `playwright` (or PLAYWRIGHT_MODULE), and CanvasXpress
 * from CX_LIB_DIR (canvasXpress.min.js; CX_CSS_DIR for the .css) or the CDN.
 * Prints `{ "<prompt id>": { ok, problems, panels } }` as JSON.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CDN = 'https://www.canvasxpress.org/dist';

/**
 * Parse `--name value` arguments.
 * @param {string[]} argv - Arguments.
 * @returns {object} name -> value.
 */
function parseArgs(argv) {
  const out = { url: 'http://127.0.0.1:8200', user: 'evaluser', password: 'evalpass' };
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

/**
 * Serve the dashboards `src/` (ES modules) and a local CanvasXpress build with
 * CORS, so a page on the dashboards server's origin can load them.
 * @returns {Promise<{server: http.Server, base: string}>} Server and base URL.
 */
function serveAssets() {
  const libDir = process.env.CX_LIB_DIR || '';
  const cssDir = process.env.CX_CSS_DIR || libDir;
  const types = { '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer(function (req, res) {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let root = REPO;
    let rel = url;
    if (url.indexOf('/__cx/') === 0) { root = /\.css$/.test(url) ? cssDir : libDir; rel = url.slice('/__cx/'.length); }
    const file = path.join(root, rel);
    if (!root || file.indexOf(path.resolve(root)) !== 0) { res.writeHead(404); return res.end(); }
    fs.readFile(file, function (err, body) {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*' });
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
 * Render one spec on a page already logged in to the dashboards server and
 * collect per-panel diagnostics (runs in the browser).
 * @param {object} spec - The dashboard spec.
 * @returns {Promise<object>} `{error, panels:[...]}`.
 */
async function renderInPage(spec) {
  const pageErrors = window.__pageErrors = window.__pageErrors || [];
  const host = document.getElementById('dash');
  host.innerHTML = '';
  let error = null;
  try {
    const handle = await window.CXD.renderDashboard(spec, host, { CanvasXpress: window.CanvasXpress, baseUrl: '' });
    await handle.ready;
    await new Promise(function (r) { setTimeout(r, 1500); });
  } catch (e) {
    error = String(e && e.message || e);
  }
  const panels = [];
  Object.keys(spec.panels || {}).forEach(function (id) {
    const panel = spec.panels[id];
    if (panel && panel.type) return;   // text / image / control / filters: not charts
    const cell = Array.prototype.find.call(document.querySelectorAll('canvas[id]'), function (c) {
      return c.id.indexOf('-panel-' + id + '-') !== -1;
    });
    const inst = cell ? window.CanvasXpress.instances.filter(function (i) { return i.target === cell.id; })[0] : null;
    const overlay = cell && cell.closest('.cxd-panel') ? cell.closest('.cxd-panel').querySelector('.cxd-error') : null;
    const data = inst && inst.data ? inst.data : null;
    panels.push({
      id: id,
      rendered: !!inst,
      overlay: overlay ? overlay.textContent.slice(0, 200) : null,
      drawn: inst && inst.meta && inst.meta.render ? inst.meta.render.objects.filter(function (o) { return o.type === 'Data'; }).length : 0,
      graphType: inst ? inst.graphType : null,
      xAxis: inst ? inst.xAxis : null,
      yAxis: inst ? inst.yAxis : null,
      vars: data && data.y ? data.y.vars : [],
      smps: data && data.y ? data.y.smps : [],
      annotations: data ? Object.keys(data.x || {}).concat(Object.keys(data.z || {})) : []
    });
  });
  return { error: error, pageErrors: pageErrors.splice(0), panels: panels };
}

/**
 * Judge one panel against its authored config.
 * @param {object} config - The panel's authored `config`.
 * @param {object} p - Diagnostics from {@link renderInPage}.
 * @returns {string[]} Problems (empty = fine).
 */
function judgePanel(config, p) {
  const problems = [];
  const at = 'panel "' + p.id + '"';
  if (!p.rendered) return [at + ': no chart was created' + (p.overlay ? ' (' + p.overlay + ')' : '')];
  if (p.overlay) problems.push(at + ': error overlay: ' + p.overlay);
  if (!p.drawn) problems.push(at + ': drew no data');
  // A Pie draws one slice per variable: one variable over several rows is a
  // single 100% slice, never a real split.
  if (p.graphType === 'Pie' && p.vars.length === 1 && p.smps.length > 1) {
    problems.push(at + ': the pie is a single 100% slice ("' + p.vars[0] + '") — its ' + p.smps.length + ' rows are not slices');
  }
  ['xAxis', 'yAxis'].forEach(function (axis) {
    const asked = [].concat(config[axis] || []).filter(function (v) { return typeof v === 'string'; });
    const got = [].concat(p[axis] || []);
    const lost = asked.filter(function (name) { return got.indexOf(name) === -1; });
    if (lost.length) {
      const where = lost.map(function (name) {
        return p.vars.indexOf(name) !== -1 ? name + ' (a variable)' : p.smps.indexOf(name) !== -1 ? name + ' (a sample)' : name + ' (not in the data)';
      });
      problems.push(at + ': ' + axis + ' ' + JSON.stringify(asked) + ' was replaced by the engine with ' +
        JSON.stringify(got) + ' — ' + where.join(', ') + ' is not valid there for a ' + p.graphType);
    }
  });
  ['groupingFactors', 'segregateSamplesBy', 'segregateVariablesBy', 'colorBy', 'shapeBy', 'sizeBy'].forEach(function (key) {
    const names = [].concat(config[key] || []).filter(function (v) { return typeof v === 'string' && v; });
    names.forEach(function (name) {
      // colorBy / shapeBy / sizeBy may also name a variable.
      const known = p.annotations.indexOf(name) !== -1 ||
        (/^(colorBy|shapeBy|sizeBy)$/.test(key) && (p.vars.indexOf(name) !== -1 || p.smps.indexOf(name) !== -1));
      if (!known) problems.push(at + ': ' + key + ' "' + name + '" is not in the panel\'s data');
    });
  });
  return problems;
}

(async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.results) { console.error('usage: node render_check.cjs --results <file> [--url --user --password --out]'); process.exit(2); }
  let chromium;
  try { chromium = require(process.env.PLAYWRIGHT_MODULE || 'playwright').chromium; } catch (e) {
    console.error('render_check: needs playwright (or PLAYWRIGHT_MODULE)'); process.exit(2);
  }
  const results = JSON.parse(fs.readFileSync(args.results, 'utf8')).results || [];
  const { server, base } = await serveAssets();
  const cx = process.env.CX_LIB_DIR ? base + '/__cx' : CDN;
  const page0 = '<!doctype html><html><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="' + cx + '/canvasXpress.css">' +
    '<script src="' + cx + '/canvasXpress.min.js"></script>' +
    '<script type="module">import * as CXD from "' + base + '/src/index.js"; window.CXD = CXD; window.cxdReady = true;</script>' +
    '</head><body style="width:1400px"><div id="dash"></div></body></html>';
  const browser = await chromium.launch();
  const report = {};
  try {
    for (const row of results) {
      if (!row.spec) continue;
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const errors = [];
      page.on('pageerror', function (e) { errors.push(String(e).slice(0, 200)); });
      await page.goto(args.url.replace(/\/$/, '') + '/auth/me');
      await page.evaluate(function (cred) {
        return fetch('/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cred) });
      }, { username: args.user, password: args.password });
      await page.setContent(page0);
      await page.waitForFunction(function () { return window.cxdReady && window.CanvasXpress; }, null, { timeout: 30000 });
      const diag = await page.evaluate(renderInPage, row.spec);
      await page.close();
      const problems = [];
      if (diag.error) problems.push('dashboard failed to render: ' + diag.error);
      errors.concat(diag.pageErrors).forEach(function (e) { problems.push('page error: ' + e); });
      diag.panels.forEach(function (p) {
        problems.push.apply(problems, judgePanel((row.spec.panels[p.id] || {}).config || {}, p));
      });
      report[row.id] = { ok: problems.length === 0, problems: problems, panels: diag.panels.map(function (p) {
        return { id: p.id, graphType: p.graphType, drawn: p.drawn, xAxis: p.xAxis, yAxis: p.yAxis };
      }) };
    }
  } finally {
    await browser.close();
    server.close();
  }
  const text = JSON.stringify(report, null, 1);
  if (args.out) fs.writeFileSync(args.out, text);
  else process.stdout.write(text + '\n');
})();
