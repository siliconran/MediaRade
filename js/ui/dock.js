/* =============================================================================
   dock.js — the timeline dock: track lanes + persist points, and the single
   place() path that every insert in the panel funnels through.
   MediaRade by sgtsilicon
   ========================================================================== */
(function (global) {
  'use strict';

  var body, head, seqLabel, tcLabel, dockEl;
  var mode = null;        // overwrite | insert
  var target = null;      // playhead | end | inpoint

  /* ---------------------------------------------------------------------- */

  var Dock = {

    init: function () {
      dockEl   = U.$('#dock');
      body     = U.$('#dockBody');
      head     = U.$('#dockHead');
      seqLabel = U.$('#dockSeq');
      tcLabel  = U.$('#dockTc');

      mode   = Config.get('defaultInsertMode');
      target = Config.get('defaultDropTarget');

      dockEl.classList.toggle('is-open', !!Config.get('dockOpen'));
      head.addEventListener('click', function () {
        var open = !dockEl.classList.contains('is-open');
        dockEl.classList.toggle('is-open', open);
        Config.set('dockOpen', open);
      });

      Bus.on('host:state', function (d, changed) { Dock.tick(d); if (changed) Dock.render(); });
      Bus.on('points', Dock.render);
      Bus.on('config', Dock.render);

      Dock.render();
    },

    /* --- lightweight per-poll update (no re-render) ---------------------- */
    tick: function (d) {
      var seq = d && d.sequence;
      if (!seq) {
        seqLabel.textContent = State.host.connected ? 'no sequence' : 'not connected';
        tcLabel.textContent = '--:--:--:--';
        return;
      }
      seqLabel.textContent = U.truncate(seq.name, 26);
      tcLabel.textContent = U.timecode(seq.playhead, seq.fps);
    },

    /* --- full render ------------------------------------------------------ */
    render: function () {
      if (!body) return;
      U.clear(body);
      var seq = State.sequence;

      /* mode + target row */
      var controls = U.el('div', { class: 'ps2-row-gap ps2-wrap', style: { marginBottom: '8px' } }, [
        U.el('span', { class: 'mr-filters__label', text: 'Mode' }),
        C.chip('Overwrite', mode === 'overwrite', function () { Dock.setMode('overwrite'); },
               { title: 'Drop replaces whatever is under it' }),
        C.chip('Insert', mode === 'insert', function () { Dock.setMode('insert'); },
               { title: 'Drop pushes existing clips to the right' }),
        U.el('span', { class: 'mr-filters__label', style: { marginLeft: '8px' }, text: 'At' }),
        C.chip('Playhead', target === 'playhead', function () { Dock.setTarget('playhead'); }),
        C.chip('Sequence end', target === 'end', function () { Dock.setTarget('end'); }),
        C.chip('In point', target === 'inpoint', function () { Dock.setTarget('inpoint'); })
      ]);
      body.appendChild(controls);

      if (!seq) {
        body.appendChild(U.el('div', { class: 'mr-claimwarn' }, [
          U.el('span', { text: 'ⓘ' }),
          U.el('span', { html: State.host.connected
            ? 'No sequence is open. Open one in Premiere and the lanes will appear — or drop media anyway and MediaRade will build a sequence from it.'
            : 'Waiting for Premiere. If this persists, close and reopen the panel from <b>Window &rsaquo; Extensions &rsaquo; MediaRade</b>.' })
        ]));
        Dock.renderPoints();
        return;
      }

      /* video lanes, top-down like the timeline */
      var vCount = U.clamp(seq.videoTracks || 1, 1, 8);
      var aCount = U.clamp(seq.audioTracks || 1, 1, 8);
      var lanes = U.el('div', { class: 'mr-lanes' });

      for (var v = vCount; v >= 1; v--) lanes.appendChild(Dock.lane('video', v));
      for (var a = 1; a <= aCount; a++) lanes.appendChild(Dock.lane('audio', a));

      body.appendChild(lanes);
      Dock.renderPoints();
    },

    lane: function (kind, index) {
      var id = (kind === 'video' ? 'V' : 'A') + index;
      var node = U.el('div', { class: 'mr-lane' + (kind === 'audio' ? ' mr-lane--audio' : '') }, [
        U.el('span', { class: 'mr-lane__id', text: id }),
        U.el('span', { class: 'ps2-grow', text: kind === 'video' ? 'drop video here' : 'drop audio here' }),
        U.el('span', { class: 'mr-lane__hint', text: mode + ' @ ' + target })
      ]);

      DnD.target(node, function (payload) {
        if (kind === 'video' && payload.kind === 'audio') {
          Toast.warn('Wrong lane', 'That is an audio-only asset. Drop it on an audio track.');
          return;
        }
        Dock.place(payload, {
          target: target,
          mode: mode,
          videoTrack: kind === 'video' ? index : 0,
          audioTrack: kind === 'video' ? Config.get('defaultAudioTrack') : index,
          kind: kind === 'video' ? payload.kind : 'audio'
        });
      });

      return node;
    },

    renderPoints: function () {
      var pts = Premiere.pointsForCurrent();

      var wrap = U.el('div', { style: { marginTop: '10px' } }, [
        U.el('div', { class: 'mr-section__title' }, [
          U.el('span', { text: 'Persist points' }),
          U.el('button', {
            class: 'ps2-btn ps2-btn--sm ps2-btn--ghost',
            style: { marginLeft: 'auto' },
            text: '+ Capture playhead',
            title: 'Save the current playhead position as a named drop target',
            onclick: Dock.capture
          })
        ])
      ]);

      var list = U.el('div', { class: 'mr-points' });

      if (!pts.length) {
        list.appendChild(U.el('span', { class: 'ps2-caption', style: { padding: '4px 0' },
          text: 'No points saved for this sequence. Capture the playhead to create a drop target you can reuse.' }));
      }

      pts.forEach(function (p) {
        var node = U.el('div', { class: 'mr-point' + (p.pinned ? ' is-pinned' : ''), title: 'Drop media here, or click to jump the playhead' }, [
          U.el('span', { text: p.name }),
          U.el('span', { class: 'mr-point__tc', text: U.timecode(p.seconds, p.fps || (State.sequence && State.sequence.fps)) }),
          U.el('span', {
            class: 'mr-point__x', text: '✕', title: 'Delete this point',
            onclick: function (e) { e.stopPropagation(); Premiere.removePoint(p.id); Dock.render(); }
          })
        ]);

        node.addEventListener('click', function () {
          Premiere.setPlayhead(p.seconds)
            .then(function () { Toast.info('Playhead moved', p.name + ' — ' + U.timecode(p.seconds, p.fps)); })
            .catch(function (e) { Toast.err('Could not move the playhead', e.message); });
        });

        node.addEventListener('dblclick', function (e) {
          e.stopPropagation();
          Modal.prompt({ title: 'Rename point', value: p.name }).then(function (name) {
            if (name) { Premiere.renamePoint(p.id, name); Dock.render(); }
          });
        });

        DnD.target(node, function (payload) {
          Dock.place(payload, {
            target: 'point',
            seconds: p.seconds,
            mode: mode,
            videoTrack: payload.kind === 'audio' ? 0 : Config.get('defaultVideoTrack'),
            audioTrack: Config.get('defaultAudioTrack'),
            kind: payload.kind
          });
        });

        list.appendChild(node);
      });

      wrap.appendChild(list);
      body.appendChild(wrap);
    },

    /* --- actions ----------------------------------------------------------- */

    setMode: function (m) { mode = m; Config.set('defaultInsertMode', m); Dock.render(); },
    setTarget: function (t) { target = t; Config.set('defaultDropTarget', t); Dock.render(); },

    capture: function (e) {
      if (e) e.stopPropagation();
      try {
        var pt = Premiere.capturePoint();
        Dock.render();
        Toast.ok('Point saved', pt.name + ' at ' + U.timecode(pt.seconds, pt.fps));
      } catch (err) {
        Toast.warn('Nothing to capture', err.message);
      }
    },

    /**
     * The one place media reaches the timeline.
     * @param {object} payload { kind, title, file, nodeId, report }
     * @param {object} opts    { target, seconds, mode, videoTrack, audioTrack, kind }
     */
    place: function (payload, opts) {
      if (!payload || (!payload.file && !payload.nodeId)) {
        Toast.warn('Nothing to place', 'That item has no downloaded file yet.');
        return Promise.resolve(null);
      }
      if (payload.file && !Paths.exists(payload.file)) {
        Toast.err('File is missing', 'The media file is no longer on disk: ' + payload.file);
        return Promise.resolve(null);
      }

      var busy = Toast.show({ kind: 'info', title: 'Placing…', text: payload.title, sticky: true });

      return Premiere.place({
        file: payload.file,
        nodeId: payload.nodeId,
        kind: opts.kind || payload.kind,
        target: opts.target,
        seconds: opts.seconds,
        mode: opts.mode,
        videoTrack: opts.videoTrack,
        audioTrack: opts.audioTrack,
        report: payload.report
      }).then(function (d) {
        busy.close();
        if (d.created) {
          Toast.ok('Sequence created', 'Premiere had no sequence open, so one was built from this clip.');
        } else {
          Toast.ok('Placed on ' + d.track,
            d.mode + ' at ' + U.timecode(d.position, State.sequence ? State.sequence.fps : 25) + ' in "' + d.sequence + '"');
        }
        if (payload.nodeId === undefined && d.item && d.item.nodeId && payload.entry) {
          payload.entry.nodeId = d.item.nodeId;
          Library.save();
        }
        Premiere.refresh();
        return d;
      }).catch(function (e) {
        busy.close();
        Toast.err('Could not place the clip', e.message);
        throw e;
      });
    },

    /** Buttons call this to use the dock's current mode/target settings. */
    quickPlace: function (payload, overrides) {
      return Dock.place(payload, Object.assign({
        target: target,
        mode: mode,
        videoTrack: payload.kind === 'audio' ? 0 : Config.get('defaultVideoTrack'),
        audioTrack: Config.get('defaultAudioTrack'),
        kind: payload.kind
      }, overrides || {}));
    },

    open: function () { if (dockEl) { dockEl.classList.add('is-open'); Config.set('dockOpen', true); } }
  };

  global.Dock = Dock;
})(window);
