/* =============================================================================
   premiere.js — bridge to the ExtendScript host (jsx/MediaRade.jsx)
   MediaRade by sgtsilicon
   ========================================================================== */
import U from './util.js';
import Bus, { state } from './bus.js';
import Config from './config.js';
import Ledger from './ledger.js';
import { CEP } from './cep.js';

let pollTimer = null;
let pollBusy = false;

export const Premiere = {

  /** Call a host function with a JSON payload and get JSON back. */
  call: function (fn, args) {
    const payload = JSON.stringify(args === undefined ? {} : args);
    const script = '$._MediaRade.' + fn + '(' + JSON.stringify(payload) + ')';
    return CEP.evalScript(script).then(function (raw) {
      if (raw === undefined || raw === null || raw === '') {
        throw new Error('No response from Premiere for ' + fn + '().');
      }
      let res;
      try { res = JSON.parse(raw); }
      catch (e) { throw new Error('Premiere returned an unreadable response for ' + fn + '(): ' + String(raw).slice(0, 200)); }
      if (res && res.ok === false) throw new Error(res.error || ('Premiere refused ' + fn + '()'));
      return res && 'data' in res ? res.data : res;
    });
  },

  /* --- host state -------------------------------------------------------- */

  connect: function () {
    const env = CEP.hostEnvironment();
    return Premiere.call('ping').then(function (d) {
      Bus.patch({
        host: { app: env ? env.appName : 'PPRO', version: d.version || (env ? env.appVersion : ''), connected: true }
      }, 'host');
      return d;
    }).catch(function (e) {
      Bus.patch({ host: { app: null, version: null, connected: false } }, 'host');
      throw e;
    });
  },

  /** Project + active sequence snapshot; drives the dock. */
  refresh: function () {
    if (pollBusy) return Promise.resolve(null);
    pollBusy = true;
    return Premiere.call('getState').then(function (d) {
      pollBusy = false;
      const changed = JSON.stringify(state.sequence) !== JSON.stringify(d.sequence) ||
                      JSON.stringify(state.project) !== JSON.stringify(d.project);
      Bus.patch({
        project: d.project,
        sequence: d.sequence,
        host: Object.assign({}, state.host, { connected: true })
      }, 'host');
      Bus.emit('host:state', d, changed);
      return d;
    }).catch(function (e) {
      pollBusy = false;
      if (state.host.connected) {
        Bus.patch({ host: Object.assign({}, state.host, { connected: false }) }, 'host');
        Bus.emit('host:state', null, true);
      }
      return null;
    });
  },

  startPolling: function (ms) {
    Premiere.stopPolling();
    pollTimer = setInterval(function () {
      if (!document.hidden) Premiere.refresh();
    }, ms || 1500);
    Premiere.refresh();
  },

  stopPolling: function () { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } },

  /* --- project ----------------------------------------------------------- */

  /** Import into the MediaRade bin, stamping licence info on the item. */
  importFile: function (filePath, meta) {
    meta = meta || {};
    const report = meta.report;
    return Premiere.call('importFile', {
      path: filePath,
      bin: Config.get('binName'),
      subBin: meta.subBin || null,
      comment: report ? Premiere.comment(report) : '',
      label: report ? Premiere.colorLabel(report) : null
    });
  },

  /** Colour-code bin items by risk so the verdict is visible in the project. */
  colorLabel: function (report) {
    if (!report) return 'Gray';
    switch (report.level) {
      case 'LOW':      return 'Green';
      case 'MODERATE': return 'Yellow';
      case 'HIGH':     return 'Red';
      case 'CRITICAL': return 'Red';
      default:         return 'Gray';
    }
  },

  comment: function (report) {
    if (!report) return '';
    const bits = ['[MediaRade] ' + report.levelInfo.title + ' (risk ' + report.score + ')'];
    if (report.attribution) bits.push(report.attribution.plain);
    if (report.counts.crit) bits.push(report.counts.crit + ' critical licence flag(s)');
    return bits.join(' — ');
  },

  /* --- timeline ---------------------------------------------------------- */

  /**
   * Put media on the timeline.
   * @param {object} o
   *   file        absolute path (imported first if needed)
   *   nodeId      existing project item, skips import
   *   target      'playhead' | 'end' | 'inpoint' | 'point'
   *   seconds     explicit position when target === 'point'
   *   mode        'overwrite' | 'insert'
   *   videoTrack  1-based, 0 = none
   *   audioTrack  1-based, 0 = none
   *   kind        'video' | 'audio'  (audio-only skips the video track)
   *   report      for the attribution marker
   */
  place: function (o) {
    const cfg = Config.all();
    const kind = o.kind || 'video';
    const payload = {
      path: o.file || null,
      nodeId: o.nodeId || null,
      bin: cfg.binName,
      target: o.target || cfg.defaultDropTarget,
      seconds: o.seconds !== undefined && o.seconds !== null ? o.seconds : null,
      mode: o.mode || cfg.defaultInsertMode,
      videoTrack: kind === 'audio' ? 0 : (o.videoTrack !== undefined ? o.videoTrack : cfg.defaultVideoTrack),
      audioTrack: o.audioTrack !== undefined ? o.audioTrack : cfg.defaultAudioTrack,
      select: cfg.selectAfterInsert,
      comment: o.report ? Premiere.comment(o.report) : '',
      label: o.report ? Premiere.colorLabel(o.report) : null,
      marker: (cfg.stampMarker && o.report && o.report.attribution) ? o.report.attribution.marker : null
    };
    return Premiere.call('place', payload).then(function (d) {
      Bus.emit('placed', d, o);
      if (o.report) {
        Ledger.record({
          event: 'timeline_insert',
          videoId: o.report.source ? o.report.source.id : null,
          title: o.report.source ? o.report.source.title : null,
          verdict: o.report.level,
          sequence: d.sequence,
          at: new Date().toISOString(),
          position: d.position,
          track: d.track
        });
      }
      return d;
    });
  },

  setPlayhead: function (seconds) { return Premiere.call('setPlayhead', { seconds: seconds }); },

  addMarker: function (seconds, name, comment) {
    return Premiere.call('addMarker', { seconds: seconds, name: name, comment: comment || '' });
  },

  newSequence: function (name) { return Premiere.call('newSequence', { name: name || 'MediaRade Sequence' }); },

  revealBin: function (nodeId) { return Premiere.call('revealBin', { nodeId: nodeId }); },

  /** Native file picker (ExtendScript) for importing local media without a download. */
  pickMedia: function (title) {
    return Premiere.call('pickMedia', { title: title || 'Select media files' });
  },

  /* Persist points are gone: MediaRade no longer mirrors the timeline. Media
     goes to the real sequence by native drag or by the Place buttons above. */
};

export default Premiere;
