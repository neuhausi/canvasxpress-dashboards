/**
 * UI design-system lock-in: the dashboards keep using
 * the shared CanvasXpress tokens and the one dark mode (data-cx-ui-theme), and do not drift back to
 * hand-written palettes.
 *
 * The standalone checks always run. The two that need the engine checkout (the generated token
 * fallback is current; the shared ratchet over both repos) run only when ../canvas-ai is present
 * (CX_ENGINE_DIR overrides), so CI without the engine still passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

var root = join(dirname(fileURLToPath(import.meta.url)), '..');
var engine = resolve(process.env.CX_ENGINE_DIR || join(root, '..', 'canvas-ai'));
var hasEngine = existsSync(join(engine, 'tools', 'ui-consistency', 'tokens.json'));

// The pages that carry dashboards chrome (narrative.html is an editorial page with its own design)
function pages() {
  var ex = readdirSync(join(root, 'examples')).filter(function (f) { return /\.html$/.test(f); })
    .map(function (f) { return join('examples', f); });
  return ex.concat(['server/src/cxd_server/static/view.html', 'server/src/cxd_server/static/shared.html']);
}

/** CSS of a page or module with scripts removed (a JS matchMedia call is fine, a stylesheet block is not). */
function styleText(rel) {
  var text = readFileSync(join(root, rel), 'utf8');
  return /\.js$/.test(rel) ? text : text.replace(/<script[\s\S]*?<\/script>/g, '');
}

test('one dark mode: no OS-only dark stylesheet outside the generated tokens', function () {
  var offenders = pages().concat(['examples/example-header.css', 'src/styles.js', 'src/exportDashboard.js'])
    .filter(function (rel) {
      // A dark @media block is allowed only as the auto theme's (it selects [data-cx-ui-theme="auto"])
      var blocks = styleText(rel).split(/prefers-color-scheme:\s*dark\)\s*\{/).slice(1);
      return blocks.some(function (b) { return !/^[^{]*\[data-cx-ui-theme="auto"\]/.test(b); });
    });
  assert.deepEqual(offenders, [], 'use the --cx-ui-* roles + data-cx-ui-theme, not a @media dark block');
});

test('every page opts into the shared theme switch', function () {
  var missing = pages().filter(function (rel) {
    return !/<html[^>]*data-cx-ui-theme="(auto|light|dark)"/.test(readFileSync(join(root, rel), 'utf8'));
  });
  assert.deepEqual(missing, [], 'add data-cx-ui-theme="auto" to <html>');
});

test('dashboardCss carries the token fallback and the theme blocks', async function () {
  var styles = await import('../src/styles.js');
  assert.match(styles.dashboardCss, /:where\(:root\) \{ --cx-color-/);
  assert.match(styles.dashboardCss, /\[data-cx-ui-theme="dark"\]/);
  assert.match(styles.dashboardCss, /:where\(:root, \[data-cx-ui-theme\]\) \{ --cxd-border: var\(--cx-ui-border\)/);
});

test('the generated token fallback matches the engine tokens', { skip: !hasEngine && 'no canvas-ai checkout' }, function () {
  execFileSync(process.execPath, [join(root, 'scripts', 'gen-ui-tokens.mjs'), '--check'],
    { env: Object.assign({}, process.env, { CX_TOKENS: join(engine, 'tools', 'ui-consistency', 'tokens.json') }), stdio: 'pipe' });
});

test('the UI ratchet (both repos) has not risen', { skip: !hasEngine && 'no canvas-ai checkout' }, function () {
  execFileSync(process.execPath, [join(engine, 'tools', 'ui-consistency', 'inventory.mjs'), '--check', '--dashboards', root],
    { stdio: 'pipe' });
});
