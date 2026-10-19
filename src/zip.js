/**
 * A tiny, dependency-free ZIP writer (STORED / no compression). Enough to pack
 * a handful of small text files — the reproducible-science bundle (spec, data
 * snapshots, R / Python regeneration code, methods.md) — into one valid `.zip`
 * without pulling in a compression library, matching the rest of this package's
 * dependency-free, self-inlining approach.
 *
 * Produces a standard archive (local file headers + central directory + EOCD)
 * that every unzip tool reads. Entry names use forward slashes; contents are
 * UTF-8. DOS date/time is stamped at a fixed epoch so the bytes are
 * reproducible (two exports of the same content are byte-identical).
 *
 * @module zip
 */

/** @type {number[]} Lazily-built CRC-32 lookup table (IEEE polynomial). */
var CRC_TABLE = null;

/**
 * Build (once) and return the CRC-32 lookup table.
 * @returns {number[]} 256 precomputed CRC values.
 * @private
 */
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  var table = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

/**
 * Compute the CRC-32 of a byte array (as ZIP requires).
 * @param {Uint8Array} bytes - The data.
 * @returns {number} The unsigned 32-bit CRC.
 * @private
 */
function crc32(bytes) {
  var table = crcTable();
  var crc = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encode a string as UTF-8 bytes (TextEncoder where present, else a manual
 * fallback so the writer also runs outside a browser without polyfills).
 * @param {string} str - The text.
 * @returns {Uint8Array} UTF-8 bytes.
 * @private
 */
function utf8(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Write a 32-bit little-endian value into a byte array at an offset.
 * @param {Uint8Array} arr - Target.
 * @param {number} offset - Byte offset.
 * @param {number} value - Unsigned 32-bit value.
 * @returns {void}
 * @private
 */
function writeU32(arr, offset, value) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >>> 8) & 0xff;
  arr[offset + 2] = (value >>> 16) & 0xff;
  arr[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Write a 16-bit little-endian value into a byte array at an offset.
 * @param {Uint8Array} arr - Target.
 * @param {number} offset - Byte offset.
 * @param {number} value - Unsigned 16-bit value.
 * @returns {void}
 * @private
 */
function writeU16(arr, offset, value) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >>> 8) & 0xff;
}

/**
 * Pack a set of text files into a STORED ZIP archive.
 * @param {Array<{name: string, content: string}>} files - The entries; each
 *   `name` is the archive path (forward slashes) and `content` is UTF-8 text.
 * @returns {Uint8Array} The complete `.zip` bytes.
 * @public
 */
export function zipSync(files) {
  files = files || [];
  var chunks = [];           // all byte chunks, in output order
  var central = [];          // central-directory records
  var offset = 0;            // running local-header offset
  // Fixed DOS date/time (1980-01-01 00:00:00) for reproducible bytes.
  var dosTime = 0;
  var dosDate = 0x21;

  files.forEach(function (file) {
    var nameBytes = utf8(file.name);
    var dataBytes = utf8(file.content != null ? String(file.content) : '');
    var crc = crc32(dataBytes);

    var local = new Uint8Array(30 + nameBytes.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);            // version needed
    writeU16(local, 6, 0);             // flags
    writeU16(local, 8, 0);             // method: stored
    writeU16(local, 10, dosTime);
    writeU16(local, 12, dosDate);
    writeU32(local, 14, crc);
    writeU32(local, 18, dataBytes.length);   // compressed size (= uncompressed)
    writeU32(local, 22, dataBytes.length);   // uncompressed size
    writeU16(local, 26, nameBytes.length);
    writeU16(local, 28, 0);            // extra length
    local.set(nameBytes, 30);

    chunks.push(local);
    chunks.push(dataBytes);

    var cd = new Uint8Array(46 + nameBytes.length);
    writeU32(cd, 0, 0x02014b50);
    writeU16(cd, 4, 20);               // version made by
    writeU16(cd, 6, 20);               // version needed
    writeU16(cd, 8, 0);                // flags
    writeU16(cd, 10, 0);               // method: stored
    writeU16(cd, 12, dosTime);
    writeU16(cd, 14, dosDate);
    writeU32(cd, 16, crc);
    writeU32(cd, 20, dataBytes.length);
    writeU32(cd, 24, dataBytes.length);
    writeU16(cd, 28, nameBytes.length);
    writeU16(cd, 30, 0);               // extra length
    writeU16(cd, 32, 0);               // comment length
    writeU16(cd, 34, 0);               // disk number start
    writeU16(cd, 36, 0);               // internal attrs
    writeU32(cd, 38, 0);               // external attrs
    writeU32(cd, 42, offset);          // local header offset
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + dataBytes.length;
  });

  var centralSize = 0;
  central.forEach(function (cd) { centralSize += cd.length; });
  var centralOffset = offset;

  var eocd = new Uint8Array(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 4, 0);                // this disk
  writeU16(eocd, 6, 0);                // disk with central dir
  writeU16(eocd, 8, central.length);   // entries on this disk
  writeU16(eocd, 10, central.length);  // total entries
  writeU32(eocd, 12, centralSize);
  writeU32(eocd, 16, centralOffset);
  writeU16(eocd, 20, 0);               // comment length

  var total = offset + centralSize + eocd.length;
  var out = new Uint8Array(total);
  var pos = 0;
  chunks.forEach(function (chunk) { out.set(chunk, pos); pos += chunk.length; });
  central.forEach(function (cd) { out.set(cd, pos); pos += cd.length; });
  out.set(eocd, pos);
  return out;
}
