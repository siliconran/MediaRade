/* =============================================================================
   config.js — persisted settings (Documents\MediaRade\config.json)
   MediaRade by sgtsilicon
   ========================================================================== */
import Paths from './paths.js';
import Bus from './bus.js';
import { Ledger } from './ledger.js';

const DEFAULTS = {
  version: 1,

  /* --- licensing -------------------------------------------------------
     strictMode is the whole point of this panel. Leave it on.            */
  strictMode: true,           // block anything not machine-verified as CC BY
  licenseMode: 'cc',          // 'cc' | 'claim' | 'all' — ignored while strictMode is on
  autoVerify: true,           // pull full metadata for every search hit
  verifyConcurrency: 5,       // parallel licence checks per page (each = 1 yt-dlp spawn)
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
  safeSearch: true,

  /* --- download --------------------------------------------------------- */
  videoQuality: 'best',       // 'best' | '2160' | '1440' | '1080' | '720' | '480'
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

  /* --- uppbeat ----------------------------------------------------------
     Sign-in happens in the user's own browser; MediaRade only ever holds the
     resulting uppbeat.io cookies, never a password.                        */
  uppbeatEnabled: true,
  uppbeatBrowser: 'chrome',         // browser to import the session from
  uppbeatLoginBrowser: 'chrome',    // browser whose window drives the email+password login (chrome/edge/brave/opera/vivaldi/chromium)
  uppbeatSession: null,             // { cookies, account, plan, signedIn, importedAt }
  uppbeatResultCount: 30,
  uppbeatSignInTries: 40,           // ~3.5 min of polling for the browser session
  uppbeatWatchDir: '',              // blank = %USERPROFILE%\Downloads (ingest fallback)
  uppbeatEndpoints: null,           // overrides for the undocumented API paths
  uppbeatLastQuery: '',

  /* --- ui --------------------------------------------------------------- */
  showBoot: true,
  ambientMotion: true,
  lastQuery: ''
};

let data = null;

export const Config = {
  DEFAULTS: DEFAULTS,

  load: function () {
    const stored = Paths.readJSON(Paths.file('config'), null) || {};
    data = Object.assign({}, DEFAULTS, stored);
    return data;
  },

  all: function () { return data || Config.load(); },

  get: function (key) {
    const d = Config.all();
    return key in d ? d[key] : DEFAULTS[key];
  },

  set: function (key, value) {
    const patch = {};
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
    if (Ledger.record) {
      Ledger.record({
        event: on ? 'strict_mode_enabled' : 'strict_mode_disabled',
        reason: reason || ''
      });
    }
  }
};

export default Config;
