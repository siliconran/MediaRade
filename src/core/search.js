/* =============================================================================
   search.js — search orchestration + the verification pipeline
   MediaRade by siliconran

   Two stages, deliberately:
     1. flat listing  — fast, but carries NO licence field
     2. verification  — full metadata per hit, which is the only thing that can
                        produce a licence verdict
   The UI never shows a green badge from stage 1.
   ========================================================================== */
import U from './util.js';
import Bus from './bus.js';
import Paths from './paths.js';
import Config from './config.js';
import License from './license.js';
import SP from './sp.js';
import YtDlp from './ytdlp.js';

const infoCache = {};      // videoId -> full yt-dlp info dict
const reportCache = {};    // videoId -> licence report
let currentRun = 0;

/* --- disk-backed verification cache ----------------------------------------
   Full metadata fetches are the slow part of a licence check (a yt-dlp spawn +
   a network round trip each). Verified verdicts and a slim slice of the info
   dict are persisted to Cache\license-cache.json, so re-opening a video or
   re-searching the same results is instant and only genuinely new/expired
   videos hit the network. Only the most recently checked are kept.         */
let licenseCachePath = null;
const MAX_LICENSE_CACHE = 600;
let persistTimer = null;

/* --- disk-backed result cache (title + thumbnail) -------------------------
   Re-running a query renders the cached page instantly, then refreshes it
   from YouTube. The cache also stands in for missing fields when a flat
   search entry arrives with an empty title or thumbnail.                  */
let cachePath = null;
const searchCache = { version: 1, ids: {}, queries: {}, maxIds: 2000, maxQueries: 300 };

export const Search = {
  infoCache: infoCache,
  reportCache: reportCache,

  /** Load the on-disk result cache. Called once at boot, after Paths. */
  init: function () {
    try {
      cachePath = Paths.file('searchCache');
      const raw = Paths.readJSON(cachePath, null);
      if (raw && raw.version === 1 && raw.ids) {
        searchCache.ids = raw.ids;
        searchCache.queries = raw.queries || {};
      }
    } catch (e) { console.warn('[MediaRade] search cache load failed:', e); }

    /* verified verdicts + slim info, so prior checks are instant */
    try {
      licenseCachePath = Paths.file('licenseCache');
      const lc = Paths.readJSON(licenseCachePath, null);
      if (lc && lc.reports) Object.assign(reportCache, lc.reports);
      if (lc && lc.info) Object.assign(infoCache, lc.info);
    } catch (e) { console.warn('[MediaRade] license cache load failed:', e); }

    return searchCache;
  },

  /** Strip a full yt-dlp dict down to the fields the UI and evaluator use. */
  slimInfo: function (info) {
    if (!info) return null;
    const out = { id: info.id };
    ['title', 'channel', 'uploader', 'channel_url', 'uploader_url', 'description',
     'license', 'tags', 'track', 'artist', 'album', 'music_sharing_info',
     'licensed_to_youtube', 'channel_is_verified', 'age_limit', 'availability',
     'is_live', 'was_live', 'webpage_url', 'upload_date', 'duration',
     'view_count', 'width', 'height', 'fps', 'categories']
      .forEach(function (k) { if (info[k] !== undefined) out[k] = info[k]; });
    return out;
  },

  /** Debounced write of the most recently verified videos. */
  persist: function () {
    if (!licenseCachePath) return;
    if (persistTimer) { clearTimeout(persistTimer); }
    persistTimer = setTimeout(function () {
      persistTimer = null;
      try {
        const ids = Object.keys(reportCache).sort(function (a, b) {
          const ra = reportCache[a], rb = reportCache[b];
          return String((rb && rb.checkedAt) || '').localeCompare(String((ra && ra.checkedAt) || ''));
        }).slice(0, MAX_LICENSE_CACHE);
        const info = {}, reports = {};
        ids.forEach(function (id) {
          reports[id] = reportCache[id];
          const i = infoCache[id];
          if (i) info[id] = Search.slimInfo(i);
        });
        Paths.writeJSON(licenseCachePath, { info: info, reports: reports });
      } catch (e) { console.warn('[MediaRade] license cache save failed:', e); }
    }, 1200);
  },

  /** Deterministic key for a query + the filter subset that shapes it. */
  queryKey: function (query, filters) {
    const f = filters || {};
    return String(query).trim().toLowerCase() + '|' +
      (f.sort || 'relevance') + '|' + (f.uploaded || 'any') + '|' +
      (f.duration || 'any') + '|' + ((f.features && f.features.creativeCommons) ? 'cc' : '');
  },

  /** Rebuild a result row purely from the cache. */
  cached: function (id) {
    const c = searchCache.ids[id];
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
    const now = Date.now();
    results.forEach(function (r) {
      const prev = searchCache.ids[r.id];
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
    let ids = Object.keys(searchCache.ids);
    if (ids.length > searchCache.maxIds) {
      ids.sort(function (a, b) { return (searchCache.ids[a].cachedAt || 0) - (searchCache.ids[b].cachedAt || 0); });
      ids.slice(0, ids.length - searchCache.maxIds).forEach(function (k) { delete searchCache.ids[k]; });
    }
    let qk = Object.keys(searchCache.queries);
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
    const id = e.id;
    const c = searchCache.ids[id];
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
    const run = ++currentRun;
    query = String(query || '').trim();
    if (!query) return Promise.resolve([]);

    /* if this exact query was run before, paint the cached page immediately
       and let the live search refresh it — instant titles and thumbnails */
    let cached = [];
    const qc = searchCache.queries[Search.queryKey(query, filters)];
    if (qc && qc.ids && qc.ids.length) cached = qc.ids.map(Search.cached).filter(Boolean);
    Bus.patch({ searching: !cached.length, searchError: null, results: cached, query: query }, 'search');

    /* a pasted URL or ID skips search entirely */
    const direct = U.videoId(query);
    let task;
    if (direct) {
      task = Search.fetchInfo(direct).then(function (info) {
        return [Search.normalize(Object.assign({}, info, { id: direct }))];
      });
    } else if (/^https?:\/\//i.test(query)) {
      task = YtDlp.search(query, Config.get('resultCount'), query).then(function (entries) {
        return entries.map(Search.normalize);
      });
    } else {
      const url = SP.url(query, {
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

  /* --- channels -----------------------------------------------------------
     Two different things live here. `channels` finds channels for a query
     (YouTube's own search with the channel type filter). `channelVideos`
     lists what one channel has uploaded, by pointing yt-dlp at its /videos
     tab — a flat-playlist read, so it is one call rather than one per video.
     ---------------------------------------------------------------------- */

  /** Normalise a channel row out of yt-dlp's flat-playlist shape. */
  normalizeChannel: function (e) {
    if (!e) return null;
    const id = e.channel_id || e.uploader_id || e.id;
    if (!id) return null;
    const url = e.url || e.channel_url || e.uploader_url ||
      ('https://www.youtube.com/channel/' + id);
    return {
      id: String(id),
      name: String(e.channel || e.uploader || e.title || 'Unknown channel'),
      url: String(url),
      handle: e.uploader_id && String(e.uploader_id).charAt(0) === '@' ? String(e.uploader_id) : null,
      thumb: (e.thumbnails && e.thumbnails.length && e.thumbnails[e.thumbnails.length - 1].url) || '',
      subs: e.channel_follower_count || null,
      description: e.description || ''
    };
  },

  /** Search YouTube for channels matching a query. */
  channels: function (query, count) {
    query = String(query || '').trim();
    if (!query) return Promise.resolve([]);
    /* A pasted channel/handle URL is not a search — resolve it directly. */
    const direct = Search.channelUrl(query);
    if (direct) {
      return YtDlp.search(query, 1, direct).then(function (entries) {
        return entries.map(Search.normalizeChannel).filter(Boolean);
      });
    }
    const url = SP.url(query, { type: 'channel' });
    return YtDlp.search(query, count || Config.get('resultCount') || 25, url)
      .then(function (entries) {
        return entries.map(Search.normalizeChannel).filter(Boolean);
      });
  },

  /** Turn a pasted channel address into its /videos tab, or null. Accepts
      @handle, /channel/UC…, /c/name, /user/name and a bare @handle. */
  channelUrl: function (input) {
    const s = String(input || '').trim();
    if (!s) return null;
    if (/^@[\w.\-]+$/.test(s)) return 'https://www.youtube.com/' + s + '/videos';
    const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/((?:@[\w.\-]+)|(?:channel\/[\w\-]+)|(?:c\/[\w.\-]+)|(?:user\/[\w.\-]+))/i);
    if (!m) return null;
    return 'https://www.youtube.com/' + m[1].replace(/\/+$/, '') + '/videos';
  },

  /** Pick the squarest thumbnail as the avatar and the widest as the banner.
      yt-dlp returns both mixed together in one list, distinguishable only by
      aspect ratio — a channel avatar is square, a banner is ~6:1. */
  pickChannelArt: function (thumbs) {
    const list = (thumbs || []).filter(function (t) { return t && t.url; });
    let avatar = null, banner = null, avatarW = 0, widest = 0;
    list.forEach(function (t) {
      const w = Number(t.width) || 0, h = Number(t.height) || 0;
      if (!w || !h) return;
      const ratio = w / h;
      /* Among the square-ish ones take the LARGEST, not the most square:
         several are exactly 1:1, so "most square" just picked whichever came
         first and could hand a 176px image to a HiDPI avatar slot. */
      if (Math.abs(ratio - 1) < 0.15 && w > avatarW) { avatarW = w; avatar = t.url; }
      if (ratio > 3 && w > widest) { widest = w; banner = t.url; }
    });
    /* A channel with no square art still deserves something to show. */
    if (!avatar && list.length) avatar = list[0].url;
    return { avatar: avatar, banner: banner };
  },

  /**
   * A channel "page": the header AND its uploads in one read, so the panel can
   * show what YouTube shows — avatar, name, handle, subscriber count — above a
   * grid containing only that channel's videos.
   * @returns {Promise<{channel:object, videos:object[]}>}
   */
  channelPage: function (channel, count) {
    const raw = channel && typeof channel === 'object' ? (channel.url || channel.id) : channel;
    const url = Search.channelUrl(raw) ||
      (/^UC[\w\-]{20,}$/.test(String(raw || '')) ? 'https://www.youtube.com/channel/' + raw + '/videos' : null);
    if (!url) return Promise.reject(new Error('That does not look like a YouTube channel address.'));

    return YtDlp.playlistPage(url, count || Config.get('resultCount') || 25).then(function (json) {
      const art = Search.pickChannelArt(json.thumbnails);
      const name = json.channel || json.uploader || json.title || '';
      /* A channel's flat-playlist entries inherit the uploader from the page
         rather than carrying it themselves, so every card would otherwise show
         a blank channel name. Stamp it back on from the header. */
      const videos = (json.entries || []).map(function (e) {
        const row = Search.normalize(e);
        if (row && !row.channel && name) row.channel = name;
        return row;
      }).filter(Boolean);
      return {
        channel: {
          id: json.channel_id || json.id || '',
          name: json.channel || json.uploader || json.title || 'Unknown channel',
          handle: json.uploader_id && String(json.uploader_id).charAt(0) === '@'
            ? String(json.uploader_id) : null,
          url: json.channel_url || json.uploader_url || url.replace(/\/videos$/, ''),
          subs: json.channel_follower_count || null,
          verified: !!json.channel_is_verified,
          description: json.description || '',
          avatar: art.avatar,
          banner: art.banner,
          videoCount: json.playlist_count || null
        },
        videos: videos
      };
    });
  },

  /** List a channel's uploads. Accepts anything channelUrl understands, or a
      channel object from `channels`. */
  channelVideos: function (channel, count) {
    const raw = channel && typeof channel === 'object' ? (channel.url || channel.id) : channel;
    const url = Search.channelUrl(raw) ||
      (/^UC[\w\-]{20,}$/.test(String(raw || '')) ? 'https://www.youtube.com/channel/' + raw + '/videos' : null);
    if (!url) return Promise.reject(new Error('That does not look like a YouTube channel address.'));
    return YtDlp.search('', count || Config.get('resultCount') || 25, url)
      .then(function (entries) { return entries.map(Search.normalize); });
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
      const report = License.evaluate(info);
      reportCache[id] = report;
      Search.persist();
      Bus.emit('verified', id, report, info);
      Bus.updateResult(id, { report: report, verifying: false });
      return report;
    }).catch(function (err) {
      const report = License.evaluate({ id: id });
      report.error = err.message;
      reportCache[id] = report;
      Search.persist();
      Bus.emit('verified', id, report, null);
      Bus.updateResult(id, { report: report, verifying: false });
      return report;
    });
  },

  /** Verify a whole result page with bounded concurrency. */
  verifyAll: function (results, run) {
    const pending = results.filter(function (r) { return !reportCache[r.id]; });
    if (!pending.length) return Promise.resolve([]);

    pending.forEach(function (r) { r.verifying = true; });
    Bus.emit('verify:start', pending.length);

    let done = 0;
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
    try { if (licenseCachePath) Paths.remove(licenseCachePath); } catch (e) {}
  }
};

export default Search;
