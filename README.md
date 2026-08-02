# actually-free-tools

### → **[iglaaa42.github.io/actually-free-tools](https://iglaaa42.github.io/actually-free-tools/)**

Rebuilds of basic tools that got paywalled, ad-stuffed, or turned into a funnel.
No accounts, no uploads, no "dynamic" links pointing at someone else's redirect
domain.

Everything is static files — no build step, no server, no dependencies — so it
runs from the link above, from any other static host, or straight off disk by
opening `index.html`. Staying that cheap to host is a hard constraint, not an
accident; see [CLAUDE.md](CLAUDE.md) for the rules.

## Tools

| | | |
|---|---|---|
| [`qr-barcode/`](qr-barcode/) | QR codes and 1D barcodes, PNG or SVG | [open ↗](https://iglaaa42.github.io/actually-free-tools/qr-barcode/) |
| [`image-resize/`](image-resize/) | Resize, convert and compress images, in batches | [open ↗](https://iglaaa42.github.io/actually-free-tools/image-resize/) |
| [`image-metadata/`](image-metadata/) | Read and strip EXIF/GPS without touching pixels | [open ↗](https://iglaaa42.github.io/actually-free-tools/image-metadata/) |

## QR & barcode generator

[Live](https://iglaaa42.github.io/actually-free-tools/qr-barcode/), or open
`qr-barcode/index.html` locally. Save the folder (with `assets/` alongside it) and
it works with the network off.

**QR codes** — ISO/IEC 18004: versions 1–40, error correction L/M/Q/H, numeric /
alphanumeric / byte (UTF-8) modes, all eight data masks with the standard penalty
evaluation. Content helpers for plain text/URL, Wi-Fi, contact card, email, SMS,
phone and location.

**Barcodes** — Code 128 (auto A/B/C switching), EAN-13, EAN-8, UPC-A, Code 39
(optional mod-43 check character), ITF and ITF-14 (with bearer bars). Check digits
are calculated when you leave them off and validated when you include them.

Output is PNG or SVG, with adjustable module size, quiet zone, colours and an
optional transparent background.

### Why bother

The common failure mode of "free" QR generators is that the code doesn't contain
your URL. It contains *theirs*, which redirects to yours — until the trial ends,
or the pricing changes, or they decide to count scans and show an interstitial.
Printed codes can't be edited, so that's leverage over anything you've already
shipped.

Here the symbol encodes exactly the string shown under the preview. The page makes
no network requests at all — there's a `connect-src 'none'` CSP on it, and you can
confirm the whole thing in your browser's network tab.

## Image resizer & converter

[Live](https://iglaaa42.github.io/actually-free-tools/image-resize/), or open
`image-resize/index.html` locally.

Drop in one image or a few hundred. Fit inside a box, set a width or height,
scale by a percentage, or force an exact size; convert between JPEG, PNG and
WebP with a quality slider for the lossy ones. One file downloads directly, and
several come back as a ZIP — browsers block a page that fires downloads in a
row, so batches need a single archive.

Large downscales are done by halving repeatedly and finishing on the exact
target. Going straight from 4000&nbsp;px to 300&nbsp;px in one `drawImage()` call
samples too few source pixels and comes out noisy; stepping down is what image
editors do and it costs nothing.

Decoding applies EXIF orientation, so photos taken sideways come out upright,
and because the output is drawn fresh from decoded pixels, metadata doesn't
survive the trip. If that's all you want, the metadata stripper does it without
the quality loss of re-encoding.

## Image metadata viewer & stripper

[Live](https://iglaaa42.github.io/actually-free-tools/image-metadata/), or open
`image-metadata/index.html` locally.

Shows what a photo is carrying — GPS coordinates converted to decimal degrees,
camera make and model, serial numbers, lens, capture dates, the software that
touched it — then writes back a copy without it. It lists every segment in the
file and marks each one kept or removed, so you can see what happened rather
than trust it.

**Nothing is re-encoded.** JPEG APP segments, PNG ancillary chunks and WebP RIFF
chunks are dropped from the container while the compressed image data is copied
across byte for byte. A stripped JPEG decodes to exactly the same pixels at
exactly the same quality. Tools that strip metadata by re-saving the image cost
you a generation of quality every time.

Colour profiles are kept by default, with a checkbox to drop them: an ICC
profile isn't personal information, and removing it visibly shifts the colours
of anything that isn't plain sRGB.

One honest limitation: if a photo depends on an EXIF orientation flag to display
upright, removing the metadata leaves it sideways. There's no way around that
without re-encoding, so the page warns you when it applies and points at the
resizer, which bakes the rotation into the pixels.

### Why bother

"Remove EXIF online" is a category where the failure mode is the whole problem:
the site asks you to upload the exact photo whose location you were trying not
to share. This page makes no network requests at all — there's a
`connect-src 'none'` CSP on it, and `img-src` is pinned to the page's own origin
plus `data:` and `blob:`, so the bytes can't leave as a query string on an
`<img>` either.

## Verifying it

```
node tests/test.mjs      # 218 checks, no dependencies
node tests/image.mjs     # 38 checks, no dependencies
```

`tests/image.mjs` builds JPEG, PNG and WebP files byte by byte, with known
metadata at known offsets, and checks that stripping removes what it should,
keeps what it should, leaves the compressed image data byte-identical and is
idempotent. It also covers GPS conversion, both TIFF byte orders, malformed
EXIF, the ZIP writer (read back with a small ZIP parser in the test file) and
the resize maths. Fixtures are generated rather than committed, so there are no
binary blobs in the repository.

`tests/test.mjs` covers four things:

1. **Block layout** for all 160 QR version/level combinations, plus the published
   ISO/IEC 18004 character capacities at versions 1 and 40.
2. **Byte-for-byte matrix comparison** against reference vectors in
   `tests/vectors.json` — 66 QR symbols (including one per version, so every
   alignment-pattern layout and version-information block is exercised) and 21
   barcodes.
3. **Round-trip decoding.** `tests/test.mjs` contains an independent QR reader
   (unmask → de-interleave → parse segments, including a BCH check on the format
   bits) and a Code 128 reader. Both decode the encoder's output back to the
   original input.
4. **Check digits, validation and error handling.**

### Regenerating the vectors

The vectors are committed so the test suite needs nothing installed. To rebuild
them:

```
pip install qrcodegen segno python-barcode
python3 tests/generate-vectors.py
```

References, and why each was picked:

- **qrcodegen** (Nayuki) — QR matrices. It follows ISO/IEC 18004 §7.4.10 exactly.
- **segno** — the error-correction block table only, as a second opinion. Its
  matrices are deliberately *not* used as vectors: `write_padding_bits()` appends a
  whole zero codeword when the bit stream already ends on a codeword boundary, so
  its padding differs from the standard. The symbols still scan; they just aren't
  byte-identical.
- **python-barcode** — 1D module patterns. Its ITF defaults to a 2:5 narrow:wide
  ratio, so the generator asks for 1:3 to match ours.

## Layout

```
index.html               landing page
favicon.svg              one mark for the whole site
assets/site.css          shared shell: tokens, chrome, controls, cards
assets/dropzone.css      file drop zone, shared by the tools that take files
assets/zip.js            store-only ZIP writer, for batch downloads
qr-barcode/              one directory per tool
  index.html             the tool
  tool.css               layout specific to this tool
  qrcode.js              QR encoder       (standalone, works in Node too)
  barcode.js             barcode encoders (standalone, works in Node too)
  render.js              shared layout → canvas + SVG
  app.js                 UI glue
image-resize/
  resize.js              target sizes and downscale steps (standalone)
  app.js                 canvas work and batching
image-metadata/
  metadata.js            container parsers, EXIF reader, stripper (standalone)
  app.js                 UI glue
tests/                   test suites and reference vectors
```

The logic modules have no DOM dependency and export themselves under CommonJS as
well, so they're usable outside the page:

```js
const QR = require('./qr-barcode/qrcode.js');
const qr = QR.encode('https://example.com', { ecl: 'M' });
qr.get(x, y);  // true = dark module

const Metadata = require('./image-metadata/metadata.js');
const clean = Metadata.strip(bytes).bytes;   // same pixels, no EXIF
```

## Not done yet

- Micro QR, UPC-E, Codabar and GS1-128 application identifiers.
- Kanji mode (text still encodes fine as UTF-8 bytes, just less densely).
- Metadata stripping handles JPEG, PNG and WebP. TIFF, HEIC and AVIF aren't
  parsed; the resizer can still convert them if the browser can decode them.
- The stripper reads EXIF but doesn't decompress `zTXt`/`iTXt` PNG chunks or
  parse XMP and IPTC payloads to show you what's inside them. They're removed in
  full either way — they just aren't listed field by field the way EXIF is.
- No `LICENSE` file yet — worth adding one before anyone else uses this.
