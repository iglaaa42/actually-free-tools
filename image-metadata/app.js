/*
 * UI glue: reads files, reports what metadata is in them, and writes back
 * copies with that metadata removed — one file directly, several as a ZIP.
 * No network calls, no storage, no analytics.
 *
 * Files are read twice on purpose: once to inspect, and again at download time
 * to strip. A File is a reference to bytes on disk rather than the bytes
 * themselves, so re-reading keeps a hundred-photo batch from sitting in memory
 * all at once.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    entries: [],   // { file, report, error }
    run: 0
  };

  var els = {
    drop: $('drop'),
    picker: $('picker'),
    workspace: $('workspace'),
    error: $('error'),
    status: $('status'),
    summary: $('summary'),
    single: $('single'),
    batch: $('batch'),
    reportTitle: $('report-title'),
    reportMeta: $('report-meta'),
    gpsCallout: $('gps-callout'),
    gpsDetail: $('gps-detail'),
    orientationCallout: $('orientation-callout'),
    orientationDetail: $('orientation-detail'),
    tagsBlock: $('tags-block'),
    tags: $('tags'),
    cleanNote: $('clean-note'),
    segments: $('segments'),
    batchTitle: $('batch-title'),
    filelist: $('filelist'),
    dropProfile: $('drop-profile'),
    download: $('download'),
    clear: $('clear')
  };

  // --------------------------------------------------------------- helpers

  function humanSize(bytes) {
    if (!(bytes >= 0)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(bytes < 10485760 ? 1 : 0) + ' MB';
  }

  function readBytes(file) {
    if (file.arrayBuffer) {
      return file.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(new Error('this file could not be read')); };
      reader.readAsArrayBuffer(file);
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
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = !message;
  }

  function status(message) {
    els.status.textContent = message || '';
  }

  function options() {
    return { keepColorProfile: !els.dropProfile.checked };
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ------------------------------------------------------------ inspecting

  function inspectAll(files) {
    var token = ++state.run;
    var entries = [];
    var index = 0;

    showError('');
    els.download.disabled = true;

    function next() {
      if (token !== state.run) return;

      if (index >= files.length) {
        state.entries = entries;
        render();
        return;
      }

      var file = files[index++];
      if (files.length > 1) status('Reading ' + index + ' of ' + files.length + '…');

      readBytes(file).then(function (bytes) {
        var report = Metadata.inspect(bytes, options());
        if (!report.supported) throw new Error('not a JPEG, PNG or WebP file');
        entries.push({ file: file, report: report });
      }, function (err) {
        entries.push({ file: file, error: err.message || 'could not be read' });
      }).then(function () {
        setTimeout(next, 0);
      });
    }

    next();
  }

  /* The checkbox only changes which segments count as removable, so the files
     don't need re-reading — just re-planning against the cached reports. */
  function reinspect() {
    if (!state.entries.length) return;
    var files = state.entries.map(function (entry) { return entry.file; });
    inspectAll(files);
  }

  // -------------------------------------------------------------- renderng

  function render() {
    status('');

    var usable = state.entries.filter(function (entry) { return entry.report; });
    var totalMetadata = 0;
    var withGps = 0;

    for (var i = 0; i < usable.length; i++) {
      totalMetadata += usable[i].report.metadataBytes;
      if (usable[i].report.gps) withGps++;
    }

    renderSummary(usable.length, totalMetadata, withGps);

    els.download.disabled = totalMetadata === 0;
    els.download.textContent = usable.length > 1
      ? 'Download ' + usable.length + ' clean copies (ZIP)'
      : 'Download clean copy';

    if (state.entries.length === 1) renderSingle(state.entries[0]);
    else renderBatch();

    var failed = state.entries.length - usable.length;
    if (failed && state.entries.length > 1) {
      status(failed + ' file' + (failed === 1 ? '' : 's') + " couldn't be read.");
    }
  }

  function renderSummary(count, totalMetadata, withGps) {
    els.summary.innerHTML = '';

    if (!count) {
      els.summary.appendChild(document.createTextNode('Nothing readable here.'));
      return;
    }

    if (totalMetadata === 0) {
      els.summary.appendChild(document.createTextNode(
        count > 1 ? 'All ' + count + ' files are already clean.' : 'This file is already clean.'));
      return;
    }

    var strong = element('b', null, humanSize(totalMetadata));
    els.summary.appendChild(strong);
    els.summary.appendChild(document.createTextNode(
      ' of metadata to remove' + (count > 1 ? ' across ' + count + ' files' : '') + '.'));

    if (withGps) {
      els.summary.appendChild(document.createElement('br'));
      els.summary.appendChild(document.createTextNode(
        withGps === 1
          ? (count > 1 ? 'One of them records a location.' : 'It records where the photo was taken.')
          : withGps + ' of them record a location.'));
    }
  }

  function renderSingle(entry) {
    els.single.hidden = false;
    els.batch.hidden = true;

    if (entry.error) {
      els.single.hidden = true;
      showError(entry.file.name + ': ' + entry.error);
      return;
    }

    var report = entry.report;
    els.reportTitle.textContent = entry.file.name;

    var parts = [report.format.toUpperCase()];
    if (report.dimensions) parts.push(report.dimensions.width + ' × ' + report.dimensions.height);
    parts.push(humanSize(report.totalBytes));
    if (report.metadataBytes) parts.push(humanSize(report.metadataBytes) + ' of it metadata');
    els.reportMeta.textContent = parts.join(' · ');

    renderGps(report);
    renderOrientation(report);
    renderTags(report);
    renderSegments(report);

    els.cleanNote.hidden = report.tags.length > 0 || report.metadataBytes > 0;
  }

  function renderGps(report) {
    els.gpsCallout.hidden = !report.gps;
    if (!report.gps) return;

    els.gpsDetail.innerHTML = '';
    els.gpsDetail.appendChild(element('span', 'coords',
      report.gps.latitude + ', ' + report.gps.longitude +
      (report.gps.altitude !== null ? '  ·  ' + report.gps.altitude + ' m' : '')));
    els.gpsDetail.appendChild(document.createElement('br'));
    // Deliberately not linked to a map: that would be a request to somebody
    // else's server carrying the coordinates, on a page that promises none.
    els.gpsDetail.appendChild(document.createTextNode(
      'Accurate to a few metres. Nothing here looks it up — copy it into a map yourself if you want to see where that is.'));
  }

  function renderOrientation(report) {
    var rotated = report.orientation && report.orientation !== 1;
    els.orientationCallout.hidden = !rotated;
    if (!rotated) return;

    els.orientationDetail.textContent =
      'The pixels are ' + report.orientationText + ', and an EXIF flag tells viewers to turn it back. ' +
      'Removing the metadata removes that flag, so the clean copy may appear sideways. ' +
      'Resizing it instead bakes the rotation into the pixels.';
  }

  function renderTags(report) {
    els.tags.innerHTML = '';
    els.tagsBlock.hidden = report.tags.length === 0;

    for (var i = 0; i < report.tags.length; i++) {
      var tag = report.tags[i];
      els.tags.appendChild(element('dt', null, tag.label));
      els.tags.appendChild(element('dd', null, tag.value));
    }
  }

  function renderSegments(report) {
    els.segments.innerHTML = '';

    for (var i = 0; i < report.segments.length; i++) {
      var segment = report.segments[i];
      var row = document.createElement('li');

      row.appendChild(element('span', 'label', segment.label));
      row.appendChild(element('span', 'size', humanSize(segment.size)));
      row.appendChild(element('span', 'badge' + (segment.strip ? ' is-removed' : ''),
        segment.strip ? 'removed' : 'kept'));

      els.segments.appendChild(row);
    }
  }

  function renderBatch() {
    els.single.hidden = true;
    els.batch.hidden = false;
    els.filelist.innerHTML = '';
    els.batchTitle.textContent = state.entries.length + ' files';

    for (var i = 0; i < state.entries.length; i++) {
      var entry = state.entries[i];
      var row = document.createElement('li');
      row.appendChild(element('span', 'name', entry.file.name));

      if (entry.error) {
        row.appendChild(element('span', 'numbers failed', entry.error));
      } else if (entry.report.metadataBytes === 0) {
        row.appendChild(element('span', 'numbers', 'already clean'));
      } else {
        var numbers = element('span', 'numbers' + (entry.report.gps ? ' has-gps' : ''));
        if (entry.report.gps) numbers.appendChild(element('b', null, 'has location · '));
        numbers.appendChild(document.createTextNode(humanSize(entry.report.metadataBytes) + ' to remove'));
        row.appendChild(numbers);
      }

      els.filelist.appendChild(row);
    }
  }

  // ------------------------------------------------------------- downloads

  function download() {
    var usable = state.entries.filter(function (entry) { return entry.report; });
    if (!usable.length) return;

    els.download.disabled = true;
    status('Preparing…');

    var opts = options();

    Promise.all(usable.map(function (entry) {
      return readBytes(entry.file).then(function (bytes) {
        return { name: entry.file.name, bytes: Metadata.strip(bytes, opts).bytes };
      });
    })).then(function (cleaned) {
      if (cleaned.length === 1) {
        saveBlob(new Blob([cleaned[0].bytes], { type: usable[0].file.type }), cleaned[0].name);
      } else {
        saveBlob(new Blob([Zip.build(cleaned)], { type: 'application/zip' }), 'metadata-removed.zip');
      }
      status('');
      els.download.disabled = false;
    }, function (err) {
      showError(err.message || 'the clean copy could not be written');
      status('');
      els.download.disabled = false;
    });
  }

  // ----------------------------------------------------------------- input

  function accept(fileList) {
    var incoming = [];
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      if (file.type && file.type.indexOf('image/') !== 0) continue;
      incoming.push(file);
    }

    if (!incoming.length) {
      showError('Those files don’t look like images.');
      return;
    }

    els.workspace.hidden = false;
    inspectAll(incoming);
  }

  function reset() {
    state.run++;
    state.entries = [];
    els.workspace.hidden = true;
    els.picker.value = '';
    els.download.disabled = true;
    showError('');
    status('');
  }

  // ---------------------------------------------------------------- wiring

  els.picker.addEventListener('change', function () {
    if (els.picker.files && els.picker.files.length) accept(els.picker.files);
  });

  els.dropProfile.addEventListener('change', reinspect);
  els.download.addEventListener('click', download);
  els.clear.addEventListener('click', reset);

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

  window.addEventListener('dragover', function (event) { event.preventDefault(); });
  window.addEventListener('drop', function (event) { event.preventDefault(); });
})();
