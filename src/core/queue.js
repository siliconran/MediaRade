/* =============================================================================
   queue.js — the download queue and the licence gate that guards it
   MediaRade by rad1x
   ========================================================================== */
import U from './util.js';
import Bus from './bus.js';
import Paths from './paths.js';
import Config from './config.js';
import License from './license.js';
import Ledger from './ledger.js';
import YtDlp from './ytdlp.js';
import Library from './library.js';
import Premiere from './premiere.js';

const jobs = [];
const running = {};        // jobId -> cancellable promise

function push() { Bus.syncJobs(jobs); }

function touch(job, patch) {
  Object.assign(job, patch);
  Bus.updateJob(job.id, patch);
  Bus.emit('job', job);
}

export const Queue = {
  jobs: jobs,

  /* --- the gate ---------------------------------------------------------
     A job may only enter the queue if the licence verdict permits it, or if
     the user has deliberately overridden with strict mode off and a reason
     that gets written to the ledger.                                       */

  /** @returns {{ok:boolean, report, reasons:string[], overridable:boolean, hard:boolean}} */
  check: function (report) {
    if (!report) return { ok: false, report: null, reasons: ['Licence has not been verified.'] };
    if (License.allow(report)) return { ok: true, report: report, reasons: [], overridable: false, hard: false };
    const st = License.blocked(report);
    return {
      ok: false, report: report,
      reasons: st.reasons,
      overridable: !!st.overridable,
      hard: !!st.hard
    };
  },

  /**
   * @param {object} spec  { info, report, kind, quality, container, audioFormat,
   *                         sectionStart, sectionEnd, writeSubs, sponsorblock,
   *                         override, overrideReason, ack }
   */
  add: function (spec) {
    const info   = spec.info || {};
    const report = spec.report || License.evaluate(info);
    const gate   = Queue.check(report);

    if (!gate.ok && !spec.override) {
      Ledger.logBlocked(info, report);
      const err = new Error('Blocked by licence policy: ' + gate.reasons.join(' '));
      err.blocked = true;
      err.report = report;
      err.overridable = !!gate.overridable;
      throw err;
    }

    /* An explicit, confirmed override stands on its own — the confirmation
       dialog IS the deliberate act, and it is written to the ledger. Strict
       mode decides what needs confirming, not what can be confirmed. The one
       exception is below: CRITICAL never yields. */
    if (spec.override && gate.hard) {
      const e3 = new Error('DO NOT USE — this material is claimed by an automated enforcement system and cannot be overridden.');
      e3.blocked = true;
      e3.hard = true;
      throw e3;
    }

    /* 'both' is one file with picture and sound muxed together — not two
       downloads. It lives beside video, because that is what it is. */
    const kind = spec.kind === 'audio' ? 'audio' : (spec.kind === 'both' ? 'both' : 'video');
    const name = U.slug(info.title || info.id) + ' [' + info.id + ']';

    const job = {
      id: U.uid('job'),
      videoId: info.id,
      url: info.webpage_url || U.watchUrl(info.id),
      title: info.title || info.id,
      channel: info.channel || info.uploader || '',
      thumb: U.thumb(info.id),
      kind: kind,
      quality: spec.quality || Config.get('videoQuality'),
      container: spec.container || Config.get('videoContainer'),
      audioFormat: spec.audioFormat || Config.get('audioFormat'),
        sectionStart: spec.sectionStart !== undefined ? spec.sectionStart : null,
        sectionEnd: spec.sectionEnd !== undefined ? spec.sectionEnd : null,
        writeSubs: !!spec.writeSubs,
        sponsorblock: spec.sponsorblock || null,
      outDir: kind === 'audio' ? Paths.dir('audio') : Paths.dir('video'),
      outName: name,
      report: report,
      override: !!spec.override,
      overrideReason: spec.overrideReason || null,
      ack: spec.ack || null,
      state: 'queued',
      percent: 0, speed: null, eta: null, downloaded: 0, total: null,
      file: null, error: null,
      addedAt: Date.now()
    };

    jobs.push(job);
    push();
    Ledger.logDownloadStart(job, report);
    Bus.emit('job:added', job);
    Queue.pump();
    return job;
  },

  /** Legacy alias — 'both' is now a single muxed job, not two downloads. */
  addBoth: function (spec) {
    return [Queue.add(Object.assign({}, spec, { kind: 'both' }))];
  },

  /* --- execution -------------------------------------------------------- */

  activeCount: function () { return Object.keys(running).length; },

  pump: function () {
    const limit = Math.max(1, Config.get('concurrentDownloads') || 2);
    while (Queue.activeCount() < limit) {
      const next = jobs.filter(function (j) { return j.state === 'queued'; })[0];
      if (!next) return;
      Queue.start(next);
    }
  },

  start: function (job) {
    touch(job, { state: 'running', startedAt: Date.now(), percent: 0 });

    const p = YtDlp.download(job, function (pr) {
      touch(job, {
        percent: pr.percent !== null && pr.percent !== undefined ? pr.percent : job.percent,
        speed: pr.speed, eta: pr.eta,
        downloaded: pr.downloaded || job.downloaded,
        total: pr.total || job.total,
        phase: pr.phase || (pr.status === 'processing' ? 'processing' : null)
      });
    });

    running[job.id] = p;

    p.then(function (res) {
      delete running[job.id];
      Queue.finish(job, res);
    }).catch(function (err) {
      delete running[job.id];
      if (err && err.canceled) {
        touch(job, { state: 'canceled', percent: 0 });
        Ledger.record({ event: 'download_canceled', videoId: job.videoId, title: job.title });
      } else {
        touch(job, { state: 'error', error: err.message });
        Paths.log('ERROR ' + job.title + ': ' + err.message);
        Ledger.record({ event: 'download_error', videoId: job.videoId, title: job.title, error: err.message });
        Bus.emit('job:error', job);
      }
      Queue.pump();
    });
  },

  /** Post-download: sidecars, ledger, library, optional auto-import. */
  finish: function (job, res) {
    const file = res.mediaFile;
    touch(job, { state: 'done', percent: 100, file: file, finishedAt: Date.now(), phase: null });

    try {
      if (file) {
        Ledger.writeSidecars(file, job.report, {
          downloadedAt: new Date().toISOString(),
          kind: job.kind,
          clip: (job.sectionStart !== null && job.sectionEnd)
            ? { start: job.sectionStart, end: job.sectionEnd } : null,
          override: job.override,
          overrideReason: job.overrideReason
        });
        Ledger.appendCredits(job.report, file);
      }
    } catch (e) { console.warn('[MediaRade] sidecar step failed:', e); }

    Ledger.logDownloadComplete(job, job.report, file);

    let entry = null;
    try {
      entry = Library.add({
        videoId: job.videoId,
        title: job.title,
        channel: job.channel,
        kind: job.kind,
        file: file,
        files: res.files,
        thumb: Library.findThumb(job.outName) || job.thumb,
        report: job.report,
        quality: job.kind === 'audio' ? job.audioFormat : job.quality,
        clip: (job.sectionStart !== null && job.sectionEnd) ? { start: job.sectionStart, end: job.sectionEnd } : null,
        downloadedAt: Date.now()
      });
    } catch (e) { console.warn('[MediaRade] library add failed:', e); }

    Bus.emit('job:done', job, entry);

    if (Config.get('autoImport') && file) {
      Premiere.importFile(file, { report: job.report, title: job.title })
        .then(function (r) {
          if (entry && r && r.nodeId) { entry.nodeId = r.nodeId; Library.save(); }
          Bus.emit('imported', entry, r);
        })
        .catch(function (e) { Bus.emit('toast', { kind: 'warn', title: 'Import failed', text: e.message }); });
    }

    Queue.pump();
  },

  /* --- controls ---------------------------------------------------------- */

  cancel: function (jobId) {
    const p = running[jobId];
    if (p && p.cancel) p.cancel();
    const job = Queue.get(jobId);
    if (job && job.state === 'queued') touch(job, { state: 'canceled' });
  },

  retry: function (jobId) {
    const job = Queue.get(jobId);
    if (!job) return;
    touch(job, { state: 'queued', error: null, percent: 0, speed: null, eta: null });
    Queue.pump();
  },

  remove: function (jobId) {
    Queue.cancel(jobId);
    const i = jobs.findIndex(function (j) { return j.id === jobId; });
    if (i > -1) jobs.splice(i, 1);
    push();
  },

  clearFinished: function () {
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (['done', 'error', 'canceled'].indexOf(jobs[i].state) > -1) jobs.splice(i, 1);
    }
    push();
  },

  cancelAll: function () {
    jobs.slice().forEach(function (j) {
      if (j.state === 'running' || j.state === 'queued') Queue.cancel(j.id);
    });
  },

  get: function (jobId) { return jobs.filter(function (j) { return j.id === jobId; })[0] || null; },

  counts: function () {
    const c = { queued: 0, running: 0, done: 0, error: 0, canceled: 0 };
    jobs.forEach(function (j) { c[j.state] = (c[j.state] || 0) + 1; });
    c.active = c.queued + c.running;
    return c;
  }
};

export default Queue;
