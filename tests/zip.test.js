/**
 * Unit tests for the tiny STORED ZIP writer. An INDEPENDENT reader (walks the
 * End-of-Central-Directory → central directory → local headers, as any unzip
 * tool does) extracts the entries, so the test validates the byte layout rather
 * than trusting the writer's own structure. CRCs are cross-checked with Node's
 * zlib.crc32 when available.
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { zipSync } from '../src/zip.js';

/**
 * Read a little-endian unsigned integer from a byte array.
 * @param {Uint8Array} b - Bytes.
 * @param {number} off - Offset.
 * @param {number} len - Byte length (2 or 4).
 * @returns {number} The value.
 */
function readU(b, off, len) {
  var v = 0;
  for (var i = len - 1; i >= 0; i--) v = (v * 256) + b[off + i];
  return v;
}

/**
 * Extract a STORED zip into `{name: content}` by walking its central directory.
 * @param {Uint8Array} bytes - The archive.
 * @returns {object} name -> UTF-8 text.
 */
function unzip(bytes) {
  // Find EOCD (fixed 22 bytes here — no comment).
  var eocd = bytes.length - 22;
  assert.equal(readU(bytes, eocd, 4), 0x06054b50, 'EOCD signature');
  var count = readU(bytes, eocd + 10, 2);
  var cdOffset = readU(bytes, eocd + 16, 4);
  var out = {};
  var p = cdOffset;
  var dec = new TextDecoder();
  for (var i = 0; i < count; i++) {
    assert.equal(readU(bytes, p, 4), 0x02014b50, 'central-dir signature');
    var crc = readU(bytes, p + 16, 4);
    var size = readU(bytes, p + 24, 4);
    var nameLen = readU(bytes, p + 28, 2);
    var lho = readU(bytes, p + 42, 4);
    var name = dec.decode(bytes.slice(p + 46, p + 46 + nameLen));
    // Local header: 30 bytes + name + extra, then data.
    assert.equal(readU(bytes, lho, 4), 0x04034b50, 'local-header signature');
    var lNameLen = readU(bytes, lho + 26, 2);
    var lExtra = readU(bytes, lho + 28, 2);
    var dataStart = lho + 30 + lNameLen + lExtra;
    var data = bytes.slice(dataStart, dataStart + size);
    if (typeof zlib.crc32 === 'function') {
      assert.equal(zlib.crc32(Buffer.from(data)) >>> 0, crc, 'CRC matches for ' + name);
    }
    out[name] = dec.decode(data);
    p += 46 + nameLen;
  }
  return out;
}

test('zipSync: an independent reader recovers every entry verbatim', function () {
  var files = [
    { name: 'a.txt', content: 'hello' },
    { name: 'dir/b.json', content: '{"x":1}\n' },
    { name: 'unicode.txt', content: 'café — αβγ' }
  ];
  var bytes = zipSync(files);
  var got = unzip(bytes);
  assert.deepEqual(Object.keys(got).sort(), ['a.txt', 'dir/b.json', 'unicode.txt']);
  assert.equal(got['a.txt'], 'hello');
  assert.equal(got['dir/b.json'], '{"x":1}\n');
  assert.equal(got['unicode.txt'], 'café — αβγ');
});

test('zipSync: empty archive is a bare EOCD', function () {
  var bytes = zipSync([]);
  assert.equal(bytes.length, 22);
  assert.equal(readU(bytes, 0, 4), 0x06054b50);
});

test('zipSync: byte-reproducible for identical input', function () {
  var files = [{ name: 'a.txt', content: 'x' }];
  assert.deepEqual(Array.from(zipSync(files)), Array.from(zipSync(files)));
});
