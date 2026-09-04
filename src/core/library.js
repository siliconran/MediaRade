/* =============================================================================
   library.js — the local manifest of everything MediaRade has downloaded
   MediaRade by siliconran
   ========================================================================== */
import U from './util.js';
import Bus from './bus.js';
import Paths from './paths.js';
import Ledger from './ledger.js';
import License from './license.js';
import { CEP } from './cep.js';

const items = [];
let loaded = false;

export const Library = {
  items: items,

  load: function () {
    const data = Paths.readJSON(Paths.file('library'), { version: 1, items: [] });
    items.length = 0;
    (data.items || []).forEach(function (i) { items.push(i); });
    loaded = true;
    Library.prune();
    Bus.syncLibrary(items);
    return items;
  },

  save: function () {
    try { Paths.writeJSON(Paths.file('library'), { version: 1, savedAt: Date.now(), items: items }); }
    catch (e) { console.warn('[MediaRade] library save failed:', e); }
    Bus.syncLibrary(items);
    return items;
  },

  add: function (entry) {
    if (!loaded) Library.load();
    entry.id = entry.id || U.uid('lib');
    const stat = entry.file ? Paths.stat(entry.file) : null;
    entry.size = stat ? stat.size : null;
    entry.name = entry.file ? CEP.path.basename(entry.file) : entry.title;

    // same source + same kind + same clip range = replace, don't duplicate
    const i = items.findIndex(function (x) {
      return x.videoId === entry.videoId && x.kind === entry.kind &&
             JSON.stringify(x.clip || null) === JSON.stringify(entry.clip || null);
    });
    if (i > -1) items[i] = Object.assign(items[i], entry);
    else items.unshift(entry);

    Library.save();
    Bus.emit('library:added', entry);
    return entry;
  },

  get: function (id) { return items.filter(function (i) { return i.id === id; })[0] || null; },

  byVideo: function (videoId) { return items.filter(function (i) { return i.videoId === videoId; }); },

  /** Drop entries whose media file has vanished from disk. */
  prune: function () {
    const before = items.length;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].file && !Paths.exists(items[i].file)) items.splice(i, 1);
    }
    if (items.length !== before) Library.save();
    return before - items.length;
  },

  /** Remove from the manifest, optionally deleting the files too. */
  remove: function (id, deleteFiles) {
    const i = items.findIndex(function (x) { return x.id === id; });
    if (i < 0) return false;
    const entry = items[i];
    if (deleteFiles) {
      (entry.files || [entry.file]).filter(Boolean).forEach(function (f) { Paths.remove(f); });
      if (entry.file) {
        const base = CEP.path.join(CEP.path.dirname(entry.file), CEP.path.basename(entry.file, CEP.path.extname(entry.file)));
        Paths.remove(base + '.license.json');
        Paths.remove(base + '.attribution.txt');
      }
      Ledger.record({ event: 'file_deleted', videoId: entry.videoId, title: entry.title, file: entry.file });
    }
    items.splice(i, 1);
    Library.save();
    return true;
  },

  /** yt-dlp writes the poster into Thumbnails\ under the same base name. */
  findThumb: function (outName) {
    const dir = Paths.dir('thumbs');
    const exts = ['.jpg', '.png', '.webp'];
    for (let i = 0; i < exts.length; i++) {
      const p = CEP.path.join(dir, outName + exts[i]);
      if (Paths.exists(p)) return p;
    }
    return null;
  },

  /** Re-read the sidecar so the panel shows what was actually recorded. */
  sidecar: function (entry) {
    if (!entry || !entry.file) return null;
    const path = CEP.path;
    const p = path.join(path.dirname(entry.file),
      path.basename(entry.file, path.extname(entry.file)) + '.license.json');
    return Paths.readJSON(p, null);
  },

  /** Add a local file the user picked manually (no YouTube metadata, no report). */
  addManual: function (file) {
    if (!file) throw new Error('No file was selected.');
    const ext = (file.match(/\.([^.]+)$/) || [])[1] || '';
    const isVideo = /^(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpeg|mpg)$/i.test(ext);
    return Library.add({
      videoId: 'manual:' + file,
      title: CEP.path.basename(file),
      channel: 'Manual import',
      kind: isVideo ? 'video' : 'audio',
      file: file,
      files: [file],
      report: null,
      downloadedAt: Date.now()
    });
  },

  filter: function (opts) {
    opts = opts || {};
    let out = items.slice();
    if (opts.kind && opts.kind !== 'all') out = out.filter(function (i) { return i.kind === opts.kind; });
    if (opts.tier && opts.tier !== 'all') out = out.filter(function (i) { return i.report && i.report.tier === opts.tier; });
    if (opts.text) {
      const q = opts.text.toLowerCase();
      out = out.filter(function (i) {
        return (i.title || '').toLowerCase().indexOf(q) > -1 ||
               (i.channel || '').toLowerCase().indexOf(q) > -1;
      });
    }
    if (opts.sort === 'name') out.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    else if (opts.sort === 'size') out.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
    else out.sort(function (a, b) { return (b.downloadedAt || 0) - (a.downloadedAt || 0); });
    return out;
  },

  stats: function () {
    const s = { count: items.length, bytes: 0, video: 0, audio: 0, cc: 0, overridden: 0, high: 0, moderate: 0 };
    items.forEach(function (i) {
      s.bytes += i.size || 0;
      if (i.kind === 'audio') s.audio++; else s.video++;
      const level = License.level(i.report);
      if (level === 'LOW') s.cc++;
      else if (level === 'MODERATE') s.moderate++;
      else if (level === 'HIGH' || level === 'CRITICAL') s.high++;
      if (i.override) s.overridden++;
    });
    return s;
  }
};

export default Library;
