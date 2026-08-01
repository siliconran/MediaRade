/* =============================================================================
   paths.js — the Documents/MediaRade tree. MediaRade by rad1x
   ========================================================================== */
import { CEP } from './cep.js';

const Paths = {
  root: null,
  ready: false,

  /** Documents\MediaRade — created on first run. */
  resolveRoot: function () {
    if (Paths.root) return Paths.root;
    let docs = '';
    try { docs = CEP.systemPath('myDocuments'); } catch (e) {}
    if (!docs) {
      try {
        const os = CEP.os, path = CEP.path;
        docs = path.join(os.homedir(), 'Documents');
      } catch (e) { docs = 'C:\\Users\\Public\\Documents'; }
    }
    Paths.root = CEP.path.join(docs, 'MediaRade');
    return Paths.root;
  },

  /** All app directories, resolved lazily off the root. */
  dir: function (key) {
    const p = CEP.path, root = Paths.resolveRoot();
    const map = {
      root:        root,
      downloads:   p.join(root, 'Downloads'),
      video:       p.join(root, 'Downloads', 'Video'),
      audio:       p.join(root, 'Downloads', 'Audio'),
      thumbs:      p.join(root, 'Downloads', 'Thumbnails'),
      subs:        p.join(root, 'Downloads', 'Subtitles'),
      licenses:    p.join(root, 'Licenses'),
      compliance:  p.join(root, 'Compliance'),
      logs:        p.join(root, 'Logs'),
      bin:         p.join(root, 'bin'),
      cache:       p.join(root, 'Cache')
    };
    return map[key] || root;
  },

  file: function (key) {
    const p = CEP.path;
    const map = {
      config:  p.join(Paths.dir('root'), 'config.json'),
      library: p.join(Paths.dir('root'), 'library.json'),
      ledger:  p.join(Paths.dir('compliance'), 'license-ledger.jsonl'),
      credits: p.join(Paths.dir('compliance'), 'CREDITS.md'),
      log:     p.join(Paths.dir('logs'), 'mediarade.log'),
      searchCache: p.join(Paths.dir('cache'), 'search-cache.json'),
      licenseCache: p.join(Paths.dir('cache'), 'license-cache.json'),
      readme:  p.join(Paths.dir('root'), 'READ-ME-FIRST.txt')
    };
    return map[key];
  },

  ensureDir: function (dir) {
    const fs = CEP.fs;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
    }
    return dir;
  },

  /** Build the whole tree + drop the explainer file. Idempotent. */
  bootstrap: function () {
    ['root', 'downloads', 'video', 'audio', 'thumbs', 'subs', 'licenses',
     'compliance', 'logs', 'bin', 'cache'].forEach(function (k) {
      Paths.ensureDir(Paths.dir(k));
    });

    const readme = Paths.file('readme');
    if (!Paths.exists(readme)) {
      Paths.write(readme, [
        'MediaRade — downloaded content',
        'by rad1x',
        '',
        'Downloads\\Video       finished video files',
        'Downloads\\Audio       extracted / audio-only files',
        'Downloads\\Thumbnails  poster frames',
        'Downloads\\Subtitles   subtitle sidecars',
        'Licenses\\             one .license.json + attribution.txt per download',
        'Compliance\\           license-ledger.jsonl (append-only) and CREDITS.md',
        'Logs\\                 yt-dlp output for troubleshooting',
        'bin\\                  optional local yt-dlp.exe / ffmpeg.exe',
        '',
        'IMPORTANT',
        'A licence verdict recorded by MediaRade reflects what YouTube reported',
        'at the moment of download. An uploader can change the licence later, and',
        'an uploader can mark material Creative Commons that they never had the',
        'right to license in the first place. MediaRade records evidence; it does',
        'not grant you rights and it is not legal advice.',
        ''
      ].join('\r\n'));
    }
    Paths.ready = true;
    return Paths.root;
  },

  /* --- fs sugar --------------------------------------------------------- */
  exists: function (p) { try { return CEP.fs.existsSync(p); } catch (e) { return false; } },

  read: function (p, fallback) {
    try { return CEP.fs.readFileSync(p, 'utf8'); } catch (e) { return fallback === undefined ? null : fallback; }
  },

  readJSON: function (p, fallback) {
    const raw = Paths.read(p, null);
    if (raw === null) return fallback;
    try { return JSON.parse(raw); } catch (e) {
      console.warn('[MediaRade] corrupt JSON at ' + p + ', using fallback');
      return fallback;
    }
  },

  write: function (p, text) {
    Paths.ensureDir(CEP.path.dirname(p));
    CEP.fs.writeFileSync(p, text, 'utf8');
    return p;
  },

  /** Write via temp + rename so a crash can't leave a half-written manifest. */
  writeJSON: function (p, obj) {
    const tmp = p + '.tmp';
    Paths.write(tmp, JSON.stringify(obj, null, 2));
    try { CEP.fs.renameSync(tmp, p); }
    catch (e) { CEP.fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); try { CEP.fs.unlinkSync(tmp); } catch (e2) {} }
    return p;
  },

  appendLine: function (p, text) {
    Paths.ensureDir(CEP.path.dirname(p));
    CEP.fs.appendFileSync(p, text + '\r\n', 'utf8');
    return p;
  },

  stat: function (p) { try { return CEP.fs.statSync(p); } catch (e) { return null; } },

  remove: function (p) {
    try { CEP.fs.unlinkSync(p); return true; } catch (e) { return false; }
  },

  /** Never clobber: name.mp4 -> name (2).mp4 */
  unique: function (fullPath) {
    if (!Paths.exists(fullPath)) return fullPath;
    const path = CEP.path;
    const dir = path.dirname(fullPath),
          ext = path.extname(fullPath),
          base = path.basename(fullPath, ext);
    for (let i = 2; i < 999; i++) {
      const candidate = path.join(dir, base + ' (' + i + ')' + ext);
      if (!Paths.exists(candidate)) return candidate;
    }
    return path.join(dir, base + '_' + Date.now() + ext);
  },

  log: function (line) {
    try { Paths.appendLine(Paths.file('log'), '[' + new Date().toISOString() + '] ' + line); } catch (e) {}
  }
};

export default Paths;
