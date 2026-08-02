/*
 * UI glue: reads the form, calls the encoders, renders to canvas, and hands out
 * PNG/SVG downloads. No network calls, no storage, no analytics.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = { mode: 'qr', layout: null, filename: 'code', payload: '' };

  var els = {
    tabs: { qr: $('tab-qr'), barcode: $('tab-barcode') },
    panels: { qr: $('panel-qr'), barcode: $('panel-barcode') },
    canvas: $('canvas'),
    error: $('error'),
    meta: $('meta'),
    copyStatus: $('copy-status'),
    downloadPng: $('download-png'),
    downloadSvg: $('download-svg'),
    copyPng: $('copy-png')
  };

  // ------------------------------------------------------------ QR content

  function esc(value) {
    // Escaping rules shared by the WIFI: and MECARD-style schemes.
    return String(value).replace(/([\\;,:"])/g, '\\$1');
  }

  var QR_BUILDERS = {
    text: function () { return $('qr-text').value; },

    wifi: function () {
      var ssid = $('wifi-ssid').value;
      if (!ssid) return '';
      var security = $('wifi-security').value;
      var parts = ['WIFI:T:' + (security === 'nopass' ? 'nopass' : security), 'S:' + esc(ssid)];
      if (security !== 'nopass') parts.push('P:' + esc($('wifi-password').value));
      if ($('wifi-hidden').checked) parts.push('H:true');
      return parts.join(';') + ';;';
    },

    vcard: function () {
      var first = $('vc-first').value.trim();
      var last = $('vc-last').value.trim();
      var org = $('vc-org').value.trim();
      var title = $('vc-title').value.trim();
      var phone = $('vc-phone').value.trim();
      var email = $('vc-email').value.trim();
      var url = $('vc-url').value.trim();
      if (!(first || last || org || phone || email)) return '';

      var lines = ['BEGIN:VCARD', 'VERSION:3.0'];
      lines.push('N:' + last + ';' + first + ';;;');
      var fn = (first + ' ' + last).trim();
      lines.push('FN:' + (fn || org));
      if (org) lines.push('ORG:' + org);
      if (title) lines.push('TITLE:' + title);
      if (phone) lines.push('TEL;TYPE=CELL:' + phone);
      if (email) lines.push('EMAIL:' + email);
      if (url) lines.push('URL:' + url);
      lines.push('END:VCARD');
      return lines.join('\n');
    },

    email: function () {
      var to = $('em-to').value.trim();
      if (!to) return '';
      var query = [];
      if ($('em-subject').value) query.push('subject=' + encodeURIComponent($('em-subject').value));
      if ($('em-body').value) query.push('body=' + encodeURIComponent($('em-body').value));
      return 'mailto:' + to + (query.length ? '?' + query.join('&') : '');
    },

    sms: function () {
      var number = $('sms-number').value.trim();
      if (!number) return '';
      var body = $('sms-body').value;
      return 'SMSTO:' + number + (body ? ':' + body : '');
    },

    tel: function () {
      var number = $('tel-number').value.trim();
      return number ? 'tel:' + number : '';
    },

    geo: function () {
      var lat = $('geo-lat').value.trim();
      var lon = $('geo-lon').value.trim();
      if (!lat || !lon) return '';
      return 'geo:' + lat + ',' + lon;
    }
  };

  var BARCODE_HINTS = {
    code128: 'Any ASCII text. Digits are packed two per symbol, so numeric values stay compact.',
    ean13: '12 digits (the 13th is calculated) or all 13 if you already have it.',
    ean8: '7 digits (the 8th is calculated) or all 8.',
    upca: '11 digits (the 12th is calculated) or all 12.',
    code39: 'A–Z, 0–9, space and - . $ / + % — lowercase is converted to uppercase.',
    itf: 'Digits only, encoded in pairs. An odd-length value gets a leading zero.',
    itf14: '13 digits (the 14th is calculated) or all 14. Drawn with bearer bars.'
  };

  var BARCODE_DEFAULTS = {
    code128: 'ACTUALLY-FREE-001',
    ean13: '4006381333931',
    ean8: '96385074',
    upca: '012345678905',
    code39: 'FREE TOOLS 123',
    itf: '1234567890',
    itf14: '12345678901231'
  };

  // ------------------------------------------------------------- rendering

  function showError(message) {
    els.error.hidden = false;
    els.error.textContent = message;
    els.canvas.hidden = true;
    els.meta.textContent = '';
    state.layout = null;
    setActionsEnabled(false);
  }

  function setActionsEnabled(enabled) {
    els.downloadPng.disabled = !enabled;
    els.downloadSvg.disabled = !enabled;
    els.copyPng.disabled = !enabled;
  }

  function slugify(text, fallback) {
    var slug = String(text).trim().toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return slug || fallback;
  }

  function renderQr() {
    var builder = QR_BUILDERS[$('qr-type').value];
    var text = builder();
    if (!text) {
      showError('Fill in the fields above to generate a QR code.');
      return;
    }

    var qr;
    try {
      qr = QR.encode(text, {
        ecl: $('qr-ecl').value,
        boostEcl: $('qr-boost').checked
      });
    } catch (err) {
      showError(err.message);
      return;
    }

    var layout = Render.layoutQr(qr, {
      scale: Number($('qr-scale').value),
      margin: Number($('qr-margin').value),
      dark: $('qr-dark').value,
      light: $('qr-transparent').checked ? null : $('qr-light').value
    });

    paint(layout, 'QR code encoding ' + preview(text));
    state.filename = 'qr-' + slugify(text, 'code');
    state.payload = text;

    var levelNames = { L: 'L (~7%)', M: 'M (~15%)', Q: 'Q (~25%)', H: 'H (~30%)' };
    var requested = $('qr-ecl').value;
    var levelKey = ['L', 'M', 'Q', 'H'][qr.ecl.ordinal];
    var levelText = 'error correction ' + levelNames[levelKey] +
      (levelKey === requested ? '' : ', raised from ' + requested + ' at no cost');
    els.meta.textContent = 'Version ' + qr.version + ' · ' + qr.size + '×' + qr.size + ' modules · ' +
      levelText + ' · mask ' + qr.mask + ' · encodes ' +
      text.length + ' character' + (text.length === 1 ? '' : 's') + ': ' + preview(text);
  }

  function preview(text) {
    var oneLine = text.replace(/\s+/g, ' ');
    return oneLine.length > 70 ? '“' + oneLine.slice(0, 70) + '…”' : '“' + oneLine + '”';
  }

  function renderBarcode() {
    var format = $('bc-format').value;
    var value = $('bc-value').value;
    if (!value) {
      showError('Enter a value to generate a barcode.');
      return;
    }

    var code;
    try {
      code = Barcode.encode(format, value, { checkDigit: $('bc-check').checked });
    } catch (err) {
      showError(err.message);
      return;
    }

    var layout = Render.layoutBarcode(code, {
      scale: Number($('bc-scale').value),
      height: Number($('bc-height').value),
      dark: $('bc-dark').value,
      light: $('bc-transparent').checked ? null : $('bc-light').value,
      showText: $('bc-showtext').checked
    });

    paint(layout, code.formatLabel + ' barcode encoding “' + code.displayText + '”');
    state.filename = format + '-' + slugify(code.displayText, 'code');
    state.payload = code.displayText;

    els.meta.textContent = code.formatLabel + ' · ' + code.binary.length + ' modules · encodes “' +
      code.displayText + '”';
  }

  function paint(layout, label) {
    els.error.hidden = true;
    els.canvas.hidden = false;
    els.canvas.setAttribute('aria-label', label || 'Generated code');
    state.layout = layout;
    Render.toCanvas(els.canvas, layout, window.devicePixelRatio || 1);
    setActionsEnabled(true);
    els.copyStatus.textContent = '';
  }

  function render() {
    if (state.mode === 'qr') renderQr();
    else renderBarcode();
  }

  // ------------------------------------------------------------ downloads

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke on the next tick so the download has definitely started.
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportCanvas() {
    // Render at 1:1 with no device pixel ratio so the PNG matches the layout.
    var canvas = document.createElement('canvas');
    Render.toCanvas(canvas, state.layout, 1);
    return canvas;
  }

  els.downloadPng.addEventListener('click', function () {
    if (!state.layout) return;
    var canvas = exportCanvas();
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) { saveBlob(blob, state.filename + '.png'); }, 'image/png');
    } else {
      var a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = state.filename + '.png';
      a.click();
    }
  });

  els.downloadSvg.addEventListener('click', function () {
    if (!state.layout) return;
    var svg = Render.toSvg(state.layout, state.payload);
    saveBlob(new Blob([svg], { type: 'image/svg+xml' }), state.filename + '.svg');
  });

  if (navigator.clipboard && window.ClipboardItem) {
    els.copyPng.hidden = false;
    els.copyPng.addEventListener('click', function () {
      if (!state.layout) return;
      exportCanvas().toBlob(function (blob) {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function () {
          els.copyStatus.textContent = 'Copied to clipboard.';
        }, function () {
          els.copyStatus.textContent = 'Your browser blocked the clipboard — use Download PNG instead.';
        });
      }, 'image/png');
    });
  }

  // ----------------------------------------------------------------- wiring

  function selectTab(mode) {
    state.mode = mode;
    ['qr', 'barcode'].forEach(function (key) {
      var active = key === mode;
      els.tabs[key].classList.toggle('is-active', active);
      els.tabs[key].setAttribute('aria-selected', String(active));
      els.panels[key].hidden = !active;
    });
    render();
  }

  els.tabs.qr.addEventListener('click', function () { selectTab('qr'); });
  els.tabs.barcode.addEventListener('click', function () { selectTab('barcode'); });

  function showQrSubform() {
    var type = $('qr-type').value;
    Array.prototype.forEach.call(document.querySelectorAll('[data-qr-form]'), function (node) {
      node.hidden = node.getAttribute('data-qr-form') !== type;
    });
  }

  $('qr-type').addEventListener('change', function () { showQrSubform(); render(); });

  $('bc-format').addEventListener('change', function () {
    var format = $('bc-format').value;
    $('bc-hint').textContent = BARCODE_HINTS[format];
    $('bc-check-wrap').hidden = format !== 'code39';
    $('bc-value').value = BARCODE_DEFAULTS[format];
    render();
  });

  // Live update on any input, plus the range value read-outs.
  [['qr-scale', 'qr-scale-out'], ['qr-margin', 'qr-margin-out'],
   ['bc-scale', 'bc-scale-out'], ['bc-height', 'bc-height-out']].forEach(function (pair) {
    var input = $(pair[0]), out = $(pair[1]);
    input.addEventListener('input', function () { out.textContent = input.value; });
  });

  document.addEventListener('input', render);
  document.addEventListener('change', render);

  // Initial paint.
  $('bc-hint').textContent = BARCODE_HINTS.code128;
  showQrSubform();
  render();
})();
