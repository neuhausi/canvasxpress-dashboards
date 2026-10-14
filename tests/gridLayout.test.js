/**
 * Unit tests for the grid geometry: a uniform-gap grid where equal `w` => equal
 * width and equal `h` => equal height. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridTemplate, cellArea, stackedTemplate } from '../src/gridLayout.js';

test('cellArea places a panel as a plain span from its unit coordinate', function () {
  assert.deepEqual(cellArea({ x: 0, y: 0, w: 6, h: 3 }), { column: '1 / span 6', row: '1 / span 3' });
  assert.deepEqual(cellArea({ x: 6, y: 3, w: 4, h: 2 }), { column: '7 / span 4', row: '4 / span 2' });
});

test('gridTemplate is a uniform repeat of equal columns and fixed rows', function () {
  var items = [{ x: 0, y: 0, w: 6, h: 4 }, { x: 6, y: 0, w: 6, h: 4 }];
  var tpl = gridTemplate(items, 12, 130, 40);
  assert.equal(tpl.columns, 'repeat(12, minmax(0, 1fr))');
  assert.equal(tpl.rows, 'repeat(4, 130px)');
  assert.equal(tpl.gap, '40px');
  assert.equal(tpl.maxRow, 4);
});

test('the gap is a single uniform value, independent of panel edges', function () {
  var a = gridTemplate([{ x: 0, y: 0, w: 12, h: 4 }], 12, 100, 10);
  var b = gridTemplate([{ x: 0, y: 0, w: 3, h: 2 }, { x: 3, y: 0, w: 9, h: 2 }], 12, 100, 60);
  assert.equal(a.gap, '10px');
  assert.equal(b.gap, '60px');
  // Column/row templates never encode per-edge gaps any more.
  assert.equal(a.columns, b.columns);
  assert.equal(a.columns.indexOf('px'), -1, 'columns carry no gap tracks');
});

test('maxRow reflects the tallest panel stack', function () {
  var tpl = gridTemplate([{ x: 0, y: 0, w: 12, h: 4 }, { x: 0, y: 4, w: 12, h: 4 }], 12, 100, 30);
  assert.equal(tpl.rows, 'repeat(8, 100px)');
  assert.equal(tpl.maxRow, 8);
});

test('stackedTemplate stacks panels one-wide in reading order, keeping heights', function () {
  var items = [
    { panel: 'b', x: 6, y: 0, w: 6, h: 3 },
    { panel: 'a', x: 0, y: 0, w: 6, h: 3 },
    { panel: 'c', x: 0, y: 3, w: 12, h: 2 }
  ];
  var tpl = stackedTemplate(items, 130, 12);
  assert.equal(tpl.columns, 'minmax(0, 1fr)');
  assert.equal(tpl.rows, 'repeat(8, 130px)');
  assert.equal(tpl.gap, '12px');
  assert.equal(tpl.maxRow, 8);
  // Reading order: a (y0 x0), b (y0 x6), c (y3) — each full-width, own height.
  assert.deepEqual(tpl.areaByPanel.a, { column: '1 / span 1', row: '1 / span 3' });
  assert.deepEqual(tpl.areaByPanel.b, { column: '1 / span 1', row: '4 / span 3' });
  assert.deepEqual(tpl.areaByPanel.c, { column: '1 / span 1', row: '7 / span 2' });
});

test('stackedTemplate tolerates an empty item set', function () {
  var tpl = stackedTemplate([], 100, 10);
  assert.equal(tpl.rows, 'repeat(1, 100px)');
  assert.equal(tpl.maxRow, 1);
  assert.deepEqual(tpl.areaByPanel, {});
});
