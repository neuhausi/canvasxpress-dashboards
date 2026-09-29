/**
 * The browser pushdown executor: the same `pushdown` grammar a connector source
 * runs in its database, run here for sources with no database. The parity
 * fixture holds the REAL canvasxpress-connectors output (SQLite) for each query
 * (regenerate with tests/fixtures/pushdown-parity.py), so these tests check the
 * browser gives the same answer as the database. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runPushdown, rowsToCx } from '../src/pushdown.js';

var PARITY = JSON.parse(fs.readFileSync(new URL('./fixtures/pushdown-parity.json', import.meta.url), 'utf8'));

/**
 * JSON round-trip (the fixture came through JSON: 3.0 reads as 3).
 * @param {*} v - Value.
 * @returns {*} Normalized copy.
 */
function norm(v) { return JSON.parse(JSON.stringify(v)); }

Object.keys(PARITY.results).forEach(function (name) {
  test('same answer as the connector database: ' + name, function () {
    var entry = PARITY.results[name];
    var query = norm(entry.query);
    // The row id is always kept in the browser (named after the axis).
    if (query.columns) query.columns = query.columns.filter(function (c) { return c !== 'id'; });
    assert.deepEqual(norm(runPushdown(PARITY.base, query, 'smps')), norm(entry.db));
  });
});

test('the input data is not modified', function () {
  var before = JSON.stringify(PARITY.base);
  runPushdown(PARITY.base, { groupBy: ['region'], measures: [{ fn: 'sum', column: 'amount' }] });
  runPushdown(PARITY.base, { columns: ['amount'], orderBy: [{ column: 'amount', desc: true }], limit: 2 });
  assert.equal(JSON.stringify(PARITY.base), before);
});

test('errors match the connector: unknown column, function, operator, non-output orderBy, rows + aggregates', function () {
  var base = PARITY.base;
  assert.throws(function () { runPushdown(base, { where: [{ column: 'nope', op: '=', value: 1 }] }); }, /No column named "nope" in this source \(it has: smps, /);
  assert.throws(function () { runPushdown(base, { measures: [{ fn: 'median', column: 'amount' }] }); }, /fn must be one of: count, count_distinct, sum, avg, min, max/);
  assert.throws(function () { runPushdown(base, { measures: [{ fn: 'sum' }] }); }, /sum needs a column/);
  assert.throws(function () { runPushdown(base, { where: [{ column: 'amount', op: 'like', value: 'x' }] }); }, /Unknown filter operator "like"/);
  assert.throws(function () { runPushdown(base, { groupBy: ['region'], measures: [{ fn: 'count' }], orderBy: ['amount'] }); }, /orderBy "amount" is not an output column/);
  assert.throws(function () { runPushdown(base, { columns: ['amount'], groupBy: ['region'] }); }, /Use 'columns' for rows, or 'groupBy'\/'measures' for aggregates/);
  assert.throws(function () { runPushdown(base, { groupBy: ['region'], measures: [{ fn: 'count', as: 'region' }] }); }, /Two outputs are named "region"/);
});

test('rows mode keeps each column kind and narrows column annotations to the kept columns', function () {
  var data = {
    y: { vars: ['a', 'b', 'c'], smps: ['s1', 's2', 's3'], data: [[1, 2, 3], [10, 20, 30], [7, 8, 9]] },
    x: { grp: ['g1', 'g2', 'g1'] },
    z: { unit: ['kg', 'm', 's'] }
  };
  var out = runPushdown(data, { columns: ['c', 'grp', 'a'], where: [{ column: 'grp', op: '=', value: 'g1' }] });
  assert.deepEqual(out, {
    y: { vars: ['c', 'a'], smps: ['s1', 's3'], data: [[7, 9], [1, 3]] },
    x: { grp: ['g1', 'g1'] },
    z: { unit: ['s', 'kg'] }
  });
  // The row id is a column named after the axis.
  assert.deepEqual(runPushdown(data, { where: [{ column: 'smps', op: 'in', value: ['s2'] }] }).y.smps, ['s2']);
});

test('a vars-axis source: rows are variables, columns are samples', function () {
  var data = {
    y: { vars: ['g1', 'g2', 'g3'], smps: ['logFC', 'p'], data: [[2, 0.01], [-1, 0.5], [3, 0.001]] },
    z: { pathway: ['A', 'B', 'A'] },
    x: { kind: ['effect', 'stat'] }
  };
  var out = runPushdown(data, { columns: ['logFC', 'pathway'], where: [{ column: 'p', op: '<', value: 0.05 }], orderBy: [{ column: 'logFC', desc: true }] }, 'vars');
  assert.deepEqual(out, {
    y: { vars: ['g3', 'g1'], smps: ['logFC'], data: [[3], [2]] },
    z: { pathway: ['A', 'A'] },
    x: { kind: ['effect'] }
  });
  var grouped = runPushdown(data, { groupBy: ['pathway'], measures: [{ fn: 'avg', column: 'logFC', as: 'meanFC' }], orderBy: ['pathway'] }, 'vars');
  assert.deepEqual(grouped, { y: { vars: ['meanFC'], smps: ['A', 'B'], data: [[2.5, -1]] } });
});

test('rowsToCx follows the connector: first column = ids, all-number columns = variables', function () {
  assert.deepEqual(rowsToCx(['k', 'n', 'label', 'mixed'], [['a', 1, 'x', 1], ['b', 2, 'y', null]]), {
    y: { vars: ['n'], smps: ['a', 'b'], data: [[1, 2]] },
    x: { label: ['x', 'y'], mixed: [1, null] }
  });
  assert.deepEqual(rowsToCx(['k', 'n'], []), { y: { vars: [], smps: [], data: [] }, x: { n: [] } });
});
