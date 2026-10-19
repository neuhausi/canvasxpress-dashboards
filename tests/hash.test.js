/**
 * Unit tests for the dependency-free SHA-256 content hash, cross-checked
 * against Node's crypto.
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256Hex } from '../src/hash.js';

test('sha256Hex matches node crypto (ASCII, empty, UTF-8, long)', function () {
  var cases = ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'café — αβγ', 'x'.repeat(1000)];
  cases.forEach(function (s) {
    assert.equal(sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  });
});

test('sha256Hex is deterministic and differs for different content', function () {
  assert.equal(sha256Hex('same'), sha256Hex('same'));
  assert.notEqual(sha256Hex('a'), sha256Hex('b'));
});
