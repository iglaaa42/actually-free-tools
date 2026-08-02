# actually-free-tools

Rebuilds of basic tools that got paywalled, ad-stuffed, or turned into a funnel.
No accounts, no uploads, no "dynamic" links pointing at someone else's redirect
domain.

Open `index.html` for the tool index. Everything is static files — no build step,
no server, no dependencies — so it runs from disk or from any static host. Staying
that cheap to host is a hard constraint, not an accident; see
[CLAUDE.md](CLAUDE.md) for the rules.

## Tools

| | |
|---|---|
| [`qr-barcode/`](qr-barcode/) | QR codes and 1D barcodes, PNG or SVG |

## QR & barcode generator

Open `qr-barcode/index.html`. Save the folder (with `assets/` alongside it) and it
works with the network off.

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

## Verifying it

```
node tests/test.mjs      # 218 checks, no dependencies
```

The suite covers four things:

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
qr-barcode/              one directory per tool
  index.html             the tool
  tool.css               layout specific to this tool
  qrcode.js              QR encoder       (standalone, works in Node too)
  barcode.js             barcode encoders (standalone, works in Node too)
  render.js              shared layout → canvas + SVG
  app.js                 UI glue
tests/                   test suite and reference vectors
```

The encoders have no DOM dependency and export themselves under CommonJS as well,
so they're usable outside the page:

```js
const QR = require('./qr-barcode/qrcode.js');
const qr = QR.encode('https://example.com', { ecl: 'M' });
qr.get(x, y);  // true = dark module
```

## Not done yet

- Micro QR, UPC-E, Codabar and GS1-128 application identifiers.
- Kanji mode (text still encodes fine as UTF-8 bytes, just less densely).
- No `LICENSE` file yet — worth adding one before anyone else uses this.
