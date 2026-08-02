/*
 * Layout + rendering for QR codes and barcodes.
 *
 * Everything goes through a layout object of plain rectangles and text runs, so
 * the canvas (PNG) and the SVG output are guaranteed to agree.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Render = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ layouts

  /**
   * options: { scale, margin (modules), dark, light }
   * Returns { width, height, background, rects: [...], texts: [] }
   */
  function layoutQr(qr, options) {
    var scale = options.scale || 8;
    var margin = options.margin === undefined ? 4 : options.margin;
    var size = qr.size + margin * 2;

    var rects = [];
    for (var y = 0; y < qr.size; y++) {
      // Merge horizontal runs of dark modules into single rectangles: fewer
      // rects means a much smaller SVG and no hairline seams when rasterised.
      var runStart = -1;
      for (var x = 0; x <= qr.size; x++) {
        var dark = x < qr.size && qr.get(x, y);
        if (dark && runStart === -1) runStart = x;
        if (!dark && runStart !== -1) {
          rects.push({
            x: (runStart + margin) * scale,
            y: (y + margin) * scale,
            w: (x - runStart) * scale,
            h: scale
          });
          runStart = -1;
        }
      }
    }

    return {
      width: size * scale,
      height: size * scale,
      background: options.light,
      color: options.dark,
      rects: rects,
      texts: []
    };
  }

  /**
   * options: { scale, height (px of the bar area), margin (modules),
   *            dark, light, showText, fontFamily }
   */
  function layoutBarcode(code, options) {
    var scale = options.scale || 2;
    var barHeight = options.height || 80;
    var quiet = options.margin === undefined ? code.quietZone : options.margin;
    var showText = options.showText !== false && !!code.displayText;

    var modules = code.binary.length;
    var fontSize = Math.max(8, Math.min(40, scale * 5.5));
    var textGap = showText ? Math.round(fontSize * 0.28) : 0;
    var textBand = showText ? Math.round(fontSize * 1.15) : 0;
    var guardExtra = showText && code.guards.length ? Math.round(textBand * 0.62) : 0;
    var padY = Math.round(scale * 3);

    var left = quiet * scale;
    var width = (modules + quiet * 2) * scale;
    var height = padY * 2 + barHeight + guardExtra + textGap + textBand;

    var isGuard = new Array(modules).fill(false);
    code.guards.forEach(function (range) {
      for (var i = range[0]; i < range[1]; i++) isGuard[i] = true;
    });

    var rects = [];
    var runStart = -1;
    for (var i = 0; i <= modules; i++) {
      var bar = i < modules && code.binary.charAt(i) === '1';
      // Guard bars are drawn taller, so break runs where that changes.
      var breakRun = runStart !== -1 && (!bar || isGuard[i] !== isGuard[runStart]);
      if (breakRun) {
        rects.push({
          x: left + runStart * scale,
          y: padY,
          w: (i - runStart) * scale,
          h: barHeight + (isGuard[runStart] ? guardExtra : 0)
        });
        runStart = -1;
      }
      if (bar && runStart === -1) runStart = i;
    }

    var texts = [];
    if (showText) {
      var baseline = padY + barHeight + guardExtra + textGap + fontSize * 0.85;
      if (code.textGroups) {
        code.textGroups.forEach(function (group) {
          texts.push({
            text: group.text,
            x: left + (group.start + group.end) / 2 * scale,
            y: baseline,
            size: fontSize,
            anchor: 'middle',
            maxWidth: Math.abs(group.end - group.start) * scale
          });
        });
      } else {
        texts.push({
          text: code.displayText,
          x: width / 2,
          y: baseline,
          size: fontSize,
          anchor: 'middle',
          maxWidth: width - scale * 2
        });
      }
    }

    if (code.bearerBar) {
      // ITF-14 bearer bars: a frame around the symbol (quiet zones included) that
      // stops a scan running off the side of the label from reading a partial value.
      var bearer = Math.max(2, Math.round(scale * 1.5));
      var frameHeight = barHeight + bearer * 2;
      rects.push({ x: 0, y: padY - bearer, w: width, h: bearer });
      rects.push({ x: 0, y: padY + barHeight, w: width, h: bearer });
      rects.push({ x: 0, y: padY - bearer, w: bearer, h: frameHeight });
      rects.push({ x: width - bearer, y: padY - bearer, w: bearer, h: frameHeight });
    }

    return {
      width: width,
      height: height,
      background: options.light,
      color: options.dark,
      rects: rects,
      texts: texts,
      fontFamily: options.fontFamily || 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
    };
  }

  // ---------------------------------------------------------------- renderers

  function toCanvas(canvas, layout, pixelRatio) {
    var ratio = pixelRatio || 1;
    canvas.width = Math.round(layout.width * ratio);
    canvas.height = Math.round(layout.height * ratio);
    canvas.style.width = layout.width + 'px';
    canvas.style.height = layout.height + 'px';

    var ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);
    if (layout.background) {
      ctx.fillStyle = layout.background;
      ctx.fillRect(0, 0, layout.width, layout.height);
    }

    ctx.fillStyle = layout.color;
    layout.rects.forEach(function (r) { ctx.fillRect(r.x, r.y, r.w, r.h); });

    layout.texts.forEach(function (t) {
      ctx.font = t.size + 'px ' + (layout.fontFamily || 'sans-serif');
      ctx.textAlign = t.anchor === 'middle' ? 'center' : 'left';
      ctx.textBaseline = 'alphabetic';
      // Squeeze overlong text rather than letting it spill into the quiet zone.
      var w = ctx.measureText(t.text).width;
      if (t.maxWidth && w > t.maxWidth) ctx.fillText(t.text, t.x, t.y, t.maxWidth);
      else ctx.fillText(t.text, t.x, t.y);
    });
    return canvas;
  }

  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }

  function toSvg(layout, title) {
    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + layout.width + '" height="' + layout.height +
      '" viewBox="0 0 ' + layout.width + ' ' + layout.height + '" shape-rendering="crispEdges">');
    if (title) parts.push('<title>' + escapeXml(title) + '</title>');
    if (layout.background) parts.push('<rect width="100%" height="100%" fill="' + layout.background + '"/>');

    if (layout.rects.length) {
      var d = layout.rects.map(function (r) {
        return 'M' + round(r.x) + ' ' + round(r.y) + 'h' + round(r.w) + 'v' + round(r.h) + 'h-' + round(r.w) + 'z';
      }).join('');
      parts.push('<path fill="' + layout.color + '" d="' + d + '"/>');
    }

    layout.texts.forEach(function (t) {
      parts.push('<text x="' + round(t.x) + '" y="' + round(t.y) + '" fill="' + layout.color +
        '" font-family="' + escapeXml(layout.fontFamily || 'sans-serif') + '" font-size="' + round(t.size) +
        '" text-anchor="' + t.anchor + '" textLength="' + round(Math.min(t.maxWidth || Infinity, t.size * 0.62 * t.text.length)) +
        '" lengthAdjust="spacingAndGlyphs">' + escapeXml(t.text) + '</text>');
    });

    parts.push('</svg>');
    return parts.join('\n');
  }

  function round(n) { return Math.round(n * 100) / 100; }

  return { layoutQr: layoutQr, layoutBarcode: layoutBarcode, toCanvas: toCanvas, toSvg: toSvg };
});
