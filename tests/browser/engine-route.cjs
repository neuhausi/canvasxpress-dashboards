/**
 * Route the CDN CanvasXpress engine to the sibling canvas-ai checkout so a browser gate is offline and
 * deterministic. Default: the engine SOURCE files concatenated in the order the engine's own render
 * harness loads them (an uncommitted engine edit is tested without a build); CX_ENGINE_BUILT=1: the
 * built canvasXpress.min.js a release ships. CX_ENGINE_DIR overrides the `build` directory.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINE_DIR = process.env.CX_ENGINE_DIR || path.join(os.homedir(), 'git', 'canvas-ai', 'build');
const ENGINE_ROOT = path.resolve(ENGINE_DIR, '..');
const BUILT = process.env.CX_ENGINE_BUILT === '1';

function engineJs() {
  const harness = path.join(ENGINE_ROOT, 'tests', 'regression', 'render-harness.html');
  if (!BUILT && fs.existsSync(harness)) {
    const list = fs.readFileSync(harness, 'utf8').match(/CX_FILES\s*=\s*\[([\s\S]*?)\]/);
    const files = list ? list[1].match(/canvasXpress\.[\w]+\.js/g) : null;
    if (files && files.length) {
      return files.map(function (f) { return fs.readFileSync(path.join(ENGINE_DIR, 'js', f), 'utf8'); }).join('\n;\n');
    }
  }
  return fs.readFileSync(path.join(ENGINE_DIR, 'js', 'canvasXpress.min.js'), 'utf8');
}

function engineCss() {
  if (BUILT) return fs.readFileSync(path.join(ENGINE_DIR, 'css', 'canvasXpress.min.css'), 'utf8');
  const dir = path.join(ENGINE_DIR, 'css', 'widgets');
  return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.css'); }).sort()
    .map(function (f) { return fs.readFileSync(path.join(dir, f), 'utf8'); }).join('');
}

const JS = engineJs();
const CSS = engineCss();

/** Serve the engine to a page asking the canvasxpress.org CDN for it. */
function routeEngine(page) {
  return Promise.all([
    page.route(/canvasxpress\.org\/dist\/canvasXpress\.min\.js/, function (route) {
      route.fulfill({ body: JS, contentType: 'text/javascript' });
    }),
    page.route(/canvasxpress\.org\/dist\/canvasXpress\.css/, function (route) {
      route.fulfill({ body: CSS, contentType: 'text/css' });
    })
  ]);
}

module.exports = { routeEngine, BUILT };
