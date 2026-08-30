/* =============================================================================
   queue.js — the download queue and the licence gate that guards it
   MediaRade by sgtsilicon
   ========================================================================== */
(function (global) {
  'use strict';

  var jobs = [];
  var running = {};        // jobId -> cancellable promise

  function push() { Bus.patch({ jobs: jobs.slice() }, 'queue'); }

  function touch(job, patch) {
    Object.assign(job, patch);
    Bus.emit('job', job);
    if (patch.state) push();
  }

  var Queue = {
    jobs: jobs,

    /* --- the gate ---------------------------------------------------------
       A job may only enter the queue if the licence verdict permits it, or if
       the user has deliberately overridden with strict mode off and a reason
       that gets written to the ledger.                                       */

    /** @returns {{ok:boolean, report, reasons:string[]}} */
    check: function (report) {
      if (!report) return { ok: false, report: null, reasons: ['Licence has not been verified.'] };
      if (License.allow(report)) return { ok: true, report: report, reasons: [] };
      if (Config.get('strictMode')) return { ok: false, report: report, reasons: report.gate.reasons };
      return { ok: false, report: report, reasons: report.gate.reasons, overridable: true };
    },

    /**
     * @param {object} spec  { info, report, kind, quality, container, audioFormat,
     *                         sectionStart, sectionEnd, writeSubs,
     *                         override, overrideReason, ack }
     */
    add: function (spec) {
      var info   = spec.info || {};
      var report = spec.report || License.evaluate(info);
      var gate   = Queue.check(report);

      if (!gate.ok && !spec.override) {
        Ledger.logBlocked(info, report);
        var err = new Error('Blocked by licence policy: ' + gate.reasons.join(' '));
        err.blocked = true;
        err.report = report;
        err.overridable = !!gate.overridable;
        throw err;
      }

      if (spec.override && Config.get('strictMode')) {
        var e2 = new Error('Strict mode is on. Turn it off in Settings before overriding a licence verdict.');
        e2.blocked = true;
        throw e2;
      }

      var kind = spec.kind === 'audio' ? 'audio' : 'video';
      var name = U.slug(info.title || info.id) + ' [' + info.id + ']';

      var job = {
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

    /** Convenience for "grab the video and the audio as separate assets". */
    addBoth: function (spec) {
      var v = Queue.add(Object.assign({}, spec, { kind: 'video' }));
      var a = Queue.add(Object.assign({}, spec, { kind: 'audio' }));
      return [v, a];
    },

    /* --- execution -------------------------------------------------------- */

    activeCount: function () { return Object.keys(running).length; },

    pump: function () {
      var limit = Math.max(1, Config.get('concurrentDownloads') || 2);
      while (Queue.activeCount() < limit) {
        var next = jobs.filter(function (j) { return j.state === 'queued'; })[0];
        if (!next) return;
        Queue.start(next);
      }
    },

    start: function (job) {
      touch(job, { state: 'running', startedAt: Date.now(), percent: 0 });

      var p = YtDlp.download(job, function (pr) {
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
      var file = res.mediaFile;
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

      var entry = null;
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
          quality: job.kind === 'video' ? job.quality : job.audioFormat,
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
      var p = running[jobId];
      if (p && p.cancel) p.cancel();
      var job = Queue.get(jobId);
      if (job && job.state === 'queued') touch(job, { state: 'canceled' });
    },

    retry: function (jobId) {
      var job = Queue.get(jobId);
      if (!job) return;
      touch(job, { state: 'queued', error: null, percent: 0, speed: null, eta: null });
      Queue.pump();
    },

    remove: function (jobId) {
      Queue.cancel(jobId);
      var i = jobs.findIndex(function (j) { return j.id === jobId; });
      if (i > -1) jobs.splice(i, 1);
      push();
    },

    clearFinished: function () {
      for (var i = jobs.length - 1; i >= 0; i--) {
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
      var c = { queued: 0, running: 0, done: 0, error: 0, canceled: 0 };
      jobs.forEach(function (j) { c[j.state] = (c[j.state] || 0) + 1; });
      c.active = c.queued + c.running;
      return c;
    }
  };

  global.Queue = Queue;
})(window);
