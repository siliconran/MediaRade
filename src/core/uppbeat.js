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
/* The rebuilt (uppbeat-next) SPA serves its API from this origin, which is NOT
   behind the Vercel Security Checkpoint — plain Node reaches it directly. The
   account/plan state lives in /api/setup_frontend (top-level `auth_token`,
   `user`, `subscriptionData`). Search is a client-side Typesense multi-search. */
const API_BASE = 'https://prod-api.uppbeat.io';
/* The rebuilt SPA also serves waveform + download from this CDN origin. It
   authenticates with the same auth_token header and keys on the asset's own
   id (track_id / sfx_id), not the musicvine id. */
const CDN_BASE = 'https://api-v2-cdn.uppbeat.io';
const TYPESENSE_BASE = 'https://3feynu8vjgbqkl27p.a1.typesense.net';
const TYPESENSE_KEY = 'MqZdBn4VL8k7IqhuMKOSNuBxmU0isNLk';

/* Undocumented endpoints, overridable from Setup. `{q}`, `{id}`, `{page}` are
   substituted. Kept in one place so a site change is a settings edit. */
export const DEFAULT_ENDPOINTS = {
  search: '/api/v1/search/tracks?query={q}&page={page}&limit={limit}',
  track: '/api/v1/track/{id}',
  account: '/api/setup_frontend',
  /* Read straight out of Uppbeat's own bundle: the V2 client calls
     GET /api/v1/track/{id}/download with a `format` query param and gets back
     { url, licenseCode, licenseId, pageUrl }. SFX and motion assets have their
     own shapes. `{id}`, `{variantId}` are substituted. */
  download: 'https://api-v2-cdn.uppbeat.io/api/v1/track/{id}/download',
  downloadSfx: 'https://api-v2-cdn.uppbeat.io/api/v1/sfx/{id}/variants/{variantId}/download',
  downloadMotion: 'https://api-v2-cdn.uppbeat.io/api/v1/motion-graphics/{id}/download'
};

/* Empty string = yt-dlp is told the profile folder "behind" `firefox`-family
   browsers is resolved automatically; set a folder here (Setup › Uppbeat) to
   force it — the catch-all that makes any homebrew / portable install work. */
const BROWSER_PROFILE_KEY = 'uppbeatProfilePath';

/* ---------------------------------------------------------------------------
   Browser registry — the browsers we can copy cookies from.
   - chromium family (chrome/edge/brave/opera/vivaldi/chromium/whale): yt-dlp
     locates their store natively with `--cookies-from-browser <id>`.
   - firefox family (firefox and forks like r3dfox/LibreWolf/Waterfox share the
     same profile format): we hand yt-dlp `--cookies-from-browser firefox[:<root>]`
     where <root> is the folder holding `profiles.ini`. Each fork lists its known
     install roots; a user profile path in Setup overrides auto-resolution for
     portable / unusual installs.
   Chrome & Edge (v127+) encrypt their own cookie stores with App-Bound
   Encryption, so yt-dlp cannot decrypt them while the browser is running — the
   fallback chain drops onto whichever Firefox-family browser is installed.
   ------------------------------------------------------------------------ */
export const BROWSERS = [
  { id: 'firefox',    label: 'Firefox',   family: 'fox', roots: ['%APPDATA%\\Mozilla\\Firefox'] },
  { id: 'r3dfox',     label: 'r3dfox',    family: 'fox', roots: ['%APPDATA%\\r3dfox', '%LOCALAPPDATA%\\r3dfox'] },
  { id: 'librewolf',  label: 'LibreWolf', family: 'fox', roots: ['%APPDATA%\\librewolf\\Profiles', '%LOCALAPPDATA%\\librewolf\\Profiles'] },
  { id: 'waterfox',   label: 'Waterfox',  family: 'fox', roots: ['%APPDATA%\\Waterfox\\Profiles'] },
  { id: 'chrome',     label: 'Chrome',    family: 'chromium',
    roots: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data'] },
  { id: 'edge',       label: 'Edge',      family: 'chromium',
    roots: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data'] },
  { id: 'brave',      label: 'Brave',     family: 'chromium',
    roots: ['%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data'] },
  { id: 'opera',      label: 'Opera',     family: 'chromium',
    roots: ['%APPDATA%\\Opera Software\\Opera Stable'] },
  { id: 'vivaldi',    label: 'Vivaldi',   family: 'chromium',
    roots: ['%LOCALAPPDATA%\\Vivaldi\\User Data'] },
  { id: 'chromium',   label: 'Chromium',  family: 'chromium',
    roots: ['%LOCALAPPDATA%\\Chromium\\User Data'] },
  { id: 'whale',      label: 'Whale',     family: 'chromium',
    roots: ['%LOCALAPPDATA%\\Naver\\Naver Whale\\User Data', '%LOCALAPPDATA%\\Naver\\Naver\\User Data'] }
];

export const BROWSER_IDS = BROWSERS.map(function (b) { return b.id; });

function envDirs() {
  let h = null;
  try { h = CEP.os.homedir(); } catch (e) { return null; }
  if (!h) return null;
  return { appdata: h + '\\AppData\\Roaming', localappdata: h + '\\AppData\\Local' };
}

function expand(p) {
  const d = envDirs();
  if (!d) return null;
  return p.replace('%APPDATA%', d.appdata).replace('%LOCALAPPDATA%', d.localappdata);
}

function browserMeta(b) {
  for (let i = 0; i < BROWSERS.length; i++) {
    if (BROWSERS[i].id === b) return BROWSERS[i];
  }
  return null;
}

/** True if the browser's profile data (or a forced profile path) is present. */
function browserInstalled(b) {
  const m = browserMeta(b);
  if (!m) return false;
  if (Config.get(BROWSER_PROFILE_KEY)) return true;
  const list = m.roots || [];
  for (let i = 0; i < list.length; i++) {
    const p = expand(list[i]);
    if (p && Paths.exists(p)) return true;
  }
  return false;
}

/** Resolve the folder holding `profiles.ini` for a Firefox-family browser,
    or the one the user forced in Setup. Null when it cannot be found. */
function foxRoot(id) {
  const forced = Config.get(BROWSER_PROFILE_KEY);
  if (forced && Paths.exists(forced)) return forced;
  const m = browserMeta(id);
  if (!m) return null;
  const list = m.roots || [];
  for (let i = 0; i < list.length; i++) {
    const root = expand(list[i]);
    if (!root || !Paths.exists(root)) continue;
    if (Paths.exists(root + '\\profiles.ini')) return root;
    if (Paths.exists(root + '\\Profiles\\profiles.ini')) return root + '\\Profiles';
    if (Paths.exists(root + '\\Profiles')) return root + '\\Profiles';
  }
  return null;
}

/** The `--cookies-from-browser` value for a browser id (null = unresolvable). */
function cookiesArg(id) {
  const m = browserMeta(id);
  if (!m) return id;
  if (m.family === 'chromium') return id;
  const root = foxRoot(id);
  if (!root) return id === 'firefox' ? 'firefox' : null;
  return 'firefox:' + root;
}

export { browserInstalled, foxRoot, cookiesArg };

/* --- session ------------------------------------------------------------- */

/* Uppbeat authenticates the two APIs with TWO different credentials that the
   user pastes/imports separately:
     - authToken          -> the account API (prod-api setup_frontend). Uppbeat
       echoes whatever `auth_token` cookie/header it is handed, and the account
       reads it for is_authenticated. This is the "who am I / what plan" token.
     - authorizationToken -> the download API (api-v2-cdn). It is the JWT the
       CDN accepts as `Authorization: Bearer` (or an `authorization_token`
       cookie). A session that can sign in but holds only an auth_token cannot
       download — they are genuinely different credentials.
   `cookies` stays as the full jar for the browser-style calls; the two token
   fields are what each API actually keys on. Both the API/cookie import path
   and the manual email+password path populate them. */
let session = { cookies: '', token: '', authToken: '', authorizationToken: '',
  account: null, plan: 'free', signedIn: false, importedAt: null };

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

/* Every app request should look like it originates from Uppbeat's own in-site
   SPA. If it doesn't, Uppbeat anti-bot flags it: search comes back 429
   ("rate-limited") and /me silently fails, so the plan reads "free" on a paid
   account. A realistic User-Agent + AJAX/origin headers keeps us under the
   radar, and the XSRF cookie is reflected back the way Laravel expects. */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** True for the V2 asset API (download/waveform). Its own client, read out of
    Uppbeat's bundle, is `axios.create({ withCredentials: true })` — cookies and
    nothing else. It has no Authorization/X-Auth-Token handling, and any
    unrecognised credential makes it 500 instead of 401, so sending our legacy
    token there is worse than sending nothing. */
function isV2Host(url) {
  return /^https?:\/\/api-v2-cdn\.uppbeat\.io/i.test(String(url || ''));
}

function sessionHeaders(extra, url) {
  const h = Object.assign({
    'User-Agent': BROWSER_UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': BASE,
    'Referer': BASE + '/',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache'
  }, extra || {});
  if (session.cookies) {
    h.Cookie = session.cookies;
    const xsrf = session.cookies.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/i);
    if (xsrf) h['X-XSRF-TOKEN'] = decodeURIComponent(xsrf[1]);
    if (isV2Host(url)) {
      /* The download API accepts the `authorization_token` (or a pasted auth
         JWT) as `Authorization: Bearer` — verified on the wire: Bearer <jwt>
         returns 200 with a real signed download URL. The auth_token COOKIE is
         ignored by it (answers 401), so the credential is sent as a Bearer
         header rather than relying on the jar to carry the right cookie. */
      /* ONLY the download credential — never fall back to auth_token here.
         Measured: this API answers a clean 401 when no credential is presented,
         but 500 for any credential it rejects, and the opaque auth_token is
         always rejected. Falling back to it would turn "not authorised" into a
         server error and send us right back to chasing a phantom 500. */
      const v = session.authorizationToken || '';
      if (v) {
        h['Authorization'] = 'Bearer ' + v;
        h['X-Authorization-Token'] = v;
      }
      return h;
    }
    /* The SPA authenticates to prod-api by reading the `auth_token` COOKIE and
       echoing it as the X-Auth-Token header (confirmed on the wire). Only
       auth_token — `authorization_token` belongs to the V2 API and is a
       different value, so it must not be substituted here. */
    const v = session.authToken || session.token || '';
    if (v) {
      h['Authorization'] = 'Bearer ' + v;
      h['X-Authorization-Token'] = v;
      h['X-Auth-Token'] = v;
    }
  }
  return h;
}

/** Can this session carry the V2 download credential?

    The download API answers 401 to the `auth_token` cookie and 200 to a JWT
    sent as `Authorization: Bearer`. `syncTokenFields` derives the download
    credential from either the `authorization_token` cookie or a JWT auth_token
    (which Uppbeat also accepts for downloads), so a jar that resolves to a
    download credential is attemptable; one that resolves to nothing is not. */
function canAttemptDownload() {
  return !!session.authorizationToken;
}

/** How much life is left in the download credential.

    Uppbeat's `authorization_token` is a JWT with a TWENTY MINUTE lifetime
    (measured: iat 05:47:33 -> exp 06:07:33). A pasted one is therefore stale
    within the hour, and an expired one answers
    `401 WWW-Authenticate: Bearer error="invalid_token"` with an empty body —
    indistinguishable, to a user, from "your whole session is broken". Since the
    token says its own expiry, read it locally and be specific instead.

    Returns { exp, expired, minutes } or null when there is no decodable JWT
    (an opaque credential is not necessarily invalid — only unreadable). */
function downloadTokenLife() {
  const claims = jwtPayload(session.authorizationToken || '');
  if (!claims || !claims.exp) return null;
  const ms = Number(claims.exp) * 1000;
  if (!isFinite(ms)) return null;
  const left = ms - Date.now();
  return { exp: ms, expired: left <= 0, minutes: Math.round(left / 60000) };
}

/** Human phrasing for an expired download credential. */
function expiredTokenMsg(life) {
  const ago = Math.max(1, -life.minutes);
  return 'Your Uppbeat download token expired ' + ago + ' minute' + (ago === 1 ? '' : 's') + ' ago. ' +
    'Uppbeat issues `authorization_token` as a JWT that is only valid for about 20 minutes, so a pasted ' +
    'one goes stale quickly — this is not a fault in the panel or your plan. Paste a fresh ' +
    '`authorization_token` from a signed-in uppbeat.io tab, or use "Sign in with email & password", ' +
    'which mints a new one each time.';
}

/**
 * Fetch a URL with the imported Uppbeat session attached. Defaults to GET;
 * pass `{ method:'POST', body:'…' }` for the endpoints that need it (the
 * Typesense multi_search browse call is POST-only — it 404s on GET).
 * @returns {Promise<{status:number, headers:object, body:string}>}
 */
function httpGet(url, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    let https, urlmod;
    try { https = CEP.require('https'); urlmod = CEP.require('url'); }
    catch (e) { return reject(new Error('Node is unavailable in this panel, so Uppbeat cannot be reached.')); }

    const parsed = urlmod.parse(url);
    const method = String(opts.method || 'GET').toUpperCase();
    const body = opts.body == null ? null : String(opts.body);
    const headers = sessionHeaders(Object.assign(
      { 'Accept': opts.accept || 'application/json, text/plain, */*' },
      opts.headers || {}
    ), url);
    if (body !== null) {
      /* Byte length, not character count — a track title with an emoji in it
         would otherwise under-declare the body and hang the request. */
      let len = body.length;
      try { len = CEP.require('buffer').Buffer.byteLength(body); } catch (e) {}
      headers['Content-Length'] = len;
    }

    const req = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      path: parsed.path,
      method: method,
      headers: headers,
      timeout: opts.timeout || 25000
    }, function (res) {
      // follow redirects ourselves so cookies survive the hop
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location &&
          opts.follow !== false && (opts.depth || 0) < 5) {
        res.resume();
        const next = res.headers.location.indexOf('http') === 0
          ? res.headers.location
          : BASE + res.headers.location;
        /* 307/308 preserve the method and body; everything else turns into a
           GET, so the body must be dropped or the next hop declares a
           Content-Length it never sends. */
        const keep = res.statusCode === 307 || res.statusCode === 308;
        return resolve(httpGet(next, Object.assign({}, opts, {
          depth: (opts.depth || 0) + 1,
          method: keep ? method : 'GET',
          body: keep ? opts.body : null
        })));
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
    if (body !== null) req.write(body);
    req.end();
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
    const headers = sessionHeaders({ 'Accept': '*/*' }, url);

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

/* What to tell the user when Uppbeat has answered but the answer is "this
   session does not belong to an account". Shared so the plan check and the
   download path tell the same story. */
const SIGNED_OUT_MSG =
  'Uppbeat does not recognise this session as signed in. An `auth_token` on its own is not enough — ' +
  'Uppbeat hands one out to signed-out visitors too, so pasting just that value logs you in as a guest ' +
  '(guest sessions read as the free plan and 500 on download). Press "Sign in" and import the whole ' +
  'cookie set while signed in at uppbeat.io, or paste the full Cookie header rather than the token alone.';

/* Downloads need a second, different cookie from the one that signs you in.
   This is the single most common reason a signed-in, paid session still cannot
   download, so it gets its own message. */
const NO_V2_TOKEN_MSG =
  'This session can sign in and read your plan, but it cannot download: it holds only an `auth_token`. ' +
  'Uppbeat uses TWO cookies — `auth_token` for the account API and `authorization_token` for the download API — ' +
  'and they hold different values, so pasting the login token alone never brings the download one with it. ' +
  'Fix it by importing the whole cookie jar: press "Sign in" › "I\'ve signed in — Import session", or copy the ' +
  'ENTIRE Cookie header (or a Cookie-Editor export) for uppbeat.io into the big box and press "Use this Cookie header".';

function explainStatus(status, what, res) {
  if (status === 403) {
    /* 403 is "Insufficient privileges" — an entitlement answer, not a session
       one. The commonest cause is asking for a format the plan does not
       include (wav returns 403 while mp3 returns 200 for the same track), so
       do not send people off to re-import a session that is working fine. */
    return 'Uppbeat allowed the session but not this request (403 — insufficient privileges). Usually the ' +
           'audio format: WAV needs a plan that includes it, while MP3 is allowed. Set Setup › Audio format ' +
           'to mp3, or upgrade the Uppbeat plan. It can also mean the track itself is outside your plan.';
  }
  if (status === 401) {
    return 'Uppbeat refused the request (401). Your session is missing or expired — press ' +
           '"Sign in" to re-open uppbeat.io in your browser and pick the session up again.';
  }
  if (status === 402) return 'This track needs a paid Uppbeat plan your account does not have.';
  if (status === 500 && (what === 'download' || what === 'audio')) {
    /* Measured against the live service, with cache-busting so the CDN could
       not replay a stale body: no credential at all -> a clean 401; ANY
       `authorization_token` value it does not accept -> 500, whether that is
       our opaque token, a well-formed JWT, or the string "abc". Only an empty
       value drops back to 401. So a 500 means precisely "the credential we
       sent was rejected" — it is not an Uppbeat outage and retrying will not
       help. */
    return 'Uppbeat\'s download API rejected this session (HTTP 500 — it returns 500 rather than 401 for a ' +
           'credential it does not accept). Your `authorization_token` cookie is stale or was not copied from a ' +
           'signed-in browser. Re-import the whole cookie jar via "Sign in" › "I\'ve signed in — Import session". ' +
           'If it still fails, use "Ingest a file": download the track on uppbeat.io yourself and let MediaRade attach the credit.';
  }
  if (status === 500) {
    return 'Uppbeat returned HTTP 500 for the ' + what + ' request — its server-side error is not something ' +
           'MediaRade can fix. Try again in a few minutes.';
  }
  if (status === 404) return 'Uppbeat returned 404 for the ' + what + ' endpoint. Their API path has probably changed — update it in Setup › Uppbeat.';
  if (status === 429) {
    const host = res && res.headers && res.headers.server ? ' (' + res.headers.server + ')' : '';
    const retry = res && res.headers && res.headers['retry-after'];
    return 'Uppbeat is rate-limiting requests from your network (HTTP 429' + host + '). This is per-network, not per-account — ' +
      'wait a few minutes before retrying' + (retry ? ' (~' + retry + 's)' : '') +
      '. Your session was imported fine; tick "this account is paid" in Sign in to unlock premium while the limiter resets.';
  }
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
  /* Prefer the asset's own id. On the real catalogue a track doc is keyed by
     `track_id` and an sfx by `sfx_id`; `id` on trending rows is a composite
     ("2372_premium_top") and on sfx rows is the variant id. The download
     endpoint keys on track_id / sfx_id, so that must be what `id` holds. */
  const id = pick(t, ['track_id', 'sfx_id', 'id', 'trackId', 'uuid', 'slug']);
  if (!id) return null;
  const slug = pick(t, ['track_slug', 'sfx_slug', 'slug', 'permalink', 'url']);
  const artist = pick(t, ['contributor_name', 'artist.name', 'artist', 'artistName', 'author.name']) || 'Unknown artist';
  return {
    id: String(id),
    kind: pick(t, ['asset_type']) || (t.sfx_id ? 'sfx' : 'track'),
    slug: slug ? String(slug) : null,
    title: String(pick(t, ['title', 'name']) || 'Untitled'),
    artist: String(artist),
    artistSlug: pick(t, ['contributor_slug', 'artist.slug', 'artistSlug']),
    duration: Number(pick(t, ['duration', 'length', 'durationSeconds', 'version_length', 'versionLength'])) || null,
    bpm: pick(t, ['bpm', 'tempo']),
    genres: [].concat(pick(t, ['genres', 'genre', 'styles', 'type', 'theme']) || []).map(function (g) {
      return typeof g === 'string' ? g : (g && (g.name || g.title)) || '';
    }).filter(Boolean),
    moods: [].concat(pick(t, ['moods', 'mood', 'tags', 'theme']) || []).map(function (m) {
      return typeof m === 'string' ? m : (m && (m.name || m.title)) || '';
    }).filter(Boolean),
    premium: !!(pick(t, ['isPremium', 'premium', 'requiresSubscription', 'is_premium',
                         'premiumTrack', 'premiumTier', 'license.isPremium'])) &&
      !pick(t, ['isFree', 'free', 'freeTrack', 'is_free']),
    preview: pick(t, ['previewUrl', 'preview', 'audioUrl', 'mp3', 'streamUrl', 'file.preview',
                      'version_preview_uri', 'versionPreviewUri', 'preview_video_url']),
    video: !!pick(t, ['preview_video_url', 'previewVideoUrl']),
    artwork: pick(t, ['artwork', 'image', 'imageUrl', 'artist.image', 'cover', 'contributor_image']),
    musicvineTrackId: pick(t, ['musicvine_track_id', 'musicvineTrackId']),
    /* The SFX download route is keyed on the variant, the track waveform on the
       version — carry both so resolveDownload never has to guess. */
    variantId: pick(t, ['sfx_variant_id', 'variant_id', 'sfxVariantId', 'variantId']),
    versionId: pick(t, ['track_version_id', 'version_id', 'trackVersionId']),
    page: slug ? (String(slug).indexOf('http') === 0 ? String(slug)
      : (t.asset_type && t.asset_type.indexOf('lut') !== -1 ? BASE + '/motion-graphics/' + slug
        : (t.asset_type === 'motiongraphic' ? BASE + '/motion-graphics/' + slug
          : BASE + '/track/' + slug)))
      : BASE,
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

/* Words that are account states, not plan names — a bare `true` or `active`
   flag does not tell us the plan, so fall through to the premium boolean. */
const NON_PLANS = ['', 'none', 'active', 'inactive', 'true', 'false', 'paid', 'standard', 'default'];

function truthy(v) { return v === true || v === 1 || v === 'true' || v === '1' || v === 'yes'; }

/** Coerce whatever Uppbeat reports for the account into a plan string that
    `isPremium()` understands ('free' | 'none' | any real-paid-plan name). */
function readPlan(acct) {
  if (!acct || typeof acct !== 'object') return 'free';
  const premiumFlag = pick(acct, ['premium', 'isPremium', 'is_premium', 'isPro', 'is_pro',
    'plan.premium', 'subscription.premium', 'subscription.active', 'hasPaidSubscription', 'isPaid', 'pro',
    'subscriptionData.isActive', 'subscriptionData.is_active', 'subscriptionData.active',
    'subscriptionData.isPaid', 'subscriptionData.premium']);
  const planName = pick(acct, ['plan.name', 'plan.title', 'plan.key', 'plan.label', 'plan.slug', 'plan.type',
    'subscription.plan.name', 'subscription.plan', 'subscription.tier', 'subscription.type', 'subscription.slug',
    'subscription.name', 'subscriptionData.plan.name', 'subscriptionData.plan', 'subscriptionData.tier',
    'subscriptionData.type', 'subscriptionData.name', 'subscriptionData.product', 'subscriptionData.subscriptionName',
    'tier.name', 'membership.name', 'license.plan.name', 'account.plan.name',
    'currentPlan.name', 'planName', 'plan_name', 'licenseType', 'accountStatus']);
  const planRaw = pick(acct, ['plan', 'subscription', 'tier', 'membership', 'accountStatus', 'planType',
    'currentPlan', 'account.plan', 'account', 'subscriptionData']);

  let plan = '';
  const rawName = planRaw && typeof planRaw === 'object'
    ? (planRaw.name || planRaw.key || planRaw.title || planRaw.slug || planRaw.tier || planRaw.type || planRaw.plan || '')
    : planRaw;
  if (typeof planName === 'string' && planName) plan = String(planName);
  else if (typeof rawName === 'string' && rawName) plan = String(rawName);
  else if (typeof rawName === 'object' && rawName) {
    plan = String(rawName.name || rawName.slug || rawName.tier || rawName.type || rawName.key || rawName.title || '');
  }

  plan = plan.trim().toLowerCase();
  if (plan && NON_PLANS.indexOf(plan) === -1) return plan;
  return truthy(premiumFlag) ? 'premium' : 'free';
}

/* --- the setup_frontend envelope ------------------------------------------
   The live shape (verified against prod-api) nests auth state one level
   deeper than the account itself:

     { user: { auth_token: <bool>, token: '<opaque hex>',
               user: {…the actual account…} | null,
               is_authenticated: <bool> },
       auth_token: <bool>,
       subscriptionData: [] | [{…}],       <- TOP level, not under `user`
       credits: {…}, preferences: {…}, … }

   Two traps live in there, and MediaRade fell into both:

   1. Top-level `auth_token` is not an answer. Uppbeat sets it true whenever a
      token cookie was sent — including a value it has never issued (a made-up
      128-char string comes back as `auth_token: true`, `is_authenticated:
      false`). Only `user.is_authenticated` / a non-null `user.user` means
      "this session belongs to an account".
   2. `json.user` is the auth WRAPPER, not the account. Reading the plan off it
      finds nothing, which is why a Creator account reported as free — and the
      plan fields it should have read (`subscriptionData`) are not in there at
      all, they sit at the top level.                                         */

/** Merge the plan-bearing top-level fields into the account object so
    `readPlan` sees them, since they do not travel with the account. */
function planSource(json, acct) {
  const merged = Object.assign({}, acct || {});
  const sub = json && json.subscriptionData;
  if (Array.isArray(sub)) {
    /* A free account gets `subscriptionData: []`. Anything in that array means
       a subscription exists, so treat its mere presence as paid even if the
       object inside uses field names readPlan does not recognise — better to
       name the plan 'premium' than to charge a paying user the free-plan
       credit obligation. A named plan below still wins over this. */
    if (sub.length) { merged.subscriptionData = sub[0]; merged.hasPaidSubscription = true; }
  } else if (sub && typeof sub === 'object') {
    merged.subscriptionData = sub;
    if (Object.keys(sub).length) merged.hasPaidSubscription = true;
  }
  if (json && json.subscription && typeof json.subscription === 'object') {
    merged.subscription = merged.subscription || json.subscription;
  }
  return merged;
}

/** Pull { authed, account, plan } out of whichever envelope Uppbeat used.
    Tolerates the older flat shape (account straight under `user`/`data`/root)
    so a changed response does not silently read as signed-out. */
function unwrapAccount(json) {
  if (!json || typeof json !== 'object') return { authed: false, account: null, plan: {} };
  const wrap = json.user && typeof json.user === 'object' && !Array.isArray(json.user) ? json.user : null;

  let acct = null;
  if (wrap && wrap.user && typeof wrap.user === 'object') acct = wrap.user;         // real envelope
  else if (wrap && (wrap.email || wrap.id)) acct = wrap;                            // flat envelope
  else if (json.data && typeof json.data === 'object' && (json.data.email || json.data.id)) acct = json.data;
  else if (json.email || json.id) acct = json;

  let authed;
  if (wrap && typeof wrap.is_authenticated === 'boolean') authed = wrap.is_authenticated;
  else if (typeof json.is_authenticated === 'boolean') authed = json.is_authenticated;
  else authed = !!(acct && (acct.email || acct.id));
  /* `is_authenticated: true` with no account attached is not a login. */
  if (!acct) authed = false;

  return { authed: authed, account: acct, plan: planSource(json, acct) };
}

function storeToken(json) {
  /* The session token lives at `user.token` on the real envelope. Top-level
     `auth_token` is only ever a boolean ("a token cookie was present"), so it
     must never be stored as the token itself. */
  const wrap = json && json.user && typeof json.user === 'object' ? json.user : null;
  let v = String((json && ((wrap && wrap.token) || json.token || json.auth_token)) || '').trim();
  if (v === 'true' || v === 'false' || v.length < 8) v = '';
  session.token = v;
}

/** Decode a JWT's payload claims (base64url) without verifying the signature.
    We only read what Uppbeat itself signed into the token the user pasted.
    Uses a dependency-free base64 decoder so it works in the panel (Node),
    the browser, and the jsdom test realm alike. */
function jwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = String(token).trim().split('.');
  if (parts.length !== 3) return null;
  let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  try {
    const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bin = [];
    let acc = 0, bits = 0;
    for (let i = 0; i < b64.length; i++) {
      if (b64[i] === '=') break;
      const idx = CH.indexOf(b64[i]);
      if (idx < 0) return null;
      acc = (acc << 6) | idx;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bin.push((acc >> bits) & 0xff);
      }
    }
    let out = '';
    for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin[i]);
    return JSON.parse(out);
  } catch (e) { return null; }
}

/** Read the plan straight from the auth token's own claims (role/permissions).
    Returns a plan name ('creator', 'premium', …) or '' when the cookies hold no
    decodable token.

    NOTE: Uppbeat's current `auth_token` is a 128-char opaque hex string, NOT a
    JWT, so this returns '' for a real live token and the caller falls through
    to the account endpoint. It is kept because it costs nothing and settles the
    plan offline if Uppbeat ever signs its claims again — but nothing may depend
    on it working. A pasted token can never settle the plan on its own today. */
function planFromToken(cookies) {
  const m = String(cookies || '').match(/(?:^|;\s*)(auth_token|authorization_token)=([^;]+)/i);
  if (!m) return '';
  let v = m[2].trim();
  try { v = decodeURIComponent(v); } catch (e) {}
  const claims = jwtPayload(v);
  if (!claims) return '';
  const roles = [].concat(claims.role || []);
  if (roles.some(function (r) { return /creator|pro|premium|studio|business|paid|partner/i.test(String(r)); })) {
    return 'creator';
  }
  const perms = [].concat(claims.permissions || []);
  if (perms.some(function (p) { return /download_premium|unlimited_downloads/i.test(String(p)); })) {
    return 'creator';
  }
  if (claims.premium || claims.isPremium) return 'premium';
  const plan = String(claims.plan || claims.planName || claims.tier || '').trim().toLowerCase();
  if (plan && plan !== 'free' && plan !== 'none') return plan;
  return '';
}

/** True when the session cookies carry a decodable auth JWT, whatever its
    plan says. Used to decide whether a manual token can settle the plan locally
    (a real token is authoritative) instead of launching a browser. */
function hasAuthJwt(cookies) {
  const m = String(cookies || '').match(/(?:^|;\s*)(auth_token|authorization_token)=([^;]+)/i);
  if (!m) return false;
  let v = m[2].trim();
  try { v = decodeURIComponent(v); } catch (e) {}
  return jwtPayload(v) !== null;
}

/** Pull one cookie's value out of a `k=v; k2=v2` jar. Returns '' when absent. */
function cookieValue(cookies, name) {
  const m = String(cookies || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)', 'i'));
  if (!m) return '';
  let v = m[1].trim();
  try { v = decodeURIComponent(v); } catch (e) {}
  return v;
}

/** Re-derive the two API credentials from the cookie jar after any change.
    - `authToken`          <- auth_token cookie  (account API)
    - `authorizationToken` <- authorization_token cookie, OR — when only the
      auth_token is present and it is a JWT — the auth_token itself, because
      the V2 download API accepts that JWT as `Authorization: Bearer`
      (verified against the live service: Bearer <jwt> answers 200 with a real
      signed download URL, while the auth_token cookie alone answers 401). */
function syncTokenFields() {
  const authz = cookieValue(session.cookies, 'authorization_token');
  const auth = cookieValue(session.cookies, 'auth_token');
  session.authToken = auth || session.token || '';
  session.authorizationToken = authz || (jwtPayload(auth) ? auth : '');
  return session;
}

/** Resolve the plan from a pasted token: premium claims -> 'creator', a
    decodable-but-free token -> 'free', no token at all -> '' (caller falls
    back to the network/browser path). */
function planFromSession(cookies) {
  const p = planFromToken(cookies);
  if (p) return p;
  return hasAuthJwt(cookies) ? 'free' : '';
}

/* ========================================================================= */

export const Uppbeat = {
  BASE: BASE,
  DEFAULT_ENDPOINTS: DEFAULT_ENDPOINTS,
  BROWSERS: BROWSERS,
  BROWSER_IDS: BROWSER_IDS,
  browserInstalled: browserInstalled,
  cookiesArg: cookiesArg,
  foxRoot: foxRoot,

  /* --- session ----------------------------------------------------------- */

  session: function () { return session; },

  loadSession: function () {
    const stored = Config.get('uppbeatSession');
    if (stored && stored.cookies) {
      session = Object.assign({ plan: 'free', signedIn: true, token: '' }, stored);
      /* A manually pasted auth_token is a JWT that already names the plan
         (role/permissions). Re-derive it here so a stale saved `plan` (e.g. a
         pre-JWT 'free') never mislabels a Creator session on the next boot. */
      syncTokenFields();
      const local = planFromSession(session.cookies);
      if (local) session.plan = local;
    }
    return session;
  },

  saveSession: function () {
    syncTokenFields();
    Config.set('uppbeatSession', {
      cookies: session.cookies,
      token: session.token,
      authToken: session.authToken,
      authorizationToken: session.authorizationToken,
      account: session.account,
      plan: session.plan,
      signedIn: session.signedIn,
      importedAt: session.importedAt
    });
    Bus.emit('uppbeat:session', session);
    return session;
  },

  clearSession: function () {
    session = { cookies: '', token: '', authToken: '', authorizationToken: '',
      account: null, plan: 'free', signedIn: false, importedAt: null };
    Uppbeat.saveSession();
    return session;
  },

  isPremium: function () {
    const p = String(session.plan || 'free').toLowerCase();
    return session.signedIn && p !== 'free' && p !== 'none';
  },

  /** Remaining life of the download credential: { exp, expired, minutes }, or
      null when it carries no readable expiry. The UI uses this to warn before
      a download is attempted rather than after it fails. */
  downloadTokenLife: function () { return downloadTokenLife(); },

  /** One line describing whether downloads can work right now, for the panel
      header. Returns null when there is nothing worth saying. */
  downloadStatus: function () {
    if (!session.cookies) return null;
    if (!canAttemptDownload()) return { tone: 'err', text: 'Downloads unavailable — no authorization_token in this session.' };
    const life = downloadTokenLife();
    if (!life) return null;
    if (life.expired) return { tone: 'err', text: 'Download token expired ' + Math.max(1, -life.minutes) + ' min ago — paste a fresh authorization_token.' };
    return { tone: life.minutes <= 3 ? 'warn' : 'ok',
             text: 'Download token valid for ' + life.minutes + ' more minute' + (life.minutes === 1 ? '' : 's') + '.' };
  },

  /** Open Uppbeat's login page in the real browser. No password ever reaches MediaRade. */
  openSignIn: function () {
    CEP.openInBrowser(BASE + '/login');
  },

  /**
   * The whole sign-in journey, hands-off after the click:
   * open uppbeat.io in the real browser, then keep trying to import the
   * session until the cookies appear. MediaRade never sees the password —
   * the browser does the authenticating, we only pick up the result.
   *
   * Tries the configured browser first, then every other installed browser,
   * because Chrome/Edge v127+ hide their cookies behind App-Bound Encryption
   * that yt-dlp cannot decrypt while they are running. The failure reason is
   * surfaced to the UI (onTick's third argument) so the user is told what is
   * actually going on instead of waiting for a silent timeout.
   *
   * @param {function} onTick  (attempt, max, {message, browser}) progress callback
   * @returns {Promise<object>} the live session; rejects if it never arrives
   */
  signIn: function (onTick) {
    const configured = Config.get('uppbeatBrowser') || 'chrome';
    const candidates = [configured].concat(BROWSER_IDS.filter(function (b) {
      return b !== configured && Uppbeat.browserInstalled(b);
    }));
    const max = Config.get('uppbeatSignInTries') || 40;      // ~3.5 minutes
    const gap = 5000;                                         // 5s between cookie-copy attempts

    Uppbeat.openSignIn();

    let cancelled = false;
    let lastError = '';

    const run = new Promise(function (resolve, reject) {
      let attempt = 0;

      function tick() {
        if (cancelled) return reject(Object.assign(new Error('cancelled'), { canceled: true, cancelled: true }));
        attempt++;
        if (onTick) { try { onTick(attempt, max, lastError ? { message: lastError, browser: null } : null); } catch (e) {} }

        let i = 0;
        function tryNext() {
          if (cancelled) return;
          const b = candidates[i++];
          if (!b) return retry();

          Uppbeat.importSession(b).then(function (s) {
            if (cancelled) return;
            if (s && s.signedIn && s.cookies) return resolve(Object.assign({}, s, { browser: b }));
            retry();
          }).catch(function (e) {
            lastError = e && e.message ? e.message : String(e);
            if (onTick) { try { onTick(attempt, max, { message: lastError, browser: b }); } catch (e2) {} }
            tryNext();
          });
        }
        tryNext();
      }

      function retry() {
        if (cancelled) return;
        if (attempt >= max) {
          return reject(new Error(
            'Timed out waiting for an Uppbeat session. Sign in at uppbeat.io, then wait a few seconds.' +
            (lastError ? '\n\nLast error: ' + lastError : '') +
            '\n\nIf you use Chrome or Edge, close them completely so the session can be read — ' +
            'or pick Firefox in Setup › Uppbeat.'));
        }
        setTimeout(tick, gap);
      }

      // Wait 5s before the first attempt: the browser needs time to open (and,
      // for an already-signed-in session, to settle on the real session before
      // we try to copy its cookies). Each failed attempt retries after another 5s.
      setTimeout(tick, gap);
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
   *
   * The URL is deliberately `unsupported:` so yt-dlp only copies the cookie jar
   * and never fetches uppbeat.io — the poll loop would otherwise hammer the
   * site (40 requests in ~3.5 minutes) and trip its rate limiter.
   */
  importSession: function (browser) {
    browser = browser || Config.get('uppbeatBrowser') || Config.get('cookiesFromBrowser') || 'chrome';
    if (!YtDlp.ready()) {
      return Promise.reject(new Error('yt-dlp is required to read browser cookies. Set it up first in Setup › Tooling.'));
    }

    const jar = CEP.path.join(Paths.dir('cache'), 'uppbeat-cookies.txt');
    Paths.remove(jar);

    const cookieFrom = cookiesArg(browser);
    if (cookieFrom === null) {
      return Promise.reject(new Error('Could not find ' + browser + '\'s profile folder. Sign in with it, ' +
        'then — if it is a portable/homebrew build — set its profile folder in Setup › Uppbeat › Custom profile folder.'));
    }

    const args = ['--cookies-from-browser', cookieFrom, '--cookies', jar,
                  '--skip-download', '--ignore-errors', '--no-warnings', '--ignore-config',
                  'unsupported:uppbeat-cookies-only'];

    return Proc.run(YtDlp.ytdlp, args, { timeout: 90000 }).then(function (r) {
      const stderr = r.stderr || '';
      if (!Paths.exists(jar)) {
        const abe = /DPAPI|app.?bound|10927|could not decrypt/i.test(stderr) ? ' ' +
            (browser === 'chrome' || browser === 'edge'
              ? browser[0].toUpperCase() + browser.slice(1) + ' v127+ protects its cookies with App-Bound ' +
                'Encryption, which yt-dlp cannot decrypt while it is running. Close ' + browser + ' completely, ' +
                'or use Firefox instead (Setup › Uppbeat › Sign in with this browser).'
              : browser + ' refused to give up its cookies.')
          : '';
        const hint = /could not (find|copy)|permission|locked|DPAPI/i.test(stderr)
          ? ' Close ' + browser + ' completely and try again — Windows locks the cookie database while it is running.'
          : '';
        throw new Error('Could not read cookies from ' + browser + '.' + (abe || hint));
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

      return Uppbeat.refreshPlan();
    });
  },

  /** One-shot cookie import: tries the configured browser, then every other
      installed browser, and resolves with the first session that sticks.
      Used by the sign-in popup's "I've signed in — Import session" button
      (no long polling, no silent retries — one click, clear result). */
  importNow: function () {
    const configured = Config.get('uppbeatBrowser') || Config.get('cookiesFromBrowser') || 'chrome';
    const seen = {};
    const order = [];
    [configured].concat(BROWSER_IDS).forEach(function (b) {
      if (!seen[b]) { seen[b] = 1; order.push(b); }
    });

    let lastError = null;
    function tryOne(i) {
      if (i >= order.length) {
        return Promise.reject(lastError || new Error('No browser could be read.'));
      }
      return Uppbeat.importSession(order[i]).then(function (s) {
        return Object.assign({}, s, { browser: order[i] });
      }).catch(function (e) {
        lastError = e;
        return tryOne(i + 1);
      });
    }
    return tryOne(0);
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

  /** Paste-cookie escape hatch when browser import is impossible. Accepts a
      raw `Cookie:` header, a `k=v; k2=v2` / newline-separated string, or a
      Cookie-Editor JSON export (array of {name,value,…} objects). */
  setCookiesManually: function (raw) {
    const cookies = Uppbeat.parseManualCookies(raw);
    if (!cookies) throw new Error('Nothing to set — paste the Cookie header or its name=value entries, not plain text.');
    session.cookies = cookies;
    session.signedIn = true;
    session.importedAt = Date.now();
    Uppbeat.saveSession();
    const local = planFromSession(session.cookies);
    if (local) {
      session.plan = local;
      session.planError = null;
      Uppbeat.saveSession();
      return Promise.resolve(session);
    }
    return Uppbeat.refreshPlan();
  },

  /** Give the login token directly (copy from Cookie Editor / DevTools).
      If the pasted text is already a `name=value` pair (e.g.
      `authorization_token=…`), route it through the full cookie parser so the
      name you supplied is preserved exactly.

      `auth_token` and `authorization_token` are TWO DIFFERENT COOKIES with
      different values, and this used to copy the pasted value into both. That
      guess was actively harmful. Verified against the live service:
        - the account API (prod-api) reads `auth_token`;
        - the V2 download API (api-v2-cdn) IGNORES the auth_token cookie
          (auth_token alone answers 401) and accepts the download credential as
          `Authorization: Bearer` — the same JWT Uppbeat signs into
          `authorization_token` answers 200 with a real signed download URL.
      So a pasted auth JWT now enables BOTH APIs: `syncTokenFields` derives the
      download credential from it, `sessionHeaders` sends it as Bearer to the
      download endpoint, and the plan is read from its role/permissions claims.
      A non-JWT opaque token can only sign in and report the plan — it cannot
      download, so it is not fabricated into an authorization_token (that minted
      cookie was itself the cause of the old HTTP 500 on every download). */
  setAuthToken: function (token) {
    const raw = String(token == null ? '' : token)
      .trim().replace(/^['"]+|['"]+$/g, '').replace(/;\s*$/, '');
    if (!raw) throw new Error('Paste the token value first.');
    if (raw.indexOf('=') > -1) return Uppbeat.setCookiesManually(raw);
    session.cookies = 'auth_token=' + raw;
    session.signedIn = true;
    session.importedAt = Date.now();
    Uppbeat.saveSession();
    const local = planFromSession(session.cookies);
    if (local) {
      session.plan = local;
      session.planError = null;
      Uppbeat.saveSession();
      return Promise.resolve(session);
    }
    return Uppbeat.refreshPlan();
  },

  /** Give BOTH session credentials at once. Uppbeat needs two different cookie
      values — `auth_token` for the account API (who you are / your plan) and
      `authorization_token` for the download API (what lets the CDN hand over
      the file). A download fails (401) with only an auth_token. So from the
      paste-your-tokens panel both are required: this builds a jar with both and
      rejects if either is missing, so a one-field session can never be stored. */
  setTokens: function (authToken, authorizationToken) {
    const a = String(authToken == null ? '' : authToken)
      .trim().replace(/^['"]+|['"]+$/g, '').replace(/;\s*$/, '');
    const z = String(authorizationToken == null ? '' : authorizationToken)
      .trim().replace(/^['"]+|['"]+$/g, '').replace(/;\s*$/, '');
    const hasPair = a.indexOf('=') > -1 || z.indexOf('=') > -1;
    if (hasPair) {
      return Uppbeat.setCookiesManually(a + (a && z ? '; ' : '') + z);
    }
    /* Reject rather than throw: this returns a promise, and the Apply button
       handles failure through the promise's rejection path only. A synchronous
       throw would escape it and leave the button stuck disabled — reachable
       whenever a paste trims to nothing (stray quotes or a lone semicolon). */
    if (!a) return Promise.reject(new Error('Paste the auth_token value (the account-API cookie).'));
    if (!z) return Promise.reject(new Error('Paste the authorization_token value (the download-API cookie).'));
    session.cookies = 'auth_token=' + a + '; authorization_token=' + z;
    session.signedIn = true;
    session.importedAt = Date.now();
    Uppbeat.saveSession();
    const local = planFromSession(session.cookies);
    if (local) {
      session.plan = local;
      session.planError = null;
      Uppbeat.saveSession();
      return Promise.resolve(session);
    }
    return Uppbeat.refreshPlan();
  },

  /** Give the authorization credential directly (the `authorization_token` cookie
      value, or the auth JWT). Separate from setAuthToken because the account
      API and the download API key on different credentials — this one is what
      resolveDownload sends as the `Authorization: Bearer`. */
  setAuthorizationToken: function (token) {
    const raw = String(token == null ? '' : token)
      .trim().replace(/^['"]+|['"]+$/g, '').replace(/;\s*$/, '');
    if (!raw) throw new Error('Paste the authorization_token value first.');
    if (raw.indexOf('=') > -1) return Uppbeat.setCookiesManually(raw);
    session.cookies = (session.cookies ? session.cookies + '; ' : '') + 'authorization_token=' + raw;
    session.signedIn = true;
    session.importedAt = Date.now();
    Uppbeat.saveSession();
    const local = planFromSession(session.cookies);
    if (local) {
      session.plan = local;
      session.planError = null;
      Uppbeat.saveSession();
      return Promise.resolve(session);
    }
    return Uppbeat.refreshPlan();
  },

  /* --- email & password (driven through a real Chrome window) -------------
     Uppbeat now sits behind a Vercel "security checkpoint" that answers 429 to
     every non-browser client (curl, Node, yt-dlp, PowerShell) regardless of IP
     — which is why a VPN never helped. The only thing that passes it is a real
     browser, so we drive one: launch Chrome, let it solve the checkpoint, fill
     the actual login form, and import the session cookies it earns. The helper
     (tools/uppbeat-login.mjs) runs under the SYSTEM Node, not the panel's.     */

  /** Resolve the system Node executable that can drive Chrome (needs Node 21+
      for global WebSocket). Prefers MR_NODE, then common install paths, then
      `where node`. */
  findNode: function () {
    let fs = null, osHome = '';
    try { fs = CEP.fs; } catch (e) {}
    const abs = function (p) {
      try { return p && fs && fs.existsSync(p) ? p : null; } catch (e) { return null; }
    };
    const d = [process.env.MR_NODE,
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe'].map(abs).filter(Boolean);
    if (d.length) return Promise.resolve(d[0]);
    return Proc.which('node');
  },

  /** Path to the shipped login helper inside this extension's install. */
  helperPath: function () {
    try {
      const ext = CEP.systemPath('extension');
      if (!ext) return '';
      return CEP.path.join(ext, 'tools', 'uppbeat-login.mjs');
    } catch (e) { return ''; }
  },

  /** Sign in to Uppbeat by driving a real Chrome window. Accepts the account
      email + password, spawns the helper (password via stdin, never argv),
      and on success stores the harvested session so plan/search work. */
  loginWithCredentials: function (email, password) {
    email = String(email == null ? '' : email).trim();
    password = String(password == null ? '' : password);
    if (!email) return Promise.reject(new Error('Enter your Uppbeat email address.'));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Promise.reject(new Error('That email address does not look valid.'));
    if (!password) return Promise.reject(new Error('Enter your Uppbeat password.'));

    return Uppbeat.findNode().then(function (node) {
      if (!node) throw new Error('Could not find a system Node.js to drive Chrome. Install Node.js 21+ and try again.');
      const script = Uppbeat.helperPath();
      if (!script) throw new Error('Node is unavailable in this panel — the Chrome login needs the bundled Node runtime.');
      let fs = null;
      try { fs = CEP.fs; if (fs && !fs.existsSync(script)) throw new Error('The Chrome login helper is not installed — re-run "npm run deploy".'); } catch (e) { if (e && e.message && e.message.indexOf('deploy') > -1) throw e; }

      return Proc.run(node, [script, '--email', email, '--timeout', '120000'], {
        stdin: password + '\n',
        timeout: 150000,
        maxBuffer: 3e6
      }).then(function (r) {
        let out = null;
        const m = r.stdout.match(/\{[\s\S]*\}/);
        if (m) { try { out = JSON.parse(m[0]); } catch (e) {} }
        if (r.code !== 0 || !out || !out.ok) {
          const err = out && out.error ? out.error
            : (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-3).join(' | ')
              || 'Chrome login did not complete.';
          throw new Error(err);
        }
        const info = unwrapAccount(out.me);
        session.cookies = out.cookies || '';
        storeToken(out.me);
        if (!info.authed) throw new Error('Chrome finished the login but Uppbeat still reports the session as signed out. ' + SIGNED_OUT_MSG);
        const acct = info.account;
        session.account = {
          email: pick(acct, ['email', 'user.email']),
          name: pick(acct, ['name', 'displayName', 'username', 'firstName'])
        };
        session.plan = readPlan(info.plan) || 'free';
        session.planError = null;
        session.signedIn = true;
        session.importedAt = Date.now();
        Uppbeat.saveSession();
        return session;
      });
    });
  },

  /**
   * Re-check the stored session's plan through a real Chrome window: hand it
   * the current cookies, let Chrome pass the Vercel checkpoint on uppbeat.io,
   * and have it fetch the account endpoint same-origin. This is the FALLBACK
   * for when the direct call fails — prod-api answers plain Node fine, so
   * `refreshPlan` tries `me()` first and only pays for Chrome if that breaks.
   * Returns the session (signed-out, with planError set, if Uppbeat says the
   * cookies do not belong to an account).
   */
  verifyInBrowser: function () {
    if (!session.cookies) return Promise.reject(new Error('No Uppbeat session to verify — sign in first.'));
    return Uppbeat.findNode().then(function (node) {
      if (!node) throw new Error('Could not find a system Node.js to drive Chrome for the plan check.');
      const script = Uppbeat.helperPath();
      if (!script) throw new Error('Node is unavailable in this panel — the plan check needs the bundled Node runtime.');
      return Proc.run(node, [script, '--verify', '--timeout', '60000'], {
        stdin: session.cookies + '\n',
        timeout: 90000,
        maxBuffer: 3e6
      }).then(function (r) {
        let out = null;
        const m = r.stdout.match(/\{[\s\S]*\}/);
        if (m) { try { out = JSON.parse(m[0]); } catch (e) {} }
        if (r.code !== 0 || !out || !out.ok) {
          const err = (out && out.error) || 'The plan check did not complete.';
          throw new Error(err);
        }
        const info = unwrapAccount(out.me);
        storeToken(out.me);
        if (!info.authed) {
          session.signedIn = false;
          session.account = null;
          session.plan = 'free';
          session.planError = SIGNED_OUT_MSG;
          Uppbeat.saveSession();
          return session;
        }
        session.account = {
          email: pick(info.account, ['email', 'user.email']),
          name: pick(info.account, ['name', 'displayName', 'username', 'firstName'])
        };
        session.plan = readPlan(info.plan) || 'free';
        session.planError = null;
        session.signedIn = true;
        Uppbeat.saveSession();
        return session;
      });
    });
  },

  /** Best-effort plan refresh.

      Order matters and it is the opposite of what it used to be. The Vercel
      checkpoint that 429s plain HTTP clients guards uppbeat.io itself, NOT
      prod-api.uppbeat.io — the account endpoint answers 200 to ordinary Node,
      so `me()` is the cheap, accurate first choice and opening Chrome is the
      fallback for when it genuinely cannot be reached. Going to the browser
      first cost seconds and, worse, its old success test accepted a guest
      session as signed in. A locally decodable JWT still short-circuits both,
      though live Uppbeat tokens are opaque so that path rarely fires. */
  refreshPlan: function () {
    const local = planFromSession(session.cookies);
    if (local) {
      session.plan = local;
      session.planError = null;
      session.signedIn = true;
      Uppbeat.saveSession();
      return Promise.resolve(session);
    }
    return Uppbeat.me().then(function (s) {
      /* me() resolves even when it failed, recording why in planError. Only a
         transport failure is worth paying for a browser round-trip; a clean
         "you are not signed in" is a final answer. */
      if (s && s.planError && s.planError !== SIGNED_OUT_MSG) {
        return Uppbeat.verifyInBrowser().catch(function () { return s; });
      }
      return s;
    }, function () {
      return Uppbeat.verifyInBrowser().catch(function () { return session; });
    });
  },

  /** Manual plan override — for when Uppbeat won't report the account level
      (e.g. /me is blocked) but you know it's paid. Passing a plan name like
      'creator' unlocks premium; 'auto'/'redetect' re-runs detection instead
      (used when you untick the override). */
  setPlan: function (plan) {    const name = String(plan == null ? '' : plan).trim().toLowerCase();
    if (name === 'auto' || name === 'redetect' || name === 'auto-redetect') {
      session.plan = 'free';
      Uppbeat.saveSession();
      return Uppbeat.refreshPlan();
    }
    session.plan = name || 'free';
    session.signedIn = true;
    Uppbeat.saveSession();
    return session;
  },

  /** Turn any pasted form into a single `k=v; k2=v2` Cookie header. */
  parseManualCookies: function (raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return '';
    const entries = [];

    function push(k, v) {
      k = String(k == null ? '' : k).trim();
      v = String(v == null ? '' : v).trim();
      if (!k) return;
      entries.push(k + '=' + v);
    }

    function fromPair(s) {
      s = String(s == null ? '' : s).trim().replace(/^['"]+|['"]+$/g, '');
      const eq = s.indexOf('=');
      if (eq < 1) return;
      push(s.slice(0, eq), s.slice(eq + 1));
    }

    function fromObject(o) {
      if (!o || typeof o !== 'object') return;
      if ('name' in o && 'value' in o) { push(o.name, o.value); return; }   // single cookie object
      const arr = Array.isArray(o) ? o : (Array.isArray(o.cookies) ? o.cookies : null);
      if (arr) {
        arr.forEach(function (c) {
          if (c && typeof c === 'object') {
            if ('name' in c) push(c.name, c.value);
            else Object.keys(c).forEach(function (k) { fromPair(k + ':' + JSON.stringify(c[k]).replace(/"/g, '')); });
          } else if (typeof c === 'string') { fromPair(c); }
        });
        return;
      }
      if (typeof o.cookies === 'string') { o.cookies.split(/[;\r\n]+/).forEach(fromPair); return; }
      Object.keys(o).forEach(function (k) {
        const v = o[k];
        if (v && typeof v === 'object') fromObject(v); else push(k, v);
      });
    }

    const first = text.charAt(0);
    if (first === '[' || first === '{') {
      let j = null;
      try { j = JSON.parse(text); } catch (e) { j = null; }
      if (j !== null) {
        fromObject(j);
        return entries.length ? entries.join('; ') : '';
      }
    }

    text.replace(/^Cookie:\s*/i, '').split(/[;\r\n]+/).forEach(fromPair);
    return entries.length ? entries.join('; ') : '';
  },

  /* --- API ---------------------------------------------------------------- */

  json: function (path, what, _attempt) {
    _attempt = _attempt || 0;
    const url = path.indexOf('http') === 0 ? path : API_BASE + path;
    return httpGet(url).then(function (res) {
      /* 429 is an IP-level limit at Uppbeat's edge (Vercel) — retrying just
         feeds it and extends the window. Only auto-retry transient 5xx. */
      if (res.status >= 500 && _attempt < 2) {
        return new Promise(function (resolve) { setTimeout(resolve, 2000 * (_attempt + 1)); })
          .then(function () { return Uppbeat.json(path, what, _attempt + 1); });
      }
      if (res.status !== 200) throw new Error(explainStatus(res.status, what || 'API', res));;
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
      const info = unwrapAccount(json);
      storeToken(json);
      if (!info.authed) {
        /* A 200 carrying is_authenticated:false is an answer, not a failure:
           the session is a guest one (or expired). Mark it signed-out so the UI
           shows the Sign-in gate instead of a session that reads free and 500s
           on every download. Network errors take the handler below instead. */
        session.signedIn = false;
        session.plan = 'free';
        session.account = null;
        session.planError = SIGNED_OUT_MSG;
        Uppbeat.saveSession();
        try { Paths.log('uppbeat: session is not signed in (setup_frontend is_authenticated=false) — marked signed-out'); } catch (x) {}
        return session;
      }
      const acct = info.account;
      session.account = {
        email: pick(acct, ['email', 'user.email']),
        name: pick(acct, ['name', 'displayName', 'username', 'firstName'])
      };
      /* readPlan gets the MERGED view (account + top-level subscriptionData),
         not the bare account — the plan fields do not travel with the account. */
      session.plan = readPlan(info.plan) || 'free';
      session.planError = null;
      session.signedIn = true;
      Uppbeat.saveSession();
      try { Paths.log('uppbeat: signed in as ' + (session.account.email || '?') + ' — plan ' + session.plan); } catch (x) {}
      return session;
    }, function (e) {
      /* Don't pretend a failed account check means "free" — surface it so the
         user can use the plan override instead of blaming the plan logic. */
      session.plan = 'free';
      session.planError = e.message;
      session.signedIn = true;
      Uppbeat.saveSession();
      try { Paths.log('uppbeat: account check failed — ' + e.message); } catch (x) {}
      return session;
    });
  },

  /** Read-only diagnostic for the account/plan state, so the raw response can
      be inspected (and pasted back when a path/session mismatch is suspected). */
  diagnose: function () {
    const ep = endpoints();
    const url = ep.account.indexOf('http') === 0 ? ep.account : API_BASE + ep.account;
    return httpGet(url).then(function (res) {
      let parsed = null;
      try { parsed = JSON.parse(res.body); } catch (e) {}
      const acct = parsed && (parsed.user || parsed.data || parsed);
      return {
        endpoint: url,
        status: res.status,
        server: (res.headers && res.headers.server) || '',
        retryAfter: (res.headers && res.headers['retry-after']) || '',
        signedIn: !!session.cookies,
        cookieNames: (session.cookies || '').split('; ').filter(Boolean)
          .map(function (c) { return c.split('=')[0]; }).join(', ') || '(none)',
        detectedPlan: readPlan(acct || {}),
        isPremium: Uppbeat.isPremium(),
        body: U.truncate(res.body || '', 700)
      };
    });
  },

  /**
   * Search the catalogue.
   * The rebuilt SPA searches a Typesense cluster client-side; we mirror that
   * with the same public key + collection ("tracks.v3", query_by "name, keywords").
   * @param {string} query
   * @param {object} opts { page, limit, genre, mood }
   */
  search: function (query, opts) {
    opts = opts || {};
    const limit = opts.limit || Config.get('uppbeatResultCount') || 30;
    const q = String(query || '').trim();
    const parts = ['q=' + encodeURIComponent(q),
                   'query_by=' + encodeURIComponent('name, keywords'),
                   'query_by_weights=' + encodeURIComponent('name:10, keywords:3'),
                   'exclude_fields=' + encodeURIComponent('embedding'),
                   'page=' + (opts.page || 1),
                   'per_page=' + limit,
                   'sort_by=' + encodeURIComponent('free_sort_score_v5:desc')];
    const url = TYPESENSE_BASE + '/collections/tracks.v3/documents/search?' + parts.join('&');

    return httpGet(url, {
      headers: { 'x-typesense-api-key': TYPESENSE_KEY, 'Origin': BASE, 'Referer': BASE + '/' }
    }).then(function (res) {
      if (res.status !== 200) throw new Error(explainStatus(res.status, 'search', res));
      let json;
      try { json = JSON.parse(res.body); } catch (e) { json = null; }
      const docs = (json && json.hits || []).map(function (h) { return h.document; });
      const tracks = docs.map(normalizeTrack).filter(Boolean);
      if (!tracks.length && docs.length) {
        Paths.log('uppbeat: search returned an unrecognised shape — ' + U.truncate(JSON.stringify(json), 400));
      }
      return tracks;
    });
  },

  /**
   * Browse a Uppbeat tab the way the SPA does — a curated multi_search against
   * the Typesense collections rather than the carousels JSON the site's pages
   * use (which MediaRade has no token-issue route for).
   * @param {string} tab  'music' | 'sfx' | 'trending' | 'luts'
   * @param {object} opts { page, limit, category }
   */
  browse: function (tab, opts) {
    opts = opts || {};
    const limit = opts.limit || Config.get('uppbeatResultCount') || 30;
    const page = opts.page || 1;
    const category = opts.category;

    const baseFilter = function (collection, extra) {
      const bits = [];
      if (collection === 'tracks.v3' && category) bits.push('featured_tags.slug:/music/category/' + encodeURIComponent(category));
      if (extra) bits.push(extra);
      return bits.length ? 'filter_by=' + encodeURIComponent(bits.join(' && ')) : '';
    };

    var searches = [];
    if (tab === 'sfx') {
      searches.push({ collection: 'sfx.v3', q: '*', sort_by: 'free_sort_score_v5:desc', per_page: limit, page: page, query_by: 'name, keywords', exclude_fields: 'embedding' });
    } else if (tab === 'trending') {
      searches.push({ collection: 'tracksTrending', q: '*', sort_by: 'trending_order:asc', per_page: limit, page: page, query_by: 'name, keywords', exclude_fields: 'embedding', filter_by: 'trending_category:=premium_top' });
    } else if (tab === 'luts') {
      searches.push({ collection: 'motiongraphics.v2', q: '*', sort_by: 'relevance_free:desc', per_page: limit, page: page, query_by: 'name, keywords', exclude_fields: 'embedding', filter_by: 'is_lut:true' });
    } else {
      const f = baseFilter('tracks.v3');
      searches.push({ collection: 'tracks.v3', q: '*', sort_by: 'free_sort_score_v5:desc', per_page: limit, page: page, query_by: 'name, keywords', query_by_weights: 'name:10, keywords:3', exclude_fields: 'embedding', filter_by: f || undefined });
    }

    return httpGet(TYPESENSE_BASE + '/multi_search', {
      method: 'POST',
      headers: { 'x-typesense-api-key': TYPESENSE_KEY, 'Origin': BASE, 'Referer': BASE + '/', 'Content-Type': 'application/json' },
      body: JSON.stringify({ searches: searches })
    }).then(function (res) {
      if (res.status !== 200) throw new Error(explainStatus(res.status, 'browse', res));
      let json;
      try { json = JSON.parse(res.body); } catch (e) { json = null; }
      const hits = (json && json.results && json.results[0] && json.results[0].hits) || [];
      const tracks = hits.map(function (h) { return h.document; }).map(normalizeTrack).filter(Boolean);
      if (!tracks.length && hits.length) {
        Paths.log('uppbeat: browse(' + tab + ') returned an unrecognised shape — ' + U.truncate(JSON.stringify(json), 400));
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
   * Resolve the actual audio URL for an asset, the way Uppbeat's own SPA does:
   *   GET /api/v1/track/{track_id}/download?format=mp3|wav
   *   GET /api/v1/sfx/{sfx_id}/variants/{variant_id}/download?format=…
   *   GET /api/v1/motion-graphics/{id}/download
   * answering { url, licenseCode, licenseId, pageUrl }. `url` is the real file;
   * licenseCode is the per-download code the credit block wants, so it is
   * returned alongside rather than thrown away.
   *
   * Auth is the `authorization_token` cookie and nothing else (see
   * sessionHeaders/v2Token). A 500 here means the credential was rejected —
   * this API answers 401 only when no credential is presented at all.
   * @returns {Promise<{url:string, licenseCode:string|null, pageUrl:string|null, licenseId:string|null}>}
   */
  resolveDownload: function (track) {
    const ep = endpoints();
    const kind = track.kind || 'track';
    const isSfx = kind === 'sfx' || String(kind).indexOf('sfx') > -1;
    const isMotion = /motion|lut/i.test(String(kind));

    let tpl = ep.download;
    if (isSfx && ep.downloadSfx) tpl = ep.downloadSfx;
    else if (isMotion && ep.downloadMotion) tpl = ep.downloadMotion;
    if (isSfx && !track.variantId) {
      return Promise.reject(new Error('This sound effect is missing its variant id, which Uppbeat\'s download endpoint requires. Re-run the search so the catalogue row is refreshed.'));
    }
    /* Uppbeat offers mp3 and wav only, and WAV is an ENTITLEMENT, not just a
       preference: an account without it gets 403 "Insufficient privileges" for
       ?format=wav while ?format=mp3 returns 200 (measured on this account).
       The panel's audioFormat setting is the YouTube/yt-dlp one (wav, flac,
       opus…), so mapping it straight through made every Uppbeat download fail
       for anyone whose global preference was wav. Ask for wav only when it is
       explicitly wanted, and fall back to mp3 when Uppbeat says no. */
    const want = String(Config.get('audioFormat') || 'mp3').toLowerCase();
    const first = want === 'wav' ? 'wav' : 'mp3';
    const base = fill(tpl, { id: track.id, variantId: track.variantId || '' });

    if (!session.cookies) {
      return Promise.reject(new Error('No Uppbeat session — press "Sign in" and import your session before downloading.'));
    }
    if (session.signedIn === false) return Promise.reject(new Error(SIGNED_OUT_MSG));
    /* The one check that would have saved all of this: a jar holding only a
       non-JWT `auth_token` cannot download, because the V2 API does not read
       that cookie and there is no JWT to send as Bearer. Refuse with an
       explanation rather than earning a 500. */
    if (!canAttemptDownload()) return Promise.reject(new Error(NO_V2_TOKEN_MSG));
    /* The token dates itself — don't spend a request to be told it is stale. */
    const life = downloadTokenLife();
    if (life && life.expired) return Promise.reject(new Error(expiredTokenMsg(life)));

    function attempt(format, allowFallback) {
      return httpGet(base + '?format=' + format, { follow: false, accept: 'application/json, audio/*, */*' })
      .then(function (res) {
        /* 403 here is "your plan does not include this FORMAT", not "no
           access to the track" — the same track returns 200 as mp3. Downgrade
           once and record it, rather than failing a download the account is
           perfectly entitled to. */
        if (res.status === 403 && allowFallback && format !== 'mp3') {
          try { Paths.log('uppbeat: ' + format + ' is not included in this plan (403) — retrying as mp3'); } catch (e) {}
          return attempt('mp3', false).then(function (r) {
            return Object.assign({}, r, { downgradedFrom: format });
          });
        }
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
          const loc = res.headers.location.indexOf('http') === 0
            ? res.headers.location : BASE + res.headers.location;
          return { url: loc, format: format, licenseCode: null, pageUrl: null, licenseId: null };
        }
        if (res.status !== 200) throw new Error(explainStatus(res.status, 'download', res));
        const ct = String((res.headers && res.headers['content-type']) || '').toLowerCase();
        const audioish = /audio|octet-stream|mpeg|mp3|wav|m4a/.test(ct);
        let json = null;
        try { json = JSON.parse(res.body); } catch (e) { json = null; }
        if (json && typeof json === 'object') {
          const link = pick(json, ['url', 'data.link', 'link', 'downloadUrl', 'download_url',
                                   'file', 'signedUrl', 'data.url', 'result', 'audioUrl']);
          if (link) {
            return {
              url: String(link),
              format: format,
              licenseCode: pick(json, ['licenseCode', 'license_code', 'data.licenseCode']) || null,
              pageUrl: pick(json, ['pageUrl', 'page_url', 'data.pageUrl']) || null,
              licenseId: pick(json, ['licenseId', 'license_id', 'data.licenseId']) || null
            };
          }
        }
        if (audioish) return { url: base + '?format=' + format, format: format,
                               licenseCode: null, pageUrl: null, licenseId: null };
        throw new Error('Uppbeat did not return a download URL for this track (HTTP ' + res.status +
                        ' ' + ct + '). Your plan may not cover it, or the download endpoint moved.');
      });
    }

    return attempt(first, true);
  },

  /**
   * Download one track into Documents\MediaRade\Downloads\Audio\Uppbeat.
   * Returns a cancellable promise -> { file, bytes, track, credit }.
   */
  download: function (track, onProgress) {
    const dir = CEP.path.join(Paths.dir('audio'), 'Uppbeat');

    let inner = null, resolved = null;
    const p = Uppbeat.resolveDownload(track).then(function (r) {
      resolved = r;
      /* Name the file after what Uppbeat ACTUALLY served. Asking for wav on a
         plan without it silently yields mp3, and a .wav named file holding mp3
         bytes breaks Premiere's import. */
      const ext = r.format === 'wav' ? 'wav' : 'mp3';
      const dest = Paths.unique(CEP.path.join(dir, U.slug(track.artist + ' - ' + track.title) + '.' + ext));
      inner = httpDownload(r.url, dest, onProgress);
      return inner;
    }).then(function (res) {
      /* Uppbeat issues the licence code with the download, not with the
         catalogue row — fold it into the track so the credit block and the
         attribution sidecar carry the real code instead of a placeholder. */
      const full = resolved && resolved.licenseCode
        ? Object.assign({}, track, { licenseCode: resolved.licenseCode,
                                     page: resolved.pageUrl || track.page })
        : track;
      return Object.assign({ track: full, credit: Uppbeat.credit(full),
                             licenseCode: (resolved && resolved.licenseCode) || null,
                             format: (resolved && resolved.format) || 'mp3',
                             downgradedFrom: (resolved && resolved.downgradedFrom) || null }, res);
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
