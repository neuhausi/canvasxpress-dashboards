/**
 * Unit tests for the provenance method-string derivation (spec 1.5). The lines
 * must be HONEST — derived from the operations in the spec, never free text —
 * so every assertion pins the exact wording against a known spec fragment.
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describePushdown, describeCalculatedFields, describeStatOptions,
  describeSource, derivePanelMethod, panelProvenanceText
} from '../src/provenance.js';

test('describePushdown: aggregate (measures + groupBy)', function () {
  assert.equal(
    describePushdown({ groupBy: ['Region'], measures: [{ fn: 'sum', column: 'Revenue' }, { fn: 'count' }] }),
    'aggregated (sum of Revenue, count) grouped by Region'
  );
  assert.equal(
    describePushdown({ measures: [{ fn: 'count_distinct', column: 'Id' }] }),
    'aggregated (distinct count of Id)'
  );
  assert.equal(describePushdown({ groupBy: ['Region'] }), 'aggregated grouped by Region');
});

test('describePushdown: columns / where / orderBy / limit', function () {
  assert.equal(describePushdown({ columns: ['A', 'B'] }), 'selected columns A, B');
  assert.equal(
    describePushdown({ where: [{ column: 'Year', op: '>=', value: 2020 }], orderBy: [{ column: 'Revenue', desc: true }], limit: 10 }),
    'filtered where Year >= 2020; sorted by Revenue desc; limited to 10 rows'
  );
  assert.equal(
    describePushdown({ where: [{ column: 'Region', op: 'in', value: ['West', 'East'] }] }),
    'filtered where Region in [West, East]'
  );
});

test('describePushdown: absent / true / malformed → empty', function () {
  assert.equal(describePushdown(undefined), '');
  assert.equal(describePushdown(true), '');
  assert.equal(describePushdown({}), '');
});

test('describeCalculatedFields: formula and binning', function () {
  assert.equal(
    describeCalculatedFields([
      { name: 'Margin', formula: 'Revenue / Units' },
      { name: 'AgeBin', bin: { field: 'Age', method: 'quantile', bins: 4 } }
    ]),
    'computed Margin = Revenue / Units; binned Age into 4 quantile bins as AgeBin'
  );
  assert.equal(
    describeCalculatedFields([{ name: 'B', bin: { field: 'X', method: 'custom', breaks: [0, 10, 20, 30] } }]),
    'binned X into 3 custom bins as B'
  );
  assert.equal(describeCalculatedFields([]), '');
});

test('describeStatOptions: overlays + confidence interval', function () {
  assert.equal(describeStatOptions({ showLoessFit: true }), 'with a loess fit');
  assert.equal(
    describeStatOptions({ showRegressionFit: true, regressionType: 'linear', showConfidenceIntervals: true, confidenceInterval: 0.95 }),
    'with a regression fit (linear) and 95% confidence interval'
  );
  assert.equal(
    describeStatOptions({ showLoessFit: true, showForecast: true }),
    'with a loess fit and a forecast'
  );
  assert.equal(describeStatOptions({ graphType: 'Bar' }), '', 'no overlay → empty');
});

test('describeSource: base kinds', function () {
  var spec = { data: {
    a: { kind: 'inline', value: {} },
    b: { kind: 'dataset', id: 'r1' },
    c: { kind: 'connector', url: '/x' },
    d: { kind: 'function', language: 'r', code: 'result <- x' },
    e: { kind: 'live', url: '/s' }
  } };
  assert.equal(describeSource('a', spec), 'inline data');
  assert.equal(describeSource('b', spec), 'dataset r1');
  assert.equal(describeSource('c', spec), 'connector data');
  assert.equal(describeSource('d', spec), 'transformed by a R function');
  assert.equal(describeSource('e', spec), 'a live stream');
  assert.equal(describeSource('missing', spec), '');
});

test('describeSource: join recurses and parenthesizes multi-clause inputs', function () {
  var spec = { data: {
    sales: { kind: 'connector', url: '/x', pushdown: { groupBy: ['Region'], measures: [{ fn: 'sum', column: 'Revenue' }] } },
    regions: { kind: 'dataset', id: 'r1' },
    j: { kind: 'join', how: 'left', left: 'sales', right: 'regions', on: 'Region' }
  } };
  assert.equal(
    describeSource('j', spec),
    'left join of (connector data; aggregated (sum of Revenue) grouped by Region) and dataset r1 on Region'
  );
});

test('describeSource: cycle guard does not recurse forever', function () {
  var spec = { data: {
    j1: { kind: 'join', left: 'j2', right: 'x', on: 'k' },
    j2: { kind: 'join', left: 'j1', right: 'x', on: 'k' },
    x: { kind: 'inline', value: {} }
  } };
  assert.doesNotThrow(function () { describeSource('j1', spec); });
});

test('derivePanelMethod: source chain + chart type + stat overlay', function () {
  var spec = {
    data: { s: { kind: 'connector', url: '/x', pushdown: { groupBy: ['Region'], measures: [{ fn: 'sum', column: 'Revenue' }] } } },
    panels: { bar: { dataRef: 's', config: { graphType: 'Bar' } } }
  };
  assert.equal(
    derivePanelMethod(spec, 'bar'),
    'connector data; aggregated (sum of Revenue) grouped by Region; plotted as Bar'
  );
  var scatter = {
    data: { s: { kind: 'inline', value: {} } },
    panels: { sc: { dataRef: 's', config: { graphType: 'Scatter2D', showLoessFit: true, showConfidenceIntervals: true, confidenceInterval: 0.9 } } }
  };
  assert.equal(
    derivePanelMethod(scatter, 'sc'),
    'inline data; plotted as Scatter2D with a loess fit and 90% confidence interval'
  );
});

test('panelProvenanceText: auto vs author-pinned, with notes', function () {
  var spec = {
    data: { s: { kind: 'inline', value: {} } },
    panels: {
      auto: { dataRef: 's', config: { graphType: 'Bar' }, provenance: { show: true, notes: 'excludes returns' } },
      pinned: { dataRef: 's', config: { graphType: 'Bar' }, provenance: { auto: false, method: 'Hand-written method' } }
    }
  };
  assert.equal(panelProvenanceText(spec, 'auto'), 'inline data; plotted as Bar — excludes returns');
  assert.equal(panelProvenanceText(spec, 'pinned'), 'Hand-written method');
});
