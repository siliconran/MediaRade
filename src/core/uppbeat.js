/* =============================================================================
   uppbeat.js — Uppbeat (uppbeat.io) integration
   MediaRade by rad1x

   Uppbeat publishes no documented public API, so this client works two ways and
   is honest about which one is running:

   1. DIRECT mode (experimental)
      Talks to uppbeat.io's own JSON endpoints using a session imported from a
      browser you are already signed in to. Because the endpoints are
      undocumented they live in an editable map (Config.uppbeatEndpoints) — if
      Uppbeat changes their site, you repoint them in Setup instead of waiting
      for a patch. Search and per-track download only; there is deliberately no
      bulk catalogue harvester.

   2. ASSISTED mode (always works)
      Opens uppbeat.io in your browser so you download through the site exactly
      as Uppbeat intends, then watches your Downloads folder and ingests the new
      audio into the MediaRade library with the credit attached.

   MediaRade never handles an Uppbeat password. Signing in happens in your own
   browser; only the resulting session cookies are imported, and only for the
   uppbeat.io domain.

   LICENCE NOTE
   Free-plan downloads require the per-download "Uppbeat Credit" to be shown
   wherever the track is used — that credit is what tells YouTube the track is
   licensed. Paid plans widen catalogue access and download limits. MediaRade
   surfaces the credit for every download and writes it to the same attribution
   sidecar and CREDITS.md that the YouTube path uses.
   ========================================================================== */
import { CEP } from './cep.js';
import U from './util.js';
import Bus from './bus.js';
import Config from './config.js';
import Paths from './paths.js';
import Proc from './proc.js';
import YtDlp from './ytdlp.js';

const BASE = 'https://uppbeat.io';

/* Undocumented endpoints, overridable from Setup. `{q}`, `{id}`, `{page}` are
   substituted. Kept in one place so a site change is a settings edit. */
export const DEFAULT_ENDPOINTS = {
  search: '/api/v1/search/tracks?query={q}&page={page}&limit={limit}',
  track: '/api/v1/tracks/{id}',
  account: '/api/v1/me',
  download: '/api/v1/tracks/{id}/download'
};

/* --- session ------------------------------------------------------------- */

let session = { cookies: '', account: null, plan: 'free', signedIn: false, importedAt: null };

function endpoints() {
  const custom = Config.get('uppbeatEndpoints');
  return Object.assign({}, DEFAULT_ENDPOINTS, custom || {});
}

function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, function (_, k) {
    return encodeURIComponent(vars[k] === undefined ? '' : String(vars[k]));
  });
}

/* --- HTTP ---------------------------------------------------------------- */

/**
 * GET a URL with the imported Uppbeat session attached.
 * @returns {Promise<{status:number, headers:object, body:string}>}
 */
function httpGet(url, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    let https, urlmod;
    try { https = CEP.require('https'); urlmod = CEP.require('url'); }
    catch (e) { return reject(new Error('Node is unavailable in this panel, so Uppbeat cannot be reached.')); }

    const parsed = urlmod.parse(url);
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MediaRade/1.0',
      'Accept': opts.accept || 'application/json, text/plain, */*',
      'Accept-Language': 'en-GB,en;q=0.9',
      'Referer': BASE + '/'
    }, opts.headers || {});
    if (session.cookies) headers.Cookie = session.cookies;

    const req = https.get({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      path: parsed.path,
      headers: headers,
      timeout: opts.timeout || 25000
    }, function (res) {
      // follow redirects ourselves so cookies survive the hop
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (opts.depth || 0) < 5) {
        res.resume();
        const next = res.headers.location.indexOf('http') === 0
          ? res.headers.location
          : BASE + res.headers.location;
        return resolve(httpGet(next, Object.assign({}, opts, { depth: (opts.depth || 0) + 1 })));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      });
    });

    req.on('timeout', function () { req.destroy(new Error('Uppbeat timed out.')); });
    req.on('error', reject);
  });
}

/** Stream a URL to disk, reporting progress. Returns a cancellable promise. */
function httpDownload(url, destPath, onProgress, depth) {
  let request = null, canceled = false;

  const p = new Promise(function (resolve, reject) {
    let https, urlmod, fs;
    try { https = CEP.require('https'); urlmod = CEP.require('url'); fs = CEP.fs; }
    catch (e) { return reject(new Error('Node is unavailable in this panel.')); }

    const parsed = urlmod.parse(url);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MediaRade/1.0',
      'Accept': '*/*',
      'Referer': BASE + '/'
    };
    if (session.cookies) headers.Cookie = session.cookies;

    Paths.ensureDir(CEP.path.dirname(destPath));
    const tmp = destPath + '.part';

    request = https.get({
      protocol: parsed.protocol, hostname: parsed.hostname, path: parsed.path,
      headers: headers, timeout: 30000
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (depth || 0) < 5) {
        res.resume();
        const next = res.headers.location.indexOf('http') === 0 ? res.headers.location : BASE + res.headers.location;
        const inner = httpDownload(next, destPath, onProgress, (depth || 0) + 1);
        request = { destroy: inner.cancel };
        return inner.then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(explainStatus(res.statusCode, 'download')));
      }

      const total = parseInt(res.headers['content-length'], 10) || null;
      let got = 0;
      const out = fs.createWriteStream(tmp);

      res.on('data', function (chunk) {
        got += chunk.length;
        if (onProgress) onProgress({ downloaded: got, total: total, percent: total ? (got / total) * 100 : null });
      });
      res.pipe(out);

      out.on('error', reject);
      out.on('finish', function () {
        out.close(function () {
          if (canceled) { Paths.remove(tmp); return reject(Object.assign(new Error('canceled'), { canceled: true })); }
          try { fs.renameSync(tmp, destPath); } catch (e) { return reject(e); }
          resolve({ file: destPath, bytes: got });
        });
      });
    });

    request.on('timeout', function () { request.destroy(new Error('Uppbeat timed out.')); });
    request.on('error', function (e) {
      Paths.remove(tmp);
      reject(canceled ? Object.assign(new Error('canceled'), { canceled: true }) : e);
    });
  });

  p.cancel = function () { canceled = true; if (request && request.destroy) try { request.destroy(); } catch (e) {} };
  return p;
}

function explainStatus(status, what) {
  if (status === 401 || status === 403) {
    return 'Uppbeat refused the request (' + status + '). Your session is missing or expired — sign in ' +
           'at uppbeat.io in your browser, then hit "Import session" in Setup.';
  }
  if (status === 402) return 'This track needs a paid Uppbeat plan your account does not have.';
  if (status === 404) return 'Uppbeat returned 404 for the ' + what + ' endpoint. Their API path has probably changed — update it in Setup › Uppbeat.';
  if (status === 429) return 'Uppbeat is rate-limiting you. Wait a few minutes.';
  return 'Uppbeat returned HTTP ' + status + ' for the ' + what + ' request.';
}

/* --- normalisation --------------------------------------------------------
   Uppbeat's payload shape is not contractual, so pull fields defensively. */

function pick(obj, names) {
  for (let i = 0; i < names.length; i++) {
    const parts = names[i].split('.');
    let v = obj;
    for (let j = 0; j < parts.length && v != null; j++) v = v[parts[j]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function normalizeTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const id = pick(t, ['id', 'trackId', 'uuid', 'slug']);
  if (!id) return null;
  const slug = pick(t, ['slug', 'permalink', 'url']);
  const artist = pick(t, ['artist.name', 'artist', 'artistName', 'author.name']) || 'Unknown artist';
  return {
    id: String(id),
    slug: slug ? String(slug) : null,
    title: String(pick(t, ['title', 'name']) || 'Untitled'),
    artist: String(artist),
    artistSlug: pick(t, ['artist.slug', 'artistSlug']),
    duration: Number(pick(t, ['duration', 'length', 'durationSeconds'])) || null,
    bpm: pick(t, ['bpm', 'tempo']),
    genres: [].concat(pick(t, ['genres', 'genre']) || []).map(function (g) {
      return typeof g === 'string' ? g : (g && (g.name || g.title)) || '';
    }).filter(Boolean),
    moods: [].concat(pick(t, ['moods', 'mood']) || []).map(function (m) {
      return typeof m === 'string' ? m : (m && (m.name || m.title)) || '';
    }).filter(Boolean),
    premium: !!(pick(t, ['isPremium', 'premium', 'requiresSubscription'])),
    preview: pick(t, ['previewUrl', 'preview', 'audioUrl', 'mp3', 'streamUrl', 'file.preview']),
    artwork: pick(t, ['artwork', 'image', 'imageUrl', 'artist.image', 'cover']),
    page: slug ? (String(slug).indexOf('http') === 0 ? String(slug) : BASE + '/track/' + slug) : BASE,
    raw: t
  };
}

/** Dig a track array out of whatever envelope the response used. */
function extractTracks(json) {
  if (!json) return [];
  const candidates = [json.tracks, json.results, json.data, json.items, json.hits,
                      json.data && json.data.tracks, json.results && json.results.tracks];
  for (let i = 0; i < candidates.length; i++) {
    if (Array.isArray(candidates[i])) {
      return candidates[i].map(normalizeTrack).filter(Boolean);
    }
  }
  if (Array.isArray(json)) return json.map(normalizeTrack).filter(Boolean);
  return [];
}

/* ========================================================================= */

export const Uppbeat = {
  BASE: BASE,
  DEFAULT_ENDPOINTS: DEFAULT_ENDPOINTS,

  /* --- session ----------------------------------------------------------- */

  session: function () { return session; },

  loadSession: function () {
    const stored = Config.get('uppbeatSession');
    if (stored && stored.cookies) {
      session = Object.assign({ plan: 'free', signedIn: true }, stored);
    }
    return session;
  },

  saveSession: function () {
    Config.set('uppbeatSession', {
      cookies: session.cookies,
      account: session.account,
      plan: session.plan,
      signedIn: session.signedIn,
      importedAt: session.importedAt
    });
    Bus.emit('uppbeat:session', session);
    return session;
  },

  clearSession: function () {
    session = { cookies: '', account: null, plan: 'free', signedIn: false, importedAt: null };
    Uppbeat.saveSession();
    return session;
  },

  isPremium: function () {
    const p = String(session.plan || 'free').toLowerCase();
    return session.signedIn && p !== 'free' && p !== 'none';
  },

  /** Open Uppbeat's sign-in page in the real browser. No password ever reaches MediaRade. */
  openSignIn: function () {
    CEP.openInBrowser(BASE + '/sign-in');
  },

  /**
   * The whole sign-in journey, hands-off after the click:
   * open uppbeat.io in the real browser, then keep trying to import the
   * session until the cookies appear. MediaRade never sees the password —
   * the browser does the authenticating, we only pick up the result.
   *
   * @param {function} onTick  (attempt, max) progress callback
   * @returns {Promise<object>} the live session; rejects if it never arrives
   */
  signIn: function (onTick) {
    const browser = Config.get('uppbeatBrowser') || 'chrome';
    const max = Config.get('uppbeatSignInTries') || 40;      // ~3.5 minutes
    const gap = 5000;

    Uppbeat.openSignIn();

    let cancelled = false;

    const run = new Promise(function (resolve, reject) {
      let attempt = 0;

      function tick() {
        if (cancelled) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
        attempt++;
        if (onTick) { try { onTick(attempt, max); } catch (e) {} }

        Uppbeat.importSession(browser).then(function (s) {
          if (cancelled) return;
          if (s && s.signedIn && s.cookies) return resolve(s);
          retry();
        }).catch(function () {
          retry();
        });
      }

      function retry() {
        if (cancelled) return;
        if (attempt >= max) {
          return reject(new Error(
            'Timed out waiting for the ' + browser + ' session. Sign in at uppbeat.io in ' + browser +
            ', then press Sign in again. If ' + browser + ' is not the browser you use, change it in Setup › Uppbeat.'));
        }
        setTimeout(tick, gap);
      }

      // give the browser a moment to open and the user a moment to type
      setTimeout(tick, 4000);
    });

    run.cancel = function () { cancelled = true; };
    return run;
  },

  openSite: function (path) {
    CEP.openInBrowser(BASE + (path || ''));
  },

  /**
   * Import the uppbeat.io session from a browser you are already signed in to.
   * yt-dlp does the cookie decryption (it already ships with MediaRade), then we
   * keep only uppbeat.io cookies — nothing from any other site is retained.
   */
  importSession: function (browser) {
    browser = browser || Config.get('uppbeatBrowser') || Config.get('cookiesFromBrowser') || 'chrome';
    if (!YtDlp.ready()) {
      return Promise.reject(new Error('yt-dlp is required to read browser cookies. Set it up first in Setup › Tooling.'));
    }

    const jar = CEP.path.join(Paths.dir('cache'), 'uppbeat-cookies.txt');
    Paths.remove(jar);

    const args = ['--cookies-from-browser', browser, '--cookies', jar,
                  '--skip-download', '--ignore-errors', '--no-warnings', '--ignore-config',
                  BASE + '/'];

    return Proc.run(YtDlp.ytdlp, args, { timeout: 90000 }).then(function (r) {
      if (!Paths.exists(jar)) {
        const hint = /could not (find|copy)|permission|locked|DPAPI/i.test(r.stderr || '')
          ? ' Close ' + browser + ' completely and try again — Windows locks the cookie database while it is running.'
          : '';
        throw new Error('Could not read cookies from ' + browser + '.' + hint);
      }

      const cookies = Uppbeat.parseJar(Paths.read(jar, ''));
      Paths.remove(jar);   // never keep a full cookie jar on disk

      if (!cookies) {
        throw new Error('No uppbeat.io cookies were found in ' + browser +
                        '. Sign in at uppbeat.io in that browser first, then import again.');
      }

      session.cookies = cookies;
      session.signedIn = true;
      session.importedAt = Date.now();
      Uppbeat.saveSession();
      Paths.log('uppbeat: session imported from ' + browser);

      return Uppbeat.me().catch(function () { return session; });
    });
  },

  /** Netscape cookie jar -> "k=v; k=v" for uppbeat.io only. */
  parseJar: function (text) {
    if (!text) return '';
    const out = [];
    String(text).split(/\r?\n/).forEach(function (line) {
      if (!line || line.charAt(0) === '#') return;
      const f = line.split('\t');
      if (f.length < 7) return;
      const domain = f[0].replace(/^\./, '').toLowerCase();
      if (domain !== 'uppbeat.io' && domain.indexOf('.uppbeat.io') === -1 &&
          !/(^|\.)uppbeat\.io$/.test(domain)) return;
      const name = f[5], value = f[6];
      if (!name) return;
      out.push(name + '=' + value);
    });
    return out.join('; ');
  },

  /** Paste-a-cookie-string escape hatch when browser import is not possible. */
  setCookiesManually: function (raw) {
    const clean = String(raw || '').trim().replace(/^Cookie:\s*/i, '');
    if (!clean) throw new Error('Nothing to set.');
    session.cookies = clean;
    session.signedIn = true;
    session.importedAt = Date.now();
    Uppbeat.saveSession();
    return Uppbeat.me().catch(function () { return session; });
  },

  /* --- API ---------------------------------------------------------------- */

  json: function (path, what) {
    const url = path.indexOf('http') === 0 ? path : BASE + path;
    return httpGet(url).then(function (res) {
      if (res.status !== 200) throw new Error(explainStatus(res.status, what || 'API'));
      let json;
      try { json = JSON.parse(res.body); }
      catch (e) {
        throw new Error('Uppbeat returned HTML rather than JSON for the ' + (what || 'API') +
                        ' request. The endpoint has moved — update it in Setup › Uppbeat, or use Assisted mode.');
      }
      return json;
    });
  },

  /** Account + plan. Used to decide whether the credit banner is mandatory. */
  me: function () {
    return Uppbeat.json(endpoints().account, 'account').then(function (json) {
      const acct = json && (json.user || json.data || json);
      session.account = {
        email: pick(acct, ['email', 'user.email']),
        name: pick(acct, ['name', 'displayName', 'username', 'firstName'])
      };
      const plan = pick(acct, ['plan.name', 'plan', 'subscription.plan', 'subscription.name',
                               'tier', 'membership', 'subscriptionStatus']);
      session.plan = plan ? String(plan).toLowerCase() : 'free';
      session.signedIn = true;
      Uppbeat.saveSession();
      return session;
    });
  },

  /**
   * Search the catalogue.
   * @param {string} query
   * @param {object} opts { page, limit, genre, mood }
   */
  search: function (query, opts) {
    opts = opts || {};
    const ep = endpoints();
    let path = fill(ep.search, {
      q: query || '',
      page: opts.page || 1,
      limit: opts.limit || Config.get('uppbeatResultCount') || 30
    });
    if (opts.genre) path += '&genre=' + encodeURIComponent(opts.genre);
    if (opts.mood) path += '&mood=' + encodeURIComponent(opts.mood);

    return Uppbeat.json(path, 'search').then(function (json) {
      const tracks = extractTracks(json);
      if (!tracks.length && !Array.isArray(json)) {
        Paths.log('uppbeat: search returned an unrecognised shape — ' + U.truncate(JSON.stringify(json), 400));
      }
      return tracks;
    });
  },

  track: function (id) {
    return Uppbeat.json(fill(endpoints().track, { id: id }), 'track').then(function (json) {
      return normalizeTrack(json && (json.track || json.data || json)) ;
    });
  },

  /**
   * Resolve the actual audio URL for a track. Uppbeat gates this on the
   * account's plan, so a 402/403 here is the plan talking, not a bug.
   */
  resolveDownload: function (track) {
    return Uppbeat.json(fill(endpoints().download, { id: track.id }), 'download').then(function (json) {
      const url = pick(json, ['url', 'downloadUrl', 'download_url', 'data.url', 'file', 'signedUrl']);
      if (!url) throw new Error('Uppbeat did not return a download URL for this track. Your plan may not cover it.');
      return String(url);
    });
  },

  /**
   * Download one track into Documents\MediaRade\Downloads\Audio\Uppbeat.
   * Returns a cancellable promise -> { file, bytes, track, credit }.
   */
  download: function (track, onProgress) {
    const dir = CEP.path.join(Paths.dir('audio'), 'Uppbeat');
    const name = U.slug(track.artist + ' - ' + track.title) + '.mp3';
    const dest = Paths.unique(CEP.path.join(dir, name));

    let inner = null;
    const p = Uppbeat.resolveDownload(track).then(function (url) {
      inner = httpDownload(url, dest, onProgress);
      return inner;
    }).then(function (res) {
      return Object.assign({ track: track, credit: Uppbeat.credit(track) }, res);
    });

    p.cancel = function () { if (inner && inner.cancel) inner.cancel(); };
    return p;
  },

  /* --- attribution --------------------------------------------------------- */

  /**
   * The credit block. Free-plan downloads must show this wherever the track is
   * used; it is what tells YouTube the track is licensed.
   */
  credit: function (track) {
    const page = track.page || BASE;
    const plain = 'Music from Uppbeat: ' + page + '\n' +
                  'Track: "' + track.title + '" by ' + track.artist + '\n' +
                  'License code: ' + (track.licenseCode || 'see your Uppbeat download page');

    const short = '"' + track.title + '" by ' + track.artist + ' — Music from Uppbeat (' + page + ')';

    const html = 'Music from <a href="' + U.esc(BASE) + '">Uppbeat</a>: &ldquo;' + U.esc(track.title) +
                 '&rdquo; by ' + U.esc(track.artist);

    return {
      title: track.title,
      author: track.artist,
      source: page,
      channelUrl: track.artistSlug ? BASE + '/artist/' + track.artistSlug : BASE,
      license: Uppbeat.isPremium() ? 'Uppbeat (paid plan)' : 'Uppbeat (free plan — credit required)',
      licenseUrl: BASE + '/user-agreement',
      plain: plain,
      short: short,
      html: html,
      credits: plain,
      marker: 'Uppbeat — ' + track.title + ' — ' + track.artist + ' — ' + page,
      required: !Uppbeat.isPremium()
    };
  },

  /**
   * A MediaRade licence report for an Uppbeat track, in the same shape the
   * YouTube risk checker produces so the rest of the app needs no special case.
   */
  report: function (track) {
    const premium = Uppbeat.isPremium();
    const credit = Uppbeat.credit(track);

    const signals = [
      { severity: 'pos', id: 'uppbeat.source', label: 'Licensed library source',
        detail: 'Uppbeat pre-clears every track with its artists, so there is no Content ID ambiguity to audit.',
        evidence: track.page },
      premium
        ? { severity: 'pos', id: 'uppbeat.plan', label: 'Paid Uppbeat plan',
            detail: 'Your account covers this download. Keep the record — plan terms decide where you may publish.',
            evidence: session.plan }
        : { severity: 'warn', id: 'uppbeat.credit', label: 'Credit is mandatory on the free plan',
            detail: 'Free-plan downloads must show the Uppbeat credit wherever the track is used. Without it the ' +
                    'track is not licensed for your video and a claim can still land.',
            evidence: credit.short }
    ];

    return {
      level: premium ? 'LOW' : 'MODERATE',
      levelInfo: premium
        ? { key: 'LOW', tone: 'ok', seal: '✓', title: 'LOW RISK — Uppbeat paid plan',
            line: 'Pre-cleared library track covered by your Uppbeat plan. Keep the record and respect your plan\'s scope.' }
        : { key: 'MODERATE', tone: 'warn', seal: '!', title: 'CREDIT REQUIRED — Uppbeat free plan',
            line: 'Pre-cleared library track, but the free plan licenses it <b>only</b> while the Uppbeat credit is ' +
                  'displayed wherever it is used. Copy the credit below into your video description.' },
      score: premium ? 8 : 30,
      verified: true,
      source: {
        id: track.id, title: track.title, channel: track.artist,
        channelUrl: credit.channelUrl, url: track.page, provider: 'uppbeat'
      },
      provider: 'uppbeat',
      licenseField: credit.license,
      contentId: false,
      requiresAttribution: !premium,
      attribution: credit,
      constraints: {
        commercialUse: premium ? 'yes' : 'restricted',
        modification: 'yes',
        attributionRequired: !premium
      },
      technical: { platformLicense: credit.license, contentIdSignals: [] },
      audit: { statedLicense: credit.license, monetizationTraps: [], derivativeFlags: [] },
      claims: [],
      signals: signals,
      obligations: premium ? [
        { key: 'Plan scope', text: 'Your plan defines where the track may be published. Check before using it in paid ads or for a client.' }
      ] : [
        { key: 'Credit', text: 'Paste the Uppbeat credit into the description of every video the track appears in. This is what licenses it.' },
        { key: 'Per-track', text: 'Each track needs its own credit, in every video it features in.' }
      ],
      counts: { crit: 0, warn: premium ? 0 : 1, pos: premium ? 2 : 1 },
      verdict: {
        level: premium ? 'LOW' : 'MODERATE',
        text: premium
          ? 'Cleared by your Uppbeat plan. Keep the .license.json record with the project.'
          : 'Cleared for use ONLY with the Uppbeat credit displayed. Copy it into your video description before publishing — ' +
            'without it the licence does not apply and YouTube can still claim the track.'
      },
      gate: { clean: true, allow: true, requireAck: false, hard: false, overridable: false, reasons: [] },
      checkedAt: new Date().toISOString()
    };
  },

  /* --- assisted mode -------------------------------------------------------
     Watch the browser's download folder and ingest new audio that appears
     while the user downloads from uppbeat.io in the normal way.              */

  watchDir: function () {
    const custom = Config.get('uppbeatWatchDir');
    if (custom) return custom;
    try { return CEP.path.join(CEP.os.homedir(), 'Downloads'); } catch (e) { return null; }
  },

  /** Audio files in the watch folder newer than `since` (ms epoch). */
  scanNew: function (since) {
    const dir = Uppbeat.watchDir();
    if (!dir || !Paths.exists(dir)) return [];
    let names = [];
    try { names = CEP.fs.readdirSync(dir); } catch (e) { return []; }

    const out = [];
    names.forEach(function (n) {
      if (!/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(n)) return;
      const full = CEP.path.join(dir, n);
      const st = Paths.stat(full);
      if (!st || !st.isFile()) return;
      if (since && st.mtimeMs < since) return;
      out.push({ file: full, name: n, size: st.size, mtime: st.mtimeMs });
    });
    out.sort(function (a, b) { return b.mtime - a.mtime; });
    return out;
  },

  /**
   * Move a file the browser downloaded into the MediaRade library.
   * `meta` supplies the title/artist the user confirmed, so the credit is real
   * rather than guessed from a filename.
   */
  ingest: function (filePath, meta) {
    meta = meta || {};
    const dir = CEP.path.join(Paths.dir('audio'), 'Uppbeat');
    Paths.ensureDir(dir);

    const guess = Uppbeat.guessFromFilename(CEP.path.basename(filePath));
    const track = {
      id: meta.id || ('local_' + U.uid('ub')),
      title: meta.title || guess.title,
      artist: meta.artist || guess.artist,
      page: meta.page || BASE,
      artistSlug: meta.artistSlug || null,
      duration: meta.duration || null
    };

    const ext = CEP.path.extname(filePath) || '.mp3';
    const dest = Paths.unique(CEP.path.join(dir, U.slug(track.artist + ' - ' + track.title) + ext));

    try { CEP.fs.renameSync(filePath, dest); }
    catch (e) {
      // cross-volume move, or the browser still has it open
      try { CEP.fs.copyFileSync(filePath, dest); } catch (e2) {
        throw new Error('Could not move the file into the MediaRade library: ' + e2.message);
      }
    }

    return { file: dest, track: track, credit: Uppbeat.credit(track), report: Uppbeat.report(track) };
  },

  /** "Artist - Title.mp3" / "Title (Artist).mp3" -> best-effort split. */
  guessFromFilename: function (name) {
    const base = String(name).replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim();
    const dash = base.split(/\s+-\s+/);
    if (dash.length >= 2) return { artist: dash[0].trim(), title: dash.slice(1).join(' - ').trim() };
    const paren = base.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (paren) return { artist: paren[2].trim(), title: paren[1].trim() };
    return { artist: 'Unknown artist', title: base || 'Untitled' };
  }
};

export default Uppbeat;
