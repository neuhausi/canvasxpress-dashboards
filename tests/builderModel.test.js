/**
 * Unit tests for the pure builder model operations. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPanel, removePanel, movePanel, resizePanel, resolveCollisions, updatePanel, setDataSource, updateSettings, blankSpec
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

test('updateSettings sets presentation fields (top-level + layout), purely', function () {
  var s0 = blankSpec('d1');
  var s1 = updateSettings(s0, { background: '#123456', canvasInset: 20, theme: 'dark', gap: 20, rowHeight: 150, cols: 8 });
  assert.equal(s0.background, undefined);
  assert.equal(s0.layout.gap, 12);
  assert.equal(s1.background, '#123456');
  assert.equal(s1.canvasInset, 20);
  assert.equal(s1.theme, 'dark');
  assert.equal(s1.layout.gap, 20);
  assert.equal(s1.layout.rowHeight, 150);
  assert.equal(s1.layout.cols, 8);
});

test('updateSettings clears an emptied background and only touches provided keys', function () {
  var s = updateSettings(blankSpec('d1'), { background: '#fff', canvasInset: 10 });
  var cleared = updateSettings(s, { background: '' });
  assert.equal(cleared.background, undefined);
  assert.equal(cleared.canvasInset, 10, 'unprovided keys are left alone');
});

test('updateSettings sets/clears colorScheme and coordinateBackground', function () {
  var s = updateSettings(blankSpec('d1'), { theme: 'cxdark', colorScheme: 'Viridis', coordinateBackground: true });
  assert.equal(s.theme, 'cxdark');
  assert.equal(s.colorScheme, 'Viridis');
  assert.equal(s.coordinateBackground, true);
  var off = updateSettings(s, { colorScheme: '', coordinateBackground: false });
  assert.equal(off.colorScheme, undefined, 'emptied colorScheme is removed');
  assert.equal(off.coordinateBackground, undefined, 'falsy coordinateBackground is removed');
  assert.equal(off.theme, 'cxdark', 'unprovided keys are left alone');
});

test('updateSettings sets/clears panelColor and coordinatePanel', function () {
  var s = updateSettings(blankSpec('d1'), { panelColor: '#101418', coordinatePanel: true });
  assert.equal(s.panelColor, '#101418');
  assert.equal(s.coordinatePanel, true);
  var off = updateSettings(s, { panelColor: '', coordinatePanel: false });
  assert.equal(off.panelColor, undefined, 'emptied panelColor is removed');
  assert.equal(off.coordinatePanel, undefined, 'falsy coordinatePanel is removed');
});

test('updateSettings sets and clears a background image', function () {
  var s = updateSettings(blankSpec('d1'), { backgroundImage: 'data:image/png;base64,AAA' });
  assert.equal(s.backgroundImage, 'data:image/png;base64,AAA');
  var cleared = updateSettings(s, { backgroundImage: '' });
  assert.equal(cleared.backgroundImage, undefined);
});

test('addPanel supports text elements (no dataRef/config)', function () {
  var s = addPanel(blankSpec('d1'), { id: 't1', type: 'text', title: 'Note', text: 'Hello', w: 4, h: 2 });
  var p = s.panels.t1;
  assert.equal(p.type, 'text');
  assert.equal(p.text, 'Hello');
  assert.equal(p.title, 'Note');
  assert.equal(p.dataRef, undefined);
  assert.equal(p.config, undefined);
  assert.ok(s.layout.items.some(function (i) { return i.panel === 't1'; }));
});

test('updatePanel edits text content', function () {
  var s = addPanel(blankSpec('d1'), { id: 't1', type: 'text', text: 'a' });
  s = updatePanel(s, 't1', { text: 'b' });
  assert.equal(s.panels.t1.text, 'b');
});

test('updatePanel html replaces the plain-text fallback', function () {
  var s = addPanel(blankSpec('d1'), { id: 't1', type: 'text', text: 'plain' });
  s = updatePanel(s, 't1', { html: '<b>rich</b>' });
  assert.equal(s.panels.t1.html, '<b>rich</b>');
  assert.equal('text' in s.panels.t1, false, 'plain text cleared');
});

test('updatePanel sets and clears a text background colour', function () {
  var s = addPanel(blankSpec('d1'), { id: 't1', type: 'text', text: 'hi' });
  s = updatePanel(s, 't1', { bg: '#ff0000' });
  assert.equal(s.panels.t1.bg, '#ff0000');
  s = updatePanel(s, 't1', { bg: '' });
  assert.equal('bg' in s.panels.t1, false);
});

test('addPanel control stores the annotation-filter fields', function () {
  var s = addPanel(blankSpec('d1'), {
    id: 'c1', type: 'control', title: 'Tissue', dataRef: 'src',
    compartment: 'z', annotation: 'Pathway', style: 'radio', w: 4, h: 2
  });
  assert.deepEqual(s.panels.c1, {
    type: 'control', title: 'Tissue', dataRef: 'src',
    compartment: 'z', annotation: 'Pathway', style: 'radio'
  });
  assert.deepEqual(s.layout.items[0], { panel: 'c1', x: 0, y: 0, w: 4, h: 2 });
});

test('addPanel control defaults compartment/style', function () {
  var s = addPanel(blankSpec('d1'), { id: 'c1', type: 'control' });
  assert.equal(s.panels.c1.compartment, 'x');
  assert.equal(s.panels.c1.style, 'auto');
  assert.equal(s.panels.c1.annotation, '');
});

test('control panels are solid in collision resolution', function () {
  var s = addPanel(blankSpec('d1'), { id: 'p1', dataRef: 'src', x: 0, y: 0, w: 6, h: 4 });
  s = addPanel(s, { id: 'c1', type: 'control', x: 0, y: 0, w: 4, h: 2 });
  var resolved = resolveCollisions(s, 'c1');
  var item = resolved.layout.items.filter(function (i) { return i.panel === 'c1'; })[0];
  var solid = resolved.layout.items.filter(function (i) { return i.panel === 'p1'; })[0];
  // The control (active) wins its spot; the graph panel is pushed below it —
  // a graph can never sit on top of (and hide) a filter bar.
  assert.deepEqual([item.x, item.y], [0, 0]);
  assert.deepEqual([solid.x, solid.y], [0, 2]);
});

test('text panels float free of collision resolution', function () {
  var s = addPanel(blankSpec('d1'), { id: 'p1', dataRef: 'src', x: 0, y: 0, w: 6, h: 4 });
  s = addPanel(s, { id: 't1', type: 'text', text: 'hi', x: 0, y: 0, w: 4, h: 2 });
  var resolved = resolveCollisions(s, 't1');
  var item = resolved.layout.items.filter(function (i) { return i.panel === 't1'; })[0];
  var solid = resolved.layout.items.filter(function (i) { return i.panel === 'p1'; })[0];
  // Overlap kept: neither the text element nor the solid panel moved.
  assert.deepEqual([item.x, item.y], [0, 0]);
  assert.deepEqual([solid.x, solid.y], [0, 0]);
});

test('updatePanel edits control fields', function () {
  var s = addPanel(blankSpec('d1'), { id: 'c1', type: 'control' });
  s = updatePanel(s, 'c1', { compartment: 'z', annotation: 'Dose', style: 'buttons' });
  assert.equal(s.panels.c1.compartment, 'z');
  assert.equal(s.panels.c1.annotation, 'Dose');
  assert.equal(s.panels.c1.style, 'buttons');
});
