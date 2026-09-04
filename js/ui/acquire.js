/* =============================================================================
   acquire.js — the single "I want this clip" flow.
   verify -> gate -> (override dialog) -> queue.
   Every download button in the panel goes through here so the licence check can
   never be skipped by using a different button.
   MediaRade by siliconran
   ========================================================================== */
(function (global) {
  'use strict';

  var Acquire = {

    /**
     * @param {string} videoId
     * @param {string} kind  'video' | 'audio' | 'both'
     * @param {object} opts  passed through to Queue.add (quality, clip range…)
     */
    request: function (videoId, kind, opts) {
      opts = opts || {};

      if (!YtDlp.ready()) {
        Toast.err('yt-dlp is missing', 'Set the path in Setup before downloading.');
        Bus.emit('nav', 'settings');
        return Promise.resolve(null);
      }

      var notice = null;
      var report = Search.report(videoId);
      var pre = report
        ? Promise.resolve(report)
        : (function () {
            notice = Toast.show({ kind: 'info', title: 'Checking the licence…',
                                  text: 'Fetching full metadata — a verdict is impossible without it.', sticky: true });
            return Search.verify(videoId);
          })();

      return pre.then(function (rep) {
        if (notice) notice.close();
        var info = Search.info(videoId) || { id: videoId };
        return Acquire.enqueue(info, rep, kind, opts);
      }).catch(function (e) {
        if (notice) notice.close();
        Toast.err('Licence check failed', e.message);
        return null;
      });
    },

    enqueue: function (info, report, kind, opts, override) {
      var spec = Object.assign({ info: info, report: report, kind: kind }, opts, override || {});
      try {
        var jobs = (kind === 'both') ? Queue.addBoth(spec) : [Queue.add(spec)];
        var label = kind === 'both' ? 'Video + audio queued' : (kind === 'audio' ? 'Audio queued' : 'Video queued');
        Toast.ok(label, U.truncate(info.title || info.id, 46) +
          (report.tier === 'VERIFIED_CC_BY' ? ' — CC BY 3.0, attribution will be written.' : ''));
        Bus.emit('nav', 'queue');
        return jobs;
      } catch (err) {
        if (!err.blocked) { Toast.err('Could not queue', err.message); return null; }
        return Acquire.blocked(info, report, kind, opts);
      }
    },

    /** Show why it was refused, and offer the audited override path. */
    blocked: function (info, report, kind, opts) {
      Toast.show({
        kind: 'err',
        title: 'Blocked — ' + report.tierInfo.title,
        text: report.gate.reasons[0] || 'This material cannot be used.',
        duration: 6000
      });

      return Modal.override(info, report).then(function (ack) {
        if (!ack) return null;
        return Acquire.enqueue(info, report, kind, opts, {
          override: true,
          overrideReason: ack.reason,
          ack: ack.ack
        });
      });
    },

    /** Payload shape shared by drag sources and place buttons. */
    payload: function (entry) {
      return {
        kind: entry.kind || 'video',
        title: entry.title || entry.name,
        file: entry.file,
        nodeId: entry.nodeId || null,
        report: entry.report || null,
        entry: entry
      };
    }
  };

  global.Acquire = Acquire;
})(window);
