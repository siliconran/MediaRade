/* =============================================================================
   sp.js — YouTube search-filter builder.
   The `sp=` query parameter is a base64'd protobuf. Encoding it ourselves lets
   us push the Creative Commons filter server-side instead of guessing from
   titles, which is the whole point of MediaRade's strict pipeline.
   MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  /* --- minimal protobuf writer ------------------------------------------ */

  function varint(n) {
    var out = [];
    n = n >>> 0;
    do { var b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
    return out;
  }

  function tag(field, wire) { return varint((field << 3) | wire); }

  function writeVarintField(field, value) {
    return tag(field, 0).concat(varint(value));
  }

  function writeMessageField(field, bytes) {
    return tag(field, 2).concat(varint(bytes.length)).concat(bytes);
  }

  function b64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /* --- filter vocabulary -------------------------------------------------- */

  var SORT = { relevance: 0, rating: 1, date: 2, views: 3 };

  var UPLOADED = { any: 0, hour: 1, today: 2, week: 3, month: 4, year: 5 };

  var TYPE = { any: 0, video: 1, channel: 2, playlist: 3, movie: 4 };

  /* YouTube's own ordering here is genuinely short=1, long=2, medium=3. */
  var DURATION = { any: 0, short: 1, long: 2, medium: 3 };

  /* boolean feature flags -> protobuf field number in the filters submessage */
  var FEATURES = {
    hd: 4,
    subtitles: 5,
    creativeCommons: 6,
    threeD: 7,
    live: 8,
    purchased: 9,
    fourK: 14,
    threeSixty: 15,
    location: 16,
    hdr: 17,
    vr180: 18
  };

  var SP = {
    SORT: SORT, UPLOADED: UPLOADED, TYPE: TYPE, DURATION: DURATION, FEATURES: FEATURES,

    /**
     * @param {object} o
     *   sort: 'relevance'|'rating'|'date'|'views'
     *   uploaded: 'any'|'hour'|'today'|'week'|'month'|'year'
     *   type: 'any'|'video'|'channel'|'playlist'|'movie'
     *   duration: 'any'|'short'|'medium'|'long'
     *   features: { creativeCommons:true, hd:true, fourK:true, ... }
     * @returns {string} value for the `sp` query parameter ('' when unfiltered)
     */
    build: function (o) {
      o = o || {};
      var filters = [];

      var up = UPLOADED[o.uploaded] || 0;
      var ty = TYPE[o.type === undefined ? 'video' : o.type] || 0;
      var du = DURATION[o.duration] || 0;

      if (up) filters = filters.concat(writeVarintField(1, up));
      if (ty) filters = filters.concat(writeVarintField(2, ty));
      if (du) filters = filters.concat(writeVarintField(3, du));

      var feats = o.features || {};
      // field order must ascend for a well-formed message
      Object.keys(FEATURES)
        .filter(function (k) { return feats[k]; })
        .sort(function (a, b) { return FEATURES[a] - FEATURES[b]; })
        .forEach(function (k) { filters = filters.concat(writeVarintField(FEATURES[k], 1)); });

      var msg = [];
      var sort = SORT[o.sort] || 0;
      if (sort) msg = msg.concat(writeVarintField(1, sort));
      if (filters.length) msg = msg.concat(writeMessageField(2, filters));

      if (!msg.length) return '';
      return b64(msg);
    },

    /** Full search URL yt-dlp's youtube:search_url extractor understands. */
    url: function (query, o) {
      var sp = SP.build(o);
      return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) +
             (sp ? '&sp=' + encodeURIComponent(sp) : '');
    },

    /** Known-good reference value, used by the self-test in Settings. */
    CC_ONLY: 'EgIwAQ=='
  };

  global.SP = SP;
})(window);
