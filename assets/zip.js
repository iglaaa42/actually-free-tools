/*
 * Minimal ZIP writer — "stored" entries only, no compression.
 *
 * Batch mode needs to hand back a single file, because browsers throttle or
 * block a page that fires several downloads in a row. Compression would be
 * wasted effort here: JPEG, PNG and WebP payloads are already compressed, so
 * deflate would burn CPU to save roughly nothing. Storing them keeps this file
 * short enough to read end to end.
 *
 * Usage:  Zip.build([{ name: 'a.jpg', bytes: <Uint8Array> }])  ->  Uint8Array
 *
 * Duplicate names are de-duplicated ("a.jpg", "a (2).jpg"), because dropping
 * two folders' worth of IMG_0001.jpg is normal and an archive with colliding
 * entries unpacks badly.
 *
 * Not supported: ZIP64 (so an archive has to stay under 4 GB), compression,
 * encryption, directory entries, per-entry comments.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Zip = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LOCAL_SIG = 0x04034b50;
  var CENTRAL_SIG = 0x02014b50;
  var EOCD_SIG = 0x06054b50;

  // Version 2.0: the floor for the "stored" method with UTF-8 names.
  var VERSION = 20;
  // General purpose bit 11 — filename and comment are UTF-8.
  var FLAG_UTF8 = 0x0800;

  var MAX_SIZE = 0xFFFFFFFF;

  // --------------------------------------------------------------- CRC-32

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // -------------------------------------------------------------- writing

  function Writer() {
    this.parts = [];
    this.length = 0;
  }

  Writer.prototype.u16 = function (value) {
    this.parts.push(new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF]));
    this.length += 2;
  };

  Writer.prototype.u32 = function (value) {
    this.parts.push(new Uint8Array([
      value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF
    ]));
    this.length += 4;
  };

  Writer.prototype.bytes = function (chunk) {
    this.parts.push(chunk);
    this.length += chunk.length;
  };

  Writer.prototype.finish = function () {
    var out = new Uint8Array(this.length);
    var offset = 0;
    for (var i = 0; i < this.parts.length; i++) {
      out.set(this.parts[i], offset);
      offset += this.parts[i].length;
    }
    return out;
  };

  // ---------------------------------------------------------------- names

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // Node before global TextEncoder, and anything else exotic.
    var bytes = unescape(encodeURIComponent(str));
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
    return out;
  }

  function splitExtension(name) {
    var dot = name.lastIndexOf('.');
    // A leading dot is part of the stem (".gitignore"), not an extension.
    if (dot <= 0) return { stem: name, ext: '' };
    return { stem: name.slice(0, dot), ext: name.slice(dot) };
  }

  function uniqueName(taken, name) {
    if (!taken[name]) {
      taken[name] = true;
      return name;
    }
    var parts = splitExtension(name);
    for (var n = 2; ; n++) {
      var candidate = parts.stem + ' (' + n + ')' + parts.ext;
      if (!taken[candidate]) {
        taken[candidate] = true;
        return candidate;
      }
    }
  }

  // ----------------------------------------------------------- timestamps

  // MS-DOS packed date/time. Two-second resolution, and the epoch is 1980.
  function dosDateTime(date) {
    var year = date.getFullYear();
    if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  // ---------------------------------------------------------------- build

  function build(entries, options) {
    options = options || {};
    var stamp = dosDateTime(options.date || new Date());
    var out = new Writer();
    var central = [];
    var taken = {};
    var total = 0;

    for (var i = 0; i < entries.length; i++) {
      var bytes = entries[i].bytes;
      if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);

      var name = utf8(uniqueName(taken, entries[i].name));
      var crc = crc32(bytes);
      var offset = out.length;

      total += bytes.length;
      if (total > MAX_SIZE || offset > MAX_SIZE) {
        throw new Error('archive would exceed 4 GB, which needs ZIP64');
      }

      out.u32(LOCAL_SIG);
      out.u16(VERSION);
      out.u16(FLAG_UTF8);
      out.u16(0);              // method: stored
      out.u16(stamp.time);
      out.u16(stamp.date);
      out.u32(crc);
      out.u32(bytes.length);   // compressed size == uncompressed size
      out.u32(bytes.length);
      out.u16(name.length);
      out.u16(0);              // extra field length
      out.bytes(name);
      out.bytes(bytes);

      central.push({ name: name, crc: crc, size: bytes.length, offset: offset });
    }

    var centralOffset = out.length;

    for (var j = 0; j < central.length; j++) {
      var entry = central[j];
      out.u32(CENTRAL_SIG);
      out.u16(VERSION);        // version made by
      out.u16(VERSION);        // version needed
      out.u16(FLAG_UTF8);
      out.u16(0);              // method: stored
      out.u16(stamp.time);
      out.u16(stamp.date);
      out.u32(entry.crc);
      out.u32(entry.size);
      out.u32(entry.size);
      out.u16(entry.name.length);
      out.u16(0);              // extra field length
      out.u16(0);              // comment length
      out.u16(0);              // disk number start
      out.u16(0);              // internal attributes
      out.u32(0);              // external attributes
      out.u32(entry.offset);
      out.bytes(entry.name);
    }

    // Measured before the EOCD itself is written, or it would count its own bytes.
    var centralSize = out.length - centralOffset;

    out.u32(EOCD_SIG);
    out.u16(0);                // this disk
    out.u16(0);                // disk with the central directory
    out.u16(central.length);
    out.u16(central.length);
    out.u32(centralSize);
    out.u32(centralOffset);
    out.u16(0);                // archive comment length

    return out.finish();
  }

  return {
    build: build,
    crc32: crc32,
    uniqueName: uniqueName
  };
});
