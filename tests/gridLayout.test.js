/**
 * Unit tests for the grid geometry: gutters only between adjacent panels.
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridTemplate, cellArea } from '../src/gridLayout.js';

test('cellArea maps unit coords to interleaved track lines (gap-independent)', function () {
  assert.deepEqual(cellArea({ x: 0, y: 0, w: 6, h: 3 }), { column: '1 / 12', row: '1 / 6' });
  assert.deepEqual(cellArea({ x: 6, y: 3, w: 6, h: 3 }), { column: '13 / 24', row: '7 / 12' });
});

test('a lone panel gets NO gap tracks — its size is gap-independent', function () {
  var items = [{ x: 0, y: 0, w: 6, h: 4 }];
  var tpl = gridTemplate(items, 12, 130, 40);
  // Every interior boundary is internal to the panel (or empty) -> all 0px.
  assert.equal(/(^|\s)40px(\s|$)/.test(tpl.rows), false, 'no 40px gap track for a lone panel');
  assert.equal((tpl.rows.match(/130px/g) || []).length, 4, '4 content rows');
});

test('a gutter appears only at a real panel boundary', function () {
  // Two panels stacked: p1 rows 0-3, p2 rows 4-7 -> boundary at line 4.
  var items = [{ x: 0, y: 0, w: 12, h: 4 }, { x: 0, y: 4, w: 12, h: 4 }];
  var tpl = gridTemplate(items, 12, 100, 30);
  var tracks = tpl.rows.split(/\s+/);
  // Interleaved: [100 g 100 g 100 g 100 | boundary-gap | 100 g 100 g 100 g 100]
  // The gap track between row 3 and row 4 is the boundary -> 30px; others 0px.
  assert.equal((tpl.rows.match(/30px/g) || []).length, 1, 'exactly one 30px gutter');
  assert.equal(tracks[7], '30px', 'gutter sits at the panel boundary');
});

test('changing the gap only changes gap-track sizes, not the panel size or lines', function () {
  var items = [{ x: 0, y: 0, w: 12, h: 4 }, { x: 0, y: 4, w: 12, h: 4 }];
  var a = gridTemplate(items, 12, 100, 10);
  var b = gridTemplate(items, 12, 100, 60);
  assert.equal((a.rows.match(/100px/g) || []).length, 8);
  assert.equal((b.rows.match(/100px/g) || []).length, 8, 'same content tracks regardless of gap');
  assert.ok(a.rows.indexOf('10px') !== -1 && b.rows.indexOf('60px') !== -1);
});
