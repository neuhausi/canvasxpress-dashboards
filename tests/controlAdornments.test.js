import test from 'node:test';
import assert from 'node:assert';
import { controlIconName, legendKeyMap, CONTROL_ICONS } from '../src/controlAdornments.js';

test('controlIconName infers the icon from the control role, not the column name', function () {
  assert.equal(controlIconName({ type: 'control', annotation: 'Island' }), 'filter');
  assert.equal(controlIconName({ type: 'control', mode: 'param', style: 'search' }), 'search');
  assert.equal(controlIconName({ type: 'control', mode: 'param', style: 'range' }), 'slider');
  assert.equal(controlIconName({ type: 'control', mode: 'transform' }), 'transform');
});

test('controlIconName reads a config control from the keys its options set', function () {
  var x = { mode: 'config', options: [{ config: { xAxis: ['a'] } }, { config: { xAxis: ['b'] } }] };
  var y = { mode: 'config', options: [{ config: { yAxis: ['a'] } }] };
  var color = { mode: 'config', options: [{ config: { colorBy: 'Species' } }] };
  assert.equal(controlIconName(x), 'axis-x');
  assert.equal(controlIconName(y), 'axis-y');
  assert.equal(controlIconName(color), 'color');
  assert.equal(controlIconName({ mode: 'config', options: [{ config: { title: 'x' } }] }), 'layers');
});

test('controlIconName honours an explicit icon, a glyph, and false', function () {
  assert.equal(controlIconName({ annotation: 'Island', icon: 'place' }), 'place');
  assert.equal(controlIconName({ annotation: 'Sex', icon: '⚥' }), '⚥');
  assert.equal(controlIconName({ annotation: 'Island', icon: false }), null);
  // An unknown long name is not a glyph: fall back to no icon rather than text.
  assert.equal(controlIconName({ annotation: 'Island', icon: 'not-an-icon-name' }), null);
  assert.ok(Object.prototype.hasOwnProperty.call(CONTROL_ICONS, 'place'));
});

test('legendKeyMap reads level colour + shape off the legend render objects', function () {
  var instance = { meta: { render: { objects: [
    { id: 'PropertyKey:Species:Adelie:x', func: 'drawShape', params: ['rectangle', 0, 0, 0, 0, 'rgba(255,255,255,0)'] },
    { id: 'PropertyKey:Species:Adelie:x', func: 'drawShape', params: ['sphere', 0, 0, 0, 0, 'rgba(10,176,219,1)'] },
    { id: 'PropertyKey:Species:Adelie:x', func: 'drawText', params: ['Adelie'] },
    { id: 'PropertyKey:Species:Gentoo:x', func: 'drawShape', params: ['triangle', 0, 0, 0, 0, 'rgb(253,192,90)'] },
    { id: 'PropertyKey:Island:Dream:x', func: 'drawShape', params: ['square', 0, 0, 0, 0, 'rgb(1,2,3)'] }
  ] } } };
  var map = legendKeyMap(instance, 'Species');
  assert.deepEqual(map, {
    Adelie: { color: 'rgba(10,176,219,1)', shape: 'sphere' },
    Gentoo: { color: 'rgb(253,192,90)', shape: 'triangle' }
  });
  // An annotation the chart does not key on yields null, so no swatches are drawn.
  assert.equal(legendKeyMap(instance, 'Sex'), null);
  assert.equal(legendKeyMap(null, 'Species'), null);
  assert.equal(legendKeyMap({ meta: {} }, 'Species'), null);
});
