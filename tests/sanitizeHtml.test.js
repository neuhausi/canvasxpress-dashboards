/**
 * Tests for the rich-text sanitizer used by text elements. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml } from '../src/renderDashboard.js';

test('keeps allowlisted formatting tags and safe styles', function () {
  assert.equal(sanitizeHtml('<b>hi</b>'), '<b>hi</b>');
  assert.equal(sanitizeHtml('<i>a</i><u>b</u>'), '<i>a</i><u>b</u>');
  assert.equal(sanitizeHtml('<span style="color: red; font-size: 18px">x</span>'),
    '<span style="color: red; font-size: 18px">x</span>');
  assert.equal(sanitizeHtml('<font size="5" color="#00f">x</font>'),
    '<font size="5" color="#00f">x</font>');
});

test('removes scripts and event handlers', function () {
  assert.equal(sanitizeHtml('a<script>alert(1)</script>b'), 'ab');
  assert.equal(sanitizeHtml('<b onclick="steal()">x</b>'), '<b>x</b>');
  assert.equal(sanitizeHtml('<span onmouseover="x" style="color:red">y</span>'),
    '<span style="color: red">y</span>');
});

test('drops javascript: URLs and unknown/dangerous tags (keeping inner text)', function () {
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeHtml('<a href="https://ok.com">x</a>'), '<a href="https://ok.com">x</a>');
  assert.equal(sanitizeHtml('<img src=x onerror=alert(1)>hi'), 'hi');
  assert.equal(sanitizeHtml('<iframe src="evil"></iframe>ok'), 'ok');
});

test('filters unsafe style properties and url()/expression', function () {
  assert.equal(sanitizeHtml('<span style="color:red;position:fixed;top:0">x</span>'),
    '<span style="color: red">x</span>');
  assert.equal(sanitizeHtml('<span style="background-color:url(javascript:x)">y</span>'),
    '<span>y</span>');
});

test('null/empty input is safe', function () {
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(''), '');
});
