#!/usr/bin/env node
/**
 * cxd-cx — build a CanvasXpress dashboard from a folder of R `canvasXpress`
 * snippets. The sibling of cxd-ggplot (which does the same for ggplot2 code).
 *
 *   cxd-cx <snippets-dir> [options]
 *
 * Each *.R file in <snippets-dir> must assign its canvasXpress widget to `g`; an
 * optional leading "# title: ..." comment titles the panel. Every snippet is
 * converted (once, in R, via the local canvasXpress package) into a native
 * CanvasXpress spec (its widget `$x`), then laid out as a grid of
 * `type:"cxcode"` panels and written as a dashboard spec. The charts render as
 * native, interactive CanvasXpress panels — not static images.
 *
 * Options:
 *   -o, --out <file>     Spec output path            (default: <id>.spec.json)
 *   --id <id>            Dashboard id                (default: dir basename)
 *   --title <title>      Dashboard title             (default: humanized id)
 *   --theme <t>          light | dark | auto         (default: auto)
 *   --per-row <n>        panels per row              (default: 2)
 *   --height <rows>      panel height in grid rows   (default: 7)
 *   --intro <text>       full-width intro banner (HTML allowed)
 *   --html               also write a runnable <id>.html page next to the spec
 *   --pkg <path>         canvasXpress R package source (or env CX_PKG_ROOT)
 *   --seed <n>           RNG seed for snippets        (default: 1)
 *
 * Exit status: 0 ok, 1 conversion/validation failed, 2 usage/read error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildCodePanelsDashboardSpec } from '../src/codePanelsDashboard.js';
import { validateSpec } from '../src/validateSpec.js';

var HERE = path.dirname(fileURLToPath(import.meta.url));
var USAGE = 'usage: cxd-cx <snippets-dir> [-o out.spec.json] [--id id] ' +
  '[--title t] [--theme auto] [--per-row 2] [--height 7] [--intro html] ' +
  '[--html] [--pkg path] [--seed 1]';

/** Read the string value following a flag in argv, or a default. */
function opt(argv, flag, dflt) {
  var i = argv.indexOf(flag);
  return (i !== -1 && i + 1 < argv.length) ? argv[i + 1] : dflt;
}

/** Humanize a kebab/snake id into a title. */
function humanize(id) {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) {
    return c.toUpperCase();
  });
}

/** Fail with a message and an exit code. */
function fail(msg, code) {
  process.stderr.write('cxd-cx: ' + msg + '\n');
  process.exit(code == null ? 2 : code);
}

function main() {
  var argv = process.argv.slice(2);
  var dir = argv.find(function (a) { return a[0] !== '-'; });
  if (!dir || argv.indexOf('-h') !== -1 || argv.indexOf('--help') !== -1) {
    process.stdout.write(USAGE + '\n');
    process.exit(dir ? 0 : 2);
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail('"' + dir + '" is not a directory', 2);
  }

  var id = opt(argv, '--id', path.basename(path.resolve(dir)));
  var title = opt(argv, '--title', humanize(id));
  var seed = opt(argv, '--seed', '1');
  var pkg = opt(argv, '--pkg', null);

  // 1. Convert every snippet in R → array of { key, title, spec, code }.
  var rArgs = [path.join(HERE, 'cxd-cx-convert.R'), '--dir', dir, '--seed', seed];
  if (pkg) rArgs.push('--pkg', pkg);
  var r = spawnSync('Rscript', rArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) fail('could not run Rscript (' + r.error.message + ')', 1);
  if (r.status !== 0) fail('conversion failed:\n' + (r.stderr || '').trim(), 1);

  var conversions;
  try {
    conversions = JSON.parse(r.stdout);
  } catch (e) {
    fail('converter did not emit valid JSON: ' + e.message, 1);
  }
  if (!Array.isArray(conversions) || !conversions.length) {
    fail('no charts were converted', 1);
  }

  // 2. Assemble the dashboard spec (shared with the test suite).
  var spec;
  try {
    spec = buildCodePanelsDashboardSpec(conversions, {
      id: id,
      title: title,
      theme: opt(argv, '--theme', 'auto'),
      perRow: parseInt(opt(argv, '--per-row', '2'), 10),
      panelHeight: parseInt(opt(argv, '--height', '7'), 10),
      intro: opt(argv, '--intro', undefined)
    });
  } catch (e) {
    fail(e.message, 1);
  }

  // 3. Validate before writing — never emit a spec the renderer will reject.
  var result = validateSpec(spec);
  if (result && result.errors && result.errors.length) {
    fail('assembled spec is invalid:\n  - ' + result.errors.join('\n  - '), 1);
  }

  // 4. Write the spec (and, with --html, a runnable page).
  var outFile = opt(argv, '--out', opt(argv, '-o', id + '.spec.json'));
  fs.writeFileSync(outFile, JSON.stringify(spec, null, 1) + '\n');
  process.stdout.write('wrote ' + outFile + ' (' + conversions.length + ' CanvasXpress panels)\n');

  if (argv.indexOf('--html') !== -1) {
    var htmlFile = path.join(path.dirname(outFile), id + '.html');
    fs.writeFileSync(htmlFile, pageHtml(spec, path.basename(outFile)));
    process.stdout.write('wrote ' + htmlFile + '\n');
  }
}

/** A standalone page that loads the CDN engine + UMD renderer and the spec. */
function pageHtml(spec, specBasename) {
  return '<!doctype html>\n<html lang="en" data-cx-ui-theme="' + spec.theme + '">\n' +
    '<head>\n<meta charset="utf-8"/>\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>\n' +
    '<title>' + spec.title + '</title>\n' +
    '<link href="https://www.canvasxpress.org/dist/canvasXpress.css" rel="stylesheet"/>\n' +
    '<script src="https://www.canvasxpress.org/dist/canvasXpress.min.js"></script>\n' +
    '<script src="https://www.canvasxpress.org/dist/canvasxpress-dashboards.umd.js"></script>\n' +
    '<style>body{margin:0;font-family:system-ui}#dashboard{padding:16px 24px 32px}</style>\n' +
    '</head>\n<body>\n<div id="dashboard"></div>\n<script>\n' +
    "fetch('./" + specBasename + "').then(function(r){return r.json();})\n" +
    "  .then(function(spec){return CanvasXpressDashboards.renderDashboard(spec,'dashboard');});\n" +
    '</script>\n</body></html>\n';
}

main();
