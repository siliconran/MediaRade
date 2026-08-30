/* =============================================================================
   inbox.js — accept download jobs handed over by other apps.
   MediaRade by sgtsilicon

   MediaRade is a CEP panel, so it has no port to listen on and is often simply
   not running. A watched folder handles both: a sender drops a small JSON file
   into Documents\MediaRade\Inbox and MediaRade picks it up next time it looks —
   immediately if it is open, on the next boot if it is not. Nothing is lost and
   no sender needs to know whether the panel is alive.

   Job file — any name ending .json:

       { "url":   "https://www.youtube.com/watch?v=…",   (required)
         "kind":  "video" | "audio",                     (default "video")
         "title": "for the toast only",                  (optional)
         "from":  "FictusTube"                           (optional, shown to the user) }

   Handled files move to Inbox\processed so a job never runs twice, and a file
   that cannot be parsed is left where it is exactly once, then quarantined —
   otherwise a single bad file would be retried on every tick forever.
   ========================================================================== */
import { CEP } from './cep.js';
import Paths from './paths.js';
import Bus from './bus.js';
import U from './util.js';

let timer = null;
let running = false;
const bad = {};          // file -> true, so a broken job is reported once

export const Inbox = {
  /** Poll interval. Slow on purpose: this is a courtesy channel, not a queue. */
  INTERVAL: 4000,

  dir: function () { return Paths.dir('inbox'); },

  /** Read and validate one job file. Returns null when it is not usable. */
  parse: function (text) {
    let j = null;
    try { j = JSON.parse(String(text || '')); } catch (e) { return null; }
    if (!j || typeof j !== 'object') return null;
    const url = String(j.url || j.link || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    const kind = String(j.kind || 'video').toLowerCase() === 'audio' ? 'audio' : 'video';
    return {
      url: url,
      kind: kind,
      title: j.title ? String(j.title) : '',
      /* Senders disagree on this field name — accept either rather than
         showing "another app" for a sender that clearly identified itself. */
      from: String(j.from || j.source || j.app || '').trim() || 'another app'
    };
  },

  /** One sweep. Returns the jobs accepted this time. */
  scan: function () {
    const fs = CEP.fs, path = CEP.path;
    let names = [];
    try {
      Paths.ensureDir(Paths.dir('inbox'));
      names = fs.readdirSync(Paths.dir('inbox'));
    } catch (e) { return []; }

    const jobs = [];
    names.forEach(function (name) {
      if (!/\.json$/i.test(name)) return;
      const file = path.join(Paths.dir('inbox'), name);
      let text = null;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }   // still being written

      const job = Inbox.parse(text);
      if (!job) {
        /* Quarantine rather than delete — the sender may want to see it — but
           only complain once, or every tick would raise the same toast. */
        if (!bad[file]) {
          bad[file] = true;
          try { Paths.log('inbox: ignoring unreadable job ' + name); } catch (e) {}
          Inbox.archive(file, name);
        }
        return;
      }
      /* Move BEFORE handing on: if the download throws, the job must not be
         replayed on the next tick. */
      if (!Inbox.archive(file, name)) return;
      job.file = name;
      jobs.push(job);
    });

    jobs.forEach(function (job) { Bus.emit('inbox:job', job); });
    return jobs;
  },

  /** Move a handled file into Inbox\processed. False if it could not be moved
      (another process holds it) so the caller leaves it for the next tick. */
  archive: function (file, name) {
    const fs = CEP.fs, path = CEP.path;
    try {
      Paths.ensureDir(Paths.dir('inboxDone'));
      const dest = Paths.unique(path.join(Paths.dir('inboxDone'),
        U.ymd(new Date()) + '-' + name));
      fs.renameSync(file, dest);
      return true;
    } catch (e) {
      try { fs.unlinkSync(file); return true; } catch (e2) { return false; }
    }
  },

  start: function () {
    if (timer) return Inbox;
    Inbox.scan();
    timer = setInterval(function () {
      if (running) return;
      running = true;
      try { Inbox.scan(); } catch (e) {
        try { Paths.log('inbox: scan failed — ' + e.message); } catch (x) {}
      }
      running = false;
    }, Inbox.INTERVAL);
    return Inbox;
  },

  stop: function () { if (timer) { clearInterval(timer); timer = null; } return Inbox; }
};

export default Inbox;
