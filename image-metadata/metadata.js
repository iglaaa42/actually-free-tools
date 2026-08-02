/*
 * Image metadata reader and stripper — no DOM, no canvas, so it can be tested
 * in Node.
 *
 * The point of this file is that it never touches pixels. Re-encoding an image
 * through a canvas does drop metadata, but it also throws away quality and
 * changes every byte of the file. Here the compressed image data is copied
 * across untouched and only the containers around it are rewritten, so a
 * stripped JPEG decodes to exactly the same pixels as the original.
 *
 *   JPEG — a chain of FF-marker segments; drop the ones carrying metadata and
 *          copy the entropy-coded scan verbatim.
 *   PNG  — length/type/data/CRC chunks; drop the text and eXIf chunks. Kept
 *          chunks keep their original CRC, because their bytes never change.
 *   WebP — RIFF chunks; drop EXIF and XMP, clear the matching flag bits in
 *          VP8X, and fix up the RIFF length.
 *
 * Usage:  Metadata.inspect(bytes)        -> what's in there, in readable form
 *         Metadata.strip(bytes, opts)    -> { bytes, removed, removedBytes }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Metadata = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------- utilities

  function ascii(bytes, start, length) {
    var out = '';
    for (var i = 0; i < length && start + i < bytes.length; i++) {
      out += String.fromCharCode(bytes[start + i]);
    }
    return out;
  }

  function startsWith(bytes, offset, text) {
    if (offset + text.length > bytes.length) return false;
    for (var i = 0; i < text.length; i++) {
      if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  }

  function u16be(bytes, i) { return (bytes[i] << 8) | bytes[i + 1]; }
  function u32be(bytes, i) {
    return ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  }
  function u32le(bytes, i) {
    return (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
  }

  function concat(parts, length) {
    var out = new Uint8Array(length);
    var offset = 0;
    for (var i = 0; i < parts.length; i++) {
      out.set(parts[i], offset);
      offset += parts[i].length;
    }
    return out;
  }

  /*
   * Decode a byte run as UTF-8, falling back to Latin-1. EXIF ASCII fields are
   * meant to be 7-bit but cameras and editors put anything in them.
   */
  function text(bytes, start, length) {
    var slice = bytes.subarray(start, start + length);
    if (typeof TextDecoder !== 'undefined') {
      try {
        return new TextDecoder('utf-8', { fatal: false }).decode(slice);
      } catch (err) { /* fall through */ }
    }
    var out = '';
    for (var i = 0; i < slice.length; i++) out += String.fromCharCode(slice[i]);
    return out;
  }

  function clean(value) {
    // EXIF strings are NUL-terminated and frequently space-padded.
    return String(value).replace(/\0[\s\S]*$/, '').replace(/\s+$/, '').trim();
  }

  function detect(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
    if (bytes.length >= 8 && bytes[0] === 0x89 && startsWith(bytes, 1, 'PNG\r\n\x1a\n')) return 'png';
    if (bytes.length >= 12 && startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP')) return 'webp';
    return null;
  }

  // ==================================================================== EXIF
  //
  // Both JPEG APP1 and the PNG eXIf chunk carry a TIFF structure: an 8-byte
  // header, then image file directories of 12-byte entries. Entries whose value
  // doesn't fit in four bytes store an offset instead, measured from the start
  // of the TIFF header.

  var TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

  var TIFF_TAGS = {
    0x010F: 'Camera make',
    0x0110: 'Camera model',
    0x0112: 'Orientation',
    0x0131: 'Software',
    0x0132: 'Date taken',
    0x013B: 'Artist',
    0x8298: 'Copyright',
    0x9C9B: 'Title',
    0x9C9C: 'Comment',
    0x9C9D: 'Author',
    0x9C9E: 'Keywords'
  };

  var EXIF_TAGS = {
    0x829A: 'Exposure time',
    0x829D: 'Aperture',
    0x8827: 'ISO',
    0x9003: 'Date taken',
    0x9004: 'Date digitised',
    0x9286: 'User comment',
    0x920A: 'Focal length',
    0xA402: 'Exposure mode',
    0xA431: 'Camera serial number',
    0xA433: 'Lens make',
    0xA434: 'Lens model',
    0xA435: 'Lens serial number'
  };

  var GPS_TAGS = {
    0x0000: 'GPSVersionID',
    0x0001: 'GPSLatitudeRef',
    0x0002: 'GPSLatitude',
    0x0003: 'GPSLongitudeRef',
    0x0004: 'GPSLongitude',
    0x0005: 'GPSAltitudeRef',
    0x0006: 'GPSAltitude',
    0x001D: 'GPSDateStamp'
  };

  var ORIENTATION_TEXT = {
    1: 'normal',
    2: 'mirrored',
    3: 'rotated 180°',
    4: 'mirrored, rotated 180°',
    5: 'mirrored, rotated 90° CW',
    6: 'rotated 90° CW',
    7: 'mirrored, rotated 90° CCW',
    8: 'rotated 90° CCW'
  };

  function TiffReader(bytes, base) {
    this.bytes = bytes;
    this.base = base;
    var order = ascii(bytes, base, 2);
    this.little = order === 'II';
    this.ok = (order === 'II' || order === 'MM') && this.u16(base + 2) === 42;
  }

  TiffReader.prototype.u16 = function (i) {
    if (i + 2 > this.bytes.length) return 0;
    return this.little ? (this.bytes[i] | (this.bytes[i + 1] << 8)) : u16be(this.bytes, i);
  };

  TiffReader.prototype.u32 = function (i) {
    if (i + 4 > this.bytes.length) return 0;
    return this.little ? u32le(this.bytes, i) : u32be(this.bytes, i);
  };

  TiffReader.prototype.s32 = function (i) {
    var value = this.u32(i);
    return value > 0x7FFFFFFF ? value - 0x100000000 : value;
  };

  /* Read one directory. Returns its entries and the offset of the next one. */
  TiffReader.prototype.readIfd = function (offset) {
    var start = this.base + offset;
    if (start + 2 > this.bytes.length) return { entries: [], next: 0 };

    var count = this.u16(start);
    var entries = [];
    // A corrupt count can be enormous; cap it against what could actually fit.
    var max = Math.min(count, Math.floor((this.bytes.length - start - 2) / 12));

    for (var i = 0; i < max; i++) {
      var at = start + 2 + i * 12;
      entries.push({
        tag: this.u16(at),
        type: this.u16(at + 2),
        count: this.u32(at + 4),
        valueAt: at + 8
      });
    }

    var nextAt = start + 2 + max * 12;
    return { entries: entries, next: nextAt + 4 <= this.bytes.length ? this.u32(nextAt) : 0 };
  };

  /* Resolve an entry to a JS value: string for ASCII, number or array otherwise. */
  TiffReader.prototype.value = function (entry) {
    var size = TYPE_SIZE[entry.type] || 0;
    if (!size || !entry.count) return null;

    var total = size * entry.count;
    // Values of four bytes or fewer sit in the entry itself.
    var at = total <= 4 ? entry.valueAt : this.base + this.u32(entry.valueAt);
    if (at < 0 || at + total > this.bytes.length) return null;

    if (entry.type === 2) return clean(text(this.bytes, at, entry.count));

    var out = [];
    for (var i = 0; i < entry.count && i < 64; i++) {
      var p = at + i * size;
      if (entry.type === 1 || entry.type === 7) out.push(this.bytes[p]);
      else if (entry.type === 3) out.push(this.u16(p));
      else if (entry.type === 4) out.push(this.u32(p));
      else if (entry.type === 9) out.push(this.s32(p));
      else if (entry.type === 5) out.push(ratio(this.u32(p), this.u32(p + 4)));
      else if (entry.type === 10) out.push(ratio(this.s32(p), this.s32(p + 4)));
      else out.push(this.bytes[p]);
    }
    return out.length === 1 ? out[0] : out;
  };

  function ratio(numerator, denominator) {
    if (!denominator) return 0;
    return numerator / denominator;
  }

  function formatValue(tag, value) {
    if (value === null || value === undefined) return '';
    if (tag === 0x0112) return (ORIENTATION_TEXT[value] || 'unknown') + ' (' + value + ')';
    if (tag === 0x829A && typeof value === 'number' && value > 0) {
      return value >= 1 ? value + ' s' : '1/' + Math.round(1 / value) + ' s';
    }
    if (tag === 0x829D && typeof value === 'number') return 'f/' + round(value, 1);
    if (tag === 0x920A && typeof value === 'number') return round(value, 1) + ' mm';
    if (Array.isArray(value)) return value.map(function (v) { return round(v, 4); }).join(', ');
    if (typeof value === 'number') return String(round(value, 4));
    return String(value);
  }

  function round(value, places) {
    if (typeof value !== 'number' || !isFinite(value)) return value;
    var factor = Math.pow(10, places);
    return Math.round(value * factor) / factor;
  }

  /* Degrees/minutes/seconds triple plus a hemisphere letter -> signed decimal. */
  function toDecimal(dms, ref) {
    if (!Array.isArray(dms) || dms.length < 2) return null;
    var degrees = dms[0] || 0;
    var minutes = dms[1] || 0;
    var seconds = dms[2] || 0;
    var value = degrees + minutes / 60 + seconds / 3600;
    if (ref === 'S' || ref === 'W') value = -value;
    return round(value, 6);
  }

  /*
   * Pull the interesting fields out of a TIFF block: IFD0, the Exif sub-IFD it
   * points at, and the GPS IFD. Anything unreadable is skipped rather than
   * thrown, because half-broken EXIF is extremely common and the caller still
   * wants to know what else is in there.
   */
  function readExif(bytes, base) {
    var reader = new TiffReader(bytes, base);
    var result = { tags: [], gps: null, orientation: null };
    if (!reader.ok) return result;

    var ifd0 = reader.readIfd(reader.u32(base + 4));
    var exifOffset = 0;
    var gpsOffset = 0;
    var i, entry, value;

    for (i = 0; i < ifd0.entries.length; i++) {
      entry = ifd0.entries[i];
      if (entry.tag === 0x8769) { exifOffset = reader.value(entry); continue; }
      if (entry.tag === 0x8825) { gpsOffset = reader.value(entry); continue; }
      if (!TIFF_TAGS[entry.tag]) continue;

      value = reader.value(entry);
      if (entry.tag === 0x0112) result.orientation = value;
      if (value === null || value === '') continue;
      result.tags.push({ group: 'Camera', label: TIFF_TAGS[entry.tag], value: formatValue(entry.tag, value) });
    }

    if (exifOffset > 0) {
      var exifIfd = reader.readIfd(exifOffset);
      for (i = 0; i < exifIfd.entries.length; i++) {
        entry = exifIfd.entries[i];
        if (!EXIF_TAGS[entry.tag]) continue;
        value = reader.value(entry);
        if (value === null || value === '') continue;
        // UserComment starts with an 8-byte character-set marker.
        if (entry.tag === 0x9286 && Array.isArray(value)) continue;
        result.tags.push({ group: 'Capture', label: EXIF_TAGS[entry.tag], value: formatValue(entry.tag, value) });
      }
    }

    if (gpsOffset > 0) {
      var gpsIfd = reader.readIfd(gpsOffset);
      var gps = {};
      for (i = 0; i < gpsIfd.entries.length; i++) {
        entry = gpsIfd.entries[i];
        var name = GPS_TAGS[entry.tag];
        if (name) gps[name] = reader.value(entry);
      }
      var lat = toDecimal(gps.GPSLatitude, gps.GPSLatitudeRef);
      var lon = toDecimal(gps.GPSLongitude, gps.GPSLongitudeRef);
      if (lat !== null && lon !== null) {
        result.gps = {
          latitude: lat,
          longitude: lon,
          altitude: typeof gps.GPSAltitude === 'number' ? round(gps.GPSAltitude, 1) : null,
          date: gps.GPSDateStamp || null
        };
      }
    }

    return result;
  }

  // ==================================================================== JPEG

  var JPEG_MARKERS = {
    0xC4: 'Huffman table', 0xDB: 'Quantisation table', 0xDD: 'Restart interval',
    0xDA: 'Scan', 0xFE: 'Comment'
  };

  function jpegSegmentInfo(bytes, marker, payloadAt, payloadLength) {
    // APPn segments start with a NUL-terminated signature saying who owns them.
    if (marker >= 0xE0 && marker <= 0xEF) {
      var n = marker - 0xE0;
      if (n === 0 && startsWith(bytes, payloadAt, 'JFIF')) {
        return { label: 'JFIF header', kind: 'structural' };
      }
      if (n === 0 && startsWith(bytes, payloadAt, 'JFXX')) {
        return { label: 'JFIF extension', kind: 'structural' };
      }
      if (n === 1 && startsWith(bytes, payloadAt, 'Exif\0\0')) {
        return { label: 'EXIF', kind: 'metadata', exifAt: payloadAt + 6 };
      }
      if (n === 1 && startsWith(bytes, payloadAt, 'http://ns.adobe.com/xap/1.0/')) {
        return { label: 'XMP', kind: 'metadata' };
      }
      if (n === 2 && startsWith(bytes, payloadAt, 'ICC_PROFILE')) {
        return { label: 'ICC colour profile', kind: 'colour' };
      }
      if (n === 13 && startsWith(bytes, payloadAt, 'Photoshop 3.0')) {
        return { label: 'Photoshop / IPTC', kind: 'metadata' };
      }
      if (n === 14 && startsWith(bytes, payloadAt, 'Adobe')) {
        // Records the colour transform. Dropping it can turn a CMYK JPEG inside out.
        return { label: 'Adobe colour transform', kind: 'structural' };
      }
      var signature = clean(ascii(bytes, payloadAt, Math.min(16, payloadLength)));
      return {
        label: 'APP' + n + (signature ? ' (' + signature + ')' : ''),
        kind: 'metadata'
      };
    }

    if (marker === 0xFE) return { label: 'Comment', kind: 'metadata' };
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { label: 'Frame header', kind: 'structural', sof: true };
    }
    return { label: JPEG_MARKERS[marker] || 'Marker FF' + marker.toString(16).toUpperCase(), kind: 'structural' };
  }

  function parseJpeg(bytes) {
    var segments = [];
    var dimensions = null;
    var i = 2;

    while (i + 1 < bytes.length) {
      if (bytes[i] !== 0xFF) break;
      var marker = bytes[i + 1];

      // Fill bytes: any number of FFs may pad the gap before a marker.
      if (marker === 0xFF) { i++; continue; }
      // Standalone markers, no length field.
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      if (marker === 0xD9) break;

      if (i + 4 > bytes.length) break;
      var length = u16be(bytes, i + 2);
      if (length < 2) break;
      var end = i + 2 + length;
      if (end > bytes.length) break;

      var info = jpegSegmentInfo(bytes, marker, i + 4, length - 2);
      if (info.sof && i + 9 <= bytes.length) {
        dimensions = { height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) };
      }

      segments.push({
        label: info.label,
        kind: info.kind,
        start: i,
        end: end,
        size: end - i,
        exifAt: info.exifAt || 0
      });

      // Everything after the scan header is entropy-coded data (plus any
      // trailing junk). It gets copied across untouched.
      if (marker === 0xDA) {
        segments.push({
          label: 'Compressed image data',
          kind: 'pixels',
          start: end,
          end: bytes.length,
          size: bytes.length - end,
          exifAt: 0
        });
        break;
      }

      i = end;
    }

    return { segments: segments, dimensions: dimensions };
  }

  // ===================================================================== PNG

  var PNG_CHUNKS = {
    tEXt: { label: 'Text', kind: 'metadata' },
    zTXt: { label: 'Compressed text', kind: 'metadata' },
    iTXt: { label: 'International text', kind: 'metadata' },
    eXIf: { label: 'EXIF', kind: 'metadata', exif: true },
    tIME: { label: 'Last modified time', kind: 'metadata' },
    iCCP: { label: 'ICC colour profile', kind: 'colour' },
    IHDR: { label: 'Header', kind: 'structural' },
    PLTE: { label: 'Palette', kind: 'structural' },
    IDAT: { label: 'Compressed image data', kind: 'pixels' },
    IEND: { label: 'End marker', kind: 'structural' }
  };

  function parsePng(bytes) {
    var segments = [];
    var dimensions = null;
    var i = 8;

    while (i + 8 <= bytes.length) {
      var length = u32be(bytes, i);
      var type = ascii(bytes, i + 4, 4);
      var end = i + 12 + length;
      if (length > bytes.length || end > bytes.length) break;

      if (type === 'IHDR' && length >= 8) {
        dimensions = { width: u32be(bytes, i + 8), height: u32be(bytes, i + 12) };
      }

      var known = PNG_CHUNKS[type];
      segments.push({
        label: known ? known.label + ' (' + type + ')' : type,
        kind: known ? known.kind : 'structural',
        start: i,
        end: end,
        size: end - i,
        // The eXIf chunk payload is a bare TIFF block, no "Exif\0\0" prefix.
        exifAt: known && known.exif ? i + 8 : 0
      });

      if (type === 'IEND') break;
      i = end;
    }

    return { segments: segments, dimensions: dimensions };
  }

  // ==================================================================== WebP

  var WEBP_CHUNKS = {
    EXIF: { label: 'EXIF', kind: 'metadata', exif: true },
    'XMP ': { label: 'XMP', kind: 'metadata' },
    ICCP: { label: 'ICC colour profile', kind: 'colour' },
    VP8X: { label: 'Extended header', kind: 'structural' },
    VP8: { label: 'Compressed image data', kind: 'pixels' },
    VP8L: { label: 'Compressed image data (lossless)', kind: 'pixels' },
    ALPH: { label: 'Alpha channel', kind: 'structural' },
    ANIM: { label: 'Animation header', kind: 'structural' },
    ANMF: { label: 'Animation frame', kind: 'pixels' }
  };

  // Flag bits in the VP8X payload's first byte.
  var VP8X_ICC = 0x20;
  var VP8X_EXIF = 0x08;
  var VP8X_XMP = 0x04;

  function parseWebp(bytes) {
    var segments = [];
    var dimensions = null;
    var i = 12;

    while (i + 8 <= bytes.length) {
      var fourcc = ascii(bytes, i, 4).replace(/\0/g, ' ');
      var length = u32le(bytes, i + 4);
      // Chunks are padded to an even length; the pad byte isn't counted.
      var padded = length + (length % 2);
      var end = i + 8 + padded;
      if (length > bytes.length || end > bytes.length) break;

      var key = fourcc === 'VP8 ' ? 'VP8' : fourcc;
      var known = WEBP_CHUNKS[key];

      if (key === 'VP8X' && length >= 10) {
        dimensions = {
          width: 1 + (bytes[i + 12] | (bytes[i + 13] << 8) | (bytes[i + 14] << 16)),
          height: 1 + (bytes[i + 15] | (bytes[i + 16] << 8) | (bytes[i + 17] << 16))
        };
      }

      segments.push({
        // Unlike PNG's four-letter chunk codes, the RIFF names are already the
        // readable thing, so there's nothing to spell out in brackets.
        label: known ? known.label : fourcc.trim(),
        kind: known ? known.kind : 'metadata',
        start: i,
        end: end,
        size: end - i,
        fourcc: key,
        exifAt: known && known.exif ? i + 8 : 0
      });

      i = end;
    }

    return { segments: segments, dimensions: dimensions };
  }

  // ================================================================ planning

  /*
   * Decide what goes and what stays.
   *
   * The default keeps the ICC profile, because dropping it silently shifts the
   * colours of anything that isn't plain sRGB — that's a change to how the
   * image looks, which is not what "remove metadata" is supposed to mean. The
   * option is there for people who want the file as bare as possible.
   */
  function plan(bytes, opts) {
    opts = opts || {};
    var keepColour = opts.keepColorProfile !== false;
    var format = detect(bytes);
    if (!format) return null;

    var parsed = format === 'jpeg' ? parseJpeg(bytes)
      : format === 'png' ? parsePng(bytes)
        : parseWebp(bytes);

    for (var i = 0; i < parsed.segments.length; i++) {
      var segment = parsed.segments[i];
      segment.strip = segment.kind === 'metadata' || (segment.kind === 'colour' && !keepColour);
    }

    parsed.format = format;
    return parsed;
  }

  // ================================================================= inspect

  function inspect(bytes, opts) {
    var parsed = plan(bytes, opts);
    if (!parsed) {
      return { format: null, supported: false, segments: [], tags: [], gps: null, orientation: null, metadataBytes: 0 };
    }

    var tags = [];
    var gps = null;
    var orientation = null;
    var metadataBytes = 0;

    for (var i = 0; i < parsed.segments.length; i++) {
      var segment = parsed.segments[i];
      if (segment.strip) metadataBytes += segment.size;
      if (!segment.exifAt) continue;

      var exif = readExif(bytes, segment.exifAt);
      tags = tags.concat(exif.tags);
      if (exif.gps) gps = exif.gps;
      if (exif.orientation !== null) orientation = exif.orientation;
    }

    return {
      format: parsed.format,
      supported: true,
      dimensions: parsed.dimensions,
      segments: parsed.segments,
      tags: tags,
      gps: gps,
      orientation: orientation,
      orientationText: orientation ? ORIENTATION_TEXT[orientation] || 'unknown' : null,
      metadataBytes: metadataBytes,
      totalBytes: bytes.length
    };
  }

  // =================================================================== strip

  function stripWebp(bytes, parsed) {
    // The 'RIFF' + length + 'WEBP' header is kept and its length fixed up last.
    var parts = [bytes.subarray(0, 12)];
    var length = 12;
    var removed = [];
    var clearedFlags = 0;
    var flagsAt = 0;

    for (var i = 0; i < parsed.segments.length; i++) {
      var segment = parsed.segments[i];
      if (segment.strip) {
        removed.push({ label: segment.label, size: segment.size });
        if (segment.fourcc === 'EXIF') clearedFlags |= VP8X_EXIF;
        if (segment.fourcc === 'XMP ') clearedFlags |= VP8X_XMP;
        if (segment.fourcc === 'ICCP') clearedFlags |= VP8X_ICC;
        continue;
      }

      // VP8X leads the file, so note where its flag byte lands in the output
      // and patch it once the whole chunk list has been walked.
      if (segment.fourcc === 'VP8X' && segment.size > 8) flagsAt = length + 8;

      parts.push(bytes.subarray(segment.start, segment.end));
      length += segment.size;
    }

    var result = concat(parts, length);

    // The VP8X flags advertise which optional chunks exist. Leaving a bit set
    // for a chunk that's gone makes strict decoders reject the file.
    if (flagsAt) result[flagsAt] = result[flagsAt] & ~clearedFlags & 0xFF;

    // RIFF length counts everything after the first eight bytes.
    var riffLength = result.length - 8;
    result[4] = riffLength & 0xFF;
    result[5] = (riffLength >>> 8) & 0xFF;
    result[6] = (riffLength >>> 16) & 0xFF;
    result[7] = (riffLength >>> 24) & 0xFF;

    return { bytes: result, removed: removed };
  }

  function strip(bytes, opts) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    var parsed = plan(bytes, opts);
    if (!parsed) throw new Error('not a JPEG, PNG or WebP file');

    var result;
    if (parsed.format === 'webp') {
      result = stripWebp(bytes, parsed);
    } else {
      var parts = [];
      var length = 0;
      var removed = [];

      // The signature (JPEG SOI, or the 8-byte PNG magic) sits before the first
      // segment and is always kept.
      var headerEnd = parsed.segments.length ? parsed.segments[0].start : bytes.length;
      parts.push(bytes.subarray(0, headerEnd));
      length += headerEnd;

      for (var i = 0; i < parsed.segments.length; i++) {
        var segment = parsed.segments[i];
        if (segment.strip) {
          removed.push({ label: segment.label, size: segment.size });
          continue;
        }
        parts.push(bytes.subarray(segment.start, segment.end));
        length += segment.size;
      }

      result = { bytes: concat(parts, length), removed: removed };
    }

    var removedBytes = 0;
    for (var j = 0; j < result.removed.length; j++) removedBytes += result.removed[j].size;

    return {
      bytes: result.bytes,
      format: parsed.format,
      removed: result.removed,
      removedBytes: removedBytes,
      originalBytes: bytes.length
    };
  }

  return {
    detect: detect,
    inspect: inspect,
    strip: strip,
    readExif: readExif,
    ORIENTATION_TEXT: ORIENTATION_TEXT,
    _internal: { parseJpeg: parseJpeg, parsePng: parsePng, parseWebp: parseWebp, plan: plan }
  };
});
