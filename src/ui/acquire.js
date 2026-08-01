/* =============================================================================
   acquire.js — the single "I want this clip" flow.
   verify -> gate -> (override dialog) -> queue.
   Every download button in the panel goes through here so the licence check can
   never be skipped by using a different button.
   MediaRade by rad1x
   ========================================================================== */
import U from '../core/util.js';
import Bus from '../core/bus.js';
import Search from '../core/search.js';
import Queue from '../core/queue.js';
import YtDlp from '../core/ytdlp.js';
import License from '../core/license.js';
import Toast from './toast.js';
import Modal from './modal.js';

export const Acquire = {

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

    let notice = null;
    const report = Search.report(videoId);
    const pre = report
      ? Promise.resolve(report)
      : (function () {
          notice = Toast.show({ kind: 'info', title: 'Checking the licence…',
                                text: 'Fetching full metadata — a verdict is impossible without it.', sticky: true });
          return Search.verify(videoId);
        })();

    return pre.then(function (rep) {
      if (notice) notice.close();
      const info = Search.info(videoId) || { id: videoId };
      return Acquire.enqueue(info, rep, kind, opts);
    }).catch(function (e) {
      if (notice) notice.close();
      Toast.err('Licence check failed', e.message);
      return null;
    });
  },

  enqueue: function (info, report, kind, opts, override) {
    const spec = Object.assign({ info: info, report: report, kind: kind }, opts, override || {});
    try {
      const jobs = [Queue.add(spec)];
      const label = kind === 'both'
        ? 'Video + audio queued (one file)'
        : (kind === 'audio' ? 'Audio queued' : 'Video queued');
      const extra = (override && override.override)
        ? ' — override recorded in the ledger.'
        : (report && report.level === 'LOW'
            ? ' — LOW risk, attribution will be written.'
            : (report && report.level === 'MODERATE' ? ' — MODERATE risk, record written.' : ''));
      Toast.ok(label, U.truncate(info.title || info.id, 46) + extra);
      Bus.emit('nav', 'queue');
      return jobs;
    } catch (err) {
      if (!err.blocked) { Toast.err('Could not queue', err.message); return null; }
      // An override that is itself refused is a hard block — do not loop.
      if (override && override.override) {
        Toast.err('Refused', err.message);
        return null;
      }
      return Acquire.blocked(info, report, kind, opts);
    }
  },

  /** Show why it was refused, and offer the audited override path. */
  blocked: function (info, report, kind, opts) {
    const st = report ? License.blocked(report) : null;

    /* CRITICAL is the only verdict with no way through: Content ID already
       fingerprints the audio, so consent cannot create a right that is not
       there. Everything else offers a recorded confirmation. */
    if (!st || st.hard) {
      Toast.show({
        kind: 'err',
        title: 'DO NOT USE — ' + (report ? report.levelInfo.title : 'unverified'),
        text: (report && report.gate.reasons[0]) ||
              'This material is claimed by an automated enforcement system and cannot be downloaded.',
        duration: 9000
      });
      return Promise.resolve(null);
    }

    const reasons = report.gate.reasons.map(function (r) {
      return U.el('div', { class: 'mr-signal mr-signal--crit' }, [
        U.el('span', { class: 'mr-signal__icon', text: '!' }),
        U.el('span', { class: 'ps2-grow', text: r })
      ]);
    });

    return Modal.confirm({
      title: 'Download anyway?',
      danger: true,
      okLabel: 'Download anyway',
      cancelLabel: 'Cancel',
      body: U.el('div', { class: 'ps2-col-gap' }, [
        U.el('div', { class: 'mr-verdict mr-verdict--' + report.levelInfo.tone }, [
          U.el('div', { class: 'mr-verdict__seal', text: report.levelInfo.seal }),
          U.el('div', { class: 'ps2-grow' }, [
            U.el('div', { class: 'mr-verdict__title', text: report.levelInfo.title }),
            U.el('div', { class: 'mr-verdict__line', html: report.levelInfo.line })
          ])
        ]),
        U.el('div', { class: 'mr-section__title', text: 'Why this is flagged' }),
        U.el('div', { class: 'ps2-col-gap', style: { marginBottom: '12px' } }, reasons),
        U.el('div', { class: 'mr-claimwarn' }, [
          U.el('span', { text: '⚠' }),
          U.el('span', { html:
            'You are about to download <b>' + U.esc(report.level) + '-risk</b> material anyway. The choice is ' +
            'recorded in <code>Compliance\\license-ledger.jsonl</code> with a timestamp, so it is on the ' +
            'record. MediaRade cannot give you rights you do not have.' })
        ])
      ])
    }).then(function (yes) {
      if (!yes) return null;
      return Acquire.enqueue(info, report, kind, opts, {
        override: true,
        overrideReason: 'Downloaded anyway — user confirmed the ' + report.level + '-risk verdict.',
        ack: null
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
      thumb: entry.thumb || (entry.videoId ? U.thumb(entry.videoId) : null),
      entry: entry
    };
  }
};

export default Acquire;
