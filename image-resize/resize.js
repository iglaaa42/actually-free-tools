/*
 * Resize maths — no DOM, no canvas, so it can be tested in Node.
 *
 * Everything the tool decides before a single pixel is touched lives here:
 * what the output dimensions should be, which intermediate steps to take to
 * get there without the result turning to mush, and what to call the file.
 *
 * Usage:  Resize.target({ width: 4032, height: 3024 }, { mode: 'fit', maxWidth: 1600 })
 *           ->  { width: 1600, height: 1200 }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Resize = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Browsers refuse to allocate canvases past a certain size, and the limit is
  // both undocumented and device-specific. This is comfortably under the
  // smallest limit in circulation (Safari on iOS).
  var MAX_DIMENSION = 16384;

  var FORMATS = {
    'image/jpeg': { ext: '.jpg', lossy: true, label: 'JPEG' },
    'image/png': { ext: '.png', lossy: false, label: 'PNG' },
    'image/webp': { ext: '.webp', lossy: true, label: 'WebP' }
  };

  function clampDimension(value) {
    // Round first, then floor at 1: a 5000x10 image scaled to 1% is still an
    // image, not a zero-height one.
    var rounded = Math.round(value);
    if (!isFinite(rounded) || rounded < 1) return 1;
    return Math.min(rounded, MAX_DIMENSION);
  }

  /*
   * Work out the output size.
   *
   *   mode: 'fit'      scale down to sit inside maxWidth x maxHeight, aspect kept
   *         'width'    scale so the width lands on opts.width, aspect kept
   *         'height'   scale so the height lands on opts.height, aspect kept
   *         'percent'  scale by opts.percent
   *         'exact'    opts.width x opts.height exactly, aspect ignored
   *
   * 'fit', 'width' and 'height' refuse to enlarge unless allowUpscale is set,
   * because asking for "max 2000px wide" on a 900px image means "leave it
   * alone", not "blow it up and invent detail". 'percent' and 'exact' are
   * explicit instructions, so they enlarge if that's what the numbers say.
   */
  function target(source, opts) {
    opts = opts || {};
    var sw = Math.max(1, Math.round(source.width));
    var sh = Math.max(1, Math.round(source.height));
    var mode = opts.mode || 'fit';
    var scale;

    if (mode === 'exact') {
      var w = opts.width > 0 ? opts.width : sw;
      var h = opts.height > 0 ? opts.height : sh;
      return { width: clampDimension(w), height: clampDimension(h) };
    }

    if (mode === 'percent') {
      var percent = opts.percent > 0 ? opts.percent : 100;
      scale = percent / 100;
    } else if (mode === 'width') {
      if (!(opts.width > 0)) return { width: sw, height: sh };
      scale = opts.width / sw;
    } else if (mode === 'height') {
      if (!(opts.height > 0)) return { width: sw, height: sh };
      scale = opts.height / sh;
    } else {
      var maxW = opts.maxWidth > 0 ? opts.maxWidth : Infinity;
      var maxH = opts.maxHeight > 0 ? opts.maxHeight : Infinity;
      if (maxW === Infinity && maxH === Infinity) return { width: sw, height: sh };
      scale = Math.min(maxW / sw, maxH / sh);
    }

    if (mode !== 'percent' && !opts.allowUpscale) scale = Math.min(scale, 1);

    return { width: clampDimension(sw * scale), height: clampDimension(sh * scale) };
  }

  /*
   * Intermediate sizes for a downscale.
   *
   * One drawImage() from 4000px to 300px samples far too few source pixels and
   * the result looks noisy and aliased, because the browser's filter only looks
   * at a small neighbourhood. Halving repeatedly and finishing with the real
   * target is the standard fix — each step is a clean 2:1 average.
   *
   * Returns the sizes to draw in order, always ending at `to`. An upscale or a
   * modest downscale gets a single step.
   */
  function steps(from, to) {
    var out = [];
    var w = from.width;
    var h = from.height;

    while (w > to.width * 2 && h > to.height * 2) {
      w = Math.max(to.width, Math.floor(w / 2));
      h = Math.max(to.height, Math.floor(h / 2));
      if (w === to.width && h === to.height) break;
      out.push({ width: w, height: h });
    }

    out.push({ width: to.width, height: to.height });
    return out;
  }

  function formatInfo(type) {
    return FORMATS[type] || null;
  }

  /* Swap the extension for one matching the output type, keeping the stem. */
  function outputName(name, type, suffix) {
    var info = FORMATS[type];
    var ext = info ? info.ext : '';
    var dot = String(name).lastIndexOf('.');
    var stem = dot > 0 ? String(name).slice(0, dot) : String(name);
    return stem + (suffix || '') + ext;
  }

  function humanSize(bytes) {
    if (!(bytes >= 0)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(bytes < 10485760 ? 1 : 0) + ' MB';
  }

  return {
    target: target,
    steps: steps,
    formatInfo: formatInfo,
    outputName: outputName,
    humanSize: humanSize,
    MAX_DIMENSION: MAX_DIMENSION,
    FORMATS: FORMATS
  };
});
