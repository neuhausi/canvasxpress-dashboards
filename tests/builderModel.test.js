/**
 * Unit tests for the pure builder model operations. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPanel, removePanel, movePanel, resizePanel, updatePanel, setDataSource, blankSpec
} from '../src/builderModel.js';

test('blankSpec is a valid empty starter', function () {
  var s = blankSpec('d1', 'Title');
  assert.equal(s.id, 'd1');
  assert.equal(s.layout.cols, 12);
  assert.deepEqual(s.layout.items, []);
  assert.deepEqual(s.panels, {});
});

test('addPanel adds a panels entry and a layout item, purely', function () {
  var s0 = blankSpec('d1');
  var s1 = addPanel(s0, { id: 'p1', title: 'One', dataRef: 'src', config: { graphType: 'Pie' } });
  // original untouched
  assert.deepEqual(s0.layout.items, []);
  assert.equal(s0.panels.p1, undefined);
  // new spec populated
  assert.equal(s1.panels.p1.title, 'One');
  assert.equal(s1.panels.p1.config.graphType, 'Pie');
  assert.deepEqual(s1.layout.items[0], { panel: 'p1', x: 0, y: 0, w: 6, h: 3 });
});

test('addPanel auto-stacks new panels below existing ones', function () {
  var s = addPanel(addPanel(blankSpec('d1'), { id: 'p1' }), { id: 'p2' });
  var p2 = s.layout.items.filter(function (i) { return i.panel === 'p2'; })[0];
  assert.equal(p2.y, 3, 'placed below the first 3-tall panel');
});

test('addPanel rejects duplicate ids and missing id', function () {
  var s = addPanel(blankSpec('d1'), { id: 'p1' });
  assert.throws(function () { return addPanel(s, { id: 'p1' }); }, /already exists/);
  assert.throws(function () { return addPanel(s, {}); }, /requires a panel id/);
});

test('removePanel drops the panel and all its layout items', function () {
  var s = addPanel(blankSpec('d1'), { id: 'p1' });
  var s2 = removePanel(s, 'p1');
  assert.equal(s2.panels.p1, undefined);
  assert.equal(s2.layout.items.length, 0);
});

test('movePanel clamps inside the grid', function () {
  var s = addPanel(blankSpec('d1'), { id: 'p1', w: 6 });
  var moved = movePanel(s, 'p1', 100, 4);
  var item = moved.layout.items[0];
  assert.equal(item.x, 6, 'x clamped to cols - w');
  assert.equal(item.y, 4);
});

test('resizePanel clamps width to remaining columns and height >= 1', function () {
  var s = movePanel(addPanel(blankSpec('d1'), { id: 'p1', x: 0, w: 3 }), 'p1', 8, 0);
  var r = resizePanel(s, 'p1', 99, 0);
  var item = r.layout.items[0];
  assert.equal(item.x, 8);
  assert.equal(item.w, 4, 'clamped to 12 - 8');
  assert.equal(item.h, 1, 'min height 1');
});

test('updatePanel changes only provided fields', function () {
  var s = addPanel(blankSpec('d1'), { id: 'p1', title: 'A', config: { graphType: 'Bar' } });
  var u = updatePanel(s, 'p1', { title: 'B' });
  assert.equal(u.panels.p1.title, 'B');
  assert.equal(u.panels.p1.config.graphType, 'Bar', 'config untouched');
  var u2 = updatePanel(u, 'p1', { config: { graphType: 'Line' } });
  assert.equal(u2.panels.p1.config.graphType, 'Line');
  assert.equal(u2.panels.p1.title, 'B');
});

test('setDataSource adds a named source without touching panels', function () {
  var s = setDataSource(blankSpec('d1'), 'sales', { kind: 'inline', value: { y: {} } });
  assert.equal(s.data.sales.kind, 'inline');
});
