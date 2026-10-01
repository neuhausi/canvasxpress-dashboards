/**
 * Data-first wizard helpers (Datawrapper-parity P9). Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableFromData, profileColumns, applyDecimalComma, wizardSpec } from '../src/wizard.js';
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
