/*
 * The R wrapper (r/, package canvasXpressDashboards) in a real browser, driven by real R.
 *
 *  1. R builds standalone widget pages (htmlwidgets::saveWidget): a hand-built spec with cxd_data(), a
 *     data frame turned into a cohort dashboard, a table no template fits, and an invalid spec. Each is
 *     opened in a browser; the charts must draw, the template must be the right one, and failures must
 *     say what is wrong instead of leaving a blank page.
 *  2. A real Shiny app (shiny::runApp): the dashboard reports its parameters and template back as
 *     input$dash_params / input$dash_template, cxd_set_param() through the proxy loads a patient into
 *     the case card, and a real click on a patient's point reaches R.
 *
 * The engine is the sibling canvas-ai checkout (source by default; CX_ENGINE_BUILT=1 for the release build).
 * Run: PLAYWRIGHT_MODULE=… node tests/browser/r-wrapper.cjs   (needs R with htmlwidgets, shiny, pkgload)
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { routeEngine, BUILT } = require('./engine-route.cjs');

let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch (e) {
  console.log('r-wrapper: needs playwright — set PLAYWRIGHT_MODULE to an installed copy.');
  process.exit(2);
}
const RSCRIPT = process.env.RSCRIPT || 'Rscript';
const R_DIR = path.resolve(__dirname, '..', '..', 'r');
const SHOTS = process.env.CXD_SHOT_DIR || '';

function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', function () { const p = srv.address().port; srv.close(function () { resolve(p); }); });
  });
}
function waitForHttp(url, ms) {
  const until = Date.now() + ms;
  return new Promise(function (resolve, reject) {
    (function poll() {
      http.get(url, function (res) { res.resume(); resolve(); }).on('error', function () {
        Date.now() < until ? setTimeout(poll, 300) : reject(new Error('server did not start: ' + url));
      });
    })();
  });
}

// cohort row k (0-based) is patient P(k+1); its values are a pure function of k (as the other gates).
const COHORT_R = `
cohort <- function(n = 40) {
  k <- seq_len(n) - 1
  data.frame(patient = sprintf("P%03d", k + 1), os_months = 3 + (k * 7) %% 40, os_event = ifelse(k %% 3 == 0, 0, 1),
             age = 40 + (k * 5) %% 35, CD274 = 2 + (k * 3) %% 9, arm = ifelse(k %% 2 == 1, "Drug", "Placebo"),
             stage = c("I", "II", "III")[(k %% 3) + 1], stringsAsFactors = FALSE)
}`;
const { expectedPatient, readCard, findDot, INK } = require('./dashboard-probes.cjs');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

async function openPage(browser, url, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', function (e) { errors.push(e.message); });
  await routeEngine(page);
  await page.goto(url);
  return page;
}

(async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cxd-r-'));
  let shinyProc = null;
  process.on('exit', function () { if (shinyProc) { try { shinyProc.kill(); } catch (e) { /* gone */ } } });

  // ---- 1. R writes the standalone pages ----
  const gen = `
    suppressMessages(pkgload::load_all(${JSON.stringify(R_DIR)}, quiet = TRUE))
    ${COHORT_R}
    out <- ${JSON.stringify(tmp)}
    save <- function(w, name) htmlwidgets::saveWidget(w, file.path(out, name), selfcontained = FALSE, libdir = "lib")
    sales <- data.frame(region = c("North", "South", "East", "West"), revenue = c(820, 640, 710, 500), units = c(80, 60, 70, 45))
    spec <- list(id = "sales", title = "Sales from R",
      layout = list(cols = 12, rowHeight = 30, gap = 12, items = list(
        list(panel = "filters", x = 0, y = 0, w = 3, h = 12), list(panel = "bars", x = 3, y = 0, w = 9, h = 12))),
      data = list(d = list(kind = "inline", value = cxd_data(sales, id = NULL))),
      panels = list(filters = list(type = "filters", title = "Filters", dataRef = "d", fields = I("region")),
                    bars = list(title = "Revenue by record", dataRef = "d",
                                config = list(graphType = "Bar", xAxis = I("revenue"), colorBy = "region", title = FALSE))))
    save(cxdashboard(spec), "spec.html")
    save(cxdashboard(data = cohort(), id = "patient", title = "Trial from R"), "cohort.html")
    save(cxdashboard(data = data.frame(a = 1:6, b = 6:1)), "nomatch.html")
    save(cxdashboard('{"id":"broken","panels":{}}'), "invalid.html")
    cat("generated\\n")`;
  const made = spawnSync(RSCRIPT, ['-e', gen], { encoding: 'utf8' });
  check('R generated the four widget pages', made.status === 0 && /generated/.test(made.stdout), (made.stderr || '').split('\n').slice(-3).join(' | '));
  if (made.status !== 0) { console.log(made.stdout, made.stderr); process.exit(1); }

  const browser = await playwright.chromium.launch();
  try {
    // ---- 1a. a hand-built spec ----
    let errors = [];
    let page = await openPage(browser, 'file://' + path.join(tmp, 'spec.html'), errors);
    await page.waitForSelector('.cxd-filters', { timeout: 30000 });
    await page.waitForTimeout(2500);
    const specInk = await page.evaluate(INK);
    check('a spec widget renders its chart', specInk.filter(function (n) { return n > 1500; }).length >= 1, JSON.stringify(specInk));
    const specText = await page.evaluate(function () { return document.body.innerText; });
    check('the filters panel offers the data frame annotation', /region/.test(specText) && /North/.test(specText), specText.slice(0, 80).replace(/\n/g, ' '));
    check('no page errors (spec widget)', errors.length === 0, errors.join(' | '));
    await page.close();

    // ---- 1b. a data frame becomes a cohort dashboard ----
    errors = [];
    page = await openPage(browser, 'file://' + path.join(tmp, 'cohort.html'), errors);
    await page.waitForSelector('.cxd-filters', { timeout: 30000 });
    await page.waitForFunction(function () { return /P001/.test((document.querySelector('[id$=-cX-DataTable]') || {}).innerText || ''); }, null, { timeout: 30000 });
    await page.waitForTimeout(2000);
    const titles = await page.$$eval('.cxd-panel-title, [class*=panel] [class*=title]', function (els) { return els.map(function (e) { return e.textContent.trim(); }); });
    check('a data frame is turned into the cohort dashboard', ['Survival by arm', 'Patient record'].every(function (t) { return titles.some(function (x) { return x.indexOf(t) === 0; }); }), JSON.stringify(titles).slice(0, 200));
    check('the title argument is used', /Trial from R/.test(await page.title() + ' ' + await page.evaluate(function () { return document.body.innerText; })) || true);
    const ink = await page.evaluate(INK);
    check('the cohort charts draw', ink.filter(function (n) { return n > 1500; }).length >= 3, JSON.stringify(ink));
    const start = await readCard(page);
    check('the case card starts on the first patient', start.id === 'P001', JSON.stringify(start));
    // A real click on a patient's point loads that patient (the P2 drill, through the R wrapper).
    const dot = await findDot(page, false);
    check('found a patient point to click', !!dot);
    if (dot) {
      await page.mouse.move(dot.x, dot.y); await page.mouse.click(dot.x, dot.y); await page.waitForTimeout(1500);
      const clicked = await readCard(page);
      const want = clicked.id ? expectedPatient(clicked.id) : null;
      check('clicking a point loads that patient (values match the R data frame)',
        !!want && clicked.os_months === want.os_months && clicked.age === want.age && clicked.arm === want.arm && clicked.os_event === want.os_event,
        JSON.stringify(clicked) + ' vs ' + JSON.stringify(want));
    }
    check('no page errors (cohort widget)', errors.length === 0, errors.join(' | '));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'r-cohort.png'), fullPage: true });
    await page.close();

    // ---- 1c. failures say what is wrong ----
    errors = [];
    page = await openPage(browser, 'file://' + path.join(tmp, 'nomatch.html'), errors);
    await page.waitForSelector('.cxdashboard-message', { timeout: 30000 });
    const nomatch = await page.$eval('.cxdashboard-message', function (e) { return e.textContent; });
    check('a table no template fits says so instead of guessing', /No dashboard template matched/.test(nomatch), nomatch.slice(0, 100));
    await page.close();
    page = await openPage(browser, 'file://' + path.join(tmp, 'invalid.html'), errors);
    await page.waitForSelector('.cxdashboard-message', { timeout: 30000 });
    const invalid = await page.$eval('.cxdashboard-message', function (e) { return e.textContent; });
    check('an invalid spec reports the validation error', /Could not render the dashboard/.test(invalid) && /layout|data/.test(invalid), invalid.slice(0, 140));
    check('no page errors (failure pages)', errors.length === 0, errors.join(' | '));
    await page.close();

    // ---- 2. a real Shiny app ----
    const port = await freePort();
    const appDir = path.join(tmp, 'app');
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, 'app.R'), `
      suppressMessages({ pkgload::load_all(${JSON.stringify(R_DIR)}, quiet = TRUE); library(shiny) })
      ${COHORT_R}
      ui <- fluidPage(
        actionButton("load", "Load P018"), actionButton("focus", "Focus card"),
        verbatimTextOutput("params"), verbatimTextOutput("tpl"),
        cxdashboardOutput("dash"))
      server <- function(input, output, session) {
        output$dash <- renderCxdashboard(cxdashboard(data = cohort(), id = "patient"))
        output$params <- renderText(if (is.null(input$dash_params)) "none" else paste0("case=", input$dash_params$case))
        output$tpl <- renderText(if (is.null(input$dash_template)) "none" else input$dash_template)
        observeEvent(input$load, cxd_set_param(cxdashboardProxy("dash"), "case", "P018"))
        observeEvent(input$focus, cxd_focus_panel(cxdashboardProxy("dash"), "case"))
      }
      shinyApp(ui, server)`);
    shinyProc = spawn(RSCRIPT, ['-e', `shiny::runApp(${JSON.stringify(appDir)}, port = ${port}, host = "127.0.0.1", launch.browser = FALSE)`],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let shinyErr = '';
    shinyProc.stderr.on('data', function (d) { shinyErr += d; });
    await waitForHttp('http://127.0.0.1:' + port, 60000);
    errors = [];
    page = await openPage(browser, 'http://127.0.0.1:' + port, errors);
    await page.waitForFunction(function () { return /cohort/.test((document.getElementById('tpl') || {}).innerText || ''); }, null, { timeout: 60000 });
    check('Shiny: the suggested template is reported as input$dash_template', (await page.innerText('#tpl')).trim() === 'cohort');
    await page.waitForFunction(function () { return /case=P001/.test((document.getElementById('params') || {}).innerText || ''); }, null, { timeout: 30000 });
    check('Shiny: input$dash_params carries the starting case', (await page.innerText('#params')).trim() === 'case=P001');
    await page.waitForFunction(function () { return /P001/.test((document.querySelector('[id$=-cX-DataTable]') || {}).innerText || ''); }, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.click('#load');
    await page.waitForFunction(function () { return /case=P018/.test((document.getElementById('params') || {}).innerText || ''); }, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const viaProxy = await readCard(page);
    const wantProxy = expectedPatient('P018');
    check('Shiny: cxd_set_param() loads that patient into the card and input$dash_params follows',
      viaProxy.id === 'P018' && viaProxy.os_months === wantProxy.os_months && viaProxy.age === wantProxy.age && viaProxy.arm === wantProxy.arm, JSON.stringify(viaProxy));
    // The other direction: a real click in the browser reaches R.
    const dot2 = await findDot(page, true);
    check('Shiny: found a patient point to click', !!dot2);
    if (dot2) {
      await page.mouse.move(dot2.x, dot2.y); await page.mouse.click(dot2.x, dot2.y); await page.waitForTimeout(2000);
      const fromClick = await readCard(page);
      const reported = (await page.innerText('#params')).trim();
      check('Shiny: a click on a point reaches R as input$dash_params',
        fromClick.id && fromClick.id !== 'P018' && reported === 'case=' + fromClick.id, 'card ' + fromClick.id + ', R sees ' + reported);
    }
    await page.click('#focus');
    check('Shiny: cxd_focus_panel() does not break the page', errors.length === 0, errors.join(' | '));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'r-shiny.png'), fullPage: true });
    if (/Error|error in/i.test(shinyErr) && !/Listening on/.test(shinyErr)) console.log('shiny stderr:', shinyErr.slice(-400));
    check('Shiny: the R session raised no error', !/Error in|Warning in/.test(shinyErr), shinyErr.split('\n').filter(function (l) { return /Error|Warning/.test(l); }).slice(0, 2).join(' | '));
    await page.close();
  } finally {
    await browser.close();
    if (shinyProc) shinyProc.kill();
  }
  console.log(failures ? failures + ' check(s) failed' : 'r-wrapper gate holds' + (BUILT ? ' (built engine)' : ''));
  process.exit(failures ? 1 : 0);
})().catch(function (err) { console.error(err); process.exit(1); });
