#!/usr/bin/env node
/**
 * cxd-spec — work with dashboard spec files from the command line / git.
 *
 *   cxd-spec validate <spec.json>            report errors (exit 1) and warnings
 *   cxd-spec migrate  <spec.json> [--write]  upgrade to the current format version
 *   cxd-spec format   <spec.json> [--write]  canonical text (stable key order)
 *   cxd-spec diff     <a.json> <b.json> [--json]
 *                                            structural diff; exit 0 equal, 1 different
 *
 * `format` doubles as a git textconv so dashboards diff readably:
 *   git config diff.cxd.textconv "cxd-spec format"
 *   echo '*.spec.json diff=cxd' >> .gitattributes
 *
 * Exit status 2 means a usage or read error.
 */
import fs from 'node:fs';
import { validateSpec } from '../src/validateSpec.js';
import { migrateSpec, serializeSpec, dashboardDiff, DASHBOARD_SCHEMA_VERSION } from '../src/spec.js';

var USAGE = 'usage: cxd-spec validate|migrate|format <spec.json> [--write]\n' +
  '       cxd-spec diff <a.json> <b.json> [--json]\n' +
  '(dashboard spec format ' + DASHBOARD_SCHEMA_VERSION + ')';

/**
 * Read and parse a spec file.
 * @param {string} file - Path.
 * @returns {object} The parsed spec.
 */
function read(file) {
  var text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(file + ': not valid JSON (' + e.message + ')');
  }
}

/**
 * Run a command.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {number} Exit status.
 */
function main(argv) {
  var flags = argv.filter(function (a) { return a.indexOf('--') === 0; });
  var args = argv.filter(function (a) { return a.indexOf('--') !== 0; });
  var command = args[0];
  var write = flags.indexOf('--write') !== -1;
  if (command === 'validate' && args.length === 2) {
    var result = validateSpec(read(args[1]));
    (result.warnings || []).forEach(function (w) { console.error('warning: ' + w); });
    result.errors.forEach(function (e) { console.error('error: ' + e); });
    if (result.valid) console.log(args[1] + ': valid');
    return result.valid ? 0 : 1;
  }
  if ((command === 'migrate' || command === 'format') && args.length === 2) {
    var spec = read(args[1]);
    if (command === 'migrate') {
      var migration = migrateSpec(spec);
      migration.warnings.forEach(function (w) { console.error('warning: ' + w); });
      console.error(args[1] + ': ' + migration.from + ' -> ' + migration.to +
        (migration.applied.length ? ' (' + migration.applied.join(', ') + ')' : ' (no change)'));
      spec = migration.spec;
    }
    var text = serializeSpec(spec);
    if (write) fs.writeFileSync(args[1], text);
    else process.stdout.write(text);
    return 0;
  }
  if (command === 'diff' && args.length === 3) {
    var d = dashboardDiff(read(args[1]), read(args[2]));
    var same = !d.added.length && !d.removed.length && !d.changed.length;
    if (flags.indexOf('--json') !== -1) console.log(JSON.stringify(d, null, 2));
    else if (same) console.log('no differences');
    else d.summary.forEach(function (line) { console.log(line); });
    return same ? 0 : 1;
  }
  console.error(USAGE);
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error('cxd-spec: ' + e.message);
  process.exitCode = 2;
}
