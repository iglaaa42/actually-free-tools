#!/usr/bin/env python3
"""Regenerate tests/vectors.json from independent reference implementations.

    pip install qrcodegen segno python-barcode
    python3 tests/generate-vectors.py

References used, and why:

  * qrcodegen (Nayuki) -- full QR matrices. Chosen as the matrix reference
    because it follows ISO/IEC 18004 7.4.10 exactly.
  * segno -- error correction block layout only (all 160 version/level
    combinations), as a second opinion on the ECC tables. Its matrices are not
    used: segno's write_padding_bits() adds a whole zero codeword when the bit
    stream already ends on a codeword boundary, so its padding differs from the
    standard. The symbols still scan, but they are not byte-identical.
  * python-barcode -- 1D barcode module patterns.

The generated vectors are committed, so `node tests/test.mjs` runs with no
dependencies at all. Only re-run this if you add or change cases.
"""
import json
import os

import barcode
import segno.consts
from qrcodegen import QrCode, QrSegment

HERE = os.path.dirname(os.path.abspath(__file__))

ECC_LEVELS = {"L": QrCode.Ecc.LOW, "M": QrCode.Ecc.MEDIUM,
              "Q": QrCode.Ecc.QUARTILE, "H": QrCode.Ecc.HIGH}
SEGNO_LEVELS = {"L": 1, "M": 0, "Q": 3, "H": 2}

QR_CASES = [
    ("HELLO WORLD", "L"), ("HELLO WORLD", "M"), ("HELLO WORLD", "Q"), ("HELLO WORLD", "H"),
    ("1", "M"), ("12345678901234567890", "L"), ("0" * 200, "H"),
    ("https://example.com/a/very/long/path?with=query&params=1234567890", "M"),
    ("hello, world", "L"), ("Hello, World!", "Q"),
    ("mixed CASE 123 and symbols !@#$%^&*()", "M"),
    ("naïve café — ünïcödé ✓ 日本語", "M"),
    ("x" * 100, "L"), ("x" * 300, "M"), ("y" * 700, "Q"), ("z" * 1200, "L"),
    ("A" * 50, "H"), ("$%*+-./: ABC 123", "L"),
    ("The quick brown fox jumps over the lazy dog. " * 8, "M"),
    ("9" * 500, "Q"), ("tel:+15551234567", "L"),
    ("WIFI:T:WPA;S:MyNetwork;P:s3cr3t!;;", "M"),
    ("BEGIN:VCARD\nVERSION:3.0\nN:Doe;Jane\nTEL:+15551234567\nEND:VCARD", "Q"),
    ("", "M"),
    ("a" * 1200, "H"), ("b" * 2000, "L"),
    # One case per version, to exercise every alignment pattern layout,
    # version information block and block-splitting arrangement.
    *[("v" + str(v) + "-" + "d" * (v * 4), "M") for v in range(1, 41)],
]

BARCODE_CASES = [
    ("code128", "Hello", {}),
    ("code128", "ABC-123", {}),
    ("code128", "1234567890", {}),
    ("code128", "12345", {}),
    ("code128", "a1b2c3", {}),
    ("code128", "Item 42: $9.99", {}),
    ("code128", "0000000000000000000042", {}),
    ("ean13", "123456789012", {}),
    ("ean13", "4006381333931", {}),
    ("ean13", "978020137962", {}),
    ("ean8", "1234567", {}),
    ("ean8", "96385074", {}),
    ("upca", "03600029145", {}),
    ("upca", "012345678905", {}),
    ("code39", "ABC123", {}),
    ("code39", "HELLO WORLD", {}),
    ("code39", "A-1.B$C/D+E%F", {}),
    ("code39", "ABC", {"checkDigit": True}),
    ("code39", "CODE39 TEST", {"checkDigit": True}),
    ("itf", "1234567890", {}),
    ("itf", "0123456789012", {}),
]


def qr_vectors():
    out = []
    for text, err in QR_CASES:
        segs = QrSegment.make_segments(text)
        qr = QrCode.encode_segments(segs, ECC_LEVELS[err], 1, 40, -1, False)
        size = qr.get_size()
        matrix = ["".join("1" if qr.get_module(x, y) else "0" for x in range(size))
                  for y in range(size)]
        out.append({
            "text": text,
            "ecl": err,
            "version": qr.get_version(),
            "mask": qr.get_mask(),
            "matrix": matrix,
        })
    return out


def ecc_table():
    """Block layout for every version/level, from segno's tables."""
    table = {}
    for version in range(1, 41):
        entry = {}
        for name, key in SEGNO_LEVELS.items():
            infos = segno.consts.ECC[version][key]
            ecc_per_block = {i.num_total - i.num_data for i in infos}
            assert len(ecc_per_block) == 1
            entry[name] = {
                "blocks": sum(i.num_blocks for i in infos),
                "ecc_per_block": ecc_per_block.pop(),
                "data_codewords": sum(i.num_blocks * i.num_data for i in infos),
                "total_codewords": sum(i.num_blocks * i.num_total for i in infos),
            }
        table[str(version)] = entry
    return table


def barcode_vectors():
    out = []
    for fmt, value, opts in BARCODE_CASES:
        cls = barcode.get_barcode_class(fmt)
        kwargs = {}
        if fmt == "code39":
            kwargs["add_checksum"] = bool(opts.get("checkDigit"))
        if fmt == "itf":
            # Match our narrow:wide ratio of 1:3 (python-barcode defaults to 2:5).
            kwargs.update(narrow=1, wide=3)
        code = cls(value, **kwargs)
        out.append({
            "format": fmt,
            "value": value,
            "options": opts,
            "binary": "".join(code.build()),
            "reference_text": code.get_fullcode(),
        })
    return out


def main():
    import qrcodegen
    data = {
        "_generated_by": "tests/generate-vectors.py",
        "_references": {
            "qr_matrices": "qrcodegen (Nayuki) %s" % getattr(qrcodegen, "__version__", "?"),
            "ecc_table": "segno %s" % segno.__version__,
            "barcodes": "python-barcode %s" % barcode.version,
        },
        "qr": qr_vectors(),
        "ecc_table": ecc_table(),
        "barcode": barcode_vectors(),
    }
    path = os.path.join(HERE, "vectors.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print("wrote %s: %d QR + %d barcode vectors + %d ECC rows"
          % (path, len(data["qr"]), len(data["barcode"]), len(data["ecc_table"])))


if __name__ == "__main__":
    main()
