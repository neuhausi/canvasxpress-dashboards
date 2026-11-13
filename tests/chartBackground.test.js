/**
 * chartBackground: the dashboard-wide canvas background for every chart. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChartBackground } from '../src/renderDashboard.js';

test('chartBackground unset keeps the theme background', function () {
  assert.equal(resolveChartBackground({}), '');
  assert.equal(resolveChartBackground({ chartBackground: '' }), '');
});

test('chartBackground transparent is passed as the CSS keyword', function () {
  assert.equal(resolveChartBackground({ chartBackground: 'transparent' }), 'transparent');
  assert.equal(resolveChartBackground({ chartBackground: ' Transparent ' }), 'transparent');
});

test('chartBackground dashboard follows the dashboard background', function () {
  assert.equal(resolveChartBackground({ chartBackground: 'dashboard', background: '#191919' }), '#191919');
  assert.equal(resolveChartBackground({ chartBackground: 'dashboard' }), 'transparent', 'no dashboard background: transparent');
});

test('chartBackground colour is used as given', function () {
  assert.equal(resolveChartBackground({ chartBackground: '#202020' }), '#202020');
});
