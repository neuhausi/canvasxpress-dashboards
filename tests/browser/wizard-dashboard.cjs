/*
 * "Whole dashboard from one dataset" browser gate.
 *
 * Drives the real app shell against a throwaway server (wizard-server.py): paste a
 * patient-cohort CSV (parsed by the CanvasXpress engine's loadFile), reach Visualize and
 * check the wizard offers a linked Cohort dashboard (live mini-previews, preselected),
 * publish it, verify the published spec over the public share API, open the share link
 * and check every chart panel renders; then re-run the wizard, pick a single chart
 * instead, and verify only one panel is published. A table that matches no template must
 * show no dashboard offer. The /api/wizard/suggest response is stubbed (the selector is
 * covered by server/tests/test_wizard.py). The engine is routed to the local canvas-ai
 * build so the test runs offline.
 *
 * Run: CXD_PYTHON=… PLAYWRIGHT_MODULE=… node tests/browser/wizard-dashboard.cjs
 * The port is picked free; CXD_WIZARD_PORT pins it.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch (e) {
  console.log('wizard-dashboard: needs playwright — set PLAYWRIGHT_MODULE to an installed copy.');
  process.exit(2);
}

const PYTHON = process.env.CXD_PYTHON || 'python3';
const ENGINE_DIR = process.env.CX_ENGINE_DIR || path.join(os.homedir(), 'git', 'canvas-ai', 'build');
const SHOTS = process.env.CXD_SHOT_DIR || '';

function cohortCsv() {
  const rows = ['Patient,os_months,os_event,age,CD274,arm,stage'];
  for (let i = 0; i < 40; i++) {
    rows.push(['P' + String(i + 1).padStart(3, '0'), 3 + (i * 7) % 40, i % 3 === 0 ? 0 : 1, 40 + (i * 5) % 35,
      (2 + (i * 3) % 9).toFixed(1), i % 2 ? 'Drug' : 'Placebo', ['I', 'II', 'III'][i % 3]].join(','));
  }
  return rows.join('\n') + '\n';
}
const PLAIN_CSV = 'Country,Region,GDP,LifeExp\nUSA,Americas,65000,79\nJapan,Asia,42000,84\nIndia,Asia,2100,70\nBrazil,Americas,9000,75\n';

// The engine comes from the sibling canvas-ai checkout, not the CDN, so the gate is deterministic.
// Default: the engine SOURCE files, concatenated in the order the engine's own render harness loads
// them (so an uncommitted engine edit — e.g. the grouped-mark highlight fix the drill relies on — is
// tested without a build). CX_ENGINE_BUILT=1: the built canvasXpress.min.js a release ships.
const ENGINE_ROOT = path.resolve(ENGINE_DIR, '..');
const ENGINE_BUILT = process.env.CX_ENGINE_BUILT === '1';
function engineJs() {
  const harness = path.join(ENGINE_ROOT, 'tests', 'regression', 'render-harness.html');
  if (!ENGINE_BUILT && fs.existsSync(harness)) {
    const list = fs.readFileSync(harness, 'utf8').match(/CX_FILES\s*=\s*\[([\s\S]*?)\]/);
    const files = list ? list[1].match(/canvasXpress\.[\w]+\.js/g) : null;
    if (files && files.length) {
      return files.map(function (f) { return fs.readFileSync(path.join(ENGINE_DIR, 'js', f), 'utf8'); }).join('\n;\n');
    }
  }
  return fs.readFileSync(path.join(ENGINE_DIR, 'js', 'canvasXpress.min.js'), 'utf8');
}
function engineCss() {
  if (ENGINE_BUILT) return fs.readFileSync(path.join(ENGINE_DIR, 'css', 'canvasXpress.min.css'), 'utf8');
  const dir = path.join(ENGINE_DIR, 'css', 'widgets');
  return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.css'); }).sort()
    .map(function (f) { return fs.readFileSync(path.join(dir, f), 'utf8'); }).join('');
}
const ENGINE_JS = engineJs();
const ENGINE_CSS = engineCss();
function routeEngine(pg) {
  return Promise.all([
    pg.route('https://www.canvasxpress.org/dist/canvasXpress.min.js', function (route) {
      route.fulfill({ body: ENGINE_JS, contentType: 'text/javascript' });
    }),
    pg.route('https://www.canvasxpress.org/dist/canvasXpress.css', function (route) {
      route.fulfill({ body: ENGINE_CSS, contentType: 'text/css' });
    })
  ]);
}

function freePort() {
  if (process.env.CXD_WIZARD_PORT) return Promise.resolve(Number(process.env.CXD_WIZARD_PORT));
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', function () { const p = srv.address().port; srv.close(function () { resolve(p); }); });
  });
}

// Ink on a canvas: pixels that are not near-white (the chart canvases paint an opaque
// background, so counting any non-transparent pixel would only measure the canvas area).
const INK = function () {
  return Array.prototype.map.call(document.querySelectorAll('canvas'), function (c) {
    var g = c.getContext('2d'); if (!g || !c.width || !c.height) return 0;
    var d = g.getImageData(0, 0, c.width, c.height).data, n = 0;
    for (var i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245)) n++;
    return n;
  }).filter(function (n) { return n > 0; });
};

function startServer(port, base) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cxd-wizdash-'));
  const proc = spawn(PYTHON, [path.join(__dirname, 'wizard-server.py'), String(port), tmp],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(function (resolve, reject) {
    proc.stdout.once('data', function () {
      const until = Date.now() + 15000;
      (function poll() {
        fetch(base + '/auth/me').then(function () { resolve(proc); },
          function () { Date.now() < until ? setTimeout(poll, 200) : reject(new Error('server did not start')); });
      })();
    });
    proc.on('exit', function (code) { reject(new Error('server exited ' + code)); });
  });
}

let serverProc = null;
process.on('exit', function () { if (serverProc) { try { serverProc.kill(); } catch (e) { /* gone */ } } });
(async function main() {
  const port = await freePort();
  const BASE = 'http://127.0.0.1:' + port;
  serverProc = await startServer(port, BASE);
  let failures = 0;
  function check(name, ok, detail) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
    if (!ok) failures++;
  }
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.on('pageerror', function (e) { console.log('PAGEERROR', e.message); });
    await routeEngine(page);
    await page.route(BASE + '/api/wizard/suggest', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        source: 'mcp',
        suggestions: [
          { graphType: 'Scatter2D', score: 0.9, reason: 'Two measures against each other.',
            config: { graphType: 'Scatter2D', xAxis: ['age'], yAxis: ['os_months'] } },
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
    await page.evaluate(function () { return refreshUser().then(function () { return null; }); });

    async function toVisualize(csv, title) {
      await page.evaluate(function () { showWizard(); });
      await page.fill('.cX-Modal textarea', csv);
      await page.fill('.cX-Modal input[type=text]', title);
      await page.click('.cX-Modal button:has-text("Next: check data")');
      await page.waitForSelector('.cxd-wizard-profile', { timeout: 20000 });
      await page.click('.cX-Modal button:has-text("Next: pick a chart")');
      await page.waitForSelector('.cxd-wizard-cards .cxd-wizard-card canvas', { timeout: 20000 });
    }
    async function publish() {
      await page.click('.cX-Modal button:has-text("Next: publish")');
      const note = await page.$eval('.cX-Modal .cxd-wizard-note', function (n) { return n.textContent; });
      await page.click('.cX-Modal button:has-text("Save & publish")');
      await page.waitForFunction(function () {
        return Array.prototype.some.call(document.querySelectorAll('.cX-Modal .cxd-wizard-note'),
          function (n) { return /Published\.|not published/.test(n.textContent); });
      }, null, { timeout: 30000 });
      const shareUrl = await page.$eval('.cX-Modal .cxd-wizard-field input[readonly]', function (i) { return i.value; });
      const token = (/token=([^&]+)/.exec(shareUrl) || [])[1];
      const shared = await (await fetch(BASE + '/api/shared/' + token)).json();
      return { note: note, token: token, shareUrl: shareUrl, spec: shared.spec || {} };
    }
    async function closeModal() {
      await page.keyboard.press('Escape');
      await page.evaluate(function () { var m = document.querySelector('.cX-Modal'); if (m && m.close) m.close(); });
    }

    // ---- 1: a cohort table is offered a whole dashboard, preselected ----
    await toVisualize(cohortCsv(), 'Trial cohort');
    await page.waitForSelector('.cxd-wizard-offer .cxd-wizard-card .cxd-wizard-mini canvas', { timeout: 20000 });
    const offer = await page.$eval('.cxd-wizard-offer .cxd-wizard-card', function (el) {
      return { text: el.textContent, chosen: el.className.indexOf('--chosen') > -1,
        charts: el.querySelectorAll('.cxd-wizard-mini-host').length, minis: el.querySelectorAll('.cxd-wizard-mini').length };
    });
    check('cohort dashboard offered', /Cohort overview/.test(offer.text), offer.text.slice(0, 90));
    check('offer lists the five panels (filters, three charts, the case card)', offer.minis === 5, 'minis ' + offer.minis);
    check('offer previews three live charts', offer.charts === 3, 'charts ' + offer.charts);
    check('offer preselected', offer.chosen);
    const chartChosen = await page.$$eval('.cxd-wizard-cards .cxd-wizard-card--chosen', function (els) { return els.length; });
    check('no single chart competes for selection', chartChosen === 0, 'chosen ' + chartChosen);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'wizard-offer.png') });

    const dash = await publish();
    check('publish step says linked 5-panel dashboard', /5-panel/.test(dash.note), dash.note.slice(0, 80));
    const ids = Object.keys(dash.spec.panels || {});
    check('published five panels', ids.length === 5 && ids[4] === 'case', JSON.stringify(ids));
    check('panel types', dash.spec.panels.filters && dash.spec.panels.filters.type === 'filters' &&
      dash.spec.panels.km && dash.spec.panels.km.config.graphType === 'KaplanMeier');
    check('every panel on the dataset, the case card on its narrowed copy',
      ids.every(function (id) { return dash.spec.panels[id].dataRef === (id === 'case' ? 'case' : 'data'); }));
    check('case param, narrowed source and click action published',
      dash.spec.params && dash.spec.params['case'] && dash.spec.params['case'].value === 'P001' &&
      dash.spec.data['case'] && dash.spec.data['case'].pushdown.where[0].value === '$case' &&
      dash.spec.panels['vs-time'].actions && dash.spec.panels['vs-time'].actions[0].setParam.name === 'case',
      JSON.stringify(dash.spec.params));
    check('filters offer the cohort factors', dash.spec.panels.filters && dash.spec.panels.filters.fields.indexOf('arm') > -1 &&
      dash.spec.panels.filters.fields.indexOf('stage') > -1, JSON.stringify(dash.spec.panels.filters && dash.spec.panels.filters.fields));
    check('survival columns mapped', dash.spec.panels.km.config.xAxis[0] === 'os_months' &&
      dash.spec.panels.km.config.yAxis[0] === 'os_event', JSON.stringify(dash.spec.panels.km.config.xAxis) + JSON.stringify(dash.spec.panels.km.config.yAxis));
    check('editorial theme preselected', dash.spec.theme === 'editorial', dash.spec.theme);
    check('scatter-type panels carry no engine transposeData (the renderer transposes)',
      dash.spec.panels.km.config.transposeData === undefined && dash.spec.panels['vs-time'].config.transposeData === undefined,
      JSON.stringify([dash.spec.panels.km.config.transposeData, dash.spec.panels['vs-time'].config.transposeData]));
    await closeModal();

    // The published share link renders: a chart per chart panel, no page errors.
    const viewer = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const viewerErrors = [];
    viewer.on('pageerror', function (e) { viewerErrors.push(e.message); });
    await routeEngine(viewer);
    await viewer.goto(dash.shareUrl.replace(/^https?:\/\/[^/]+/, BASE));
    await viewer.waitForFunction(function () { return document.querySelectorAll('canvas').length >= 3; }, null, { timeout: 30000 });
    await viewer.waitForTimeout(2500);
    const drawn = await viewer.evaluate(INK);
    // Three charts plus the case card's table canvas.
    check('shared dashboard draws all three charts and the card', drawn.filter(function (n) { return n > 1500; }).length === 4, JSON.stringify(drawn));
    check('no page errors in the shared view', viewerErrors.length === 0, viewerErrors.join(' | '));
    if (SHOTS) await viewer.screenshot({ path: path.join(SHOTS, 'wizard-dashboard.png') });

    // ---- The case drill: click a real patient in the scatter, the card shows that patient ----
    // cohortCsv() row k (0-based) is patient P(k+1); its values are a pure function of k.
    const expectedPatient = function (id) {
      const k = Number(id.slice(1)) - 1;
      return { os_months: 3 + (k * 7) % 40, os_event: k % 3 === 0 ? 0 : 1, age: 40 + (k * 5) % 35, arm: k % 2 ? 'Drug' : 'Placebo' };
    };
    // The card's one row, read from what the table actually DISPLAYS (not its data object).
    const readCard = async function () {
      const text = await viewer.evaluate(function () {
        const root = document.querySelector('[id$=-cX-DataTable]');
        return root ? root.innerText.replace(/\s+/g, ' ') : '';
      });
      const m = /CD274\s+1\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(text);
      return m ? { id: m[1], arm: m[2], stage: m[3], os_months: Number(m[4]), os_event: Number(m[5]), age: Number(m[6]), text: text } : { id: null, text: text };
    };
    // A saturated dot on the scatter canvas (bottom-right chart): the first one scanning from the
    // top-left, or the last scanning from the bottom-right, as a client-space click point.
    const findDot = function (fromEnd) {
      return viewer.evaluate(function (fromEnd) {
        // The panel titled "age vs os_months": climb from its heading to the first container
        // holding a canvas, and take the largest one (every chart also has a small overlay canvas).
        const heading = Array.prototype.find.call(document.querySelectorAll('*'), function (el) {
          return el.children.length === 0 && el.textContent.trim() === 'age vs os_months';
        });
        let box = heading;
        while (box && !box.querySelector('canvas')) box = box.parentElement;
        if (!box) return null;
        box.scrollIntoView({ block: 'center' });          // a dot below the fold cannot be clicked
        const canvases = Array.prototype.slice.call(box.querySelectorAll('canvas')).filter(function (c) { return c.width > 200; });
        for (let ci = 0; ci < canvases.length; ci++) {
          const c = canvases[ci];
          const r = c.getBoundingClientRect(), sx = c.width / r.width, sy = c.height / r.height;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          const sat = function (x, y) { const k = (y * c.width + x) * 4; return d[k + 3] > 200 && Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]) >= 60; };   // coloured, not the grey axes / text
          const limitX = Math.floor(c.width * 0.8);           // leave the legend swatches out
          let hit = null;
          for (let k = 0; k < c.width * c.height && !hit; k++) {
            const n = fromEnd ? c.width * c.height - 1 - k : k;
            const x = n % c.width, y = Math.floor(n / c.width);
            if (x < limitX && y > 30 && y < c.height - 60 && sat(x, y)) hit = { x: x, y: y };
          }
          if (!hit) continue;                                  // the transparent overlay canvas has no dots
          let sxs = 0, sys = 0, cnt = 0;                       // centroid of the dot
          for (let yy = hit.y - 8; yy <= hit.y + 8; yy++) for (let xx = hit.x - 8; xx <= hit.x + 8; xx++) {
            if (xx >= 0 && yy >= 0 && xx < c.width && yy < c.height && sat(xx, yy)) { sxs += xx; sys += yy; cnt++; }
          }
          return { x: r.left + (sxs / cnt) / sx, y: r.top + (sys / cnt) / sy };
        }
        return null;
      }, fromEnd);
    };
    const startCard = await readCard();
    check('card starts on the first patient', startCard.id === 'P001', JSON.stringify(startCard.id) + ' ' + startCard.text.slice(-60));
    const picked = [];
    for (const fromEnd of [false, true]) {
      const dot = await findDot(fromEnd);
      check('found a scatter dot to click (' + (fromEnd ? 'last' : 'first') + ')', !!dot, JSON.stringify(dot));
      if (!dot) continue;
      await viewer.mouse.move(dot.x, dot.y);
      await viewer.mouse.click(dot.x, dot.y);
      await viewer.waitForTimeout(1500);
      const card = await readCard();
      const want = card.id ? expectedPatient(card.id) : null;
      check('click loads that patient into the card (' + (fromEnd ? 'last' : 'first') + ')',
        !!want && card.os_months === want.os_months && card.age === want.age && card.arm === want.arm && card.os_event === want.os_event,
        card.id + ' shows ' + JSON.stringify({ os_months: card.os_months, age: card.age, arm: card.arm, os_event: card.os_event }) +
          ' expected ' + JSON.stringify(want));
      picked.push(card.id);
      // The dashboard marks the clicked patient on the same-source panels shown the other way round
      // (declarative highlightSmp), so the grouped boxplot must keep the box of THE PATIENT'S arm.
      // On an engine without the grouped-mark fix it keeps the group whose index equals the sample's.
      const box = await viewer.evaluate(function () {
        const bp = (window.CanvasXpress.instances || []).filter(function (i) { return i.graphType === 'Boxplot'; })[0];
        if (!bp || typeof bp.collectGreyOutHighlightIndices !== 'function') return null;
        const labels = bp.getWrangled().smps;
        const kept = {};
        bp.collectGreyOutHighlightIndices().forEach(function (i) {
          const o = bp.meta.render.objects[i];
          if (o && o.type === 'Data' && o.idx && o.idx.length === 2) kept[String(labels[o.idx[1]]).replace(/\u0000/g, '')] = true;
        });
        return { smps: bp.highlightSmp, keptGroups: Object.keys(kept) };
      });
      check('the boxplot highlights the clicked patient\'s own arm (' + (fromEnd ? 'last' : 'first') + ')',
        !!box && box.smps && box.smps.indexOf(card.id) !== -1 && box.keptGroups.length === 1 && box.keptGroups[0] === card.arm,
        card.id + ' is ' + card.arm + '; boxplot marks ' + JSON.stringify(box) +
          (ENGINE_BUILT ? ' [built engine: needs the grouped-mark highlight fix in the release]' : ''));
      await viewer.keyboard.press('Escape');                 // the documented selection-clear gesture
      await viewer.waitForTimeout(800);
      const afterEsc = await readCard();
      check('the card keeps its patient after Escape', afterEsc.id === card.id, card.id + ' -> ' + afterEsc.id);
    }
    // Rebuilding the card's table switches the engine's loader mask on; none may be left showing.
    const maskedLoaders = await viewer.evaluate(function () {
      return Array.prototype.filter.call(document.querySelectorAll('.cX-Loader'), function (el) {
        const r = el.getBoundingClientRect();
        return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
      }).length;
    });
    check('no loader spinner is left over the case card', maskedLoaders === 0, 'visible loaders: ' + maskedLoaders);
    check('two clicks load two different patients, neither the starting one only',
      picked.length === 2 && picked[0] && picked[1] && picked[0] !== picked[1] && (picked[0] !== 'P001' || picked[1] !== 'P001'),
      JSON.stringify(picked));
    check('the other charts keep the whole cohort (the card narrows, nothing else)',
      // 40 patients, two arms: the arm filter still reads 20 / 20 for both after the drill.
      (await viewer.evaluate(function () { return document.body.innerText; })).split('20 / 20').length - 1 >= 2);
    if (SHOTS) await viewer.screenshot({ path: path.join(SHOTS, 'wizard-dashboard-drilled.png'), fullPage: true });

    // Linked: unticking "Drug" in the Filters panel narrows the chart panels (one canvas per
    // chart is the main one; the overlay canvas follows it).
    const mainPixels = function () {
      return viewer.evaluate(INK).then(function (all) { return all.filter(function (n) { return n > 1500; }); });
    };
    const before = await mainPixels();
    await viewer.locator('.cxd-filters-check:has(input[value="Drug"]) label.cxd-filters-name').click();
    await viewer.waitForTimeout(2500);
    const after = await mainPixels();
    // The three charts redraw (narrowed to Placebo); the case card is on its own source and does not.
    check('filtering redraws every chart panel, not the case card', before.length === 4 && after.length === 4 &&
      [0, 1, 2].every(function (i) { return before[i] !== after[i]; }) && before[3] === after[3],
      JSON.stringify(before) + ' -> ' + JSON.stringify(after));
    if (SHOTS) await viewer.screenshot({ path: path.join(SHOTS, 'wizard-dashboard-filtered.png') });
    await viewer.close();

    // ---- Proactive insights on the anonymous share link ----
    // The wizard's dashboard opts in (`insights: {}`). Declare one threshold on the saved dashboard
    // (thresholds are never invented), then open the link with no session at all.
    check('the wizard dashboard opts in to insights', dash.spec.insights && typeof dash.spec.insights === 'object',
      JSON.stringify(dash.spec.insights));
    const saved = await page.evaluate(function (id) {
      const client = CanvasXpressDashboards.createDashboardClient({ baseUrl: '' });
      return client.load(id).then(function (stored) {
        stored.insights = { thresholds: [{ field: 'age', op: 'lt', value: 45, label: 'Age under 45' }] };
        return client.save(stored).then(function () { return true; });
      });
    }, dash.spec.id);
    check('threshold declared on the saved dashboard', saved === true);
    const insightsPage = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const insightsErrors = [];
    insightsPage.on('pageerror', function (e) { insightsErrors.push(e.message); });
    await routeEngine(insightsPage);
    await insightsPage.goto(dash.shareUrl.replace(/^https?:\/\/[^/]+/, BASE));
    await insightsPage.waitForSelector('.cxd-insights', { timeout: 30000 });
    await insightsPage.waitForFunction(function () {
      return document.querySelectorAll('[id$=-cX-DataTable]').length > 0 && /P001/.test((document.querySelector('[id$=-cX-DataTable]') || {}).innerText || '');
    }, null, { timeout: 30000 });
    const captions = await insightsPage.$$eval('.cxd-insight-caption', function (els) { return els.map(function (e) { return e.textContent; }); });
    check('the strip shows insights on the anonymous link', captions.length >= 2, JSON.stringify(captions).slice(0, 300));
    // Patients with age < 45: age = 40 + (k*5)%35 < 45 only when k*5 % 35 === 0, i.e. k = 0, 7, 14, 21, 28, 35.
    check('the declared threshold is flagged first, with the right count',
      /^Age under 45: 6 of 40 records have age below 45 \(P001, P008, P015/.test(captions[0] || ''), captions[0]);
    // CD274 = 2 + (k*3)%9 depends only on k%3, which is the stage: a perfect group difference.
    check('a data-derived group difference is reported, corrected for multiple tests',
      captions.some(function (c) { return /^CD274 differs by stage: .*Kruskal-Wallis p < 0\.001 \(BH-adjusted p < 0\.001\)/.test(c); }),
      JSON.stringify(captions).slice(0, 300));
    const noteText = await insightsPage.$eval('.cxd-insights-head', function (e) { return e.textContent; });
    check('the strip says how many comparisons were corrected for', /\d+ group comparisons, corrected for multiple testing/.test(noteText), noteText);
    await insightsPage.locator('.cxd-insight >> nth=0').locator('summary').click();
    const figureText = await insightsPage.locator('.cxd-insight >> nth=0').locator('.cxd-insight-figures').innerText();
    check('the figures behind the caption are there to check',
      /count: 6/.test(figureText) && /n: 40/.test(figureText) && /id=P008 value=40/.test(figureText), figureText.slice(0, 120).replace(/\n/g, ' | '));
    // Click a flagged patient: the case card loads exactly that patient's record.
    const readInsightCard = async function () {
      const text = await insightsPage.evaluate(function () {
        const root = document.querySelector('[id$=-cX-DataTable]'); return root ? root.innerText.replace(/\s+/g, ' ') : '';
      });
      const m = /CD274\s+1\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(text);
      return m ? { id: m[1], arm: m[2], os_months: Number(m[4]), os_event: Number(m[5]), age: Number(m[6]) } : { id: null, text: text };
    };
    await insightsPage.locator('.cxd-insight >> nth=0').locator('.cxd-insight-id', { hasText: 'P015' }).click();
    await insightsPage.waitForTimeout(1500);
    const clicked = await readInsightCard();
    const wanted = clicked.id ? expectedPatient(clicked.id) : null;
    check('clicking a flagged patient loads that patient into the case card',
      clicked.id === 'P015' && !!wanted && clicked.os_months === wanted.os_months && clicked.age === wanted.age && clicked.arm === wanted.arm,
      JSON.stringify(clicked) + ' expected ' + JSON.stringify(wanted));
    check('no page errors on the insights page', insightsErrors.length === 0, insightsErrors.join(' | '));
    if (SHOTS) await insightsPage.screenshot({ path: path.join(SHOTS, 'wizard-insights.png'), fullPage: true });
    // A dashboard that never opted in shows no strip: the single-chart wizard dashboards have no `insights`.
    await insightsPage.close();

    // ---- 2: choosing a single chart instead publishes just that chart ----
    await toVisualize(cohortCsv(), 'Just one chart');
    await page.waitForSelector('.cxd-wizard-offer .cxd-wizard-card--chosen');
    await page.click('.cxd-wizard-cards .cxd-wizard-card >> nth=0');
    const swapped = await page.evaluate(function () {
      return { offerChosen: !!document.querySelector('.cxd-wizard-offer .cxd-wizard-card--chosen'),
        chart: !!document.querySelector('.cxd-wizard-cards .cxd-wizard-card--chosen') };
    });
    check('picking a chart un-selects the dashboard', !swapped.offerChosen && swapped.chart, JSON.stringify(swapped));
    const single = await publish();
    const singleIds = Object.keys(single.spec.panels || {});
    check('single chart published', singleIds.length === 1 && single.spec.panels[singleIds[0]].config.graphType === 'Scatter2D', JSON.stringify(singleIds));
    check('single-chart note unchanged', /one-chart/.test(single.note));
    check('single scatter publishes without the engine transposeData', single.spec.panels[singleIds[0]].config.transposeData === undefined,
      String(single.spec.panels[singleIds[0]].config.transposeData));
    const solo = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const soloErrors = [];
    solo.on('pageerror', function (e) { soloErrors.push(e.message); });
    await routeEngine(solo);
    await solo.goto(single.shareUrl.replace(/^https?:\/\/[^/]+/, BASE));
    await solo.waitForFunction(function () { return document.querySelectorAll('canvas').length >= 1; }, null, { timeout: 30000 });
    await solo.waitForTimeout(2000);
    check('single shared chart has no page errors', soloErrors.length === 0, soloErrors.join(' | '));
    if (SHOTS) await solo.screenshot({ path: path.join(SHOTS, 'wizard-single.png') });
    await solo.close();
    await closeModal();

    // ---- 3: a table that matches no template gets no dashboard offer ----
    await toVisualize(PLAIN_CSV, 'Plain');
    const plainOffer = await page.$$eval('.cxd-wizard-offer .cxd-wizard-card', function (els) { return els.length; });
    check('no dashboard offer for an unrecognised table', plainOffer === 0, 'offers ' + plainOffer);
    const plainChosen = await page.$$eval('.cxd-wizard-cards .cxd-wizard-card--chosen', function (els) { return els.length; });
    check('single-chart flow unchanged', plainChosen === 1, 'chosen ' + plainChosen);
    await closeModal();
  } finally {
    await browser.close();
    serverProc.kill();
  }
  console.log(failures ? failures + ' check(s) failed' : 'wizard-dashboard gate holds');
  process.exit(failures ? 1 : 0);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
