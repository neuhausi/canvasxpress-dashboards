/**
 * Zero-dependency bundler for canvasxpress-dashboards.
 *
 * The source is authored as small ES modules under `src/`. This script inlines
 * them (in dependency order) into two distributable artifacts:
 *
 *   dist/canvasxpress-dashboards.esm.js  — ESM, named exports
 *   dist/canvasxpress-dashboards.umd.js  — UMD, global `CanvasXpressDashboards`
 *
 * It intentionally avoids a bundler toolchain: the module graph is small and
 * flat (no circular deps, only named exports), so inlining is a line transform.
 *
 * Run: `node scripts/build.mjs`
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

var here = dirname(fileURLToPath(import.meta.url));
var root = join(here, '..');
var srcDir = join(root, 'src');
var distDir = join(root, 'dist');

// Dependency order — leaves first, entry last-ish. index.js only re-exports.
var MODULES = ['styles.js', 'dataStore.js', 'gridLayout.js', 'validateSpec.js', 'renderDashboard.js', 'persistence.js', 'builderModel.js', 'builder.js'];

// Public API exposed by both bundles.
var EXPORTS = [
  'renderDashboard',
  'validateSpec',
  'dashboardCss',
  'injectStyles',
  'createDataStore',
  'isEmptyData',
  'DataError',
  'clearSharedCache',
  'exportSpec',
  'importSpecFromFile',
  'parseAndValidate',
  'createDashboardClient',
  'createBuilder',
  'pointerToCell',
  'csvToCx',
  'buildDataSource',
  'addPanel',
  'removePanel',
  'movePanel',
  'resizePanel',
  'resolveCollisions',
  'updatePanel',
  'setDataSource',
  'updateSettings',
  'blankSpec',
  'DEFAULT_COLS'
];
var VERSION = readVersion();

/**
 * Strip ESM import/export syntax from a module body so it can be inlined.
 * @param {string} code - Raw module source.
 * @returns {string} Body with imports removed and `export ` prefixes dropped.
 */
function stripModule(code) {
  return code
    // Drop `import { ... } from './x.js';` lines (internal deps are inlined).
    .replace(/^\s*import\s+[^;]*;\s*$/gm, '')
    // Drop `export { ... } from '...';` re-export lines.
    .replace(/^\s*export\s+\{[^}]*\}\s+from\s+[^;]*;\s*$/gm, '')
    // Turn `export function foo` / `export var foo` into plain declarations.
    .replace(/^\s*export\s+(function|var|const|let|class)\b/gm, '$1');
}

var body = MODULES
  .map(function (name) {
    var code = readFileSync(join(srcDir, name), 'utf8');
    return '/* ==== src/' + name + ' ==== */\n' + stripModule(code).trim() + '\n';
  })
  .join('\n');

var apiObject =
  'var CanvasXpressDashboards = {\n' +
  EXPORTS.map(function (n) { return '  ' + n + ': ' + n; }).join(',\n') +
  ',\n  version: ' + JSON.stringify(VERSION) + '\n};';

mkdirSync(distDir, { recursive: true });

// --- ESM bundle ---
var esm =
  banner('ESM') +
  body +
  '\nvar version = ' + JSON.stringify(VERSION) + ';\n' +
  'export { ' + EXPORTS.join(', ') + ', version };\n' +
  'export default { ' + EXPORTS.join(', ') + ', version };\n';
writeFileSync(join(distDir, 'canvasxpress-dashboards.esm.js'), esm);

// --- UMD bundle ---
var umd =
  banner('UMD') +
  '(function (root, factory) {\n' +
  '  if (typeof define === "function" && define.amd) { define([], factory); }\n' +
  '  else if (typeof module === "object" && module.exports) { module.exports = factory(); }\n' +
  '  else { root.CanvasXpressDashboards = factory(); }\n' +
  '}(typeof self !== "undefined" ? self : this, function () {\n' +
  '"use strict";\n' +
  body + '\n' +
  apiObject + '\n' +
  'return CanvasXpressDashboards;\n' +
  '}));\n';
writeFileSync(join(distDir, 'canvasxpress-dashboards.umd.js'), umd);

// Mirror the UMD bundle into the server's static dir so the shared viewer is
// self-contained when served by cxd_server, and generate the first-class app
// shell (index.html) from the single-source dev page (examples/builder.html),
// swapping its dev asset URLs for production ones so cxd_server serves the full
// no-code app at `/`.
var serverStatic = join(root, 'server', 'src', 'cxd_server', 'static');
try {
  mkdirSync(serverStatic, { recursive: true });
  writeFileSync(join(serverStatic, 'canvasxpress-dashboards.umd.js'), umd);
  writeFileSync(join(serverStatic, 'index.html'), buildAppShell());
} catch (e) {
  // Server package may be absent in a slim checkout — non-fatal.
}

console.log('Built dist/canvasxpress-dashboards.esm.js and .umd.js (v' + VERSION + ')');

/**
 * Build the production app shell (served at `/` by cxd_server) from the
 * single-source dev page. The dev page (examples/builder.html) loads the
 * dashboards bundle from `../dist` with a cache-buster inside a CX-LIB-START…END
 * block; the served app loads the bundle from the same origin (so `/api/*` needs
 * no CORS) and gets its CanvasXpress tags from the CXD_HEAD block that cxd_server
 * fills at serve time. Only the `<head>` asset block changes; the body + app
 * logic stay identical, so there is one source of truth.
 * @returns {string} The generated index.html.
 */
function buildAppShell() {
  var devPage = readFileSync(join(root, 'examples', 'builder.html'), 'utf8');
  // cxd_server replaces the CXD_HEAD_START…END block at serve time to inject the
  // CanvasXpress license (window.cX), the configured library URL, and client
  // config. The CDN defaults inside keep the page working on a plain static host
  // (no license / default library) when it is NOT served by cxd_server.
  var prodHead =
    '  <!-- Generated from examples/builder.html by scripts/build.mjs. Do not edit. -->\n' +
    '  <!--CXD_HEAD_START-->\n' +
    '  <link href="https://www.canvasxpress.org/dist/canvasXpress.css" rel="stylesheet" />\n' +
    '  <script src="https://www.canvasxpress.org/dist/canvasXpress.min.js"></script>\n' +
    '  <!--CXD_HEAD_END-->\n' +
    '  <script src="canvasxpress-dashboards.umd.js"></script>';
  // Replace the dev asset block (the CX-LIB-START…END markers wrap the
  // CanvasXpress tags + the cache-busting document.write bundle loader).
  var shell = devPage.replace(
    /  <!--CX-LIB-START[\s\S]*?<!--CX-LIB-END-->/,
    prodHead
  );
  if (shell === devPage) {
    throw new Error('buildAppShell: dev asset block not found in examples/builder.html');
  }
  return shell;
}

/**
 * Read the package version from package.json.
 * @returns {string} The version string.
 */
function readVersion() {
  try {
    var pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

/**
 * Build a file banner comment.
 * @param {string} kind - Bundle kind label.
 * @returns {string} The banner text.
 */
function banner(kind) {
  return '/* canvasxpress-dashboards ' + VERSION + ' (' + kind + ') — generated by scripts/build.mjs. Do not edit. */\n';
}
