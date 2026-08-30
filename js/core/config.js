/* =============================================================================
   config.js — persisted settings (Documents\MediaRade\config.json)
   MediaRade by sgtsilicon
   ========================================================================== */
(function (global) {
  'use strict';

  var DEFAULTS = {
    version: 1,

    /* --- licensing -------------------------------------------------------
       strictMode is the whole point of this panel. Leave it on.            */
    strictMode: true,           // block anything not machine-verified as CC BY
    autoVerify: true,           // pull full metadata for every search hit
    verifyConcurrency: 3,
    requireAckPhrase: true,     // typing the phrase is what gets logged
    writeSidecars: true,        // .license.json + attribution.txt next to media
    writeCredits: true,         // append to Compliance\CREDITS.md
    stampMarker: true,          // drop a timeline marker carrying attribution
    ledgerEnabled: true,

    /* --- binaries --------------------------------------------------------- */
    ytdlpPath: '',              // blank = auto-detect (bin\ then PATH)
    ffmpegPath: '',
    cookiesFromBrowser: '',     // '', 'chrome', 'edge', 'firefox', ...
    proxy: '',
    rateLimit: '',              // e.g. "2M"

    /* --- search ----------------------------------------------------------- */
    resultCount: 25,
    /* Licence preset that drives both the search filter and the download gate:
       'cc'    — Creative Commons only (pin YouTube's CC search filter, only
                 machine-verified CC BY 3.0 material is downloadable)
       'claim' — Royalty-free / claim-based (no CC pin; a "royalty free" claim
                 is accepted as best-effort evidence unless the licence field
                 or other critical signals contradict it)
       'all'   — Everything (no CC pin, no gate — still verified and flagged) */
    licenseMode: 'cc',
    safeSearch: true,

    /* --- download --------------------------------------------------------- */
    videoQuality: '1080',       // 'best' | '2160' | '1440' | '1080' | '720' | '480'
    videoContainer: 'mp4',      // mp4 | mkv | webm
    audioFormat: 'wav',         // wav | mp3 | m4a | flac | opus
    audioQuality: '0',          // yt-dlp -q scale, 0 = best
    embedThumbnail: true,
    embedMetadata: true,
    embedChapters: true,
    writeSubs: false,
    subLangs: 'en',
    sponsorblockRemove: '',     // e.g. 'sponsor,selfpromo'
    concurrentDownloads: 2,
    concurrentFragments: 4,
    filenameTemplate: '%(title)s [%(id)s]',
    restrictFilenames: false,

    /* --- premiere --------------------------------------------------------- */
    binName: 'MediaRade',
    autoImport: true,           // import to project as soon as a file lands
    defaultInsertMode: 'overwrite',   // overwrite | insert
    defaultVideoTrack: 1,
    defaultAudioTrack: 1,
    defaultDropTarget: 'playhead',    // playhead | end | inpoint
    selectAfterInsert: true,
    persistPoints: [],                // named timeline anchors you can drop onto

    /* --- ui --------------------------------------------------------------- */
    showBoot: true,
    ambientMotion: true,
    dockOpen: true,
    lastQuery: '',
    presetTags: [
      'royalty free music', 'no copyright background', 'creative commons b-roll',
      'stock footage 4k', 'ambient loop', 'cinematic drone', 'sound effects',
      'lofi instrumental', 'public domain film', 'nature timelapse'
    ]
  };

  var data = null;

  var Config = {
    DEFAULTS: DEFAULTS,

    load: function () {
      var stored = Paths.readJSON(Paths.file('config'), null) || {};
      // v0 -> v1: defaultCcOnly was replaced by the licenseMode preset
      if (stored.licenseMode === undefined && stored.defaultCcOnly !== undefined) {
        stored.licenseMode = stored.defaultCcOnly ? 'cc' : 'all';
      }
      data = Object.assign({}, DEFAULTS, stored);
      // heal arrays that a bad merge could have flattened
      if (!Array.isArray(data.presetTags) || !data.presetTags.length) data.presetTags = DEFAULTS.presetTags.slice();
      if (['cc', 'claim', 'all'].indexOf(data.licenseMode) === -1) data.licenseMode = DEFAULTS.licenseMode;
      return data;
    },

    all: function () { return data || Config.load(); },

    get: function (key) {
      var d = Config.all();
      return key in d ? d[key] : DEFAULTS[key];
    },

    set: function (key, value) {
      var patch = {};
      if (typeof key === 'object') Object.assign(patch, key);
      else patch[key] = value;
      Object.assign(Config.all(), patch);
      Config.save();
      Bus.emit('config', patch);
      return data;
    },

    save: function () {
      try { Paths.writeJSON(Paths.file('config'), data); }
      catch (e) { console.error('[MediaRade] could not save config:', e); }
      return data;
    },

    reset: function () {
      data = Object.assign({}, DEFAULTS);
      Config.save();
      Bus.emit('config', data);
      return data;
    },

    /** Turning strict mode off is a deliberate, logged act. */
    setStrict: function (on, reason) {
      Config.set('strictMode', !!on);
      if (typeof Ledger !== 'undefined' && Ledger.record) {
        Ledger.record({
          event: on ? 'strict_mode_enabled' : 'strict_mode_disabled',
          reason: reason || ''
        });
      }
    }
  };

  global.Config = Config;
})(window);
