/**
 * The two distributables load and expose the same public API as src/index.js. Builds into a temp
 * directory (CXD_BUILD_OUT leaves dist/ and server/static untouched). Run with `node --test`.
 *
 * Why this exists: every module is inlined into one scope, so a name declared in two modules made
 * the ESM bundle fail to load (and silently swapped one module's helper for the other's in the UMD
 * bundle) — node tests that import modules one by one never noticed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';

var root = join(fileURLToPath(import.meta.url), '..', '..');
var out = mkdtempSync(join(tmpdir(), 'cxd-bundle-'));
execFileSync('node', [join(root, 'scripts', 'build.mjs')], { env: Object.assign({}, process.env, { CXD_BUILD_OUT: out }), stdio: 'ignore' });

// The public API: every name src/index.js exports.
var indexNames = [];
readFileSync(join(root, 'src', 'index.js'), 'utf8').replace(/export\s*\{([^}]*)\}/g, function (m, list) {
  list.split(',').forEach(function (n) { n = n.trim().split(/\s+as\s+/).pop(); if (n) indexNames.push(n); });
  return m;
});

test('the ESM bundle loads and exports the whole public API', async function () {
  var mod = await import(pathToFileURL(join(out, 'canvasxpress-dashboards.esm.js')).href);
  indexNames.forEach(function (name) { assert.equal(typeof mod[name] !== 'undefined', true, name + ' is exported'); });
  assert.equal(typeof mod.suggestDashboard, 'function');
  assert.equal(typeof mod.renderDashboard, 'function');
});

test('the UMD bundle loads and exposes the same API', function () {
  var sandbox = { self: {}, console: console };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(out, 'canvasxpress-dashboards.umd.js'), 'utf8'), sandbox);
  var api = sandbox.self.CanvasXpressDashboards || sandbox.CanvasXpressDashboards;
  assert.ok(api, 'global CanvasXpressDashboards');
  indexNames.forEach(function (name) { assert.equal(typeof api[name] !== 'undefined', true, name + ' is exposed'); });
});

test('a bundled helper keeps its own module behavior (no name shadowing)', async function () {
  // pushdown treats only null / NaN as missing; the wizard also treats "NA", "" and "-" as missing.
  var mod = await import(pathToFileURL(join(out, 'canvasxpress-dashboards.esm.js')).href);
  var data = { y: { vars: ['n'], smps: ['a', 'b', 'c'], data: [[1, 2, 3]] }, x: { tag: ['NA', 'x', ''] } };
  var res = mod.runPushdown ? mod.runPushdown(data, { where: [{ column: 'tag', op: 'not_null' }] }) : null;
  if (res) assert.deepEqual(res.y.smps, ['a', 'b', 'c'], '"NA" and "" are values to pushdown, not missing');
  assert.equal(mod.profileColumns([['Id', 'c'], ['r1', 'NA'], ['r2', '1'], ['r3', '2']])[1].missing, 1, 'the wizard still counts NA as missing');
});
