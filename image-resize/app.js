/*
 * UI glue: takes files from the picker or a drop, decodes them, redraws them at
 * the requested size and hands back the results — one file directly, several as
 * a ZIP. No network calls, no storage, no analytics.
 *
 * Files are held as ordinary variables for as long as the page is open and are
 * gone the moment it closes. Nothing is written to storage of any kind.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // Object URLs for previews are cheap but not free, and a few hundred of them
  // would pin every decoded image in memory at once.
  var MAX_PREVIEWS = 60;

  var state = {
    files: [],     // the File objects currently loaded
    results: [],   // { name, blob, width, height, originalSize, error }
    urls: [],      // object URLs awaiting revocation
    run: 0         // bumped on every re-run, so stale passes can bail out
  };

  var els = {
    drop: $('drop'),
    picker: $('picker'),
    workspace: $('workspace'),
    error: $('error'),
    status: $('status'),
    single: $('single'),
    batch: $('batch'),
    filelist: $('filelist'),
    batchSummary: $('batch-summary'),
    singleMeta: $('single-meta'),
    beforeImg: $('before-img'),
    afterImg: $('after-img'),
    beforeCaption: $('before-caption'),
    afterCaption: $('after-caption'),
    download: $('download'),
    clear: $('clear')
  };

  // --------------------------------------------------------------- helpers

  function number(value) {
    var parsed = parseInt(String(value).replace(/[^0-9]/g, ''), 10);
    return isFinite(parsed) ? parsed : 0;
  }

  function trackUrl(url) {
    state.urls.push(url);
    return url;
  }

  function releaseUrls() {
    for (var i = 0; i < state.urls.length; i++) URL.revokeObjectURL(state.urls[i]);
    state.urls = [];
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = !message;
  }

  function status(message) {
    els.status.textContent = message || '';
  }

  /* Not every browser can encode every format; WebP in particular is recent. */
  function canEncode(type) {
    var canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    try {
      return canvas.toDataURL(type).indexOf('data:' + type) === 0;
    } catch (err) {
      return false;
    }
  }

  function bytesOf(blob) {
    if (blob.arrayBuffer) {
      return blob.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(new Error('could not read the encoded image')); };
      reader.readAsArrayBuffer(blob);
    });
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  // -------------------------------------------------------------- decoding

  function decodeViaElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () {
        resolve({
          source: image,
          width: image.naturalWidth,
          height: image.naturalHeight,
          release: function () { URL.revokeObjectURL(url); }
        });
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('this file could not be decoded as an image'));
      };
      image.src = url;
    });
  }

  /*
   * imageOrientation: 'from-image' applies the EXIF rotation while decoding, so
   * a photo taken sideways is drawn upright and the rotation is baked into the
   * output pixels rather than left as a metadata flag that the next program
   * might ignore.
   */
  function decode(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bitmap) {
          return {
            source: bitmap,
            width: bitmap.width,
            height: bitmap.height,
            release: function () { if (bitmap.close) bitmap.close(); }
          };
        }, function () {
          return decodeViaElement(file);
        });
      } catch (err) {
        return decodeViaElement(file);
      }
    }
    return decodeViaElement(file);
  }

  // -------------------------------------------------------------- drawing

  function draw(decoded, target, opaque) {
    var steps = Resize.steps({ width: decoded.width, height: decoded.height }, target);
    var source = decoded.source;
    var canvas = null;

    for (var i = 0; i < steps.length; i++) {
      canvas = document.createElement('canvas');
      canvas.width = steps[i].width;
      canvas.height = steps[i].height;

      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // JPEG has no alpha channel. Without a white base underneath, transparent
      // areas would be encoded as black rather than as nothing.
      if (opaque && i === steps.length - 1) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      source = canvas;
    }

    return canvas;
  }

  function encode(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      var done = function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('the browser could not encode this image'));
      };
      // PNG is lossless, so passing a quality would be meaningless.
      if (Resize.formatInfo(type) && Resize.formatInfo(type).lossy) canvas.toBlob(done, type, quality);
      else canvas.toBlob(done, type);
    });
  }

  // --------------------------------------------------------------- options

  function readOptions() {
    var mode = $('mode').value;
    var format = $('format').value;
    return {
      mode: mode,
      maxWidth: number($('max-width').value),
      maxHeight: number($('max-height').value),
      width: mode === 'exact' ? number($('exact-width').value) : number($('target-width').value),
      height: mode === 'exact' ? number($('exact-height').value) : number($('target-height').value),
      percent: number($('percent').value),
      allowUpscale: $('upscale').checked,
      format: format,
      quality: number($('quality').value) / 100
    };
  }

  function targetFor(decoded, opts) {
    // 'none' is a UI convenience rather than a resize mode — it means "convert
    // or recompress, but leave the dimensions where they are".
    if (opts.mode === 'none') return { width: decoded.width, height: decoded.height };
    return Resize.target({ width: decoded.width, height: decoded.height }, opts);
  }

  function outputType(file, opts) {
    if (opts.format) return opts.format;
    // "Keep the original format" only works if it's one we can write back out;
    // anything else (HEIC, AVIF, GIF, BMP) becomes a PNG so nothing is lost.
    return Resize.formatInfo(file.type) ? file.type : 'image/png';
  }

  function syncFields() {
    var mode = $('mode').value;
    var groups = document.querySelectorAll('[data-for]');

    for (var i = 0; i < groups.length; i++) {
      var modes = groups[i].getAttribute('data-for').split(' ');
      groups[i].hidden = modes.indexOf(mode) === -1;
    }

    var format = $('format').value;
    var info = Resize.formatInfo(format);
    // With "keep the original format" the batch may contain both, so the
    // quality control stays visible.
    $('quality-field').hidden = !!info && !info.lossy;

    $('percent-out').textContent = $('percent').value;
    $('quality-out').textContent = $('quality').value;
  }

  // ------------------------------------------------------------ processing

  function processOne(file, opts) {
    return decode(file).then(function (decoded) {
      var target = targetFor(decoded, opts);
      var type = outputType(file, opts);
      var info = Resize.formatInfo(type);
      var canvas = draw(decoded, target, !!info && info.lossy);

      return encode(canvas, type, opts.quality).then(function (blob) {
        decoded.release();
        return {
          name: Resize.outputName(file.name, type),
          blob: blob,
          type: type,
          width: target.width,
          height: target.height,
          sourceWidth: decoded.width,
          sourceHeight: decoded.height,
          originalSize: file.size,
          originalFile: file
        };
      }, function (err) {
        decoded.release();
        throw err;
      });
    });
  }

  function run() {
    if (!state.files.length) return;

    var token = ++state.run;
    var opts = readOptions();
    var results = [];
    var index = 0;

    showError('');
    els.download.disabled = true;

    function next() {
      // A newer run started while this one was working; drop this pass.
      if (token !== state.run) return;

      if (index >= state.files.length) {
        state.results = results;
        finish();
        return;
      }

      var file = state.files[index++];
      if (state.files.length > 1) {
        status('Processing ' + index + ' of ' + state.files.length + '…');
      }

      processOne(file, opts).then(function (result) {
        results.push(result);
      }, function (err) {
        results.push({ name: file.name, error: err.message || 'could not be processed', originalSize: file.size });
      }).then(function () {
        // Yield to the event loop so the browser can paint between images.
        setTimeout(next, 0);
      });
    }

    next();
  }

  function finish() {
    var usable = state.results.filter(function (result) { return result.blob; });
    var failed = state.results.length - usable.length;

    els.download.disabled = usable.length === 0;
    els.download.textContent = usable.length > 1 ? 'Download ' + usable.length + ' images (ZIP)' : 'Download';

    if (state.results.length === 1) renderSingle();
    else renderBatch();

    status(failed ? failed + ' file' + (failed === 1 ? '' : 's') + " couldn't be processed." : '');
  }

  function sizeChange(from, to) {
    if (!from || !to) return '';
    var delta = Math.round((1 - to / from) * 100);
    if (delta > 0) return delta + '% smaller';
    if (delta < 0) return -delta + '% larger';
    return 'about the same';
  }

  function renderSingle() {
    var result = state.results[0];
    els.single.hidden = false;
    els.batch.hidden = true;

    if (result.error) {
      els.single.hidden = true;
      showError(result.name + ': ' + result.error);
      return;
    }

    els.beforeImg.src = trackUrl(URL.createObjectURL(result.originalFile));
    els.afterImg.src = trackUrl(URL.createObjectURL(result.blob));

    els.beforeCaption.innerHTML = '';
    els.beforeCaption.appendChild(document.createTextNode('Original · '));
    els.beforeCaption.appendChild(strong(result.sourceWidth + ' × ' + result.sourceHeight));
    els.beforeCaption.appendChild(document.createTextNode(' · ' + Resize.humanSize(result.originalSize)));

    els.afterCaption.innerHTML = '';
    els.afterCaption.appendChild(document.createTextNode('Result · '));
    els.afterCaption.appendChild(strong(result.width + ' × ' + result.height));
    els.afterCaption.appendChild(document.createTextNode(' · ' + Resize.humanSize(result.blob.size)));

    var info = Resize.formatInfo(result.type);
    var change = sizeChange(result.originalSize, result.blob.size);
    els.singleMeta.textContent = (info ? info.label + ' · ' : '') + result.name +
      (change ? ' · ' + change : '');
  }

  function strong(text) {
    var node = document.createElement('b');
    node.textContent = text;
    return node;
  }

  function renderBatch() {
    els.single.hidden = true;
    els.batch.hidden = false;
    els.filelist.innerHTML = '';

    var totalBefore = 0;
    var totalAfter = 0;
    var shown = Math.min(state.results.length, MAX_PREVIEWS * 4);

    for (var i = 0; i < state.results.length; i++) {
      var result = state.results[i];
      totalBefore += result.originalSize || 0;
      if (result.blob) totalAfter += result.blob.size;
      if (i >= shown) continue;

      var row = document.createElement('li');
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = result.name;
      row.appendChild(name);

      var numbers = document.createElement('span');
      numbers.className = 'numbers';
      if (result.error) {
        numbers.className += ' failed';
        numbers.textContent = result.error;
      } else {
        numbers.appendChild(strong(result.width + ' × ' + result.height));
        numbers.appendChild(document.createTextNode(
          ' · ' + Resize.humanSize(result.originalSize) + ' → ' + Resize.humanSize(result.blob.size)));
      }
      row.appendChild(numbers);
      els.filelist.appendChild(row);
    }

    if (state.results.length > shown) {
      var more = document.createElement('li');
      more.textContent = '…and ' + (state.results.length - shown) + ' more';
      els.filelist.appendChild(more);
    }

    var change = sizeChange(totalBefore, totalAfter);
    els.batchSummary.textContent = state.results.length + ' images · ' +
      Resize.humanSize(totalBefore) + ' → ' + Resize.humanSize(totalAfter) +
      (change ? ' · ' + change : '');
  }

  // ------------------------------------------------------------- downloads

  function download() {
    var usable = state.results.filter(function (result) { return result.blob; });
    if (!usable.length) return;

    if (usable.length === 1) {
      saveBlob(usable[0].blob, usable[0].name);
      return;
    }

    status('Building the ZIP…');
    els.download.disabled = true;

    Promise.all(usable.map(function (result) {
      return bytesOf(result.blob).then(function (bytes) {
        return { name: result.name, bytes: bytes };
      });
    })).then(function (entries) {
      saveBlob(new Blob([Zip.build(entries)], { type: 'application/zip' }), 'resized-images.zip');
      status('');
      els.download.disabled = false;
    }, function (err) {
      showError(err.message || 'the ZIP could not be built');
      els.download.disabled = false;
    });
  }

  // ----------------------------------------------------------------- input

  function accept(fileList) {
    var incoming = [];
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      // Directories arrive as zero-byte entries with no type; skip them rather
      // than reporting a decode failure the user can't do anything about.
      if (file.type && file.type.indexOf('image/') !== 0) continue;
      incoming.push(file);
    }

    if (!incoming.length) {
      showError('Those files don’t look like images.');
      return;
    }

    releaseUrls();
    state.files = incoming;
    els.workspace.hidden = false;
    run();
  }

  function reset() {
    state.run++;
    releaseUrls();
    state.files = [];
    state.results = [];
    els.workspace.hidden = true;
    els.picker.value = '';
    els.download.disabled = true;
    showError('');
    status('');
  }

  // ---------------------------------------------------------------- wiring

  var rerunTimer = null;
  function rerunSoon() {
    syncFields();
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(run, 250);
  }

  els.picker.addEventListener('change', function () {
    if (els.picker.files && els.picker.files.length) accept(els.picker.files);
  });

  ['mode', 'max-width', 'max-height', 'target-width', 'target-height',
    'exact-width', 'exact-height', 'percent', 'upscale', 'format', 'quality'
  ].forEach(function (id) {
    var el = $(id);
    el.addEventListener('change', rerunSoon);
    el.addEventListener('input', rerunSoon);
  });

  els.download.addEventListener('click', download);
  els.clear.addEventListener('click', reset);

  // Drag and drop. dragover has to be cancelled or the browser just opens the
  // file instead of letting the page have it.
  ['dragenter', 'dragover'].forEach(function (name) {
    els.drop.addEventListener(name, function (event) {
      event.preventDefault();
      els.drop.classList.add('is-dragging');
    });
  });

  ['dragleave', 'dragend', 'drop'].forEach(function (name) {
    els.drop.addEventListener(name, function () {
      els.drop.classList.remove('is-dragging');
    });
  });

  els.drop.addEventListener('drop', function (event) {
    event.preventDefault();
    if (event.dataTransfer && event.dataTransfer.files.length) accept(event.dataTransfer.files);
  });

  // Dropping anywhere else on the page should not navigate away from it.
  window.addEventListener('dragover', function (event) { event.preventDefault(); });
  window.addEventListener('drop', function (event) { event.preventDefault(); });

  if (!canEncode('image/webp')) {
    var option = $('format').querySelector('option[value="image/webp"]');
    option.disabled = true;
    option.textContent = 'WebP — not supported by this browser';
  }

  syncFields();
})();
