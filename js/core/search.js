/* =============================================================================
   search.js — search orchestration + the verification pipeline
   MediaRade by rad1x

   Two stages, deliberately:
     1. flat listing  — fast, but carries NO licence field
     2. verification  — full metadata per hit, which is the only thing that can
                        produce a licence verdict
   The UI never shows a green badge from stage 1.
   ========================================================================== */
(function (global) {
  'use strict';

  var infoCache = {};      // videoId -> full yt-dlp info dict
  var reportCache = {};    // videoId -> licence report
  var currentRun = 0;

  /* --- disk-backed result cache (title + thumbnail) -----------------------
     Re-running a query renders the cached page instantly, then refreshes it
     from YouTube. The cache also stands in for missing fields when a flat
     search entry arrives with an empty title or thumbnail.                  */
  var cachePath = null;
  var searchCache = { version: 1, ids: {}, queries: {}, maxIds: 2000, maxQueries: 300 };

  var Search = {
    infoCache: infoCache,
    reportCache: reportCache,

    /** Load the on-disk result cache. Called once at boot, after Paths. */
    init: function () {
      try {
        cachePath = Paths.file('searchCache');
        var raw = Paths.readJSON(cachePath, null);
        if (raw && raw.version === 1 && raw.ids) {
          searchCache.ids = raw.ids;
          searchCache.queries = raw.queries || {};
        }
      } catch (e) { console.warn('[MediaRade] search cache load failed:', e); }
      return searchCache;
    },

    /** Deterministic key for a query + the filter subset that shapes it. */
    queryKey: function (query, filters) {
      var f = filters || {};
      return String(query).trim().toLowerCase() + '|' +
        (f.sort || 'relevance') + '|' + (f.uploaded || 'any') + '|' +
        (f.duration || 'any') + '|' + ((f.features && f.features.creativeCommons) ? 'cc' : '');
    },

    /** Rebuild a result row purely from the cache. */
    cached: function (id) {
      var c = searchCache.ids[id];
      if (!c) return null;
      return {
        id: id,
        cached: true,
        title: c.title || '(untitled)',
        channel: c.channel || '',
        channelUrl: c.channelUrl || '',
        duration: c.duration != null ? c.duration : null,
        views: c.views != null ? c.views : null,
        uploadDate: c.uploadDate || null,
        thumb: c.thumb || U.thumb(id),
        url: U.watchUrl(id),
        live: !!c.live,
        report: reportCache[id] || null,
        verifying: false
      };
    },

    /** Record a live result page in the cache, prune, persist. */
    seen: function (query, filters, results) {
      var now = Date.now();
      results.forEach(function (r) {
        var prev = searchCache.ids[r.id];
        searchCache.ids[r.id] = {
          title: r.title,
          channel: r.channel,
          channelUrl: r.channelUrl,
          thumb: (r.thumb && r.thumb.indexOf('i.ytimg.com') > -1) ? r.thumb : U.thumb(r.id),
          duration: r.duration != null ? r.duration : (prev && prev.duration != null ? prev.duration : null),
          views: r.views != null ? r.views : (prev && prev.views != null ? prev.views : null),
          uploadDate: r.uploadDate || (prev && prev.uploadDate) || null,
          live: !!r.live,
          cachedAt: now
        };
      });
      searchCache.queries[Search.queryKey(query, filters)] = {
        ids: results.map(function (r) { return r.id; }),
        at: now
      };
      Search.prune();
      Search.save();
    },

    prune: function () {
      var ids = Object.keys(searchCache.ids);
      if (ids.length > searchCache.maxIds) {
        ids.sort(function (a, b) { return (searchCache.ids[a].cachedAt || 0) - (searchCache.ids[b].cachedAt || 0); });
        ids.slice(0, ids.length - searchCache.maxIds).forEach(function (k) { delete searchCache.ids[k]; });
      }
      var qk = Object.keys(searchCache.queries);
      if (qk.length > searchCache.maxQueries) {
        qk.sort(function (a, b) { return (searchCache.queries[a].at || 0) - (searchCache.queries[b].at || 0); });
        qk.slice(0, qk.length - searchCache.maxQueries).forEach(function (k) { delete searchCache.queries[k]; });
      }
    },

    save: function () {
      if (!cachePath) return;
      try { Paths.writeJSON(cachePath, searchCache); } catch (e) { console.warn('[MediaRade] search cache save failed:', e); }
    },

    /** Normalise a flat entry into the shape the UI renders. */
    normalize: function (e) {
      var id = e.id;
      var c = searchCache.ids[id];
      return {
        id: id,
        title: e.title || (c && c.title) || '(untitled)',
        channel: e.channel || e.uploader || (c && c.channel) || '',
        channelUrl: e.channel_url || e.uploader_url || (c && c.channelUrl) || '',
        duration: e.duration != null ? e.duration : (c && c.duration != null ? c.duration : null),
        views: e.view_count != null ? e.view_count : (c && c.views != null ? c.views : null),
        uploadDate: e.upload_date || (c && c.uploadDate) || null,
        thumb: (e.thumbnails && e.thumbnails.length ? e.thumbnails[e.thumbnails.length - 1].url : null) ||
               (c && c.thumb) || U.thumb(id),
        url: e.url && /^https?:/.test(e.url) ? e.url : U.watchUrl(id),
        live: !!e.is_live,
        report: reportCache[id] || null,
        verifying: false
      };
    },

    /**
     * @param {string} query  free text, a URL, or a bare video ID
     * @param {object} filters see views/browse
     */
    run: function (query, filters) {
      var run = ++currentRun;
      query = String(query || '').trim();
      if (!query) return Promise.resolve([]);

      /* if this exact query was run before, paint the cached page immediately
         and let the live search refresh it — instant titles and thumbnails */
      var cached = [];
      var qc = searchCache.queries[Search.queryKey(query, filters)];
      if (qc && qc.ids && qc.ids.length) cached = qc.ids.map(Search.cached).filter(Boolean);
      Bus.patch({ searching: !cached.length, searchError: null, results: cached, query: query }, 'search');

      /* a pasted URL or ID skips search entirely */
      var direct = U.videoId(query);
      var task;
      if (direct) {
        task = Search.fetchInfo(direct).then(function (info) {
          return [Search.normalize(Object.assign({}, info, { id: direct }))];
        });
      } else if (/^https?:\/\//i.test(query)) {
        task = YtDlp.search(query, Config.get('resultCount'), query).then(function (entries) {
          return entries.map(Search.normalize);
        });
      } else {
        var url = SP.url(query, {
          sort: filters.sort,
          uploaded: filters.uploaded,
          duration: filters.duration,
          type: 'video',
          features: filters.features
        });
        task = YtDlp.search(query, Config.get('resultCount'), url)
          .catch(function (err) {
            // the sp filter can be rejected; fall back to a plain ytsearch
            Paths.log('sp search failed, falling back: ' + err.message);
            return YtDlp.search(query, Config.get('resultCount'), null);
          })
          .then(function (entries) { return entries.map(Search.normalize); });
      }

      return task.then(function (results) {
        if (run !== currentRun) return [];              // a newer search won
        Config.set('lastQuery', query);
        Search.seen(query, filters, results);
        Bus.patch({ results: results, searching: false }, 'search');

        if (Config.get('autoVerify')) Search.verifyAll(results, run);
        return results;
      }).catch(function (err) {
        if (run !== currentRun) return [];
        Bus.patch({ searching: false, searchError: err.message, results: [] }, 'search');
        throw err;
      });
    },

    /** Full metadata, cached. This is the call that unlocks a verdict. */
    fetchInfo: function (id, force) {
      if (!force && infoCache[id]) return Promise.resolve(infoCache[id]);
      return YtDlp.info(id).then(function (info) {
        infoCache[id] = info;
        return info;
      });
    },

    /** Fetch + evaluate one video. */
    verify: function (id, force) {
      return Search.fetchInfo(id, force).then(function (info) {
        var report = License.evaluate(info);
        reportCache[id] = report;
        Bus.emit('verified', id, report, info);
        return report;
      }).catch(function (err) {
        var report = License.evaluate({ id: id });
        report.error = err.message;
        reportCache[id] = report;
        Bus.emit('verified', id, report, null);
        return report;
      });
    },

    /** Verify a whole result page with bounded concurrency. */
    verifyAll: function (results, run) {
      var pending = results.filter(function (r) { return !reportCache[r.id]; });
      if (!pending.length) return Promise.resolve([]);

      pending.forEach(function (r) { r.verifying = true; });
      Bus.emit('verify:start', pending.length);

      var done = 0;
      return U.pool(pending, Config.get('verifyConcurrency') || 3, function (r) {
        if (run !== undefined && run !== currentRun) return null;
        return Search.verify(r.id).then(function (report) {
          r.verifying = false;
          r.report = report;
          done++;
          Bus.emit('verify:progress', done, pending.length);
          return report;
        });
      }).then(function (out) {
        Bus.emit('verify:done');
        return out;
      });
    },

    /** Force a re-check, ignoring the cache — licences do change. */
    revalidate: function (id) {
      delete infoCache[id];
      delete reportCache[id];
      return Search.verify(id, true);
    },

    report: function (id) { return reportCache[id] || null; },
    info: function (id) { return infoCache[id] || null; },

    clearCache: function () {
      Object.keys(infoCache).forEach(function (k) { delete infoCache[k]; });
      Object.keys(reportCache).forEach(function (k) { delete reportCache[k]; });
      searchCache.ids = {};
      searchCache.queries = {};
      try { if (cachePath) Paths.remove(cachePath); } catch (e) {}
    }
  };

  global.Search = Search;
})(window);
