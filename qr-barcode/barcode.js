/*
 * 1D barcode encoders — pure JavaScript, no dependencies, no network.
 * Supported: Code 128 (auto A/B/C), EAN-13, EAN-8, UPC-A, Code 39, ITF / ITF-14.
 *
 * Usage:  Barcode.encode("code128", "Hello")
 *   -> { format, binary, displayText, quietZone, guards, textGroups }
 *
 * `binary` is one character per module: "1" = bar, "0" = space.
 * `guards` are [start, end) module ranges drawn full height (EAN/UPC guard bars).
 * `textGroups` position the human readable text; module -1 means "left of the symbol".
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Barcode = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function widthsToBinary(widths, startsWithBar) {
    var out = '';
    var bar = startsWithBar !== false;
    for (var i = 0; i < widths.length; i++) {
      out += (bar ? '1' : '0').repeat(widths[i]);
      bar = !bar;
    }
    return out;
  }

  // ------------------------------------------------------------------ Code 128

  // Element widths for values 0-106 (bar, space, bar, space, bar, space).
  var CODE128_WIDTHS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
  ];

  var CODE128 = { START_A: 103, START_B: 104, START_C: 105, STOP: 106, CODE_A: 101, CODE_B: 100, CODE_C: 99 };

  function isDigit(ch) { return ch >= '0' && ch <= '9'; }

  function digitRunLength(data, i) {
    var n = 0;
    while (i + n < data.length && isDigit(data.charAt(i + n))) n++;
    return n;
  }

  function code128Values(data) {
    for (var i = 0; i < data.length; i++) {
      if (data.charCodeAt(i) > 127) {
        throw new Error('Code 128 supports ASCII characters only (found "' + data.charAt(i) + '")');
      }
    }

    var values = [];
    var set = null; // 'A' | 'B' | 'C'

    function startOrSwitch(target) {
      if (set === null) {
        values.push(target === 'A' ? CODE128.START_A : target === 'B' ? CODE128.START_B : CODE128.START_C);
      } else if (set !== target) {
        values.push(target === 'A' ? CODE128.CODE_A : target === 'B' ? CODE128.CODE_B : CODE128.CODE_C);
      }
      set = target;
    }

    var i = 0;
    while (i < data.length) {
      var run = digitRunLength(data, i);
      var evenRun = run - (run % 2); // set C encodes digit pairs
      // Switching to C pays off for 4+ digits at either end, 6+ in the middle.
      var threshold = (i === 0 || i + run === data.length) ? 4 : 6;
      if (evenRun >= threshold) {
        startOrSwitch('C');
        for (var j = 0; j < evenRun; j += 2) values.push(parseInt(data.substr(i + j, 2), 10));
        i += evenRun;
        continue;
      }

      var code = data.charCodeAt(i);
      var target;
      if (set === 'A' && code <= 95) target = 'A';
      else if (set === 'B' && code >= 32) target = 'B';
      else target = code < 32 ? 'A' : 'B';
      startOrSwitch(target);

      values.push(target === 'A' ? (code < 32 ? code + 64 : code - 32) : code - 32);
      i++;
    }

    if (set === null) throw new Error('Nothing to encode');

    var checksum = values[0];
    for (var k = 1; k < values.length; k++) checksum += values[k] * k;
    values.push(checksum % 103);
    values.push(CODE128.STOP);
    return values;
  }

  function encodeCode128(data) {
    var values = code128Values(data);
    var binary = '';
    for (var i = 0; i < values.length; i++) {
      binary += widthsToBinary(CODE128_WIDTHS[values[i]].split('').map(Number));
    }
    return { binary: binary, displayText: data, quietZone: 10, guards: [], textGroups: null };
  }

  // ---------------------------------------------------------------- EAN family

  var EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  var EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  var EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  var EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

  /** Standard GS1 mod-10 check digit: weights alternate 3,1 from the rightmost data digit. */
  function gs1CheckDigit(digits) {
    var sum = 0;
    for (var i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) {
      sum += Number(digits.charAt(i)) * w;
    }
    return String((10 - sum % 10) % 10);
  }

  function normalizeDigits(value, expected, name) {
    var digits = String(value).replace(/[\s-]/g, '');
    if (!/^[0-9]+$/.test(digits)) throw new Error(name + ' accepts digits only');
    if (digits.length === expected - 1) {
      digits += gs1CheckDigit(digits); // check digit omitted: compute it
    } else if (digits.length === expected) {
      var expectedCheck = gs1CheckDigit(digits.slice(0, -1));
      if (digits.charAt(expected - 1) !== expectedCheck) {
        throw new Error(name + ' check digit should be ' + expectedCheck + ', got ' + digits.charAt(expected - 1));
      }
    } else {
      throw new Error(name + ' needs ' + (expected - 1) + ' or ' + expected + ' digits, got ' + digits.length);
    }
    return digits;
  }

  function ean13Binary(digits) {
    var parity = EAN13_PARITY[Number(digits.charAt(0))];
    var binary = '101';
    for (var i = 1; i <= 6; i++) {
      binary += (parity.charAt(i - 1) === 'L' ? EAN_L : EAN_G)[Number(digits.charAt(i))];
    }
    binary += '01010';
    for (var i = 7; i <= 12; i++) binary += EAN_R[Number(digits.charAt(i))];
    return binary + '101';
  }

  function encodeEan13(value) {
    var digits = normalizeDigits(value, 13, 'EAN-13');
    return {
      binary: ean13Binary(digits),
      displayText: digits,
      quietZone: 11,
      guards: [[0, 3], [45, 50], [92, 95]],
      textGroups: [
        { text: digits.charAt(0), start: -10, end: -2 },
        { text: digits.slice(1, 7), start: 3, end: 45 },
        { text: digits.slice(7), start: 50, end: 92 }
      ]
    };
  }

  function encodeEan8(value) {
    var digits = normalizeDigits(value, 8, 'EAN-8');
    var binary = '101';
    for (var i = 0; i < 4; i++) binary += EAN_L[Number(digits.charAt(i))];
    binary += '01010';
    for (var i = 4; i < 8; i++) binary += EAN_R[Number(digits.charAt(i))];
    binary += '101';
    return {
      binary: binary,
      displayText: digits,
      quietZone: 9,
      guards: [[0, 3], [31, 36], [64, 67]],
      textGroups: [
        { text: digits.slice(0, 4), start: 3, end: 31 },
        { text: digits.slice(4), start: 36, end: 64 }
      ]
    };
  }

  function encodeUpcA(value) {
    var digits = normalizeDigits(value, 12, 'UPC-A');
    return {
      binary: ean13Binary('0' + digits), // UPC-A is EAN-13 with a leading zero
      displayText: digits,
      quietZone: 9,
      guards: [[0, 3], [45, 50], [92, 95]],
      textGroups: [
        { text: digits.charAt(0), start: -8, end: -1 },
        { text: digits.slice(1, 6), start: 10, end: 45 },
        { text: digits.slice(6, 11), start: 50, end: 85 },
        { text: digits.charAt(11), start: 96, end: 103 }
      ]
    };
  }

  // ------------------------------------------------------------------ Code 39

  var CODE39 = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
    '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
    'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
    'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
    'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
    'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
    'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
    'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
    '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn'
  };
  var CODE39_CHECK_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';

  function encodeCode39(value, options) {
    var text = String(value).toUpperCase();
    for (var i = 0; i < text.length; i++) {
      if (!(text.charAt(i) in CODE39) || text.charAt(i) === '*') {
        throw new Error('Code 39 cannot encode "' + text.charAt(i) + '"');
      }
    }
    var payload = text;
    if (options && options.checkDigit) {
      var sum = 0;
      for (var i = 0; i < text.length; i++) sum += CODE39_CHECK_CHARSET.indexOf(text.charAt(i));
      payload += CODE39_CHECK_CHARSET.charAt(sum % 43);
    }

    var wide = (options && options.wideRatio) || 3;
    var chars = ('*' + payload + '*').split('');
    var binary = '';
    for (var i = 0; i < chars.length; i++) {
      if (i > 0) binary += '0'; // narrow inter-character gap
      var widths = CODE39[chars[i]].split('').map(function (w) { return w === 'w' ? wide : 1; });
      binary += widthsToBinary(widths);
    }
    return { binary: binary, displayText: '*' + payload + '*', quietZone: 10, guards: [], textGroups: null };
  }

  // ---------------------------------------------- ITF (Interleaved 2 of 5) / ITF-14

  var ITF_DIGITS = ['nnwwn', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw', 'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'nwnwn'];

  function encodeItf(value, options) {
    var digits = String(value).replace(/[\s-]/g, '');
    if (!/^[0-9]+$/.test(digits)) throw new Error('ITF accepts digits only');

    var isItf14 = options && options.itf14;
    if (isItf14) {
      if (digits.length === 13) digits += gs1CheckDigit(digits);
      else if (digits.length === 14) {
        var check = gs1CheckDigit(digits.slice(0, 13));
        if (digits.charAt(13) !== check) throw new Error('ITF-14 check digit should be ' + check);
      } else throw new Error('ITF-14 needs 13 or 14 digits, got ' + digits.length);
    } else if (digits.length % 2 !== 0) {
      digits = '0' + digits; // ITF encodes pairs, so pad odd-length data
    }

    var wide = (options && options.wideRatio) || 3;
    var binary = widthsToBinary([1, 1, 1, 1]); // start: narrow bar, space, bar, space
    for (var i = 0; i < digits.length; i += 2) {
      var barWidths = ITF_DIGITS[Number(digits.charAt(i))].split('');
      var spaceWidths = ITF_DIGITS[Number(digits.charAt(i + 1))].split('');
      for (var j = 0; j < 5; j++) {
        binary += '1'.repeat(barWidths[j] === 'w' ? wide : 1);
        binary += '0'.repeat(spaceWidths[j] === 'w' ? wide : 1);
      }
    }
    binary += widthsToBinary([wide, 1, 1]); // stop: wide bar, narrow space, narrow bar
    return {
      binary: binary,
      displayText: digits,
      quietZone: 10,
      guards: [],
      textGroups: null,
      bearerBar: !!isItf14
    };
  }

  // ------------------------------------------------------------------- dispatch

  var FORMATS = {
    code128: { label: 'Code 128', encode: function (v, o) { return encodeCode128(v, o); } },
    ean13: { label: 'EAN-13', encode: function (v) { return encodeEan13(v); } },
    ean8: { label: 'EAN-8', encode: function (v) { return encodeEan8(v); } },
    upca: { label: 'UPC-A', encode: function (v) { return encodeUpcA(v); } },
    code39: { label: 'Code 39', encode: function (v, o) { return encodeCode39(v, o); } },
    itf: { label: 'ITF', encode: function (v, o) { return encodeItf(v, o); } },
    itf14: {
      label: 'ITF-14', encode: function (v, o) {
        o = Object.assign({}, o, { itf14: true });
        return encodeItf(v, o);
      }
    }
  };

  function encode(format, value, options) {
    var f = FORMATS[format];
    if (!f) throw new Error('Unknown barcode format: ' + format);
    if (String(value).length === 0) throw new Error('Nothing to encode');
    var result = f.encode(value, options || {});
    result.format = format;
    result.formatLabel = f.label;
    return result;
  }

  return { encode: encode, formats: FORMATS, gs1CheckDigit: gs1CheckDigit };
});
