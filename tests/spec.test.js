/**
 * Unit tests for the portable, versioned spec: format version & compatibility,
 * migration, canonical serialization, and the dashboard-aware diff.
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateSpec, specCompatibility, parseSchemaVersion, serializeSpec, canonicalSpec,
  dashboardDiff, dashboardsEqual, DASHBOARD_SCHEMA_VERSION
} from '../src/spec.js';

var SPEC = {
  id: 'sales',
  title: 'Sales',
  layout: { cols: 12, items: [
    { panel: 'bar', x: 0, y: 0, w: 6, h: 3 },
    { panel: 'pie', x: 6, y: 0, w: 6, h: 3 }
  ] },
  data: { s: { kind: 'inline', value: { y: { vars: ['R'], smps: ['A'], data: [[1]] } } } },
  panels: {
    bar: { dataRef: 's', config: { graphType: 'Bar' } },
    pie: { dataRef: 's', config: { graphType: 'Pie' } }
  }
};

/**
 * Deep copy.
 * @param {*} v - Value.
 * @returns {*} Copy.
 */
function clone(v) { return JSON.parse(JSON.stringify(v)); }

test('versions parse as MAJOR.MINOR; an unstamped spec is the legacy 1.0', function () {
  assert.deepEqual(parseSchemaVersion(undefined), { major: 1, minor: 0 });
  assert.deepEqual(parseSchemaVersion('2.13'), { major: 2, minor: 13 });
  assert.equal(parseSchemaVersion('1'), null);
  assert.equal(parseSchemaVersion(1.1), null);
  assert.equal(parseSchemaVersion('1.1\n'), null);
});

test('compatibility: older / current / newer-minor / newer-major / invalid', function () {
  assert.equal(specCompatibility({}).status, 'older');
  assert.equal(specCompatibility({ schemaVersion: DASHBOARD_SCHEMA_VERSION }).status, 'current');
  assert.equal(specCompatibility({ schemaVersion: '1.9' }).status, 'newer-minor');
  assert.equal(specCompatibility({ schemaVersion: '2.0' }).status, 'newer-major');
  assert.equal(specCompatibility({ schemaVersion: 'x' }).status, 'invalid');
});

test('migrateSpec stamps the current version without touching the input', function () {
  var input = clone(SPEC);
  var out = migrateSpec(input);
  assert.equal(out.from, '1.0');
  assert.equal(out.to, DASHBOARD_SCHEMA_VERSION);
  assert.deepEqual(out.applied, ['1.0 -> 1.1', '1.1 -> 1.2']);
  assert.equal(out.spec.schemaVersion, DASHBOARD_SCHEMA_VERSION);
  assert.equal('schemaVersion' in input, false, 'input not modified');
  assert.deepEqual(migrateSpec(out.spec).applied, [], 'idempotent on a current spec');
});

test('migrateSpec keeps author-supplied functions (shallow copy)', function () {
  var click = function () {};
  var input = clone(SPEC);
  input.panels.bar.events = { click: click };
  assert.equal(migrateSpec(input).spec.panels.bar.events.click, click);
});

test('migrateSpec refuses a newer MAJOR and a malformed stamp; warns on a newer MINOR', function () {
  assert.throws(function () { migrateSpec(Object.assign(clone(SPEC), { schemaVersion: '2.0' })); }, /needs a newer canvasxpress-dashboards/);
  assert.throws(function () { migrateSpec(Object.assign(clone(SPEC), { schemaVersion: 'v1' })); }, /must be "MAJOR.MINOR"/);
  var newer = migrateSpec(Object.assign(clone(SPEC), { schemaVersion: '1.9' }));
  assert.equal(newer.spec.schemaVersion, '1.9', 'a newer minor keeps its own stamp');
  assert.equal(newer.warnings.length, 1);
});

test('serializeSpec: canonical top-level order, stable text, trailing newline', function () {
  var shuffled = { panels: SPEC.panels, data: SPEC.data, id: 'sales', layout: SPEC.layout, custom: 1, title: 'Sales', schemaVersion: '1.1' };
  var text = serializeSpec(shuffled);
  assert.deepEqual(Object.keys(JSON.parse(text)), ['schemaVersion', 'id', 'title', 'layout', 'data', 'panels', 'custom']);
  assert.equal(text, serializeSpec(canonicalSpec(shuffled)), 'stable');
  assert.equal(text.slice(-1), '\n');
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(shuffled)), 'content unchanged');
});

test('dashboardDiff: equal specs, and layout items matched by panel id', function () {
  assert.equal(dashboardsEqual(SPEC, clone(SPEC)), true);
  var reordered = clone(SPEC);
  reordered.layout.items.reverse();
  assert.equal(dashboardsEqual(SPEC, reordered), true, 'reordering layout items is not a change');
  var stamped = Object.assign(clone(SPEC), { schemaVersion: '1.1', $schema: 'https://x' });
  assert.equal(dashboardsEqual(SPEC, stamped), true, 'the format stamp is ignored by default');
});

test('dashboardDiff reports added / removed / changed paths with a summary', function () {
  var after = clone(SPEC);
  after.panels.bar.config.graphType = 'Line';
  after.layout.items[1].x = 3;
  delete after.panels.pie.dataRef;
  after.panels.bar.title = 'Revenue';
  var d = dashboardDiff(SPEC, after);
  assert.deepEqual(d.changed.sort(), ['layout.items.panel=pie.x', 'panels.bar.config.graphType']);
  assert.deepEqual(d.removed, ['panels.pie.dataRef']);
  assert.deepEqual(d.added, ['panels.bar.title']);
  assert.ok(d.summary.indexOf('changed panels.bar.config.graphType: "Bar" -> "Line"') !== -1);
  assert.ok(d.summary.indexOf('added panels.bar.title = "Revenue"') !== -1);
  assert.deepEqual(dashboardDiff(SPEC, Object.assign(clone(SPEC), { version: 2 }), { ignore: ['version'] }).changed, []);
});
