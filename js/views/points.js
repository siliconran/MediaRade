/* =============================================================================
   views/points.js — persist points: named timeline anchors you can drop onto
   MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var root, toolbar, body;

  var PointsView = {

    init: function () {
      root = U.$('.mr-view[data-view="points"]');
      toolbar = U.el('div', { class: 'mr-view__toolbar' });
      body = U.el('div', { class: 'mr-view__body' });
      U.append(root, [toolbar, body]);

      Bus.on('points', PointsView.render);
      Bus.on('host:state', function (d, changed) { if (changed && State.view === 'points') PointsView.render(); });
      Bus.on('view', function (v) { if (v === 'points') PointsView.render(); });

      PointsView.render();
    },

    render: function () {
      if (!body) return;
      U.clear(toolbar);
      U.clear(body);

      var seq = State.sequence;

      toolbar.appendChild(U.el('div', { class: 'ps2-row-gap ps2-wrap' }, [
        C.btn('Capture playhead', { variant: 'primary', onclick: function () { PointsView.capture(); } }),
        C.btn('Capture in point', { onclick: function () { PointsView.capture('inpoint'); } }),
        C.btn('Capture sequence end', { onclick: function () { PointsView.capture('end'); } }),
        U.el('span', { class: 'ps2-grow' }),
        C.btn('Clear all', { size: 'sm', variant: 'ghost', onclick: function () {
          Modal.confirm({ title: 'Clear points', body: 'Delete every saved persist point?', danger: true })
            .then(function (yes) { if (yes) { Premiere.savePoints([]); PointsView.render(); } });
        } })
      ]));

      toolbar.appendChild(U.el('div', { class: 'ps2-caption', style: { marginTop: '8px' },
        text: seq ? 'Active sequence: ' + seq.name + ' · ' + U.timecode(seq.playhead, seq.fps) +
                    ' · ' + seq.videoTracks + 'V / ' + seq.audioTracks + 'A'
                  : 'No sequence is open.' }));

      body.appendChild(U.el('div', { class: 'mr-claimwarn', style: {
        color: 'var(--ps2-info)', background: 'rgba(127,178,255,0.07)',
        borderColor: 'rgba(127,178,255,0.28)', borderLeftColor: 'var(--ps2-info)' } }, [
        U.el('span', { text: 'ⓘ' }),
        U.el('span', { html:
          'A <b>persist point</b> is a named position on a sequence that survives panel reloads. ' +
          'Drag any clip from Browse, Queue or Library onto a point — in this list or in the dock — ' +
          'and it lands exactly there. Click a point to jump the playhead to it.' })
      ]));

      var all = Premiere.points();
      if (!all.length) {
        body.appendChild(C.empty('No persist points',
          'Park the playhead where you keep dropping media, then hit <b>Capture playhead</b>.'));
        return;
      }

      /* group by sequence so points from other timelines stay visible but inert */
      var groups = {};
      all.forEach(function (p) { (groups[p.sequence] || (groups[p.sequence] = [])).push(p); });

      Object.keys(groups).sort().forEach(function (seqName) {
        var isCurrent = seq && (seqName === seq.name);
        var rows = groups[seqName]
          .sort(function (a, b) { return a.seconds - b.seconds; })
          .map(function (p) { return PointsView.row(p, isCurrent); });

        body.appendChild(C.section(
          seqName + (isCurrent ? '' : '  (not open)'),
          U.el('div', { class: 'ps2-list' }, rows),
          isCurrent ? C.badge('active', 'ok') : null
        ));
      });
    },

    row: function (p, isCurrent) {
      var node = U.el('div', { class: 'ps2-row' + (isCurrent ? '' : ' is-disabled'), style: { opacity: isCurrent ? 1 : 0.55 } }, [
        U.el('div', { class: 'ps2-row__main' }, [
          U.el('div', { class: 'ps2-row__title', text: p.name }),
          U.el('div', { class: 'ps2-row__sub ps2-mono', text: U.timecode(p.seconds, p.fps) + '  ·  ' + p.seconds.toFixed(3) + 's' })
        ]),
        isCurrent ? C.btn('Go', { size: 'sm', onclick: function (e) {
          e.stopPropagation();
          Premiere.setPlayhead(p.seconds).then(function () { Premiere.refresh(); });
        } }) : null,
        C.btn('Rename', { size: 'sm', variant: 'ghost', onclick: function (e) {
          e.stopPropagation();
          Modal.prompt({ title: 'Rename point', value: p.name }).then(function (n) {
            if (n) { Premiere.renamePoint(p.id, n); PointsView.render(); }
          });
        } }),
        C.btn('✕', { size: 'sm', variant: 'ghost', onclick: function (e) {
          e.stopPropagation();
          Premiere.removePoint(p.id);
          PointsView.render();
        } })
      ]);

      if (isCurrent) {
        DnD.target(node, function (payload) {
          Dock.place(payload, {
            target: 'point',
            seconds: p.seconds,
            mode: Config.get('defaultInsertMode'),
            videoTrack: payload.kind === 'audio' ? 0 : Config.get('defaultVideoTrack'),
            audioTrack: Config.get('defaultAudioTrack'),
            kind: payload.kind
          });
        });
        node.title = 'Drop media here to insert at ' + U.timecode(p.seconds, p.fps);
      }

      return node;
    },

    capture: function (which) {
      var seq = State.sequence;
      if (!seq) { Toast.warn('No sequence', 'Open a sequence in Premiere first.'); return; }

      var seconds = seq.playhead, label = 'Playhead';
      if (which === 'inpoint') {
        if (seq.inPoint === null) { Toast.warn('No in point', 'Set an in point on the sequence first.'); return; }
        seconds = seq.inPoint; label = 'In point';
      } else if (which === 'end') {
        seconds = seq.end; label = 'End';
      }

      Modal.prompt({
        title: 'Name this point',
        text: label + ' at ' + U.timecode(seconds, seq.fps),
        value: label + ' ' + U.timecode(seconds, seq.fps)
      }).then(function (name) {
        if (!name) return;
        var pts = Premiere.points();
        pts.push({
          id: U.uid('pt'), name: name, sequence: seq.name, sequenceId: seq.id,
          seconds: seconds, fps: seq.fps, pinned: false, createdAt: Date.now()
        });
        Premiere.savePoints(pts);
        PointsView.render();
        Toast.ok('Point saved', name);
      });
    }
  };

  global.PointsView = PointsView;
})(window);
