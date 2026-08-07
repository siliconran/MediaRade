/* =============================================================================
   MediaRade.jsx — ExtendScript host layer for Adobe Premiere Pro
   MediaRade by rad1x

   ExtendScript is ES3: no JSON, no Array.prototype.map/forEach/indexOf,
   no Object.keys, no String.trim. Everything below stays inside that box.
   Every entry point takes one JSON string and returns one JSON string.
   ========================================================================== */

/*global app, qe, ProjectItemType, Time, XMPMeta, ExternalObject, $ */

$._MediaRade = (function () {
  'use strict';

  var VERSION = '1.3.4';
  var TICKS_PER_SECOND = 254016000000;

  /* =========================================================================
     JSON (ES3 has none)
     ====================================================================== */

  function esc(s) {
    var out = '', i, c, code;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (code < 32 || code > 126) {
        var hex = code.toString(16);
        while (hex.length < 4) hex = '0' + hex;
        out += '\\u' + hex;
      } else out += c;
    }
    return out;
  }

  function stringify(v) {
    var t = typeof v, i, parts, k;
    if (v === null || v === undefined) return 'null';
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return '"' + esc(v) + '"';
    if (v instanceof Array) {
      parts = [];
      for (i = 0; i < v.length; i++) parts.push(stringify(v[i]));
      return '[' + parts.join(',') + ']';
    }
    if (t === 'object') {
      parts = [];
      for (k in v) {
        if (v.hasOwnProperty(k) && typeof v[k] !== 'function') {
          parts.push('"' + esc(String(k)) + '":' + stringify(v[k]));
        }
      }
      return '{' + parts.join(',') + '}';
    }
    return 'null';
  }

  function parse(s) {
    if (!s) return {};
    try { return eval('(' + s + ')'); } catch (e) { return {}; }
  }

  function ok(data)   { return stringify({ ok: true, data: data === undefined ? null : data }); }
  function fail(msg)  { return stringify({ ok: false, error: String(msg) }); }

  /* =========================================================================
     small helpers
     ====================================================================== */

  function secondsToTicks(sec) {
    return String(Math.round(Number(sec) * TICKS_PER_SECOND));
  }

  function ticksToSeconds(ticks) {
    var n = Number(ticks);
    return isNaN(n) ? 0 : n / TICKS_PER_SECOND;
  }

  function makeTime(sec) {
    var t = new Time();
    t.seconds = Number(sec);
    return t;
  }

  function fpsOf(seq) {
    try {
      var s = seq.getSettings();
      var frameTicks = Number(s.videoFrameRate.ticks);
      if (frameTicks > 0) return TICKS_PER_SECOND / frameTicks;
    } catch (e) {}
    return 25;
  }

  function baseName(p) {
    var s = String(p).replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i < 0 ? s : s.substring(i + 1);
  }

  function samePath(a, b) {
    if (!a || !b) return false;
    return String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
  }

  /* Premiere's colour-label indices. */
  var LABELS = { Violet: 0, Iris: 1, Caribbean: 2, Lavender: 3, Cerulean: 4, Forest: 5,
                 Rose: 6, Mango: 7, Purple: 8, Blue: 9, Teal: 10, Magenta: 11,
                 Tan: 12, Green: 13, Brown: 14, Yellow: 15 };
  var LABEL_ALIAS = { Red: 'Rose', Gray: 'Tan', Grey: 'Tan' };

  function applyLabel(item, name) {
    if (!item || !name) return;
    if (LABEL_ALIAS[name]) name = LABEL_ALIAS[name];
    var idx = LABELS[name];
    if (idx === undefined) return;
    try { item.setColorLabel(idx); } catch (e) {}
  }

  /* Comment column, via the private project metadata namespace. Best effort:
     if the XMP library is unavailable we simply skip it. */
  var XMP_NS = 'http://ns.adobe.com/premierePrivateProjectMetaData/1.0/';
  var xmpLoaded = false;

  function loadXMP() {
    if (xmpLoaded) return true;
    try {
      if (ExternalObject.AdobeXMPScript === undefined) {
        ExternalObject.AdobeXMPScript = new ExternalObject('lib:AdobeXMPScript');
      }
      xmpLoaded = true;
    } catch (e) { xmpLoaded = false; }
    return xmpLoaded;
  }

  function setComment(item, text) {
    if (!item || !text || !loadXMP()) return false;
    try {
      var field = 'Column.Intrinsic.Comment';
      var xmp = new XMPMeta(item.getProjectMetadata());
      xmp.setProperty(XMP_NS, field, String(text));
      item.setProjectMetadata(xmp.serialize(), [field]);
      return true;
    } catch (e) { return false; }
  }

  /* =========================================================================
     bins
     ====================================================================== */

  function findBin(parent, name) {
    if (!parent || !parent.children) return null;
    for (var i = 0; i < parent.children.numItems; i++) {
      var c = parent.children[i];
      try {
        if (c.type === ProjectItemType.BIN && String(c.name) === String(name)) return c;
      } catch (e) {}
    }
    return null;
  }

  function ensureBin(name, subName) {
    var root = app.project.rootItem;
    var bin = findBin(root, name);
    if (!bin) {
      try { root.createBin(name); } catch (e) { return root; }
      bin = findBin(root, name) || root;
    }
    if (subName) {
      var sub = findBin(bin, subName);
      if (!sub) {
        try { bin.createBin(subName); } catch (e) { return bin; }
        sub = findBin(bin, subName) || bin;
      }
      return sub;
    }
    return bin;
  }

  function findByPath(node, path) {
    if (!node || !node.children) return null;
    for (var i = 0; i < node.children.numItems; i++) {
      var c = node.children[i];
      try {
        if (c.type === ProjectItemType.BIN) {
          var deep = findByPath(c, path);
          if (deep) return deep;
        } else if (samePath(c.getMediaPath(), path)) {
          return c;
        }
      } catch (e) {}
    }
    return null;
  }

  function findByNodeId(node, nodeId) {
    if (!node || !node.children) return null;
    for (var i = 0; i < node.children.numItems; i++) {
      var c = node.children[i];
      try {
        if (String(c.nodeId) === String(nodeId)) return c;
        if (c.type === ProjectItemType.BIN) {
          var deep = findByNodeId(c, nodeId);
          if (deep) return deep;
        }
      } catch (e) {}
    }
    return null;
  }

  function describeItem(item) {
    if (!item) return null;
    var d = { name: null, nodeId: null, path: null, duration: null };
    try { d.name = String(item.name); } catch (e) {}
    try { d.nodeId = String(item.nodeId); } catch (e) {}
    try { d.path = String(item.getMediaPath()); } catch (e) {}
    try { d.duration = ticksToSeconds(item.getOutPoint().ticks) - ticksToSeconds(item.getInPoint().ticks); } catch (e) {}
    return d;
  }

  /** Import if not already present; returns the ProjectItem. */
  function importOne(path, binName, subBin) {
    if (!app.project) throw new Error('No project is open.');

    var existing = findByPath(app.project.rootItem, path);
    if (existing) return existing;

    var bin = ensureBin(binName || 'MediaRade', subBin);
    var before = bin && bin.children ? bin.children.numItems : 0;
    var okImport = false;
    try { okImport = app.project.importFiles([path], true, bin, false); } catch (e) {
      throw new Error('Import failed for ' + baseName(path) + ': ' + e.toString());
    }

    var item = findByPath(bin, path) || findByPath(app.project.rootItem, path);

    /* Fallback: getMediaPath() can be null in some versions right after an
       import, so scan the target bin for the clip that just appeared. */
    if (!item && bin && bin.children && bin.children.numItems > before) {
      for (var k = before; k < bin.children.numItems; k++) {
        var cand = bin.children[k];
        try {
          if (cand.type !== ProjectItemType.BIN) { item = cand; break; }
        } catch (e2) {}
      }
    }

    if (!item && !okImport) throw new Error('Premiere would not import ' + baseName(path) + '.');
    return item;
  }

  /* =========================================================================
     sequence / timeline
     ====================================================================== */

  function activeSequence() {
    try { return app.project.activeSequence || null; } catch (e) { return null; }
  }

  function sequenceEndSeconds(seq) {
    try { return ticksToSeconds(seq.end); } catch (e) {}
    // fall back to the furthest clip end across every track
    var end = 0, i, j, tr, clip;
    try {
      for (i = 0; i < seq.videoTracks.numTracks; i++) {
        tr = seq.videoTracks[i];
        for (j = 0; j < tr.clips.numItems; j++) {
          clip = tr.clips[j];
          var e = ticksToSeconds(clip.end.ticks);
          if (e > end) end = e;
        }
      }
      for (i = 0; i < seq.audioTracks.numTracks; i++) {
        tr = seq.audioTracks[i];
        for (j = 0; j < tr.clips.numItems; j++) {
          clip = tr.clips[j];
          var e2 = ticksToSeconds(clip.end.ticks);
          if (e2 > end) end = e2;
        }
      }
    } catch (e3) {}
    return end;
  }

  function describeSequence(seq) {
    if (!seq) return null;
    var d = {
      name: '', id: '', playhead: 0, inPoint: null, outPoint: null,
      fps: 25, videoTracks: 0, audioTracks: 0, end: 0, zeroPoint: 0
    };
    try { d.name = String(seq.name); } catch (e) {}
    try { d.id = String(seq.sequenceID); } catch (e) {}
    try { d.playhead = ticksToSeconds(seq.getPlayerPosition().ticks); } catch (e) {}
    try {
      var ip = Number(seq.getInPoint());
      var op = Number(seq.getOutPoint());
      if (!isNaN(ip) && ip >= 0) d.inPoint = ip;
      if (!isNaN(op) && op > 0) d.outPoint = op;
    } catch (e) {}
    try { d.fps = fpsOf(seq); } catch (e) {}
    try { d.videoTracks = seq.videoTracks.numTracks; } catch (e) {}
    try { d.audioTracks = seq.audioTracks.numTracks; } catch (e) {}
    try { d.end = sequenceEndSeconds(seq); } catch (e) {}
    try { d.zeroPoint = ticksToSeconds(seq.zeroPoint); } catch (e) {}
    return d;
  }

  function resolveTime(seq, target, seconds) {
    if (target === 'point' && seconds !== null && seconds !== undefined) return Number(seconds);
    if (target === 'end') return sequenceEndSeconds(seq);
    if (target === 'inpoint') {
      try {
        var ip = Number(seq.getInPoint());
        if (!isNaN(ip) && ip >= 0) return ip;
      } catch (e) {}
      return ticksToSeconds(seq.getPlayerPosition().ticks);
    }
    if (target === 'zero') return 0;
    try { return ticksToSeconds(seq.getPlayerPosition().ticks); } catch (e) { return 0; }
  }

  /* =========================================================================
     public API
     ====================================================================== */

  var API = {};

  API.ping = function () {
    try {
      return ok({
        version: VERSION,
        host: String(app.appName || 'Premiere Pro'),
        hostVersion: String(app.version || ''),
        hasProject: !!(app.project),
        panel: 'MediaRade by rad1x'
      });
    } catch (e) { return fail(e.toString()); }
  };

  API.getState = function () {
    try {
      var project = null;
      try {
        if (app.project) project = { name: String(app.project.name), path: String(app.project.path || '') };
      } catch (e) {}
      return ok({ project: project, sequence: describeSequence(activeSequence()) });
    } catch (e2) { return fail(e2.toString()); }
  };

  API.importFile = function (raw) {
    var a = parse(raw);
    try {
      if (!a.path) return fail('No file path was given.');
      var item = importOne(a.path, a.bin, a.subBin);
      if (!item) return fail('The file was imported but Premiere did not report the item back.');
      if (a.label) applyLabel(item, a.label);
      if (a.comment) setComment(item, a.comment);
      return ok(describeItem(item));
    } catch (e) { return fail(e.toString ? e.toString() : String(e)); }
  };

  API.place = function (raw) {
    var a = parse(raw);
    try {
      if (!app.project) return fail('No project is open.');

      /* 1. project item */
      var item = null;
      if (a.nodeId) item = findByNodeId(app.project.rootItem, a.nodeId);
      if (!item && a.path) item = importOne(a.path, a.bin, a.subBin);
      if (!item) return fail('Could not find or import the media to place.');
      if (a.label) applyLabel(item, a.label);
      if (a.comment) setComment(item, a.comment);

      /* 2. sequence — build one from the clip if the project has none open */
      var seq = activeSequence();
      var created = false;
      if (!seq) {
        try {
          app.project.createNewSequenceFromClips('MediaRade Sequence', [item]);
          seq = activeSequence();
          created = true;
        } catch (e) {}
        if (!seq) return fail('No sequence is open, and Premiere would not create one. Open or create a sequence and try again.');
        if (created) {
          return ok({
            sequence: String(seq.name), created: true, position: 0,
            track: 'V1', mode: 'new-sequence', item: describeItem(item)
          });
        }
      }

      /* 3. position */
      var seconds = resolveTime(seq, a.target, a.seconds);
      if (seconds < 0) seconds = 0;
      var time = makeTime(seconds);

      /* 4. tracks (the API is 0-based; the UI is 1-based) */
      var vIndex = Number(a.videoTrack) > 0 ? Number(a.videoTrack) - 1 : -1;
      var aIndex = Number(a.audioTrack) > 0 ? Number(a.audioTrack) - 1 : -1;

      if (vIndex >= 0 && vIndex >= seq.videoTracks.numTracks) {
        return fail('This sequence has only ' + seq.videoTracks.numTracks + ' video track(s); V' + (vIndex + 1) + ' does not exist.');
      }
      if (aIndex >= 0 && aIndex >= seq.audioTracks.numTracks) {
        return fail('This sequence has only ' + seq.audioTracks.numTracks + ' audio track(s); A' + (aIndex + 1) + ' does not exist.');
      }

      var insert = (a.mode === 'insert');
      var placed = false;
      var trackLabel = '';

      if (vIndex < 0) {
        /* audio-only: straight onto the chosen audio track */
        if (aIndex < 0) return fail('No target track was selected.');
        var atr = seq.audioTracks[aIndex];
        try {
          if (insert) atr.insertClip(item, time); else atr.overwriteClip(item, time);
          placed = true;
        } catch (e1) {
          try {
            if (insert) atr.insertClip(item, seconds); else atr.overwriteClip(item, seconds);
            placed = true;
          } catch (e2) { return fail('Premiere refused the audio placement: ' + e2.toString()); }
        }
        trackLabel = 'A' + (aIndex + 1);
      } else {
        /* video (plus its audio, when the sequence-level call is available) */
        try {
          if (insert) seq.insertClip(item, time, vIndex, aIndex < 0 ? 0 : aIndex);
          else seq.overwriteClip(item, time, vIndex, aIndex < 0 ? 0 : aIndex);
          placed = true;
          trackLabel = 'V' + (vIndex + 1) + (aIndex >= 0 ? '+A' + (aIndex + 1) : '');
        } catch (eSeq) {
          var vtr = seq.videoTracks[vIndex];
          try {
            if (insert) vtr.insertClip(item, time); else vtr.overwriteClip(item, time);
            placed = true;
            trackLabel = 'V' + (vIndex + 1);
          } catch (eTr) {
            try {
              if (insert) vtr.insertClip(item, seconds); else vtr.overwriteClip(item, seconds);
              placed = true;
              trackLabel = 'V' + (vIndex + 1);
            } catch (eTr2) {
              return fail('Premiere refused the placement: ' + eTr2.toString());
            }
          }
        }
      }

      if (!placed) return fail('The clip could not be placed.');

      /* 5. attribution marker */
      if (a.marker) {
        try {
          var mk = seq.markers.createMarker(seconds);
          mk.name = 'MediaRade licence';
          mk.comments = String(a.marker);
        } catch (eM) {}
      }

      /* 6. park the playhead after an append so the next drop stacks up */
      if (a.target === 'end') {
        try { seq.setPlayerPosition(secondsToTicks(sequenceEndSeconds(seq))); } catch (eP) {}
      }

      return ok({
        sequence: String(seq.name),
        position: seconds,
        track: trackLabel,
        mode: insert ? 'insert' : 'overwrite',
        item: describeItem(item),
        created: created
      });
    } catch (e) { return fail(e.toString ? e.toString() : String(e)); }
  };

  API.setPlayhead = function (raw) {
    var a = parse(raw);
    try {
      var seq = activeSequence();
      if (!seq) return fail('No sequence is open.');
      seq.setPlayerPosition(secondsToTicks(a.seconds || 0));
      return ok({ playhead: Number(a.seconds || 0) });
    } catch (e) { return fail(e.toString()); }
  };

  API.addMarker = function (raw) {
    var a = parse(raw);
    try {
      var seq = activeSequence();
      if (!seq) return fail('No sequence is open.');
      var sec = (a.seconds === null || a.seconds === undefined)
        ? ticksToSeconds(seq.getPlayerPosition().ticks) : Number(a.seconds);
      var mk = seq.markers.createMarker(sec);
      mk.name = String(a.name || 'MediaRade');
      if (a.comment) mk.comments = String(a.comment);
      return ok({ seconds: sec, name: mk.name });
    } catch (e) { return fail(e.toString()); }
  };

  API.newSequence = function (raw) {
    var a = parse(raw);
    try {
      if (!app.project) return fail('No project is open.');
      app.project.createNewSequence(String(a.name || 'MediaRade Sequence'), '');
      var seq = activeSequence();
      return ok(describeSequence(seq));
    } catch (e) {
      return fail('Premiere could not create a sequence without a preset. Create one manually, then try again.');
    }
  };

  API.revealBin = function (raw) {
    var a = parse(raw);
    try {
      var item = findByNodeId(app.project.rootItem, a.nodeId);
      if (!item) return fail('That item is no longer in the project.');
      try { item.select(); } catch (e) {}
      return ok(describeItem(item));
    } catch (e2) { return fail(e2.toString()); }
  };

  /** Track counts, so the dock only offers lanes that actually exist. */
  API.getTracks = function () {
    try {
      var seq = activeSequence();
      if (!seq) return ok({ video: 0, audio: 0 });
      return ok({ video: seq.videoTracks.numTracks, audio: seq.audioTracks.numTracks });
    } catch (e) { return fail(e.toString()); }
  };

  /** Native media-picker dialog, so the panel can import files without a download. */
  API.pickMedia = function (raw) {
    var a = parse(raw);
    try {
      var filter = a.filter || 'Media:*.mp4;*.mov;*.m4a;*.mp3;*.wav;*.flac;*.webm;*.mkv';
      var picked = File.openDialog(String(a.title || 'Select media files'), filter, true);
      if (!picked) return ok({ files: [] });
      if (!(picked instanceof Array)) picked = [picked];
      var files = [];
      for (var i = 0; i < picked.length; i++) files.push(String(picked[i].fsName));
      return ok({ files: files });
    } catch (e) { return fail(e.toString()); }
  };

  return API;
})();
