/* =============================================================================
   views/settings.js — setup, policy, diagnostics. MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var root, body;

  function row(label, control, hint) {
    return U.el('div', { style: { marginBottom: '10px' } }, [
      U.el('div', { class: 'mr-field__label', style: { marginBottom: '3px' }, text: label }),
      control,
      hint ? U.el('div', { class: 'ps2-caption', style: { marginTop: '3px' }, html: hint }) : null
    ]);
  }

  function textInput(key, placeholder) {
    var i = U.el('input', { class: 'ps2-input', type: 'text', value: Config.get(key) || '', placeholder: placeholder || '' });
    i.addEventListener('change', function () { Config.set(key, i.value.trim()); });
    return i;
  }

  function numInput(key, min, max) {
    var i = U.el('input', { class: 'ps2-input', type: 'number', min: min, max: max, value: Config.get(key) });
    i.addEventListener('change', function () {
      Config.set(key, U.clamp(parseInt(i.value, 10) || min, min, max));
      i.value = Config.get(key);
    });
    return i;
  }

  function toggle(key, label, hint, onchange) {
    return U.el('div', { style: { marginBottom: '8px' } }, [
      C.switch_(label, Config.get(key), function (on) {
        Config.set(key, on);
        if (onchange) onchange(on);
      }),
      hint ? U.el('div', { class: 'ps2-caption', style: { marginTop: '2px', marginLeft: '44px' }, html: hint }) : null
    ]);
  }

  function panel(title, children, badge) {
    return U.el('div', { class: 'ps2-panel', style: { marginBottom: '14px' } }, [
      U.el('div', { class: 'ps2-panel__header' }, [
        U.el('span', { class: 'ps2-panel__title', text: title }),
        U.el('span', { class: 'ps2-panel__spacer' }),
        badge || null
      ]),
      U.el('div', {}, children)
    ]);
  }

  var SettingsView = {

    init: function () {
      root = U.$('.mr-view[data-view="settings"]');
      body = U.el('div', { class: 'mr-view__body' });
      root.appendChild(body);

      Bus.on('tools', function () { if (State.view === 'settings') SettingsView.render(); });
      Bus.on('view', function (v) { if (v === 'settings') SettingsView.render(); });

      SettingsView.render();
    },

    render: function () {
      if (!body) return;
      U.clear(body);
      U.append(body, [
        SettingsView.licensing(),
        SettingsView.tools(),
        SettingsView.downloads(),
        SettingsView.premiere(),
        SettingsView.storage(),
        SettingsView.diagnostics(),
        SettingsView.about()
      ]);
    },

    /* --- licence policy ----------------------------------------------------- */

    licensing: function () {
      var strict = Config.get('strictMode');

      var strictSwitch = C.switch_('Strict mode', strict, function (on) {
        if (on) {
          Config.setStrict(true);
          Toast.ok('Strict mode on', 'Only machine-verified Creative Commons material can be downloaded.');
          SettingsView.render();
          Bus.emit('config', { strictMode: true });
          return;
        }
        // turning it off is the dangerous direction — make it deliberate
        Modal.confirm({
          title: 'Turn strict mode off?',
          danger: true,
          okLabel: 'Turn it off',
          cancelLabel: 'Keep it on',
          body:
            'Strict mode is what stops a mislabelled "royalty free" upload reaching your timeline. ' +
            'With it off, MediaRade will still verify and still flag every problem — but it will let you ' +
            'override a verdict after you record a written reason.<br><br>' +
            '<b>The change itself is written to the ledger</b>, along with every override that follows. ' +
            'Only do this for material you actually have the rights to.'
        }).then(function (yes) {
          if (!yes) { SettingsView.render(); return; }
          Modal.prompt({
            title: 'Reason for disabling strict mode',
            text: 'This goes in the ledger.',
            placeholder: 'e.g. "Licensed archive footage cleared by production"'
          }).then(function (reason) {
            if (!reason) { SettingsView.render(); return; }
            Config.setStrict(false, reason);
            Toast.warn('Strict mode off', 'Overrides are now possible, and every one is logged.');
            SettingsView.render();
            Bus.emit('config', { strictMode: false });
          });
        });
      });

      return panel('Licence policy', [
        U.el('div', { class: 'mr-claimwarn', style: strict ? {
            color: 'var(--ps2-ok)', background: 'rgba(69,214,127,0.07)',
            borderColor: 'rgba(69,214,127,0.3)', borderLeftColor: 'var(--ps2-ok)'
          } : {} }, [
          U.el('span', { text: strict ? '🔒' : '⚠' }),
          U.el('span', { html: strict
            ? 'Downloads are limited to uploads whose <b>YouTube licence field</b> reports Creative Commons ' +
              'and that carry no critical flags. Everything else is refused.'
            : '<b>Strict mode is off.</b> Verdicts are still produced and still shown, but you can override ' +
              'them. Each override needs a written reason and lands in the ledger.' })
        ]),
        U.el('div', { style: { height: '10px' } }),
        strictSwitch,
        U.el('div', { style: { height: '12px' } }),
        row('Search + download policy', (function () {
          var sel = C.select([
            { value: 'cc', label: 'Creative Commons only' },
            { value: 'claim', label: 'Royalty free (claims allowed)' },
            { value: 'all', label: 'Everything (no gate)' }
          ], strict ? 'cc' : Config.get('licenseMode'), function (v) {
            Config.set('licenseMode', v);
            Toast.ok('Policy set', License.modeLabel());
            SettingsView.render();
            Bus.emit('config', { licenseMode: v });
          }, { title: strict ? 'Locked while strict mode is on' : 'Sets the search filter and the download gate together' });
          sel.disabled = !!strict;
          return sel;
        })(), strict
          ? 'Locked on by strict mode, which only admits machine-verified Creative Commons. Turn strict mode off to enable the other presets.'
          : '<b>Creative Commons only</b> — verified CC BY 3.0 and nothing else. <b>Royalty free</b> — a clean "royalty free" claim passes, but a contradiction with the licence field still blocks. <b>Everything</b> — no gate, warnings only.'),
        toggle('autoVerify', 'Verify every search result automatically',
          'Off means results stay unverified until you open or download them — faster searches, no verdicts up front.'),
        toggle('requireAckPhrase', 'Require the typed acknowledgement for overrides',
          'Forces "I ACCEPT THE RISK" to be typed before a blocked download can proceed.'),
        toggle('writeSidecars', 'Write .license.json and attribution.txt beside each download'),
        toggle('writeCredits', 'Append every credit to Compliance\\CREDITS.md'),
        toggle('stampMarker', 'Stamp a timeline marker with the attribution on insert'),
        toggle('ledgerEnabled', 'Keep the append-only compliance ledger'),
        row('Verification concurrency', numInput('verifyConcurrency', 1, 8),
          'Parallel metadata fetches. Too high invites YouTube rate-limiting.')
      ], C.badge(strict ? 'strict' : 'permissive', strict ? 'ok' : 'crit'));
    },

    /* --- binaries ----------------------------------------------------------- */

    tools: function () {
      var t = State.tools;

      var status = U.el('div', { class: 'mr-meta-grid', style: { marginBottom: '10px' } }, [
        U.el('dt', { text: 'yt-dlp' }),
        U.el('dd', { text: t.ytdlp ? t.ytdlp + (t.ytdlpVersion ? '  (' + t.ytdlpVersion + ')' : '') : 'NOT FOUND',
                     style: { color: t.ytdlp ? 'var(--ps2-ok)' : 'var(--ps2-crit)' } }),
        U.el('dt', { text: 'ffmpeg' }),
        U.el('dd', { text: t.ffmpeg || 'NOT FOUND',
                     style: { color: t.ffmpeg ? 'var(--ps2-ok)' : 'var(--ps2-warn)' } }),
        U.el('dt', { text: 'Node' }),
        U.el('dd', { text: CEP.nodeAvailable ? 'available' : 'UNAVAILABLE — the panel cannot run yt-dlp',
                     style: { color: CEP.nodeAvailable ? 'var(--ps2-ok)' : 'var(--ps2-crit)' } })
      ]);

      return panel('Tooling', [
        status,
        U.el('div', { class: 'ps2-row-gap ps2-wrap', style: { marginBottom: '12px' } }, [
          C.btn('Re-detect', { size: 'sm', variant: 'primary', onclick: function () {
            YtDlp.locate().then(function (r) {
              Toast[r.ytdlp ? 'ok' : 'err'](r.ytdlp ? 'Found yt-dlp' : 'yt-dlp not found',
                r.ytdlp || 'Install it, or drop yt-dlp.exe in Documents\\MediaRade\\bin.');
              SettingsView.render();
            });
          } }),
          C.btn('Update yt-dlp', { size: 'sm', onclick: function () {
            if (!YtDlp.ready()) { Toast.err('Nothing to update', 'yt-dlp was not found.'); return; }
            var n = Toast.show({ kind: 'info', title: 'Updating yt-dlp…', text: 'This can take a minute.', sticky: true });
            YtDlp.selfUpdate().then(function (out) {
              n.close(); Toast.ok('yt-dlp updated', (YtDlp.version || '') + ' — ' + U.truncate(out.trim().split('\n').pop(), 70));
              SettingsView.render();
            }).catch(function (e) { n.close(); Toast.err('Update failed', e.message); });
          } }),
          C.btn('bin folder', { size: 'sm', variant: 'ghost',
            onclick: function () { CEP.openFolder(Paths.dir('bin')); } })
        ]),
        row('yt-dlp path', textInput('ytdlpPath', 'blank = auto-detect (bin\\ then PATH)'),
          'MediaRade looks in <code>Documents\\MediaRade\\bin\\yt-dlp.exe</code> first, then your PATH.'),
        row('ffmpeg path', textInput('ffmpegPath', 'blank = auto-detect'),
          'Required for merging video+audio streams and for any audio conversion.'),
        row('Cookies from browser', C.select(
          [{ value: '', label: 'none' }, 'chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium'],
          Config.get('cookiesFromBrowser'), function (v) { Config.set('cookiesFromBrowser', v); }),
          'Needed for age-restricted videos and when YouTube challenges the request. Uses your signed-in session.'),
        row('Proxy', textInput('proxy', 'http://host:port  or  socks5://host:port')),
        row('Rate limit', textInput('rateLimit', 'e.g. 2M — blank for unlimited'),
          'Throttling downloads makes rate-limiting far less likely on long sessions.')
      ], C.badge(t.ytdlp ? 'ready' : 'not ready', t.ytdlp ? 'ok' : 'crit'));
    },

    /* --- download defaults --------------------------------------------------- */

    downloads: function () {
      return panel('Download defaults', [
        U.el('div', { class: 'mr-optgrid', style: { marginBottom: '12px' } }, [
          C.field('Video quality', C.select(
            [{ value: 'best', label: 'Best available' }, { value: '2160', label: '2160p (4K)' },
             { value: '1440', label: '1440p' }, { value: '1080', label: '1080p' },
             { value: '720', label: '720p' }, { value: '480', label: '480p' }],
            Config.get('videoQuality'), function (v) { Config.set('videoQuality', v); })),
          C.field('Container', C.select(['mp4', 'mkv', 'webm'], Config.get('videoContainer'),
            function (v) { Config.set('videoContainer', v); })),
          C.field('Audio format', C.select(
            [{ value: 'wav', label: 'WAV' }, { value: 'flac', label: 'FLAC' }, { value: 'm4a', label: 'M4A' },
             { value: 'mp3', label: 'MP3' }, { value: 'opus', label: 'Opus' }],
            Config.get('audioFormat'), function (v) { Config.set('audioFormat', v); })),
          C.field('Results per search', numInput('resultCount', 5, 100)),
          C.field('Parallel downloads', numInput('concurrentDownloads', 1, 6)),
          C.field('Fragments per download', numInput('concurrentFragments', 1, 16))
        ]),
        toggle('embedMetadata', 'Embed metadata in the file'),
        toggle('embedThumbnail', 'Embed the poster frame'),
        toggle('embedChapters', 'Embed chapters'),
        toggle('writeSubs', 'Download subtitles by default'),
        row('Subtitle languages', textInput('subLangs', 'en,en-GB')),
        row('SponsorBlock segments to remove', textInput('sponsorblockRemove', 'sponsor,selfpromo,interaction'),
          'Blank disables it. Applies to every download; the Video view can also set it per clip.'),
        row('Filename template', textInput('filenameTemplate', '%(title)s [%(id)s]'),
          'yt-dlp output template. The extension is appended automatically.'),
        toggle('restrictFilenames', 'Restrict filenames to ASCII',
          'Useful if your storage or NLE chokes on unicode filenames.')
      ]);
    },

    /* --- premiere ------------------------------------------------------------ */

    premiere: function () {
      var seq = State.sequence;
      return panel('Premiere', [
        row('Project bin name', textInput('binName', 'MediaRade'),
          'Downloads are imported into this bin, colour-coded by licence verdict.'),
        toggle('autoImport', 'Import to the project as soon as a download finishes'),
        toggle('selectAfterInsert', 'Select the clip after inserting'),
        U.el('div', { class: 'mr-optgrid', style: { marginBottom: '12px' } }, [
          C.field('Default insert mode', C.select(
            [{ value: 'overwrite', label: 'Overwrite' }, { value: 'insert', label: 'Insert (ripple)' }],
            Config.get('defaultInsertMode'), function (v) { Config.set('defaultInsertMode', v); Dock.render(); })),
          C.field('Default drop point', C.select(
            [{ value: 'playhead', label: 'Playhead' }, { value: 'end', label: 'Sequence end' },
             { value: 'inpoint', label: 'Sequence in point' }],
            Config.get('defaultDropTarget'), function (v) { Config.set('defaultDropTarget', v); Dock.render(); })),
          C.field('Default video track', numInput('defaultVideoTrack', 1, 16)),
          C.field('Default audio track', numInput('defaultAudioTrack', 1, 16))
        ]),
        U.el('div', { class: 'ps2-caption', html: seq
          ? 'Active sequence <b>' + U.esc(seq.name) + '</b> has ' + seq.videoTracks + ' video and ' +
            seq.audioTracks + ' audio tracks.'
          : 'No sequence is open. If you drop media with no sequence, MediaRade asks Premiere to build one from the clip.' })
      ], C.badge(State.host.connected ? 'connected' : 'no host', State.host.connected ? 'ok' : 'mute'));
    },

    /* --- storage -------------------------------------------------------------- */

    storage: function () {
      var stats = Library.stats();
      return panel('Storage', [
        U.el('div', { class: 'mr-meta-grid', style: { marginBottom: '10px' } }, [
          U.el('dt', { text: 'Root' }),      U.el('dd', { text: Paths.dir('root') }),
          U.el('dt', { text: 'Video' }),     U.el('dd', { text: Paths.dir('video') }),
          U.el('dt', { text: 'Audio' }),     U.el('dd', { text: Paths.dir('audio') }),
          U.el('dt', { text: 'Compliance' }),U.el('dd', { text: Paths.dir('compliance') }),
          U.el('dt', { text: 'On disk' }),   U.el('dd', { text: stats.count + ' items · ' + U.bytes(stats.bytes) })
        ]),
        U.el('div', { class: 'ps2-row-gap ps2-wrap' }, [
          C.btn('Open MediaRade folder', { size: 'sm', variant: 'primary',
            onclick: function () { CEP.openFolder(Paths.dir('root')); } }),
          C.btn('Open downloads', { size: 'sm', onclick: function () { CEP.openFolder(Paths.dir('downloads')); } }),
          C.btn('Open logs', { size: 'sm', onclick: function () { CEP.openFolder(Paths.dir('logs')); } }),
          C.btn('Prune missing', { size: 'sm', variant: 'ghost', onclick: function () {
            var n = Library.prune();
            Toast.info('Pruned', n ? n + ' entries whose files were gone.' : 'Every library entry still has its file.');
          } })
        ])
      ]);
    },

    /* --- diagnostics ---------------------------------------------------------- */

    diagnostics: function () {
      var out = U.el('pre', {
        class: 'mr-attrib', style: { whiteSpace: 'pre-wrap', maxHeight: '190px', overflow: 'auto', margin: 0 },
        text: 'Run a check to see results here.'
      });

      function log(s) { out.textContent = s; }

      return panel('Diagnostics', [
        U.el('div', { class: 'ps2-row-gap ps2-wrap', style: { marginBottom: '10px' } }, [
          C.btn('Test Premiere link', { size: 'sm', onclick: function () {
            Premiere.call('ping').then(function (d) {
              return Premiere.call('getState').then(function (s) {
                log('Premiere link OK\n' + JSON.stringify(d, null, 2) + '\n\nState:\n' + JSON.stringify(s, null, 2));
              });
            }).catch(function (e) { log('Premiere link FAILED\n' + e.message); });
          } }),

          C.btn('Test yt-dlp', { size: 'sm', onclick: function () {
            if (!YtDlp.ready()) { log('yt-dlp not found.'); return; }
            log('Running…');
            YtDlp.probeVersion().then(function (v) {
              log('yt-dlp ' + (v || 'unknown') + '\nPath: ' + YtDlp.ytdlp + '\nffmpeg: ' + (YtDlp.ffmpeg || 'missing'));
            });
          } }),

          C.btn('Test search filter', { size: 'sm', onclick: function () {
            var cc = SP.build({ features: { creativeCommons: true }, type: 'video' });
            var combo = SP.build({ sort: 'views', duration: 'short', uploaded: 'year',
                                   type: 'video', features: { creativeCommons: true, hd: true } });
            log('Creative Commons filter : ' + cc + (cc === SP.CC_ONLY ? '   [matches reference ✓]' : '   [MISMATCH — expected ' + SP.CC_ONLY + ']') +
                '\nCombined example        : ' + combo +
                '\n\nURL:\n' + SP.url('royalty free b-roll', { features: { creativeCommons: true }, type: 'video' }));
          } }),

          C.btn('Test licence engine', { size: 'sm', onclick: function () {
            var trap = License.evaluate({
              id: 'TESTTESTTES', title: 'ROYALTY FREE Cinematic B-Roll — No Copyright!',
              channel: 'Example Uploads',
              description: 'Free to use in any project! Music by Some Artist. (c) 2024 Example. Do not reupload.',
              license: 'Standard YouTube License'
            });
            var clean = License.evaluate({
              id: 'TESTTESTTE2', title: 'City timelapse', channel: 'Real Creator',
              description: 'Shot on my own camera.',
              license: 'Creative Commons Attribution license (reuse allowed)',
              channel_is_verified: true
            });
            log('TRAP CASE  ("royalty free" text + Standard licence)\n' +
                '  verdict    : ' + trap.tier + '  (' + trap.score + '%)\n' +
                '  allowed    : ' + trap.gate.allow + '\n' +
                '  reasons    : ' + trap.gate.reasons.join(' | ') + '\n\n' +
                'CLEAN CASE (genuine CC BY)\n' +
                '  verdict    : ' + clean.tier + '  (' + clean.score + '%)\n' +
                '  allowed    : ' + clean.gate.allow + '\n' +
                '  attribution: ' + (clean.attribution ? clean.attribution.plain : 'none'));
          } }),

          C.btn('Paths', { size: 'sm', onclick: function () {
            log(['root       ' + Paths.dir('root'),
                 'video      ' + Paths.dir('video'),
                 'audio      ' + Paths.dir('audio'),
                 'compliance ' + Paths.dir('compliance'),
                 'config     ' + Paths.file('config'),
                 'ledger     ' + Paths.file('ledger'),
                 'exists?    ' + Paths.exists(Paths.dir('root'))].join('\n'));
          } })
        ]),
        out
      ]);
    },

    /* --- about ---------------------------------------------------------------- */

    about: function () {
      return panel('About', [
        U.el('div', { style: { fontSize: '11px', lineHeight: '1.7', color: 'var(--ps2-text-secondary)' }, html:
          '<b style="color:var(--ps2-ash)">MediaRade 1.2.2</b> — by rad1x.<br>' +
          'A YouTube acquisition panel for Premiere Pro with strict, evidence-based licence verification.<br><br>' +
          'Interface built on a vanilla CSS port of <a href="https://github.com/Timmy-Lane/ps2ui">PS2UI</a> (MIT), ' +
          'retinted to a black-and-red ramp. No Sony assets are used; PlayStation and PlayStation 2 are ' +
          'trademarks of Sony Interactive Entertainment.<br><br>' +
          'Downloading is powered by <b>yt-dlp</b> and <b>ffmpeg</b>, which are not bundled — install them yourself. ' +
          'Respect YouTube\'s Terms of Service and the rights of creators. MediaRade records what YouTube ' +
          'reported; it does not grant rights and it is not legal advice.'
        }),
        U.el('div', { class: 'ps2-hr' }),
        U.el('div', { class: 'ps2-row-gap ps2-wrap' }, [
          toggleInline('showBoot', 'Boot animation'),
          toggleInline('ambientMotion', 'Ambient motion', function (on) { Ambient.toggle(on); })
        ]),
        U.el('div', { style: { height: '10px' } }),
        C.btn('Reset all settings', { size: 'sm', variant: 'danger', onclick: function () {
          Modal.confirm({
            title: 'Reset settings',
            body: 'Restore every setting to its default? Your downloads, library and ledger are untouched.',
            danger: true, okLabel: 'Reset'
          }).then(function (yes) {
            if (!yes) return;
            Config.reset();
            Toast.ok('Settings reset', 'Strict mode is back on.');
            SettingsView.render();
            Bus.emit('config', Config.all());
          });
        } })
      ]);
    }
  };

  function toggleInline(key, label, onchange) {
    return C.switch_(label, Config.get(key), function (on) {
      Config.set(key, on);
      if (onchange) onchange(on);
    });
  }

  global.SettingsView = SettingsView;
})(window);
