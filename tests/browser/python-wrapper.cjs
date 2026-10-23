/*
 * The Python wrapper (python/, package canvasxpress-dashboards) in a real browser, driven by real Python.
 *
 *  1. Python writes standalone pages (Dashboard.save): a hand-built spec with cxd_data(), a pandas
 *     DataFrame turned into a cohort dashboard, a table no template fits, an invalid spec. Charts must
 *     draw, the right template must be chosen, a click must load a patient into the case card, and
 *     failures must say what is wrong.
 *  2. A notebook-style host page embeds the cell output (Dashboard._repr_html_): the iframe must grow to
 *     the dashboard, and the host must receive the messages the frame posts (resize, and the case param).
 *  3. A real Flask app and a real Dash app (an <iframe srcDoc>) serve a dashboard.
 *
 * Streamlit and Shiny for Python are not exercised here (not installed); the same page goes through
 * streamlit.components.v1.html / shiny.ui.HTML.
 *
 * The engine is the sibling canvas-ai checkout (source by default; CX_ENGINE_BUILT=1 for the release build).
 * Run: PLAYWRIGHT_MODULE=… node tests/browser/python-wrapper.cjs
 *   PYTHON (default python3) needs pandas; PYTHON_WEB (default ~/git/.venv/bin/python) needs flask and dash.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { routeEngine, BUILT } = require('./engine-route.cjs');
const { expectedPatient, readCard, findDot, INK } = require('./dashboard-probes.cjs');

let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch (e) {
  console.log('python-wrapper: needs playwright — set PLAYWRIGHT_MODULE to an installed copy.');
  process.exit(2);
}
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
const PY_SRC = path.join(PY_DIR, 'src');
const PYTHON = process.env.PYTHON || 'python3';
const PYTHON_WEB = process.env.PYTHON_WEB || path.join(os.homedir(), 'git', '.venv', 'bin', 'python');
const SHOTS = process.env.CXD_SHOT_DIR || '';

const COHORT_PY = `
import pandas as pd
def cohort(n=40):
    k = list(range(n))
    return pd.DataFrame({
        "patient": ["P%03d" % (i + 1) for i in k], "os_months": [3 + (i * 7) % 40 for i in k],
        "os_event": [0 if i % 3 == 0 else 1 for i in k], "age": [40 + (i * 5) % 35 for i in k],
        "CD274": [2 + (i * 3) % 9 for i in k], "arm": ["Drug" if i % 2 else "Placebo" for i in k],
        "stage": [["I", "II", "III"][i % 3] for i in k]})
`;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}
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
async function openPage(browser, url, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', function (e) { errors.push(e.message); });
  await routeEngine(page);
  await page.goto(url);
  return page;
}
/** Click a patient's point inside an iframe: find it in the frame, then add the iframe's page offset. */
async function clickDotInFrame(page, frame, fromEnd) {
  const dot = await findDot(frame, fromEnd);
  if (!dot) return false;
  await page.waitForTimeout(300);                               // let the scroll the probe did settle
  const box = await (await frame.frameElement()).boundingBox();
  const again = await findDot(frame, fromEnd);                  // recomputed after the scroll
  await page.mouse.move(box.x + again.x, box.y + again.y);
  await page.mouse.click(box.x + again.x, box.y + again.y);
  return true;
}
function frameOf(page) { return page.frames().filter(function (f) { return f !== page.mainFrame(); })[0]; }

(async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cxd-py-'));
  const procs = [];
  process.on('exit', function () { procs.forEach(function (p) { try { p.kill(); } catch (e) { /* gone */ } }); });
  const env = Object.assign({}, process.env, { PYTHONPATH: PY_SRC });

  // ---- 1. Python writes the standalone pages ----
  const gen = `
${COHORT_PY}
import os
from canvasxpress_dashboards import Dashboard, cxd_data
out = ${JSON.stringify(tmp)}
sales = {"region": ["North", "South", "East", "West"], "revenue": [820, 640, 710, 500], "units": [80, 60, 70, 45]}
spec = {"id": "sales", "title": "Sales from Python",
  "layout": {"cols": 12, "rowHeight": 30, "gap": 12, "items": [
    {"panel": "filters", "x": 0, "y": 0, "w": 3, "h": 12}, {"panel": "bars", "x": 3, "y": 0, "w": 9, "h": 12}]},
  "data": {"d": {"kind": "inline", "value": cxd_data(sales)}},
  "panels": {"filters": {"type": "filters", "title": "Filters", "dataRef": "d", "fields": ["region"]},
             "bars": {"title": "Revenue by record", "dataRef": "d",
                      "config": {"graphType": "Bar", "xAxis": ["revenue"], "colorBy": "region", "title": False}}}}
Dashboard(spec).save(os.path.join(out, "spec.html"))
Dashboard(data=cohort(), id="patient", title="Trial from Python").save(os.path.join(out, "cohort.html"))
Dashboard(data={"a": [1, 2, 3, 4, 5, 6], "b": [6, 5, 4, 3, 2, 1]}).save(os.path.join(out, "nomatch.html"))
Dashboard('{"id": "broken", "panels": {}}').save(os.path.join(out, "invalid.html"))
# A notebook-style host: the cell output (an iframe) inside a page that records the messages it receives.
host = ("<!doctype html><html><body><script>window.__msgs=[];addEventListener('message',function(e){window.__msgs.push(e.data)})</script>"
        + Dashboard(data=cohort(), id="patient", height=150)._repr_html_() + "</body></html>")
open(os.path.join(out, "host.html"), "w", encoding="utf-8").write(host)
print("generated")`;
  const made = spawnSync(PYTHON, ['-c', gen], { encoding: 'utf8', env: env });
  check('Python generated the pages', made.status === 0 && /generated/.test(made.stdout), (made.stderr || '').split('\n').slice(-3).join(' | '));
  if (made.status !== 0) { console.log(made.stdout, made.stderr); process.exit(1); }

  const browser = await playwright.chromium.launch();
  try {
    // ---- 1a. a hand-built spec ----
    let errors = [];
    let page = await openPage(browser, 'file://' + path.join(tmp, 'spec.html'), errors);
    await page.waitForSelector('.cxd-filters', { timeout: 30000 });
    await page.waitForTimeout(2500);
    const specInk = await page.evaluate(INK);
    check('a spec dashboard renders its chart', specInk.filter(function (n) { return n > 1500; }).length >= 1, JSON.stringify(specInk));
    const text = await page.evaluate(function () { return document.body.innerText; });
    check('the filters panel offers the annotation from cxd_data()', /region/.test(text) && /North/.test(text));
    check('no page errors (spec)', errors.length === 0, errors.join(' | '));
    await page.close();

    // ---- 1b. a DataFrame becomes a cohort dashboard ----
    errors = [];
    page = await openPage(browser, 'file://' + path.join(tmp, 'cohort.html'), errors);
    await page.waitForSelector('.cxd-filters', { timeout: 30000 });
    await page.waitForFunction(function () { return /P001/.test((document.querySelector('[id$=-cX-DataTable]') || {}).innerText || ''); }, null, { timeout: 30000 });
    await page.waitForTimeout(2000);
    const titles = await page.$$eval('.cxd-panel-title, [class*=panel] [class*=title]', function (els) { return els.map(function (e) { return e.textContent.trim(); }); });
    check('a DataFrame is turned into the cohort dashboard', ['Survival by arm', 'Patient record'].every(function (t) { return titles.some(function (x) { return x.indexOf(t) === 0; }); }), JSON.stringify(titles).slice(0, 160));
    const ink = await page.evaluate(INK);
    check('the cohort charts draw', ink.filter(function (n) { return n > 1500; }).length >= 3, JSON.stringify(ink));
    check('the case card starts on the first patient', (await readCard(page)).id === 'P001');
    const dot = await findDot(page, false);
    if (dot) {
      await page.mouse.move(dot.x, dot.y); await page.mouse.click(dot.x, dot.y); await page.waitForTimeout(1500);
      const c = await readCard(page); const want = c.id ? expectedPatient(c.id) : null;
      check('clicking a point loads that patient (values match the DataFrame)',
        !!want && c.os_months === want.os_months && c.age === want.age && c.arm === want.arm && c.os_event === want.os_event, JSON.stringify(c));
    } else check('found a patient point to click', false);
    check('no page errors (cohort)', errors.length === 0, errors.join(' | '));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'py-cohort.png'), fullPage: true });
    await page.close();

    // ---- 1c. failures say what is wrong ----
    errors = [];
    page = await openPage(browser, 'file://' + path.join(tmp, 'nomatch.html'), errors);
    await page.waitForSelector('.cxdashboard-message', { timeout: 30000 });
    check('a table no template fits says so instead of guessing', /No dashboard template matched/.test(await page.$eval('.cxdashboard-message', function (e) { return e.textContent; })));
    await page.close();
    page = await openPage(browser, 'file://' + path.join(tmp, 'invalid.html'), errors);
    await page.waitForSelector('.cxdashboard-message', { timeout: 30000 });
    const invalid = await page.$eval('.cxdashboard-message', function (e) { return e.textContent; });
    check('an invalid spec reports the validation error', /Could not render the dashboard/.test(invalid) && /layout|data/.test(invalid), invalid.slice(0, 120));
    check('no page errors (failure pages)', errors.length === 0, errors.join(' | '));
    await page.close();

    // ---- 2. a notebook cell output: the iframe follows the dashboard, the host hears from it ----
    errors = [];
    page = await openPage(browser, 'file://' + path.join(tmp, 'host.html'), errors);
    // The starting height is part of the generated markup (the page has grown it by the time goto returns).
    check('the notebook output starts at its configured height', /<iframe[^>]*style="[^"]*height:150px/.test(fs.readFileSync(path.join(tmp, 'host.html'), 'utf8')));
    await page.waitForFunction(function () { return document.querySelector('iframe').getBoundingClientRect().height > 600; }, null, { timeout: 30000 });
    const grown = await page.$eval('iframe', function (f) { return f.getBoundingClientRect().height; });
    check('the iframe grows to the dashboard (it listens for the frame resize messages)', grown > 600, 'height ' + Math.round(grown));
    let frame = frameOf(page);
    await frame.waitForFunction(function () { return /P001/.test((document.querySelector('[id$=-cX-DataTable]') || {}).innerText || ''); }, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    check('the dashboard inside the frame starts on the first patient', (await readCard(frame)).id === 'P001');
    const clicked = await clickDotInFrame(page, frame, false);
    check('found a patient point inside the frame', clicked);
    if (clicked) {
      await page.waitForTimeout(2000);
      const c = await readCard(frame);
      const msgs = await page.evaluate(function () { return window.__msgs; });
      const params = msgs.filter(function (m) { return m && m.type === 'cxd-params'; });
      check('a click inside the frame loads the patient', !!c.id && c.id !== 'P001' && c.os_months === expectedPatient(c.id).os_months, JSON.stringify(c));
      check('the host page is told the new case (postMessage cxd-params)', params.length >= 1 && params[params.length - 1].params.case === c.id,
        'last: ' + JSON.stringify(params[params.length - 1]) + ' card ' + c.id);
      check('the host page is told the height (postMessage cxd-resize)', msgs.some(function (m) { return m && m.type === 'cxd-resize' && m.height > 600; }));
    }
    check('no page errors (notebook output)', errors.length === 0, errors.join(' | '));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'py-notebook.png'), fullPage: true });
    await page.close();

    // ---- 3. Flask and Dash ----
    const webProbe = spawnSync(PYTHON_WEB, ['-c', 'import flask, dash, pandas'], { encoding: 'utf8', env: env });
    if (webProbe.status !== 0) {
      console.log('skip Flask/Dash: ' + PYTHON_WEB + ' lacks flask, dash or pandas (set PYTHON_WEB)');
    } else {
      const fport = await freePort(), dport = await freePort();
      fs.writeFileSync(path.join(tmp, 'flask_app.py'), COHORT_PY + `
from flask import Flask
from canvasxpress_dashboards import Dashboard
app = Flask(__name__)
@app.route("/")
def index():
    return Dashboard(data=cohort(), id="patient", title="Flask trial").to_html()
app.run(host="127.0.0.1", port=${fport})`);
      fs.writeFileSync(path.join(tmp, 'dash_app.py'), COHORT_PY + `
from dash import Dash, html
from canvasxpress_dashboards import Dashboard
app = Dash(__name__)
app.layout = html.Div([html.H3("Trial in Dash"),
    html.Iframe(srcDoc=Dashboard(data=cohort(), id="patient").to_html(frame=True), style={"width": "100%", "height": "1500px", "border": "0"})])
app.run(host="127.0.0.1", port=${dport}, debug=False)`);
      ['flask_app.py', 'dash_app.py'].forEach(function (file) {
        const p = spawn(PYTHON_WEB, [path.join(tmp, file)], { env: env, stdio: ['ignore', 'ignore', 'pipe'] });
        procs.push(p);
      });
      await waitForHttp('http://127.0.0.1:' + fport + '/', 60000);
      await waitForHttp('http://127.0.0.1:' + dport + '/', 60000);

      errors = [];
      page = await openPage(browser, 'http://127.0.0.1:' + fport + '/', errors);
      await page.waitForFunction(function () { return /P001/.test((document.querySelector('[id$=-cX-DataTable]') || {}).innerText || ''); }, null, { timeout: 30000 });
      await page.waitForTimeout(1500);
      check('Flask: a view returning Dashboard.to_html() serves the cohort dashboard', (await readCard(page)).id === 'P001');
      const fdot = await findDot(page, false);
      if (fdot) {
        await page.mouse.move(fdot.x, fdot.y); await page.mouse.click(fdot.x, fdot.y); await page.waitForTimeout(1500);
        const c = await readCard(page);
        check('Flask: a click loads that patient', !!c.id && c.os_months === expectedPatient(c.id).os_months, JSON.stringify(c));
      }
      check('Flask: no page errors', errors.length === 0, errors.join(' | '));
      await page.close();

      errors = [];
      page = await openPage(browser, 'http://127.0.0.1:' + dport + '/', errors);
      await page.waitForSelector('iframe', { timeout: 60000 });
      frame = frameOf(page);
      await frame.waitForFunction(function () { return /P001/.test((document.querySelector('[id$=-cX-DataTable]') || {}).innerText || ''); }, null, { timeout: 60000 });
      await page.waitForTimeout(1500);
      check('Dash: an html.Iframe(srcDoc=Dashboard.to_html()) serves the cohort dashboard', (await readCard(frame)).id === 'P001');
      const dink = await frame.evaluate(INK);
      check('Dash: the charts draw inside the frame', dink.filter(function (n) { return n > 1500; }).length >= 3, JSON.stringify(dink));
      const dclicked = await clickDotInFrame(page, frame, false);
      if (dclicked) {
        await page.waitForTimeout(2000);
        const c = await readCard(frame);
        check('Dash: a click inside the frame loads that patient', !!c.id && c.id !== 'P001' && c.os_months === expectedPatient(c.id).os_months, JSON.stringify(c));
      } else check('Dash: found a patient point to click', false);
      check('Dash: no page errors', errors.length === 0, errors.join(' | '));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'py-dash.png') });
      await page.close();
    }
  } finally {
    await browser.close();
    procs.forEach(function (p) { try { p.kill(); } catch (e) { /* gone */ } });
  }
  console.log(failures ? failures + ' check(s) failed' : 'python-wrapper gate holds' + (BUILT ? ' (built engine)' : ''));
  process.exit(failures ? 1 : 0);
})().catch(function (err) { console.error(err); process.exit(1); });
