/* =============================================================================
   bus.js — pub/sub + the single mutable app state. MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var handlers = {};

  var Bus = {
    on: function (evt, fn) {
      (handlers[evt] || (handlers[evt] = [])).push(fn);
      return function () { Bus.off(evt, fn); };
    },
    once: function (evt, fn) {
      var off = Bus.on(evt, function () { off(); fn.apply(null, arguments); });
      return off;
    },
    off: function (evt, fn) {
      var a = handlers[evt];
      if (!a) return;
      var i = a.indexOf(fn);
      if (i > -1) a.splice(i, 1);
    },
    emit: function (evt) {
      var args = Array.prototype.slice.call(arguments, 1);
      (handlers[evt] || []).slice().forEach(function (fn) {
        try { fn.apply(null, args); }
        catch (e) { console.error('[MediaRade] handler for "' + evt + '" threw:', e); }
      });
      (handlers['*'] || []).slice().forEach(function (fn) {
        try { fn(evt, args); } catch (e) {}
      });
    }
  };

  /* ---------------------------------------------------------------------- */

  var State = {
    view: 'browse',

    /* host */
    host: { app: null, version: null, connected: false },
    project: { name: null, path: null },
    sequence: null,           // { name, id, playhead, inPoint, outPoint, fps, videoTracks, audioTracks, end }

    /* tooling */
    tools: { ytdlp: null, ytdlpVersion: null, ffmpeg: null, checked: false },

    /* search */
    query: '',
    filters: null,            // owned by views/browse
    results: [],              // [SearchResult]
    searching: false,
    searchError: null,

    /* detail */
    current: null,            // full metadata + license report

    /* work */
    jobs: [],
    libraryItems: [],
    points: [],

    /* drag */
    drag: null                // { kind:'video'|'audio', source:'library'|'result', item }
  };

  /** Shallow-merge a patch into State and announce it. */
  Bus.patch = function (patch, evt) {
    Object.keys(patch).forEach(function (k) { State[k] = patch[k]; });
    Bus.emit(evt || 'state', patch);
  };

  global.Bus = Bus;
  global.State = State;
})(window);
