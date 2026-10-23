/**
 * The language wrappers (r/, python/) ship a copy of the dashboards bundle. It must be the one
 * `npm run build` produces, so a wrapper can never render with a stale renderer. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

var root = join(fileURLToPath(import.meta.url), '..', '..');
var dist = readFileSync(join(root, 'dist', 'canvasxpress-dashboards.umd.js'));
var COPIES = {
  'r/': join(root, 'r', 'inst', 'htmlwidgets', 'lib', 'canvasxpress-dashboards', 'canvasxpress-dashboards.umd.js'),
  'python/': join(root, 'python', 'src', 'canvasxpress_dashboards', 'assets', 'canvasxpress-dashboards.umd.js')
};

Object.keys(COPIES).forEach(function (wrapper) {
  test('the ' + wrapper + ' wrapper bundles exactly the built dashboards bundle', function (t) {
    if (!existsSync(join(root, wrapper))) { t.skip(wrapper + ' not present'); return; }
    assert.ok(existsSync(COPIES[wrapper]), 'bundle copied into ' + wrapper + ' (run `npm run build`)');
    assert.ok(readFileSync(COPIES[wrapper]).equals(dist), wrapper + ' has a stale bundle: run `npm run build`');
  });
});

test('the R widget declares the same version as the package', function () {
  var yaml = readFileSync(join(root, 'r', 'inst', 'htmlwidgets', 'cxdashboard.yaml'), 'utf8');
  var pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(yaml, new RegExp('version: ' + pkg.version.replace(/\./g, '\\.')));
});
