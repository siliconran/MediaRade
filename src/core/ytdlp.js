/* =============================================================================
   ytdlp.js — everything that talks to yt-dlp / ffmpeg. MediaRade by siliconran
   ========================================================================== */
import U from './util.js';
import Config from './config.js';
import Paths from './paths.js';
import Proc from './proc.js';
import Bus from './bus.js';
import { CEP } from './cep.js';

const P_TAG = '@@MRP@@';   // progress line marker
const F_TAG = '@@MRF@@';   // final filepath marker

/* Session-scoped cache of resolved preview streams, keyed "id|cap".
   The Player resolves a stream the moment a video is selected, so Play is
   instant; a fresh yt-dlp spawn (~seconds) would defeat that. YouTube's URLs
   stay valid for hours, so an 8-minute refresh is comfortably safe. */
const streamCache = {};
const STREAM_TTL = 8 * 60 * 1000;
const STREAM_MAX = 120;

export const YtDlp = {
  ytdlp: null,
  ffmpeg: null,
  version: null,

  /* --- discovery -------------------------------------------------------- */

  /** config path -> Documents\MediaRade\bin -> PATH. */
  locate: function () {
    const cfg = Config.all();
    const path = CEP.path;

    function pick(explicit, localName, cmdName) {
      if (explicit && Paths.exists(explicit)) return Promise.resolve(explicit);
      const local = path.join(Paths.dir('bin'), localName);
      if (Paths.exists(local)) return Promise.resolve(local);
      return Proc.which(cmdName);
    }

    return Promise.all([
      pick(cfg.ytdlpPath, 'yt-dlp.exe', 'yt-dlp'),
      pick(cfg.ffmpegPath, 'ffmpeg.exe', 'ffmpeg')
    ]).then(function (r) {
      YtDlp.ytdlp = r[0];
      YtDlp.ffmpeg = r[1];
      return YtDlp.probeVersion().then(function (v) {
        Bus.patch({ tools: { ytdlp: YtDlp.ytdlp, ytdlpVersion: v, ffmpeg: YtDlp.ffmpeg, checked: true } }, 'tools');
        return { ytdlp: YtDlp.ytdlp, ffmpeg: YtDlp.ffmpeg, version: v };
      });
    });
  },

  probeVersion: function () {
    if (!YtDlp.ytdlp) return Promise.resolve(null);
    return Proc.run(YtDlp.ytdlp, ['--version'], { timeout: 12000 })
      .then(function (r) {
        YtDlp.version = (r.stdout || '').trim().split(/\r?\n/)[0] || null;
        return YtDlp.version;
      })
      .catch(function () { return null; });
  },

  ready: function () { return !!YtDlp.ytdlp; },

  requireReady: function () {
    if (!YtDlp.ytdlp) {
      throw new Error('yt-dlp was not found. Open Settings and set its path, or install it so it is on PATH.');
    }
  },

  /** yt-dlp -U. Only meaningful for a standalone exe install. */
  selfUpdate: function () {
    YtDlp.requireReady();
    return Proc.run(YtDlp.ytdlp, ['-U'], { timeout: 120000 })
      .then(function (r) { return YtDlp.probeVersion().then(function () { return r.stdout + r.stderr; }); });
  },

  /* --- shared argument blocks ------------------------------------------- */

  /** Network/auth flags every invocation should carry. */
  commonArgs: function () {
    const cfg = Config.all(), a = ['--no-warnings', '--ignore-config', '--no-colors'];
    if (cfg.proxy) a.push('--proxy', cfg.proxy);
    if (cfg.cookiesFromBrowser) a.push('--cookies-from-browser', cfg.cookiesFromBrowser);
    if (YtDlp.ffmpeg) a.push('--ffmpeg-location', YtDlp.ffmpeg);
    // YouTube intermittently 403s the default (web) player client on media
    // downloads. Giving yt-dlp a client list lets it fall back when blocked;
    // android/tv serve the same streams and are far less likely to be throttled.
    a.push('--extractor-args', 'youtube:player_client=default,android,tv,web');
    // Since mid-2025 YouTube runs the "n" signature challenge on many streams.
    // Without a JS runtime + solver distribution yt-dlp cannot decrypt the n
    // parameter, and the resulting media URL comes back as HTTP 403 (or an
    // early SSL EOF). `node` is auto-detected once named, and ejs:github pulls
    // the solver script on demand. --force-ipv4 dodges flaky IPv6 media CDNs
    // that otherwise cut the connection mid-download.
    a.push('--js-runtimes', 'node', '--remote-components', 'ejs:github', '--force-ipv4');
    return a;
  },

  /**
   * Sample the public IP several times and report whether it holds still.
   *
   * This exists because a rotating exit IP is indistinguishable, from the
   * error text alone, from a YouTube bot check: both surface as HTTP 403 on
   * the media fetch. googlevideo signs every media URL against the IP that
   * requested it, so a VPN that hands out a different exit IP per connection
   * breaks downloads no matter what yt-dlp flags are used — the link is
   * fetched from one address and the bytes are asked for from another.
   *
   * @returns {Promise<{stable:boolean, ips:string[], sampled:number}>}
   */
  checkIpStability: function (samples) {
    const n = Math.max(2, Math.min(5, samples || 3));
    let https;
    try { https = CEP.require('https'); }
    catch (e) { return Promise.reject(new Error('Node is unavailable in this panel, so the connection check cannot run.')); }

    function once() {
      return new Promise(function (resolve) {
        const req = https.get({ hostname: 'api.ipify.org', path: '/', timeout: 12000,
                                headers: { 'User-Agent': 'MediaRade' } }, function (res) {
          let b = '';
          res.setEncoding('utf8');
          res.on('data', function (c) { b += c; });
          res.on('end', function () { resolve(String(b).trim() || null); });
        });
        req.on('timeout', function () { req.destroy(); resolve(null); });
        req.on('error', function () { resolve(null); });
      });
    }

    const seen = [];
    let chain = Promise.resolve();
    for (let i = 0; i < n; i++) {
      chain = chain.then(once).then(function (ip) { if (ip) seen.push(ip); });
    }
    return chain.then(function () {
      const uniq = seen.filter(function (v, i) { return seen.indexOf(v) === i; });
      return { stable: uniq.length <= 1, ips: uniq, sampled: seen.length };
    });
  },

  /* --- metadata --------------------------------------------------------- */

  /**
   * Full metadata for one video. This is the only call that can produce a
   * trustworthy licence verdict, because `license` only appears here.
   */
  info: function (urlOrId) {
    YtDlp.requireReady();
    const url = U.videoId(urlOrId) ? U.watchUrl(U.videoId(urlOrId)) : urlOrId;
    const args = YtDlp.commonArgs().concat([
      '-J', '--skip-download', '--no-playlist', url
    ]);
    return Proc.run(YtDlp.ytdlp, args, { timeout: 60000 }).then(function (r) {
      if (r.code !== 0) {
        throw new Error(YtDlp.explain(r.stderr) || ('yt-dlp exited ' + r.code));
      }
      let json;
      try { json = JSON.parse(r.stdout); }
      catch (e) { throw new Error('yt-dlp returned unreadable metadata for ' + url); }
      return json;
    });
  },

  /**
   * Search. `spUrl` (from SP.build) is preferred because it lets YouTube do
   * the Creative Commons filtering server-side; falls back to ytsearchN:.
   */
  /**
   * Read a playlist/channel page WHOLE — the top-level object as well as the
   * entries. `search` throws the envelope away, but a channel's name, handle,
   * avatar, banner and subscriber count only exist up there, so a channel
   * header cannot be built without it.
   */
  playlistPage: function (url, count) {
    YtDlp.requireReady();
    count = count || 30;
    const args = YtDlp.commonArgs().concat([
      '-J', '--flat-playlist', '--playlist-end', String(count), url
    ]);
    return Proc.run(YtDlp.ytdlp, args, { timeout: 90000 }).then(function (r) {
      if (r.code !== 0) throw new Error(YtDlp.explain(r.stderr) || ('channel read failed (exit ' + r.code + ')'));
      let json;
      try { json = JSON.parse(r.stdout); }
      catch (e) { throw new Error('yt-dlp returned unreadable channel data'); }
      return json || {};
    });
  },

  search: function (query, count, spUrl) {
    YtDlp.requireReady();
    count = count || 25;
    const target = spUrl || ('ytsearch' + count + ':' + query);
    const args = YtDlp.commonArgs().concat([
      '-J', '--flat-playlist', '--playlist-end', String(count), target
    ]);
    return Proc.run(YtDlp.ytdlp, args, { timeout: 90000 }).then(function (r) {
      if (r.code !== 0) throw new Error(YtDlp.explain(r.stderr) || ('search failed (exit ' + r.code + ')'));
      let json;
      try { json = JSON.parse(r.stdout); } catch (e) { throw new Error('search returned unreadable data'); }
      const entries = json.entries || (json.id ? [json] : []);
      return entries.filter(function (e) { return e && e.id; });
    });
  },

  /* --- format planning --------------------------------------------------- */

  /**
   * Turn UI choices into yt-dlp -f / postprocessor args.
   * opts: { kind:'video'|'audio', quality, container, audioFormat, audioQuality }
   */
  formatArgs: function (opts) {
    const cfg = Config.all(), a = [];

    if (opts.kind === 'audio') {
      const af = opts.audioFormat || cfg.audioFormat;
      a.push('-f', 'ba/bestaudio/best', '-x', '--audio-format', af,
             '--audio-quality', String(opts.audioQuality !== undefined ? opts.audioQuality : cfg.audioQuality));
      return a;
    }

    const q = opts.quality || cfg.videoQuality;
    const container = opts.container || cfg.videoContainer;
    const cap = (q === 'best') ? '' : '[height<=' + parseInt(q, 10) + ']';

    /* 'both' means one file with the picture and the sound muxed together, so
       every fallback must still carry audio — no video-only branch. Plain
       'video' keeps the video-only fallback for silent sources. */
    const mustHaveAudio = opts.kind === 'both';

    // Exclude AV1 — Premiere Pro does not support it in MP4/MOV containers.
    // Prefer H.264 (mp4) or H.265/HEVC as fallback; never AV1 or VP9 in mp4.
    const vc = '[vcodec!~="av01"]';
    let sel;
    if (container === 'mp4') {
      sel = 'bv*' + cap + vc + '[ext=mp4]+ba[ext=m4a]' +
            '/bv*' + cap + vc + '+ba' +
            '/b' + cap + vc + '[ext=mp4]' +
            '/b' + cap + vc +
            (mustHaveAudio ? '' : '/b' + cap);
    } else if (container === 'webm') {
      sel = 'bv*' + cap + '[ext=webm]+ba[ext=webm]/bv*' + cap + '+ba/b' + cap + (mustHaveAudio ? '' : '/b');
    } else {
      sel = 'bv*' + cap + vc + '+ba/b' + cap + vc + (mustHaveAudio ? '' : '/b' + cap);
    }
    a.push('-f', sel, '--merge-output-format', container === 'mkv' ? 'mkv' : container);
    return a;
  },

  /**
   * A directly playable stream URL for the in-panel preview.
   *
   * The YouTube iframe embed cannot work here: a CEP panel is loaded over
   * file://, so its origin is "null" and YouTube refuses the embed with
   * "Error 153 — Video player configuration error". Asking yt-dlp for a
   * progressive stream sidesteps the embed entirely and gives <video> a plain
   * MP4 it can play. The URL is short-lived and tied to this machine, which is
   * fine for a preview.
   *
   * @param {string} idOrUrl
   * @param {number} maxHeight  cap the preview resolution (default 720)
   * @returns {Promise<string>} a single media URL
   */
  streamUrl: function (idOrUrl, maxHeight) {
    YtDlp.requireReady();
    const id = U.videoId(idOrUrl);
    const url = id ? U.watchUrl(id) : idOrUrl;
    const cap = maxHeight || 720;
    const key = (id || url) + '|' + cap;

    const hit = streamCache[key];
    if (hit && (Date.now() - hit.at) < STREAM_TTL) return Promise.resolve(hit.url);

    // Progressive only: one file carrying both picture and sound. A split
    // bv+ba pair would print two URLs that <video> cannot combine.
    // Exclude AV1 — browsers in CEP/CEF may not hardware-decode it, causing
    // stutter. H.264 progressive streams are universally playable.
    const PRIMARY = 'b[ext=mp4][vcodec^=avc1][acodec!=none][height<=' + cap + ']' +
                    '/b[ext=mp4][vcodec!~="av01"][acodec!=none][height<=' + cap + ']' +
                    '/b[vcodec!~="av01"][acodec!=none][height<=' + cap + ']' +
                    '/b[ext=mp4][vcodec^=avc1][acodec!=none]' +
                    '/b[ext=mp4][vcodec!~="av01"][acodec!=none]' +
                    '/b[vcodec!~="av01"][acodec!=none]' +
                    '/b[ext=mp4][acodec!=none]' +
                    '/b[acodec!=none]';
    // Last resort: a video whose only "progressive" stream the strict chain
    // rejects (e.g. AV1-only, or a codec CEF cannot decode) still deserves a
    // preview attempt. Bare `b` can also hand back a video-only stream, which
    // plays picture with no sound — better than nothing in the panel.
    const FALLBACK = 'b[acodec!=none]/b';

    const selectors = [PRIMARY, FALLBACK];
    let firstFail = null;

    const attempt = function (i) {
      const args = YtDlp.commonArgs().concat(['-g', '-f', selectors[i], '--no-playlist', url]);
      return Proc.run(YtDlp.ytdlp, args, { timeout: 30000 }).then(function (r) {
        const urls = (r.stdout || '').split(/\r?\n/)
          .map(function (s) { return s.trim(); })
          .filter(function (s) { return s.indexOf('http') === 0; });
        if (r.code !== 0 || !urls.length) {
          if (!firstFail) {
            firstFail = YtDlp.explain(r.stderr) ||
              'No stream could be resolved for this video, so it cannot be previewed in the panel.';
          }
          if (i + 1 < selectors.length) return attempt(i + 1);
          throw new Error(firstFail);
        }
        streamCache[key] = { url: urls[0], at: Date.now() };
        const keys = Object.keys(streamCache);
        if (keys.length > STREAM_MAX) {
          keys.sort(function (a, b) { return streamCache[a].at - streamCache[b].at; })
            .slice(0, keys.length - STREAM_MAX)
            .forEach(function (k) { delete streamCache[k]; });
        }
        return urls[0];
      });
    };

    return attempt(0);
  },

  /**
   * Can this job's output container hold an embedded thumbnail?
   * yt-dlp's supported set: mp3, mkv/mka, ogg/opus/flac, m4a/mp4/m4v/mov.
   */
  supportsThumbnail: function (job) {
    const cfg = Config.all();
    if (job.kind === 'audio') {
      const af = String(job.audioFormat || cfg.audioFormat || '').toLowerCase();
      return ['mp3', 'm4a', 'flac', 'opus', 'ogg', 'mka'].indexOf(af) > -1;
    }
    const container = String(job.container || cfg.videoContainer || '').toLowerCase();
    return ['mp4', 'mkv', 'm4v', 'mov'].indexOf(container) > -1;
  },

  /**
   * Compose the full download argv.
   * job: { url,id,kind,outDir,outName,quality,container,audioFormat,
   *        sectionStart,sectionEnd,writeSubs,subLangs,thumbnail,sponsorblock }
   */
  downloadArgs: function (job) {
    const cfg = Config.all(), path = CEP.path;
    let a = YtDlp.commonArgs();

    a.push('--newline', '--no-quiet', '--no-simulate', '--progress',
           '--progress-template',
           'download:' + P_TAG + '%(progress.status)s|%(progress.downloaded_bytes)s|' +
           '%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s',
           '--print', 'after_move:' + F_TAG + '%(filepath)s');

    a.push('--no-playlist', '--no-overwrites', '--no-part',
           '--retries', '6', '--fragment-retries', '10',
           '--concurrent-fragments', String(cfg.concurrentFragments || 4));

    if (cfg.rateLimit) a.push('--limit-rate', cfg.rateLimit);
    if (cfg.restrictFilenames) a.push('--restrict-filenames');

    a = a.concat(YtDlp.formatArgs(job));

    // clip range — keyframe-accurate cuts cost a re-encode of the edges only
    if (job.sectionStart !== null && job.sectionStart !== undefined && job.sectionEnd) {
      a.push('--download-sections', '*' + job.sectionStart + '-' + job.sectionEnd,
             '--force-keyframes-at-cuts');
    }

    if (job.sponsorblock || cfg.sponsorblockRemove) {
      a.push('--sponsorblock-remove', job.sponsorblock || cfg.sponsorblockRemove);
    }

    if (cfg.embedMetadata) a.push('--embed-metadata');
    if (cfg.embedChapters && job.kind === 'video') a.push('--embed-chapters');

    // Only containers that can actually carry cover art. yt-dlp aborts the whole
    // job in post-processing otherwise, and WAV — our default audio format — is
    // one of the containers that cannot.
    if (cfg.embedThumbnail && YtDlp.supportsThumbnail(job)) a.push('--embed-thumbnail');

    if (job.thumbnail !== false) a.push('--write-thumbnail', '--convert-thumbnails', 'jpg');

    if (job.writeSubs || cfg.writeSubs) {
      a.push('--write-subs', '--sub-langs', job.subLangs || cfg.subLangs || 'en', '--convert-subs', 'srt');
    }

    const template = path.join(job.outDir, (job.outName || cfg.filenameTemplate) + '.%(ext)s');
    a.push('-o', template);
    a.push('-o', 'thumbnail:' + path.join(Paths.dir('thumbs'), (job.outName || cfg.filenameTemplate) + '.%(ext)s'));
    if (job.writeSubs || cfg.writeSubs) {
      a.push('-o', 'subtitle:' + path.join(Paths.dir('subs'), (job.outName || cfg.filenameTemplate) + '.%(ext)s'));
    }

    a.push(job.url);
    return a;
  },

  /**
   * Run a download. onProgress({percent,downloaded,total,speed,eta,status}).
   * Returns a cancellable promise resolving to { files, mediaFile, log }.
   */
  download: function (job, onProgress) {
    YtDlp.requireReady();
    Paths.ensureDir(job.outDir);

    const args = YtDlp.downloadArgs(job);
    const files = [], logLines = [];

    Paths.log('download ' + job.url + '\n  ' + args.join(' '));

    function line(l) {
      if (!l) return;
      if (l.indexOf(P_TAG) === 0) {
        const f = l.slice(P_TAG.length).split('|');
        const num = function (v) { const n = parseFloat(v); return isNaN(n) ? null : n; };
        const dl = num(f[1]), total = num(f[2]) || num(f[3]);
        let pct = (dl !== null && total) ? U.clamp((dl / total) * 100, 0, 100) : null;
        if (pct === null && num(f[6]) && num(f[7])) pct = (num(f[6]) / num(f[7])) * 100;
        if (onProgress) onProgress({
          status: f[0], downloaded: dl, total: total,
          speed: num(f[4]), eta: num(f[5]), percent: pct
        });
        return;
      }
      if (l.indexOf(F_TAG) === 0) { files.push(l.slice(F_TAG.length).trim()); return; }
      if (logLines.length < 400) logLines.push(l);
      // post-processing has no byte progress; surface the phase instead
      if (/\[(Merger|ExtractAudio|EmbedThumbnail|Metadata|SponsorBlock|VideoConvertor|ModifyChapters|FixupM3u8)\]/.test(l)) {
        if (onProgress) onProgress({ status: 'processing', phase: l.replace(/^\[|\].*$/g, ''), percent: null });
      }
    }

    const p = Proc.run(YtDlp.ytdlp, args, { onStdout: line, onStderr: line });

    const wrapped = p.then(function (r) {
      if (r.killed) { const e = new Error('canceled'); e.canceled = true; throw e; }
      if (r.code !== 0) {
        throw new Error(YtDlp.explain(r.stderr) || ('yt-dlp exited ' + r.code + ': ' + logLines.slice(-3).join(' | ')));
      }
      // --no-overwrites means an existing file yields no after_move print
      if (!files.length) {
        const m = (r.stdout + r.stderr).match(/\[download\]\s+(.+?)\s+has already been downloaded/);
        if (m) files.push(m[1].trim());
      }
      const media = files.filter(function (f) { return !/\.(jpg|png|webp|srt|vtt)$/i.test(f); });
      return { files: files, mediaFile: media[0] || files[0] || null, log: logLines.join('\n') };
    });

    wrapped.cancel = p.cancel;
    return wrapped;
  },

  /** Turn yt-dlp's stderr into something a human can act on. */
  explain: function (stderr) {
    const s = String(stderr || '');
    if (!s.trim()) return null;
    const rules = [
      [/Sign in to confirm your age|age-restricted/i,
       'This video is age-restricted. Set "Cookies from browser" in Settings to a browser where you are signed in.'],
      [/Sign in to confirm (that )?you.?re not a bot|cookies are no longer valid/i,
       'YouTube is challenging this request. Set "Cookies from browser" in Settings, or try again later.'],
      [/Private video/i, 'This video is private.'],
      [/Video unavailable/i, 'This video is unavailable (removed, region-blocked, or the ID is wrong).'],
      [/members-only|join this channel/i, 'This video is members-only.'],
      [/is not a valid URL/i, 'That does not look like a valid YouTube URL or video ID.'],
      [/ffmpeg (is )?not (found|installed)|ffmpeg-location/i,
       'ffmpeg is required for this format. Install it or set its path in Settings.'],
      [/HTTP Error 429|Too Many Requests/i, 'YouTube is rate-limiting you. Wait a few minutes, or set a rate limit in Settings.'],
      [/HTTP Error 403|HTTP 403/i,
       'YouTube refused the media data (HTTP 403). The usual cause is NOT a bot check: googlevideo ties every ' +
       'media URL to the IP that asked for it, so if your connection changes IP between fetching the link and ' +
       'downloading it — a VPN or proxy with rotating exit IPs does exactly that — every chunk after the ' +
       'first is refused. The giveaway: very short clips download fine while anything past a few seconds ' +
       'fails, because a short file finishes inside one IP window. Press "Check connection" in Settings ' +
       'to see whether your IP is stable. If it is ' +
       'rotating, switch the VPN to a static/dedicated IP or turn it off while downloading. If your IP IS ' +
       'stable, then it is a bot check: install Node.js so yt-dlp can solve the "n" challenge, or set ' +
       '"Cookies from browser" in Settings.'],
      /* An SSL EOF mid-transfer is the connection being cut underneath the
         download, not a TLS misconfiguration. On a proxy/VPN that hands out a
         different exit IP per connection it is the same underlying problem as
         the 403: googlevideo drops a transfer that arrives from an address the
         URL was not signed for. Unmatched, this fell through to the raw yt-dlp
         line, which told the user nothing. */
      [/UNEXPECTED_EOF_WHILE_READING|EOF occurred in violation of protocol|SSLError|ConnectionResetError|Connection aborted|IncompleteRead/i,
       'The connection was cut partway through the download (SSL EOF). That usually means the route to ' +
       'YouTube changed mid-transfer — a VPN or proxy with rotating exit IPs does exactly that. Press ' +
       '"Check connection" in Settings: if it lists more than one IP, switch to a static/dedicated IP or ' +
       'turn the VPN off while downloading. Otherwise it is ordinary network instability — retry.'],
      [/Unable to download webpage|getaddrinfo|ENOTFOUND|timed out/i, 'Network error reaching YouTube.'],
      [/Requested format is not available/i, 'That quality is not available for this video. Try a lower cap or "Best".'],
      [/No space left|ENOSPC/i, 'The drive is full.']
    ];
    for (let i = 0; i < rules.length; i++) if (rules[i][0].test(s)) return rules[i][1];
    const err = s.split(/\r?\n/).filter(function (l) { return /^ERROR/i.test(l); })[0];
    return err ? err.replace(/^ERROR:\s*/i, '') : null;
  }
};

export default YtDlp;
