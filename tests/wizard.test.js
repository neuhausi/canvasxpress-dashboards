/**
 * Data-first wizard helpers (Datawrapper-parity P9). Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableFromData, profileColumns, applyDecimalComma, wizardSpec,
  sqlParamNames, paramNameFor, choicesSql, detailSql, connectorSourceUrl, databaseExplorerSpec, orientConfig,
  WIZARD_CHART_TYPES, chartFieldsFor, buildChartConfig, chartColumns } from '../src/wizard.js';
import { transposeCxData } from '../src/join.js';
import { validateSpec } from '../src/validateSpec.js';

// As CanvasXpress parses a CSV: measures are vars, rows are samples, text columns become x.
var DATA = {
  y: { vars: ['GDP', 'LifeExp'], smps: ['USA', 'Japan', 'India'], data: [[65000, 42000, 2100], [79, 84, 70]] },
  x: { Region: ['Americas', 'Asia', 'Asia'] }
};

test('tableFromData: header + one row per sample, measures then annotations', function () {
  assert.deepEqual(tableFromData(DATA), [
    ['Id', 'GDP', 'LifeExp', 'Region'],
    ['USA', 65000, 79, 'Americas'],
    ['Japan', 42000, 84, 'Asia'],
    ['India', 2100, 70, 'Asia']
  ]);
});

test('tableFromData: the shorter axis is the columns (wide data)', function () {
  var wide = transposeCxData(DATA);            // vars = samples now: 3 vars, 2 smps
  var table = tableFromData(wide);
  assert.deepEqual(table[0], ['Id', 'GDP', 'LifeExp', 'Region']);   // same columns either way
  assert.deepEqual(table[2], ['Japan', 42000, 84, 'Asia']);
});

test('profileColumns: types, missing, and bad cells in numeric columns', function () {
  var table = [
    ['Id', 'Sales', 'When', 'Region'],
    ['a', 10, '2024-01-01', 'N'],
    ['b', '12', '2024-02-01', 'S'],
    ['c', '1.234,5', '2024-03-01', 'N'],
    ['d', 'NA', '2024-04-01', 'S'],
    ['e', 8, '2024-05-01', 'E'],
    ['f', 9, 'soon', 'E']
  ];
  var p = profileColumns(table);
  var sales = p[1], when = p[2], region = p[3];
  assert.equal(sales.type, 'numeric');
  assert.equal(sales.missing, 1);               // 'NA'
  assert.equal(sales.bad, 1);                   // '1.234,5'
  assert.deepEqual(sales.badRows, [3]);
  assert.equal(when.type, 'date');
  assert.equal(when.bad, 1);                    // 'soon'
  assert.equal(region.type, 'text');
  assert.equal(region.bad, 0);
  assert.equal(region.unique, 3);
});

test('applyDecimalComma converts only unambiguous comma decimals', function () {
  var data = { y: { vars: ['v'], smps: ['a', 'b', 'c', 'd', 'e'], data: [['1.234,5', '12,5', '-3,25', '1234', 'text']] } };
  var out = applyDecimalComma(data);
  assert.equal(out.converted, 3);
  assert.deepEqual(out.data.y.data[0], [1234.5, 12.5, -3.25, '1234', 'text']);
  assert.equal(data.y.data[0][0], '1.234,5');   // input untouched
});

test('wizardSpec: one full-width chart bound to the stored dataset, valid', function () {
  var spec = wizardSpec({ id: 'w1', title: 'My chart', datasetId: 'ds-9',
    config: { graphType: 'Scatter2D', xAxis: ['GDP'], yAxis: ['LifeExp'] } });
  assert.deepEqual(spec.data.data, { kind: 'dataset', id: 'ds-9' });
  assert.equal(Object.keys(spec.panels).length, 1);
  assert.equal(spec.panels.chart.dataRef, 'data');
  assert.equal(spec.panels.chart.config.graphType, 'Scatter2D');
  assert.equal(spec.layout.items[0].w, spec.layout.cols);
  assert.equal(validateSpec(spec).valid, true);
});

// ---- "Dashboard from database" wizard ----

test('sqlParamNames: :name binds in order, skipping strings, comments and ::casts', function () {
  assert.deepEqual(sqlParamNames('SELECT * FROM t WHERE g = :gene AND r = :region OR g = :gene'), ['gene', 'region']);
  assert.deepEqual(sqlParamNames("SELECT x::int, ':nope' AS s FROM t -- :also_no\nWHERE y = :yes /* :no */"), ['yes']);
  assert.deepEqual(sqlParamNames('SELECT 1'), []);
});

test('paramNameFor: a column name becomes a bind-parameter name', function () {
  assert.equal(paramNameFor('Gene Name'), 'gene_name');
  assert.equal(paramNameFor('2024 value'), 'value');
  assert.equal(paramNameFor('***'), 'value');
});

test('choicesSql / detailSql: the explorer query templates', function () {
  assert.equal(choicesSql('expression', 'geneName', 'gene'),
    'SELECT DISTINCT geneName AS id, geneName AS gene FROM expression WHERE geneName IS NOT NULL ORDER BY 1');
  assert.equal(detailSql('expression', 'geneName', 'gene'), 'SELECT * FROM expression WHERE geneName = :gene');
  assert.deepEqual(sqlParamNames(detailSql('t', 'c', 'p')), ['p']);
});

test('databaseExplorerSpec: param control over a re-queried chart, valid spec', function () {
  var spec = databaseExplorerSpec({ id: 'genes', title: 'Genes', param: 'gene', value: 'TP53',
    choicesSource: 'genes-choices', detailSource: 'genes detail', choicesCount: 300,
    config: { graphType: 'Boxplot', title: 'x' }, chartTitle: 'Expression' });
  assert.deepEqual(spec.params, { gene: { value: 'TP53', type: 'string' } });
  assert.deepEqual(spec.data.choices, { kind: 'connector', url: '/connectors/api/data?source=genes-choices', ttl: 600000 });
  assert.deepEqual(spec.data.detail, { kind: 'connector', url: connectorSourceUrl('genes detail'),
    query: { gene: '$gene' }, ttl: 0 });
  assert.equal(spec.data.detail.url, '/connectors/api/data?source=genes%20detail');
  var control = spec.panels.control;
  assert.equal(control.mode, 'param');
  assert.equal(control.param, 'gene');
  assert.equal(control.style, 'search');              // > 50 choices → type-ahead
  assert.deepEqual(control.optionsFrom, { dataRef: 'choices', annotation: 'gene' });
  assert.equal(spec.panels.chart.dataRef, 'detail');
  assert.equal(spec.panels.chart.config.title, false);
  assert.equal(spec.panels.chart.title, 'Expression');
  var result = validateSpec(spec);
  assert.ok(result.valid, JSON.stringify(result.errors));
});

test('databaseExplorerSpec: a short choice list is a dropdown', function () {
  var spec = databaseExplorerSpec({ id: 'r', title: 'R', param: 'region', value: 'East',
    choicesSource: 'a', detailSource: 'b', choicesCount: 4, config: { graphType: 'Bar' } });
  assert.equal(spec.panels.control.style, 'dropdown');
});

test('orientConfig: scatter-family charts over row-per-sample data get transposeData', function () {
  // DATA: rows are samples (3), columns are the 2 measures — as a CSV / SQL query parses.
  assert.deepEqual(orientConfig({ graphType: 'Ridgeline', xAxis: ['GDP'], ridgeBy: 'Region' }, DATA),
    { graphType: 'Ridgeline', xAxis: ['GDP'], ridgeBy: 'Region', transposeData: true });
  assert.equal(orientConfig({ graphType: 'CDF' }, DATA).transposeData, true);
  assert.equal(orientConfig({ graphType: 'Boxplot' }, DATA).transposeData, undefined);   // bar/box family: as is
  assert.equal(orientConfig({ graphType: 'CDF' }, transposeCxData(DATA)).transposeData, undefined);  // already wide
  assert.equal(orientConfig({ graphType: 'CDF', transposeData: false }, DATA).transposeData, false);  // explicit wins
  var config = { graphType: 'Density' };
  orientConfig(config, DATA);
  assert.equal(config.transposeData, undefined);   // the input is not mutated
});

test('chartFieldsFor: scatter has X+Y, others a group (ridgeBy for Ridgeline, none for Histogram/Density)', function () {
  assert.deepEqual(chartFieldsFor('Scatter2D'), { y: true, groupKey: null });
  assert.deepEqual(chartFieldsFor('Boxplot'), { y: false, groupKey: 'groupingFactors' });
  assert.deepEqual(chartFieldsFor('Ridgeline'), { y: false, groupKey: 'ridgeBy' });
  assert.deepEqual(chartFieldsFor('Density'), { y: false, groupKey: null });
  assert.ok(WIZARD_CHART_TYPES.indexOf('Pie') === -1 && WIZARD_CHART_TYPES.indexOf('Scatter2D') !== -1);
});

test('buildChartConfig: fields, then extra config on top, oriented to the data', function () {
  assert.deepEqual(buildChartConfig('Boxplot', { x: 'GDP', group: 'Region', color: 'Region' }, null, DATA),
    { graphType: 'Boxplot', xAxis: ['GDP'], groupingFactors: ['Region'], colorBy: 'Region' });
  assert.deepEqual(buildChartConfig('Scatter2D', { x: 'GDP', y: 'LifeExp', group: 'Region', color: 'Region' }, { theme: 'GGPlot' }, DATA),
    { graphType: 'Scatter2D', xAxis: ['GDP'], yAxis: ['LifeExp'], colorBy: 'Region', theme: 'GGPlot', transposeData: true });
  assert.equal(buildChartConfig('Ridgeline', { x: 'GDP', group: 'Region' }, null, DATA).ridgeBy, 'Region');
  assert.equal(buildChartConfig('Boxplot', { x: 'GDP', color: '' }, { colorBy: 'Region' }, DATA).colorBy, 'Region');  // extra wins
  assert.equal(buildChartConfig('Density', { x: 'GDP', group: 'Region' }, null, DATA).groupingFactors, undefined);
});

test('chartColumns: measures and annotations on the column axis', function () {
  assert.deepEqual(chartColumns(DATA), { numbers: ['GDP', 'LifeExp'], texts: ['Region'] });
});
