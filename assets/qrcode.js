/*
 * QR Code encoder — pure JavaScript, no dependencies, no network.
 * Implements ISO/IEC 18004: versions 1-40, EC levels L/M/Q/H,
 * numeric / alphanumeric / byte (UTF-8) modes, all 8 data masks.
 *
 * Usage:  QR.encode("hello", { ecl: "M" })  ->  { size, version, ecl, mask, get(x, y) }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ECL = {
    L: { ordinal: 0, formatBits: 1 },
    M: { ordinal: 1, formatBits: 0 },
    Q: { ordinal: 2, formatBits: 3 },
    H: { ordinal: 3, formatBits: 2 }
  };

  // Number of error correction codewords per block, indexed [ecl][version].
  var ECC_CODEWORDS_PER_BLOCK = [
    // 0  1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]  // H
  ];

  // Number of error correction blocks, indexed [ecl][version].
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]  // H
  ];

  var ALPHANUMERIC_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  // ---------------------------------------------------------------- bit buffer

  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.appendBits = function (val, len) {
    if (len < 0 || len > 31 || val >>> len !== 0) throw new RangeError('Value out of range');
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  // ------------------------------------------------------------------ segments

  function isNumeric(text) { return /^[0-9]*$/.test(text); }
  function isAlphanumeric(text) {
    for (var i = 0; i < text.length; i++) {
      if (ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) === -1) return false;
    }
    return true;
  }

  function toUtf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var cp = str.codePointAt(i);
      if (cp > 0xFFFF) i++; // surrogate pair consumed
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xC0 | (cp >>> 6), 0x80 | (cp & 0x3F));
      } else if (cp < 0x10000) {
        out.push(0xE0 | (cp >>> 12), 0x80 | ((cp >>> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        out.push(0xF0 | (cp >>> 18), 0x80 | ((cp >>> 12) & 0x3F), 0x80 | ((cp >>> 6) & 0x3F), 0x80 | (cp & 0x3F));
      }
    }
    return out;
  }

  // A segment is { mode, numChars, bits: [0/1, ...] }.
  function makeNumericSegment(digits) {
    var bb = new BitBuffer();
    for (var i = 0; i < digits.length;) {
      var n = Math.min(digits.length - i, 3);
      bb.appendBits(parseInt(digits.substr(i, n), 10), n * 3 + 1);
      i += n;
    }
    return { mode: 'numeric', numChars: digits.length, bits: bb.bits };
  }

  function makeAlphanumericSegment(text) {
    var bb = new BitBuffer();
    var i = 0;
    for (; i + 2 <= text.length; i += 2) {
      var v = ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) * 45 + ALPHANUMERIC_CHARSET.indexOf(text.charAt(i + 1));
      bb.appendBits(v, 11);
    }
    if (i < text.length) bb.appendBits(ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)), 6);
    return { mode: 'alphanumeric', numChars: text.length, bits: bb.bits };
  }

  function makeByteSegment(text) {
    var bytes = toUtf8Bytes(text);
    var bb = new BitBuffer();
    for (var i = 0; i < bytes.length; i++) bb.appendBits(bytes[i], 8);
    return { mode: 'byte', numChars: bytes.length, bits: bb.bits };
  }

  function makeSegment(text) {
    if (text === '') return { mode: 'byte', numChars: 0, bits: [] };
    if (isNumeric(text)) return makeNumericSegment(text);
    if (isAlphanumeric(text)) return makeAlphanumericSegment(text);
    return makeByteSegment(text);
  }

  var MODE_BITS = { numeric: 1, alphanumeric: 2, byte: 4 };
  var CHAR_COUNT_BITS = { numeric: [10, 12, 14], alphanumeric: [9, 11, 13], byte: [8, 16, 16] };

  function charCountBits(mode, version) {
    var i = version <= 9 ? 0 : (version <= 26 ? 1 : 2);
    return CHAR_COUNT_BITS[mode][i];
  }

  function getTotalBits(segs, version) {
    var total = 0;
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var ccbits = charCountBits(seg.mode, version);
      if (seg.numChars >= (1 << ccbits)) return Infinity; // does not fit this version
      total += 4 + ccbits + seg.bits.length;
    }
    return total;
  }

  // ------------------------------------------------------------- capacity math

  function getNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function getNumDataCodewords(ver, ecl) {
    return Math.floor(getNumRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
  }

  // --------------------------------------------------------------- Reed-Solomon

  function reedSolomonComputeDivisor(degree) {
    if (degree < 1 || degree > 255) throw new RangeError('Degree out of range');
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    // Multiply by (x - r^0)(x - r^1)...(x - r^(degree-1)) over GF(2^8).
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = reedSolomonMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = reedSolomonMultiply(root, 0x02);
    }
    return result;
  }

  function reedSolomonComputeRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ result.shift();
      result.push(0);
      for (var j = 0; j < divisor.length; j++) result[j] ^= reedSolomonMultiply(divisor[j], factor);
    }
    return result;
  }

  function reedSolomonMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  function addEccAndInterleave(data, version, ecl) {
    if (data.length !== getNumDataCodewords(version, ecl)) throw new RangeError('Invalid argument');
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][version];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][version];
    var rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [];
    var rsDiv = reedSolomonComputeDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = reedSolomonComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0); // padding so all blocks are the same length for interleaving
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        // Skip the padding byte in short blocks.
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  // ----------------------------------------------------------------- QR object

  function QrCode(version, ecl, dataCodewords, mask) {
    this.version = version;
    this.ecl = ecl;
    this.size = version * 4 + 17;

    this.modules = [];
    this.isFunction = [];
    for (var i = 0; i < this.size; i++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }

    this.drawFunctionPatterns();
    var allCodewords = addEccAndInterleave(dataCodewords, version, ecl);
    this.drawCodewords(allCodewords);

    if (mask === -1) { // pick the mask with the lowest penalty
      var minPenalty = Infinity;
      for (var i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        var penalty = this.getPenaltyScore();
        if (penalty < minPenalty) { mask = i; minPenalty = penalty; }
        this.applyMask(i); // XOR is its own inverse
      }
    }
    this.mask = mask;
    this.applyMask(mask);
    this.drawFormatBits(mask);
    this.isFunction = null;
  }

  QrCode.prototype.get = function (x, y) {
    return (0 <= x && x < this.size && 0 <= y && y < this.size) ? this.modules[y][x] : false;
  };

  QrCode.prototype.setFunctionModule = function (x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  };

  QrCode.prototype.drawFunctionPatterns = function () {
    var size = this.size;
    // Timing patterns
    for (var i = 0; i < size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    // Finder patterns plus separators
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(size - 4, 3);
    this.drawFinderPattern(3, size - 4);

    // Alignment patterns
    var alignPos = this.getAlignmentPatternPositions();
    for (var i = 0; i < alignPos.length; i++) {
      for (var j = 0; j < alignPos.length; j++) {
        // Skip the three corners occupied by finder patterns
        if (!(i === 0 && j === 0 || i === 0 && j === alignPos.length - 1 || i === alignPos.length - 1 && j === 0)) {
          this.drawAlignmentPattern(alignPos[i], alignPos[j]);
        }
      }
    }

    this.drawFormatBits(0); // dummy; overwritten once the mask is known
    this.drawVersion();
  };

  QrCode.prototype.drawFinderPattern = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev distance
        var xx = x + dx, yy = y + dy;
        if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size) {
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  };

  QrCode.prototype.drawAlignmentPattern = function (x, y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  QrCode.prototype.getAlignmentPatternPositions = function () {
    if (this.version === 1) return [];
    var numAlign = Math.floor(this.version / 7) + 2;
    var step = (this.version === 32) ? 26
      : Math.floor((this.version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  };

  QrCode.prototype.drawFormatBits = function (mask) {
    var data = this.ecl.formatBits << 3 | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    // First copy, around the top-left finder
    for (var i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (var i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));

    // Second copy, split across the other two finders
    var size = this.size;
    for (var i = 0; i < 8; i++) this.setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    for (var i = 8; i < 15; i++) this.setFunctionModule(8, size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, size - 8, true); // always-dark module
  };

  QrCode.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = this.version << 12 | rem;

    for (var i = 0; i < 18; i++) {
      var bit = getBit(bits, i);
      var a = this.size - 11 + i % 3;
      var b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  };

  QrCode.prototype.drawCodewords = function (data) {
    var size = this.size;
    var i = 0; // bit index into data
    for (var right = size - 1; right >= 1; right -= 2) { // column pair, right to left
      if (right === 6) right = 5; // skip the vertical timing pattern column
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
          // Remainder bits (if any) stay light.
        }
      }
    }
  };

  QrCode.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = x * y % 2 + x * y % 3 === 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
          default: throw new RangeError('Invalid mask');
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  QrCode.prototype.getPenaltyScore = function () {
    var result = 0;
    var size = this.size;

    // Adjacent modules in a row with the same color, and finder-like patterns
    for (var y = 0; y < size; y++) {
      var runColor = false, runX = 0, runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (var x = 0; x < size; x++) {
        if (this.modules[y][x] === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = this.modules[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
    }
    // Same, per column
    for (var x = 0; x < size; x++) {
      var runColor = false, runY = 0, runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (var y = 0; y < size; y++) {
        if (this.modules[y][x] === runColor) {
          runY++;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = this.modules[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * PENALTY_N3;
    }

    // 2x2 blocks of the same color
    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        var color = this.modules[y][x];
        if (color === this.modules[y][x + 1] && color === this.modules[y + 1][x] && color === this.modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    // Balance of dark and light modules
    var dark = 0;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) if (this.modules[y][x]) dark++;
    }
    var total = size * size;
    // Smallest k such that (20k + 45)% <= dark/total% <= (20k + 55)%
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  };

  QrCode.prototype.finderPenaltyCountPatterns = function (runHistory) {
    var n = runHistory[1];
    var core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
      + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  };

  QrCode.prototype.finderPenaltyTerminateAndCount = function (currentRunColor, currentRunLength, runHistory) {
    if (currentRunColor) { // end the dark run
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size; // add the light border to the final run
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  };

  QrCode.prototype.finderPenaltyAddHistory = function (currentRunLength, runHistory) {
    if (runHistory[0] === 0) currentRunLength += this.size; // add the light border to the first run
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  };

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  // ------------------------------------------------------------------ encoding

  function encodeSegments(segs, ecl, minVersion, maxVersion, mask, boostEcl) {
    var version, dataUsedBits;
    for (version = minVersion; ; version++) {
      var dataCapacityBits = getNumDataCodewords(version, ecl) * 8;
      var usedBits = getTotalBits(segs, version);
      if (usedBits <= dataCapacityBits) { dataUsedBits = usedBits; break; }
      if (version >= maxVersion) {
        throw new RangeError('Data too long: needs a larger QR version or a lower error correction level');
      }
    }

    // Use the highest EC level that still fits in the chosen version, for free.
    if (boostEcl) {
      ['M', 'Q', 'H'].forEach(function (name) {
        if (dataUsedBits <= getNumDataCodewords(version, ECL[name]) * 8 && ECL[name].ordinal > ecl.ordinal) {
          ecl = ECL[name];
        }
      });
    }

    var bb = new BitBuffer();
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      bb.appendBits(MODE_BITS[seg.mode], 4);
      bb.appendBits(seg.numChars, charCountBits(seg.mode, version));
      for (var j = 0; j < seg.bits.length; j++) bb.bits.push(seg.bits[j]);
    }

    var dataCapacityBits = getNumDataCodewords(version, ecl) * 8;
    bb.appendBits(0, Math.min(4, dataCapacityBits - bb.bits.length)); // terminator
    bb.appendBits(0, (8 - bb.bits.length % 8) % 8); // pad to a byte boundary
    for (var padByte = 0xEC; bb.bits.length < dataCapacityBits; padByte ^= 0xEC ^ 0x11) {
      bb.appendBits(padByte, 8);
    }

    var dataCodewords = [];
    for (var i = 0; i < bb.bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bb.bits[i + j];
      dataCodewords.push(b);
    }

    return new QrCode(version, ecl, dataCodewords, mask);
  }

  /**
   * Encode text as a QR code.
   * options: { ecl: 'L'|'M'|'Q'|'H', minVersion, maxVersion, mask: -1..7, boostEcl: bool }
   */
  function encode(text, options) {
    options = options || {};
    var ecl = ECL[(options.ecl || 'M').toUpperCase()];
    if (!ecl) throw new RangeError('Unknown error correction level: ' + options.ecl);
    var minVersion = options.minVersion || 1;
    var maxVersion = options.maxVersion || 40;
    var mask = options.mask === undefined ? -1 : options.mask;
    var boostEcl = options.boostEcl !== false;
    // Empty input carries no segment at all — just terminator and padding.
    var segs = text === '' ? [] : [makeSegment(text)];
    return encodeSegments(segs, ecl, minVersion, maxVersion, mask, boostEcl);
  }

  /** Largest number of characters of `text`'s natural mode that fits a version+ecl. */
  function capacityFor(text, eclName) {
    var ecl = ECL[(eclName || 'M').toUpperCase()];
    var seg = makeSegment(text);
    var bits = getTotalBits([seg], 40);
    return { usedBits: bits, maxBits: getNumDataCodewords(40, ecl) * 8, mode: seg.mode };
  }

  return {
    encode: encode,
    capacityFor: capacityFor,
    // exposed for tests
    _internal: {
      getNumDataCodewords: getNumDataCodewords,
      getNumRawDataModules: getNumRawDataModules,
      makeSegment: makeSegment,
      ECL: ECL
    }
  };
});
