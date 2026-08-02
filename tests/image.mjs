/*
 * Tests for the image tools. No dependencies — run with:  node tests/image.mjs
 *
 * Fixtures are built byte by byte in this file rather than committed as sample
 * photos, because the thing under test is container surgery: which segments
 * survive, which are dropped, and whether the compressed image data comes out
 * the other side unchanged. A hand-built file with known metadata at known
 * offsets tests that far more precisely than a real JPEG would, and it keeps
 * the repository free of binary blobs.
 *
 * Four kinds of check:
 *  1. EXIF/TIFF parsing, including GPS conversion and both byte orders.
 *  2. Stripping JPEG, PNG and WebP — metadata gone, pixels byte-identical.
 *  3. ZIP writing, verified by reading the archive back.
 *  4. Resize maths.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const Metadata = require(join(here, '..', 'image-metadata', 'metadata.js'));
const Resize = require(join(here, '..', 'image-resize', 'resize.js'));
const Zip = require(join(here, '..', 'assets', 'zip.js'));

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertClose(actual, expected, tolerance, msg) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${msg || 'mismatch'}: expected ~${expected}, got ${actual}`);
  }
}
function assertBytesEqual(actual, expected, msg) {
  assertEqual(actual.length, expected.length, `${msg}: length`);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`${msg}: byte ${i} is ${actual[i]}, expected ${expected[i]}`);
  }
}

// ======================================================== fixture building

const be16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];
const be32 = (v) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
const le16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
const le32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
const chars = (s) => [...s].map((c) => c.charCodeAt(0));
const nulString = (s) => [...chars(s), 0];

/*
 * A TIFF/EXIF block: IFD0 carrying Make, Model, Orientation and a pointer to a
 * GPS IFD carrying a latitude and longitude. Offsets are laid out by hand so
 * the expected values are obvious from reading this function.
 */
function buildExif({ make, model, orientation, lat, lon, little = false }) {
  const u16 = little ? le16 : be16;
  const u32 = little ? le32 : be32;
  const rational = (n, d) => [...u32(n), ...u32(d)];

  const makeBytes = nulString(make);
  const modelBytes = nulString(model);

  // IFD0: 4 entries, so 2 + 4*12 + 4 = 54 bytes, starting at offset 8.
  const IFD0_AT = 8;
  const IFD0_SIZE = 2 + 4 * 12 + 4;
  const makeAt = IFD0_AT + IFD0_SIZE;
  const modelAt = makeAt + makeBytes.length;
  // Pad to an even offset — not required by TIFF, but it is conventional.
  const gpsAt = modelAt + modelBytes.length + ((modelAt + modelBytes.length) % 2);

  // GPS IFD: 4 entries, same 54-byte shape, then two 24-byte rational triples.
  const GPS_SIZE = 2 + 4 * 12 + 4;
  const latAt = gpsAt + GPS_SIZE;
  const lonAt = latAt + 24;

  const entry = (tag, type, count, valueBytes) => [
    ...u16(tag), ...u16(type), ...u32(count),
    // Values of four bytes or fewer live in the entry; longer ones are offsets.
    ...(valueBytes.length <= 4 ? [...valueBytes, ...new Array(4 - valueBytes.length).fill(0)] : valueBytes)
  ];

  const out = [
    ...chars(little ? 'II' : 'MM'), ...u16(42), ...u32(IFD0_AT),
    ...u16(4),
    ...entry(0x010F, 2, makeBytes.length, u32(makeAt)),
    ...entry(0x0110, 2, modelBytes.length, u32(modelAt)),
    ...entry(0x0112, 3, 1, [...u16(orientation), 0, 0]),
    ...entry(0x8825, 4, 1, u32(gpsAt)),
    ...u32(0)
  ];

  while (out.length < makeAt) out.push(0);
  out.push(...makeBytes, ...modelBytes);
  while (out.length < gpsAt) out.push(0);

  out.push(
    ...u16(4),
    ...entry(0x0001, 2, 2, chars(lat.ref).concat(0)),
    ...entry(0x0002, 5, 3, u32(latAt)),
    ...entry(0x0003, 2, 2, chars(lon.ref).concat(0)),
    ...entry(0x0004, 5, 3, u32(lonAt)),
    ...u32(0),
    ...rational(lat.d, 1), ...rational(lat.m, 1), ...rational(lat.s * 100, 100),
    ...rational(lon.d, 1), ...rational(lon.m, 1), ...rational(lon.s * 100, 100)
  );

  return out;
}

const SAMPLE_EXIF = {
  make: 'ExampleCorp',
  model: 'Model X100',
  orientation: 6,
  lat: { ref: 'N', d: 51, m: 30, s: 11.76 },
  lon: { ref: 'W', d: 0, m: 7, s: 40.44 }
};

// Roughly Trafalgar Square, from the values above.
const EXPECTED_LAT = 51 + 30 / 60 + 11.76 / 3600;
const EXPECTED_LON = -(0 + 7 / 60 + 40.44 / 3600);

/* Distinct, recognisable bytes standing in for entropy-coded scan data. */
function fakePixels(length, seed) {
  const out = [];
  for (let i = 0; i < length; i++) out.push((i * 7 + seed) & 0x7F);
  return out;
}

const JPEG_SCAN = fakePixels(64, 3);

function segment(marker, payload) {
  return [0xFF, marker, ...be16(payload.length + 2), ...payload];
}

function buildJpeg({ exif = true, comment = true, icc = true, width = 800, height = 600 } = {}) {
  const out = [0xFF, 0xD8];

  out.push(...segment(0xE0, [...nulString('JFIF'), 1, 2, 0, 0, 1, 0, 1, 0, 0]));
  if (exif) out.push(...segment(0xE1, [...chars('Exif'), 0, 0, ...buildExif(SAMPLE_EXIF)]));
  if (comment) out.push(...segment(0xFE, chars('created with something that logs your name')));
  if (icc) out.push(...segment(0xE2, [...nulString('ICC_PROFILE'), 1, 1, ...fakePixels(32, 9)]));

  out.push(...segment(0xDB, [0, ...fakePixels(64, 1)]));
  // SOF0: precision, height, width, then one component.
  out.push(...segment(0xC0, [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]));
  out.push(...segment(0xC4, [0x00, ...fakePixels(16, 5)]));
  out.push(...segment(0xDA, [1, 1, 0, 0, 63, 0]));
  out.push(...JPEG_SCAN);
  out.push(0xFF, 0xD9);

  return new Uint8Array(out);
}

function pngChunk(type, data) {
  const body = [...chars(type), ...data];
  const crc = Zip.crc32(new Uint8Array(body));
  return [...be32(data.length), ...body, ...be32(crc)];
}

const PNG_IDAT = fakePixels(40, 11);

function buildPng({ text = true, exif = true, time = true, icc = true } = {}) {
  const out = [0x89, ...chars('PNG'), 0x0D, 0x0A, 0x1A, 0x0A];

  out.push(...pngChunk('IHDR', [...be32(320), ...be32(240), 8, 6, 0, 0, 0]));
  if (icc) out.push(...pngChunk('iCCP', [...nulString('profile'), 0, ...fakePixels(16, 13)]));
  if (text) out.push(...pngChunk('tEXt', [...nulString('Author'), ...chars('Jane Doe')]));
  if (exif) out.push(...pngChunk('eXIf', buildExif(SAMPLE_EXIF)));
  if (time) out.push(...pngChunk('tIME', [...be16(2024), 3, 14, 15, 9, 26]));
  out.push(...pngChunk('IDAT', PNG_IDAT));
  out.push(...pngChunk('IEND', []));

  return new Uint8Array(out);
}

const WEBP_VP8 = fakePixels(30, 17);

function webpChunk(fourcc, data) {
  const out = [...chars(fourcc), ...le32(data.length), ...data];
  if (data.length % 2) out.push(0);   // chunks are padded to an even length
  return out;
}

function buildWebp({ exif = true, xmp = true, icc = true } = {}) {
  // VP8X flags: ICC 0x20, EXIF 0x08, XMP 0x04.
  const flags = (icc ? 0x20 : 0) | (exif ? 0x08 : 0) | (xmp ? 0x04 : 0);
  const dim = (v) => [(v - 1) & 0xFF, ((v - 1) >> 8) & 0xFF, ((v - 1) >> 16) & 0xFF];

  const body = [
    ...webpChunk('VP8X', [flags, 0, 0, 0, ...dim(640), ...dim(480)]),
    ...(icc ? webpChunk('ICCP', fakePixels(15, 19)) : []),
    ...webpChunk('VP8 ', WEBP_VP8),
    ...(exif ? webpChunk('EXIF', buildExif(SAMPLE_EXIF)) : []),
    ...(xmp ? webpChunk('XMP ', chars('<x:xmpmeta>Jane Doe</x:xmpmeta>')) : [])
  ];

  return new Uint8Array([...chars('RIFF'), ...le32(body.length + 4), ...chars('WEBP'), ...body]);
}

// ================================================== 1. EXIF / TIFF parsing

check('detects the three supported formats and rejects others', () => {
  assertEqual(Metadata.detect(buildJpeg()), 'jpeg');
  assertEqual(Metadata.detect(buildPng()), 'png');
  assertEqual(Metadata.detect(buildWebp()), 'webp');
  assertEqual(Metadata.detect(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null, 'GIF is not supported');
  assertEqual(Metadata.detect(new Uint8Array([])), null, 'empty input');
});

check('reads camera make, model and orientation out of EXIF', () => {
  const report = Metadata.inspect(buildJpeg());
  const find = (label) => report.tags.find((t) => t.label === label);
  assertEqual(find('Camera make').value, 'ExampleCorp');
  assertEqual(find('Camera model').value, 'Model X100');
  assertEqual(report.orientation, 6);
  assertEqual(report.orientationText, 'rotated 90° CW');
});

check('converts GPS coordinates to signed decimal degrees', () => {
  const report = Metadata.inspect(buildJpeg());
  assert(report.gps, 'expected GPS to be found');
  assertClose(report.gps.latitude, EXPECTED_LAT, 1e-5, 'latitude');
  assertClose(report.gps.longitude, EXPECTED_LON, 1e-5, 'longitude');
  assert(report.gps.longitude < 0, 'a western longitude must come out negative');
});

check('reads both TIFF byte orders identically', () => {
  const big = Metadata.readExif(new Uint8Array(buildExif(SAMPLE_EXIF)), 0);
  const little = Metadata.readExif(new Uint8Array(buildExif({ ...SAMPLE_EXIF, little: true })), 0);
  assertEqual(little.orientation, big.orientation, 'orientation');
  assertClose(little.gps.latitude, big.gps.latitude, 1e-9, 'latitude');
  assertClose(little.gps.longitude, big.gps.longitude, 1e-9, 'longitude');
  assertEqual(little.tags.length, big.tags.length, 'tag count');
});

check('survives truncated and malformed EXIF without throwing', () => {
  const full = buildJpeg();
  for (const cut of [20, 40, 80, 160, 240]) {
    const report = Metadata.inspect(full.subarray(0, cut));
    assert(report !== null, `truncated at ${cut} returned nothing`);
  }
  // An IFD claiming far more entries than the buffer could hold.
  const lying = new Uint8Array([...chars('MM'), 0, 42, 0, 0, 0, 8, 0xFF, 0xFF]);
  const report = Metadata.readExif(lying, 0);
  assertEqual(report.tags.length, 0, 'no tags from a bogus entry count');
});

// ============================================================ 2. stripping

check('JPEG: metadata segments go, image data is byte-identical', () => {
  const original = buildJpeg();
  const result = Metadata.strip(original);

  const labels = result.removed.map((r) => r.label);
  assert(labels.includes('EXIF'), 'EXIF should be removed');
  assert(labels.includes('Comment'), 'the comment should be removed');
  assert(!labels.includes('ICC colour profile'), 'the ICC profile is kept by default');
  assert(!labels.includes('JFIF header'), 'the JFIF header is structural');

  assert(result.bytes.length < original.length, 'the file should get smaller');
  assertEqual(result.bytes[0], 0xFF, 'still starts with SOI');
  assertEqual(result.bytes[1], 0xD8, 'still starts with SOI');

  // The scan data is the last thing in the file before EOI.
  const tail = result.bytes.subarray(result.bytes.length - 2 - JPEG_SCAN.length, result.bytes.length - 2);
  assertBytesEqual(tail, new Uint8Array(JPEG_SCAN), 'scan data');
  assertEqual(result.bytes[result.bytes.length - 2], 0xFF, 'EOI marker');
  assertEqual(result.bytes[result.bytes.length - 1], 0xD9, 'EOI marker');
});

check('JPEG: the structural segments all survive', () => {
  const result = Metadata.strip(buildJpeg());
  const after = Metadata.inspect(result.bytes);
  const labels = after.segments.map((s) => s.label);

  for (const wanted of ['JFIF header', 'Quantisation table', 'Frame header', 'Huffman table', 'Scan']) {
    assert(labels.includes(wanted), `${wanted} should still be there`);
  }
  assertEqual(after.dimensions.width, 800, 'width still readable');
  assertEqual(after.dimensions.height, 600, 'height still readable');
});

check('JPEG: nothing metadata-shaped is left afterwards', () => {
  const after = Metadata.inspect(Metadata.strip(buildJpeg()).bytes);
  assertEqual(after.tags.length, 0, 'no tags left');
  assertEqual(after.gps, null, 'no GPS left');
  assertEqual(after.orientation, null, 'no orientation left');
  assertEqual(after.metadataBytes, 0, 'nothing left to strip');
});

check('JPEG: dropping the colour profile is opt-in', () => {
  const kept = Metadata.strip(buildJpeg());
  const dropped = Metadata.strip(buildJpeg(), { keepColorProfile: false });
  assert(dropped.bytes.length < kept.bytes.length, 'dropping ICC should shrink it further');
  assert(dropped.removed.some((r) => r.label === 'ICC colour profile'), 'ICC should be listed as removed');
});

check('JPEG: stripping twice changes nothing the second time', () => {
  const once = Metadata.strip(buildJpeg());
  const twice = Metadata.strip(once.bytes);
  assertBytesEqual(twice.bytes, once.bytes, 'second pass');
  assertEqual(twice.removedBytes, 0, 'nothing left to remove');
});

check('JPEG: a file with no metadata comes back untouched', () => {
  const bare = buildJpeg({ exif: false, comment: false, icc: false });
  const result = Metadata.strip(bare);
  assertBytesEqual(result.bytes, bare, 'unchanged');
  assertEqual(result.removed.length, 0, 'nothing removed');
});

check('PNG: text, EXIF and timestamp chunks go, IDAT stays', () => {
  const original = buildPng();
  const result = Metadata.strip(original);
  const labels = result.removed.map((r) => r.label);

  assert(labels.some((l) => l.includes('tEXt')), 'tEXt should be removed');
  assert(labels.some((l) => l.includes('eXIf')), 'eXIf should be removed');
  assert(labels.some((l) => l.includes('tIME')), 'tIME should be removed');
  assert(!labels.some((l) => l.includes('iCCP')), 'iCCP is kept by default');

  const after = Metadata.inspect(result.bytes);
  const kept = after.segments.map((s) => s.label);
  assert(kept.some((l) => l.includes('IHDR')), 'IHDR kept');
  assert(kept.some((l) => l.includes('IDAT')), 'IDAT kept');
  assert(kept.some((l) => l.includes('IEND')), 'IEND kept');
  assertEqual(after.tags.length, 0, 'no tags left');
  assertEqual(after.dimensions.width, 320, 'dimensions still readable');
});

check('PNG: kept chunks keep their original CRC', () => {
  const result = Metadata.strip(buildPng());
  // Walk the output and re-verify every chunk's CRC over type+data.
  let i = 8;
  let chunks = 0;
  while (i + 8 <= result.bytes.length) {
    const length = (result.bytes[i] << 24 | result.bytes[i + 1] << 16 | result.bytes[i + 2] << 8 | result.bytes[i + 3]) >>> 0;
    const stored = (result.bytes[i + 8 + length] << 24 | result.bytes[i + 9 + length] << 16
      | result.bytes[i + 10 + length] << 8 | result.bytes[i + 11 + length]) >>> 0;
    const actual = Zip.crc32(result.bytes.subarray(i + 4, i + 8 + length));
    assertEqual(actual, stored, `chunk at ${i} CRC`);
    chunks++;
    i += 12 + length;
  }
  assertEqual(chunks, 4, 'IHDR, iCCP, IDAT, IEND');
});

check('PNG: image data is byte-identical', () => {
  const result = Metadata.strip(buildPng());
  const idatAt = indexOfBytes(result.bytes, new Uint8Array(PNG_IDAT));
  assert(idatAt > 0, 'IDAT payload should appear unchanged');
});

check('WebP: EXIF and XMP go and the VP8X flags are cleared', () => {
  const original = buildWebp();
  const result = Metadata.strip(original);
  const labels = result.removed.map((r) => r.label);

  assert(labels.includes('EXIF'), 'EXIF removed');
  assert(labels.includes('XMP'), 'XMP removed');

  // VP8X payload starts at 20: 12 header bytes, then fourcc + size.
  const flags = result.bytes[20];
  assertEqual(flags & 0x08, 0, 'EXIF flag cleared');
  assertEqual(flags & 0x04, 0, 'XMP flag cleared');
  assertEqual(flags & 0x20, 0x20, 'ICC flag still set, since the profile was kept');
});

check('WebP: the RIFF length is corrected', () => {
  const result = Metadata.strip(buildWebp());
  const declared = result.bytes[4] | (result.bytes[5] << 8) | (result.bytes[6] << 16) | (result.bytes[7] << 24);
  assertEqual(declared, result.bytes.length - 8, 'RIFF size field');
});

check('WebP: dropping the profile clears the ICC flag too', () => {
  const result = Metadata.strip(buildWebp(), { keepColorProfile: false });
  assertEqual(result.bytes[20] & 0x20, 0, 'ICC flag cleared');
  assert(result.removed.some((r) => r.label === 'ICC colour profile'), 'ICC listed as removed');
});

check('WebP: image data is byte-identical', () => {
  const result = Metadata.strip(buildWebp());
  assert(indexOfBytes(result.bytes, new Uint8Array(WEBP_VP8)) > 0, 'VP8 payload should appear unchanged');
});

check('unsupported input is refused rather than mangled', () => {
  let threw = false;
  try { Metadata.strip(new Uint8Array([1, 2, 3, 4])); } catch (err) { threw = true; }
  assert(threw, 'strip() should throw on input it cannot parse');
});

function indexOfBytes(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// ================================================================= 3. ZIP

/* Just enough of a ZIP reader to prove the writer produced a real archive. */
function readZip(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const u16 = (i) => bytes[i] | (bytes[i + 1] << 8);
  const u32 = (i) => (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;

  const count = u16(eocd + 10);
  const size = u32(eocd + 12);
  let at = u32(eocd + 16);
  if (at + size !== eocd) throw new Error('central directory does not end where the EOCD starts');

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (u32(at) !== 0x02014b50) throw new Error(`bad central header at ${at}`);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const offset = u32(at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (u32(offset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localNameLength = u16(offset + 26);
    const localExtraLength = u16(offset + 28);
    const dataAt = offset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataAt, dataAt + u32(at + 24));

    entries.push({ name, data, crc: u32(at + 16), method: u16(at + 10) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

check('ZIP: entries round-trip with correct names, data and CRCs', () => {
  const a = new Uint8Array(fakePixels(500, 1));
  const b = new Uint8Array(fakePixels(37, 2));
  const archive = Zip.build([{ name: 'photo.jpg', bytes: a }, { name: 'folder/note.png', bytes: b }]);
  const entries = readZip(archive);

  assertEqual(entries.length, 2, 'entry count');
  assertEqual(entries[0].name, 'photo.jpg');
  assertEqual(entries[1].name, 'folder/note.png');
  assertBytesEqual(entries[0].data, a, 'first payload');
  assertBytesEqual(entries[1].data, b, 'second payload');
  assertEqual(entries[0].crc, Zip.crc32(a), 'first CRC');
  assertEqual(entries[1].crc, Zip.crc32(b), 'second CRC');
  assertEqual(entries[0].method, 0, 'stored, not deflated');
});

check('ZIP: CRC-32 matches the known check value', () => {
  // The standard CRC-32 test vector: "123456789" -> 0xCBF43926.
  assertEqual(Zip.crc32(new Uint8Array(chars('123456789'))), 0xCBF43926);
  assertEqual(Zip.crc32(new Uint8Array([])), 0, 'empty input');
});

check('ZIP: duplicate names are made unique', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const archive = Zip.build([
    { name: 'IMG_0001.jpg', bytes },
    { name: 'IMG_0001.jpg', bytes },
    { name: 'IMG_0001.jpg', bytes }
  ]);
  const names = readZip(archive).map((e) => e.name);
  assertEqual(names[0], 'IMG_0001.jpg');
  assertEqual(names[1], 'IMG_0001 (2).jpg');
  assertEqual(names[2], 'IMG_0001 (3).jpg');
});

check('ZIP: non-ASCII names are written as UTF-8', () => {
  const archive = Zip.build([{ name: 'føto — 1.jpg', bytes: new Uint8Array([9]) }]);
  assertEqual(readZip(archive)[0].name, 'føto — 1.jpg');
});

check('ZIP: an empty archive is still a valid archive', () => {
  assertEqual(readZip(Zip.build([])).length, 0);
});

check('ZIP: an empty file inside an archive is handled', () => {
  const entries = readZip(Zip.build([{ name: 'empty.png', bytes: new Uint8Array([]) }]));
  assertEqual(entries.length, 1);
  assertEqual(entries[0].data.length, 0);
  assertEqual(entries[0].crc, 0);
});

// ============================================================== 4. resize

check('fit: scales down to sit inside the box, keeping aspect', () => {
  const out = Resize.target({ width: 4032, height: 3024 }, { mode: 'fit', maxWidth: 1600, maxHeight: 1600 });
  assertEqual(out.width, 1600);
  assertEqual(out.height, 1200);
});

check('fit: the limiting dimension is the one that binds', () => {
  const out = Resize.target({ width: 1000, height: 4000 }, { mode: 'fit', maxWidth: 800, maxHeight: 800 });
  assertEqual(out.width, 200);
  assertEqual(out.height, 800);
});

check('fit: refuses to enlarge unless asked', () => {
  const source = { width: 900, height: 600 };
  const capped = Resize.target(source, { mode: 'fit', maxWidth: 2000, maxHeight: 2000 });
  assertEqual(capped.width, 900, 'left alone by default');
  assertEqual(capped.height, 600);

  const allowed = Resize.target(source, { mode: 'fit', maxWidth: 1800, maxHeight: 1800, allowUpscale: true });
  assertEqual(allowed.width, 1800, 'enlarged when allowed');
  assertEqual(allowed.height, 1200);
});

check('width and height modes drive the other dimension', () => {
  assertEqual(Resize.target({ width: 1000, height: 750 }, { mode: 'width', width: 400 }).height, 300);
  assertEqual(Resize.target({ width: 1000, height: 750 }, { mode: 'height', height: 300 }).width, 400);
});

check('percent scales both ways, including up', () => {
  const half = Resize.target({ width: 1000, height: 500 }, { mode: 'percent', percent: 50 });
  assertEqual(half.width, 500);
  assertEqual(half.height, 250);

  const double = Resize.target({ width: 100, height: 50 }, { mode: 'percent', percent: 200 });
  assertEqual(double.width, 200, 'an explicit 200% means 200%');
});

check('exact ignores aspect ratio', () => {
  const out = Resize.target({ width: 1000, height: 1000 }, { mode: 'exact', width: 300, height: 100 });
  assertEqual(out.width, 300);
  assertEqual(out.height, 100);
});

check('never produces a zero or negative dimension', () => {
  const out = Resize.target({ width: 5000, height: 3 }, { mode: 'percent', percent: 1 });
  assertEqual(out.width, 50);
  assertEqual(out.height, 1, 'rounds up to a single pixel rather than vanishing');
});

check('clamps to a size the browser will actually allocate', () => {
  const out = Resize.target({ width: 10000, height: 10000 }, { mode: 'percent', percent: 1000 });
  assertEqual(out.width, Resize.MAX_DIMENSION);
});

check('missing or nonsense options leave the image alone', () => {
  const source = { width: 640, height: 480 };
  for (const opts of [{}, { mode: 'fit' }, { mode: 'width' }, { mode: 'percent', percent: 0 }]) {
    const out = Resize.target(source, opts);
    assertEqual(out.width, 640, `width for ${JSON.stringify(opts)}`);
    assertEqual(out.height, 480, `height for ${JSON.stringify(opts)}`);
  }
});

check('steps halve repeatedly and always land on the target', () => {
  const steps = Resize.steps({ width: 4000, height: 3000 }, { width: 250, height: 188 });
  assert(steps.length > 1, 'a big downscale should be done in stages');
  assertEqual(steps[steps.length - 1].width, 250, 'ends at the target');
  assertEqual(steps[steps.length - 1].height, 188, 'ends at the target');
  for (let i = 1; i < steps.length; i++) {
    assert(steps[i].width <= steps[i - 1].width, 'monotonically shrinking');
    assert(steps[i].width >= 1, 'never degenerate');
  }
});

check('steps stay single for modest changes and upscales', () => {
  assertEqual(Resize.steps({ width: 1000, height: 800 }, { width: 700, height: 560 }).length, 1);
  assertEqual(Resize.steps({ width: 400, height: 300 }, { width: 800, height: 600 }).length, 1);
});

check('output names take the extension of the chosen format', () => {
  assertEqual(Resize.outputName('holiday.HEIC', 'image/jpeg'), 'holiday.jpg');
  assertEqual(Resize.outputName('holiday.png', 'image/webp'), 'holiday.webp');
  assertEqual(Resize.outputName('no-extension', 'image/png'), 'no-extension.png');
  assertEqual(Resize.outputName('a.b.c.jpg', 'image/png', '-small'), 'a.b.c-small.png');
});

check('file sizes render readably', () => {
  assertEqual(Resize.humanSize(0), '0 B');
  assertEqual(Resize.humanSize(999), '999 B');
  assertEqual(Resize.humanSize(2048), '2.0 KB');
  assertEqual(Resize.humanSize(3 * 1024 * 1024), '3.0 MB');
});

// ================================================================ results

if (failures.length) {
  console.log(`\n${failures.length} failed, ${passed} passed\n`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`\n${passed} checks passed\n`);
