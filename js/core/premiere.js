/* =============================================================================
   premiere.js — bridge to the ExtendScript host (jsx/MediaRade.jsx)
   MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var pollTimer = null;
  var pollBusy = false;

  var Premiere = {

    /** Call a host function with a JSON payload and get JSON back. */
    call: function (fn, args) {
      var payload = JSON.stringify(args === undefined ? {} : args);
      var script = '$._MediaRade.' + fn + '(' + JSON.stringify(payload) + ')';
      return CEP.evalScript(script).then(function (raw) {
        if (raw === undefined || raw === null || raw === '') {
          throw new Error('No response from Premiere for ' + fn + '().');
        }
        var res;
        try { res = JSON.parse(raw); }
        catch (e) { throw new Error('Premiere returned an unreadable response for ' + fn + '(): ' + String(raw).slice(0, 200)); }
        if (res && res.ok === false) throw new Error(res.error || ('Premiere refused ' + fn + '()'));
        return res && 'data' in res ? res.data : res;
      });
    },

    /* --- host state -------------------------------------------------------- */

    connect: function () {
      var env = CEP.hostEnvironment();
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
        var changed = JSON.stringify(State.sequence) !== JSON.stringify(d.sequence) ||
                      JSON.stringify(State.project) !== JSON.stringify(d.project);
        State.project = d.project;
        State.sequence = d.sequence;
        if (!State.host.connected) State.host.connected = true;
        Bus.emit('host:state', d, changed);
        return d;
      }).catch(function (e) {
        pollBusy = false;
        if (State.host.connected) {
          State.host.connected = false;
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
      var report = meta.report;
      return Premiere.call('importFile', {
        path: filePath,
        bin: Config.get('binName'),
        subBin: meta.subBin || null,
        comment: report ? Premiere.comment(report) : '',
        label: report ? Premiere.colorLabel(report) : null
      });
    },

    /** Colour-code bin items by verdict so the risk is visible in the project. */
    colorLabel: function (report) {
      if (!report) return 'Gray';
      switch (report.tier) {
        case 'VERIFIED_CC_BY':      return 'Green';
        case 'UNVERIFIED_CLAIM':    return 'Yellow';
        case 'CONFLICT':            return 'Red';
        case 'ALL_RIGHTS_RESERVED': return 'Red';
        default:                    return 'Gray';
      }
    },

    comment: function (report) {
      if (!report) return '';
      var bits = ['[MediaRade] ' + report.tierInfo.title + ' (' + report.score + '%)'];
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
      var cfg = Config.all();
      var kind = o.kind || 'video';
      var payload = {
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
            verdict: o.report.tier,
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

    /* --- persist points ----------------------------------------------------
       Named timeline anchors the user can drop media onto. Stored in config so
       they survive a panel reload; keyed by sequence so they follow the edit. */

    points: function () {
      var pts = Config.get('persistPoints');
      return Array.isArray(pts) ? pts : [];
    },

    savePoints: function (pts) {
      Config.set('persistPoints', pts);
      Bus.patch({ points: pts.slice() }, 'points');
      return pts;
    },

    capturePoint: function (name) {
      var seq = State.sequence;
      if (!seq) throw new Error('Open a sequence first — there is no playhead to capture.');
      var pts = Premiere.points();
      var pt = {
        id: U.uid('pt'),
        name: name || ('Point ' + (pts.filter(function (p) { return p.sequence === seq.name; }).length + 1)),
        sequence: seq.name,
        sequenceId: seq.id,
        seconds: seq.playhead,
        fps: seq.fps,
        pinned: false,
        createdAt: Date.now()
      };
      pts.push(pt);
      Premiere.savePoints(pts);
      return pt;
    },

    removePoint: function (id) {
      Premiere.savePoints(Premiere.points().filter(function (p) { return p.id !== id; }));
    },

    renamePoint: function (id, name) {
      var pts = Premiere.points();
      var p = pts.filter(function (x) { return x.id === id; })[0];
      if (p) { p.name = name; Premiere.savePoints(pts); }
      return p;
    },

    /** Points belonging to the sequence that is currently open. */
    pointsForCurrent: function () {
      var seq = State.sequence;
      if (!seq) return [];
      return Premiere.points().filter(function (p) {
        return p.sequenceId === seq.id || p.sequence === seq.name;
      });
    }
  };

  global.Premiere = Premiere;
})(window);
