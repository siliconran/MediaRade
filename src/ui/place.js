/* =============================================================================
   place.js — the single path every "put this on the timeline" action funnels
   through. MediaRade by siliconran

   MediaRade deliberately has no timeline of its own. Media reaches Premiere in
   exactly two ways, both of which act on the real sequence:

     • Native OS drag (DnD.native) — grab a clip and drop it wherever you want
       on Premiere's own timeline or project panel.
     • The Place / Insert buttons — a one-click insert at the configured target
       (playhead by default) for when you do not want to drag.

   Everything below is the second path.
   ========================================================================== */
import Bus, { state } from '../core/bus.js';
import Config from '../core/config.js';
import Premiere from '../core/premiere.js';
import Paths from '../core/paths.js';
import Library from '../core/library.js';
import U from '../core/util.js';
import Toast from './toast.js';

export const Place = {

  /**
   * @param {object} payload { kind, title, file, nodeId, report, entry }
   * @param {object} opts    { target, seconds, mode, videoTrack, audioTrack, kind }
   */
  run: function (payload, opts) {
    opts = opts || {};

    if (!payload || (!payload.file && !payload.nodeId)) {
      Toast.warn('Nothing to place', 'That item has no downloaded file yet.');
      return Promise.resolve(null);
    }
    if (payload.file && !Paths.exists(payload.file)) {
      Toast.err('File is missing', 'The media file is no longer on disk: ' + payload.file);
      return Promise.resolve(null);
    }

    const busy = Toast.show({ kind: 'info', title: 'Placing…', text: payload.title, sticky: true });

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
          d.mode + ' at ' + U.timecode(d.position, state.sequence ? state.sequence.fps : 25) +
          ' in "' + d.sequence + '"');
      }
      // cache the project item so a second insert skips the re-import
      if (d.item && d.item.nodeId && payload.entry && !payload.entry.nodeId) {
        payload.entry.nodeId = d.item.nodeId;
        Library.save();
      }
      Premiere.refresh();
      return d;
    }).catch(function (e) {
      busy.close();
      Toast.err('Could not place the clip', e.message);
      return null;
    });
  },

  /** Buttons call this to use the configured mode/target. */
  quick: function (payload, overrides) {
    return Place.run(payload, Object.assign({
      target: Config.get('defaultDropTarget'),
      mode: Config.get('defaultInsertMode'),
      videoTrack: payload.kind === 'audio' ? 0 : Config.get('defaultVideoTrack'),
      audioTrack: Config.get('defaultAudioTrack'),
      kind: payload.kind
    }, overrides || {}));
  },

  /** Import into the project bin without touching the timeline. */
  toBin: function (payload) {
    if (!payload || !payload.file) return Promise.resolve(null);
    return Premiere.importFile(payload.file, { report: payload.report, title: payload.title })
      .then(function (d) {
        if (payload.entry) { payload.entry.nodeId = d.nodeId; Library.save(); }
        Toast.ok('Imported', d.name);
        return d;
      })
      .catch(function (e) { Toast.err('Import failed', e.message); return null; });
  }
};

export default Place;
