/* =============================================================================
   ytdlp.js — everything that talks to yt-dlp / ffmpeg. MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var P_TAG = '@@MRP@@';   // progress line marker
  var F_TAG = '@@MRF@@';   // final filepath marker

  var YtDlp = {
    ytdlp: null,
    ffmpeg: null,
    version: null,

    /* --- discovery -------------------------------------------------------- */

    /** config path -> Documents\MediaRade\bin -> PATH. */
    locate: function () {
      var cfg = Config.all();
      var path = CEP.path;

      function pick(explicit, localName, cmdName) {
        if (explicit && Paths.exists(explicit)) return Promise.resolve(explicit);
        var local = path.join(Paths.dir('bin'), localName);
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
      var cfg = Config.all(), a = ['--no-warnings', '--ignore-config', '--no-colors'];
      if (cfg.proxy) a.push('--proxy', cfg.proxy);
      if (cfg.cookiesFromBrowser) a.push('--cookies-from-browser', cfg.cookiesFromBrowser);
      if (YtDlp.ffmpeg) a.push('--ffmpeg-location', YtDlp.ffmpeg);
      a.push('--js-runtimes', 'node', '--remote-components', 'ejs:github', '--force-ipv4');
      return a;
    },

    /* --- metadata --------------------------------------------------------- */

    /**
     * Full metadata for one video. This is the only call that can produce a
     * trustworthy licence verdict, because `license` only appears here.
     */
    info: function (urlOrId) {
      YtDlp.requireReady();
      var url = U.videoId(urlOrId) ? U.watchUrl(U.videoId(urlOrId)) : urlOrId;
      var args = YtDlp.commonArgs().concat([
        '-J', '--skip-download', '--no-playlist', url
      ]);
      return Proc.run(YtDlp.ytdlp, args, { timeout: 60000 }).then(function (r) {
        if (r.code !== 0) {
          throw new Error(YtDlp.explain(r.stderr) || ('yt-dlp exited ' + r.code));
        }
        var json;
        try { json = JSON.parse(r.stdout); }
        catch (e) { throw new Error('yt-dlp returned unreadable metadata for ' + url); }
        return json;
      });
    },

    /**
     * Search. `spUrl` (from SP.build) is preferred because it lets YouTube do
     * the Creative Commons filtering server-side; falls back to ytsearchN:.
     */
    search: function (query, count, spUrl) {
      YtDlp.requireReady();
      count = count || 25;
      var target = spUrl || ('ytsearch' + count + ':' + query);
      var args = YtDlp.commonArgs().concat([
        '-J', '--flat-playlist', '--playlist-end', String(count), target
      ]);
      return Proc.run(YtDlp.ytdlp, args, { timeout: 90000 }).then(function (r) {
        if (r.code !== 0) throw new Error(YtDlp.explain(r.stderr) || ('search failed (exit ' + r.code + ')'));
        var json;
        try { json = JSON.parse(r.stdout); } catch (e) { throw new Error('search returned unreadable data'); }
        var entries = json.entries || (json.id ? [json] : []);
        return entries.filter(function (e) { return e && e.id; });
      });
    },

    /* --- format planning --------------------------------------------------- */

    /**
     * Turn UI choices into yt-dlp -f / postprocessor args.
     * opts: { kind:'video'|'audio', quality, container, audioFormat, audioQuality }
     */
    formatArgs: function (opts) {
      var cfg = Config.all(), a = [];

      if (opts.kind === 'audio') {
        var af = opts.audioFormat || cfg.audioFormat;
        a.push('-f', 'ba/bestaudio/best', '-x', '--audio-format', af,
               '--audio-quality', String(opts.audioQuality !== undefined ? opts.audioQuality : cfg.audioQuality));
        return a;
      }

      var q = opts.quality || cfg.videoQuality;
      var container = opts.container || cfg.videoContainer;
      var cap = (q === 'best') ? '' : '[height<=' + parseInt(q, 10) + ']';

      // Prefer a stream set that remuxes cleanly into the chosen container.
      var sel;
      if (container === 'mp4') {
        sel = 'bv*' + cap + '[ext=mp4]+ba[ext=m4a]/bv*' + cap + '+ba/b' + cap + '[ext=mp4]/b' + cap + '/b';
      } else if (container === 'webm') {
        sel = 'bv*' + cap + '[ext=webm]+ba[ext=webm]/bv*' + cap + '+ba/b' + cap + '/b';
      } else {
        sel = 'bv*' + cap + '+ba/b' + cap + '/b';
      }
      a.push('-f', sel, '--merge-output-format', container === 'mkv' ? 'mkv' : container);
      return a;
    },

    /**
     * Compose the full download argv.
     * job: { url,id,kind,outDir,outName,quality,container,audioFormat,
     *        sectionStart,sectionEnd,writeSubs,subLangs,thumbnail,sponsorblock }
     */
    downloadArgs: function (job) {
      var cfg = Config.all(), path = CEP.path;
      var a = YtDlp.commonArgs();

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
      if (cfg.embedThumbnail) a.push('--embed-thumbnail');

      if (job.thumbnail !== false) a.push('--write-thumbnail', '--convert-thumbnails', 'jpg');

      if (job.writeSubs || cfg.writeSubs) {
        a.push('--write-subs', '--sub-langs', job.subLangs || cfg.subLangs || 'en', '--convert-subs', 'srt');
      }

      var template = path.join(job.outDir, (job.outName || cfg.filenameTemplate) + '.%(ext)s');
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

      var args = YtDlp.downloadArgs(job);
      var files = [], logLines = [];

      Paths.log('download ' + job.url + '\n  ' + args.join(' '));

      function line(l) {
        if (!l) return;
        if (l.indexOf(P_TAG) === 0) {
          var f = l.slice(P_TAG.length).split('|');
          var num = function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; };
          var dl = num(f[1]), total = num(f[2]) || num(f[3]);
          var pct = (dl !== null && total) ? U.clamp((dl / total) * 100, 0, 100) : null;
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

      var p = Proc.run(YtDlp.ytdlp, args, { onStdout: line, onStderr: line });

      var wrapped = p.then(function (r) {
        if (r.killed) { var e = new Error('canceled'); e.canceled = true; throw e; }
        if (r.code !== 0) {
          throw new Error(YtDlp.explain(r.stderr) || ('yt-dlp exited ' + r.code + ': ' + logLines.slice(-3).join(' | ')));
        }
        // --no-overwrites means an existing file yields no after_move print
        if (!files.length) {
          var m = (r.stdout + r.stderr).match(/\[download\]\s+(.+?)\s+has already been downloaded/);
          if (m) files.push(m[1].trim());
        }
        var media = files.filter(function (f) { return !/\.(jpg|png|webp|srt|vtt)$/i.test(f); });
        return { files: files, mediaFile: media[0] || files[0] || null, log: logLines.join('\n') };
      });

      wrapped.cancel = p.cancel;
      return wrapped;
    },

    /** Turn yt-dlp's stderr into something a human can act on. */
    explain: function (stderr) {
      var s = String(stderr || '');
      if (!s.trim()) return null;
      var rules = [
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
        [/Unable to download webpage|getaddrinfo|ENOTFOUND|timed out/i, 'Network error reaching YouTube.'],
        [/Requested format is not available/i, 'That quality is not available for this video. Try a lower cap or "Best".'],
        [/No space left|ENOSPC/i, 'The drive is full.']
      ];
      for (var i = 0; i < rules.length; i++) if (rules[i][0].test(s)) return rules[i][1];
      var err = s.split(/\r?\n/).filter(function (l) { return /^ERROR/i.test(l); })[0];
      return err ? err.replace(/^ERROR:\s*/i, '') : null;
    }
  };

  global.YtDlp = YtDlp;
})(window);
