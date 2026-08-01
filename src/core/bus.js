/* =============================================================================
   bus.js — pub/sub + the single mutable app state, backed by a Solid store.
   MediaRade by rad1x

   In the SolidJS port this is the reactive backbone: every module mutates the
   store through Bus.patch / setState, and every component reads `state` from
   inside its JSX so Solid re-renders exactly the cells that changed.
   ========================================================================== */
import { createStore } from 'solid-js/store';

const handlers = {};

const Bus = {
  on: function (evt, fn) {
    (handlers[evt] || (handlers[evt] = [])).push(fn);
    return function () { Bus.off(evt, fn); };
  },
  once: function (evt, fn) {
    let off = null;
    off = Bus.on(evt, function () { off(); fn.apply(null, arguments); });
    return off;
  },
  off: function (evt, fn) {
    const a = handlers[evt];
    if (!a) return;
    const i = a.indexOf(fn);
    if (i > -1) a.splice(i, 1);
  },
  emit: function (evt) {
    const args = Array.prototype.slice.call(arguments, 1);
    (handlers[evt] || []).slice().forEach(function (fn) {
      try { fn.apply(null, args); }
      catch (e) { console.error('[MediaRade] handler for "' + evt + '" threw:', e); }
    });
    (handlers['*'] || []).slice().forEach(function (fn) {
      try { fn(evt, args); } catch (e) {}
    });
  }
};

/* ---------------------------------------------------------------------- */

const initial = {
  view: 'browse',

  /* host */
  host: { app: null, version: null, connected: false },
  project: { name: null, path: null },
  sequence: null,           // { name, id, playhead, inPoint, outPoint, fps, videoTracks, audioTracks, end }

  /* tooling */
  tools: { ytdlp: null, ytdlpVersion: null, ffmpeg: null, checked: false },

  /* search */
  query: '',
  filters: null,            // owned by views/browse
  results: [],              // [SearchResult]
  searching: false,
  searchError: null,

  /* detail */
  current: null,            // full metadata + licence report
  videoId: null,            // id of the video shown in the Video view (store-driven,
                            // because the view mounts lazily and would miss events)
  autoPlay: false,          // one-shot: when opening a video, start the preview
  videoNonce: 0,            // bumped on every open request so re-opening the SAME
                            // video still re-triggers the Video view's effect

  /* work */
  jobs: [],
  libraryItems: [],

  /* uppbeat */
  uppbeat: {
    signedIn: false, plan: 'free', account: null,
    results: [], searching: false, error: null, query: ''
  }
};

const [state, setState] = createStore(initial);

/** Shallow-merge a patch into State and announce it. */
Bus.patch = function (patch, evt) {
  setState(patch);
  Bus.emit(evt || 'state', patch);
};

/**
 * Keep the store's job list in step with Queue's own array.
 *
 * The entries are SHALLOW COPIES on purpose. Queue mutates its own job objects
 * in place (Object.assign) before announcing the change; if the store held the
 * same references, setState would compare the new value against an already
 * mutated object, decide nothing changed, and skip the update — which is
 * exactly how the queue silently stopped re-rendering. Copies keep the store's
 * previous value distinct so the diff is real.
 */
Bus.syncJobs = function (jobs) {
  setState('jobs', jobs.map(function (j) { return Object.assign({}, j); }));
  Bus.emit('queue', { jobs: jobs });
};

/** Fine-grained per-job update: only the changed fields re-render. */
Bus.updateJob = function (id, patch) {
  const i = state.jobs.findIndex(function (j) { return j.id === id; });
  if (i === -1) return;
  setState('jobs', i, Object.assign({}, patch));
  Bus.emit('job', Object.assign({}, state.jobs[i]));
};

/** Same copy-on-write rule as syncJobs, for the library grid. */
Bus.syncLibrary = function (items) {
  setState('libraryItems', items.map(function (i) { return Object.assign({}, i); }));
  Bus.emit('library', { items: items });
};

/** Fine-grained per-result update for the verification pass. */
Bus.updateResult = function (id, patch) {
  const i = state.results.findIndex(function (r) { return r.id === id; });
  if (i === -1) return;
  setState('results', i, { ...patch });
};

export { state, setState };
export default Bus;
