/* =============================================================================
   views/video.js — the detail view: preview, licence report, acquisition
   MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var root, body, currentId = null, info = null, report = null;

  var opts = {
    quality: null, container: null, audioFormat: null,
    sectionStart: null, sectionEnd: null,
    writeSubs: false, sponsorblock: ''
  };

  var Video = {

    init: function () {
      root = U.$('.mr-view[data-view="video"]');
      body = U.el('div', { class: 'mr-view__body' });
      root.appendChild(body);

      Bus.on('open:video', Video.open);
      Bus.on('verified', function (id) { if (id === currentId) Video.load(id, true); });
      Bus.on('job:done', function (job) { if (job.videoId === currentId) Video.render(); });
      Bus.on('library', function () { if (currentId) Video.render(); });

      Video.render();
    },

    open: function (id) {
      Bus.emit('nav', 'video');
      Video.load(id);
    },

    load: function (id, quiet) {
      currentId = id;
      info = Search.info(id);
      report = Search.report(id);

      opts.quality = Config.get('videoQuality');
      opts.container = Config.get('videoContainer');
      opts.audioFormat = Config.get('audioFormat');
      opts.sectionStart = null;
      opts.sectionEnd = null;

      Video.render();

      if (!report || !info) {
        if (!quiet) Video.renderLoading();
        Search.verify(id).then(function () {
          info = Search.info(id);
          report = Search.report(id);
          Video.render();
        }).catch(function (e) {
          Video.renderError(e.message);
        });
      }
    },

    renderLoading: function () {
      U.clear(body);
      body.appendChild(U.el('div', { style: { padding: '24px 0' } }, [
        C.progress(0, true),
        U.el('div', { class: 'ps2-caption', style: { marginTop: '10px', textAlign: 'center' },
                      text: 'Fetching full metadata and checking the licence…' })
      ]));
    },

    renderError: function (msg) {
      U.clear(body);
      body.appendChild(C.empty('Could not load this video', U.esc(msg),
        C.btn('Retry', { variant: 'primary', onclick: function () { Search.revalidate(currentId).then(function () { Video.load(currentId); }); } })));
    },

    /* ---------------------------------------------------------------------- */

    render: function () {
      if (!body) return;
      U.clear(body);

      if (!currentId) {
        body.appendChild(C.empty('No video selected',
          'Pick a result in <b>Browse</b> to see its full licence report, preview it and download it.'));
        return;
      }
      if (!report) { Video.renderLoading(); return; }

      var meta = info || {};
      var downloads = Library.byVideo(currentId);

      U.append(body, [
        Video.player(meta),
        Video.headline(meta),
        Video.metaBlock(meta),
        U.el('div', { class: 'ps2-panel', style: { marginBottom: '14px' } }, [
          U.el('div', { class: 'ps2-panel__header' }, [
            U.el('span', { class: 'ps2-panel__title', text: 'Licence report' }),
            U.el('span', { class: 'ps2-panel__spacer' }),
            C.btn('Re-check', {
              size: 'sm',
              title: 'Licences can change after upload — re-fetch from YouTube',
              onclick: function () {
                Toast.info('Re-checking…', 'Fetching fresh metadata.');
                Search.revalidate(currentId).then(function () { Video.load(currentId, true); });
              }
            })
          ]),
          C.licenseReport(report)
        ]),
        Video.description(meta),
        downloads.length ? Video.localBlock(downloads) : null,
        Video.acquireBlock(meta)
      ]);
    },

    /* --- pieces ------------------------------------------------------------ */

    player: function (meta) {
      var wrap = U.el('div', { class: 'mr-player', style: { marginBottom: '12px' } });
      var cover = U.el('div', {
        class: 'mr-player__cover',
        style: { backgroundImage: 'url("' + U.thumb(currentId, 'hqdefault') + '")' }
      }, [U.el('div', { class: 'mr-player__play', html: U.icon('play', 22) })]);

      cover.addEventListener('click', function () {
        U.clear(wrap);
        wrap.appendChild(U.el('iframe', {
          src: 'https://www.youtube-nocookie.com/embed/' + currentId + '?autoplay=1&rel=0&modestbranding=1',
          allow: 'autoplay; encrypted-media',
          allowfullscreen: true
        }));
      });

      wrap.appendChild(cover);
      return wrap;
    },

    headline: function (meta) {
      var allowed = License.allow(report);
      var policy = Config.get('strictMode') ? 'cc' : (Config.get('licenseMode') || 'cc');
      return U.el('div', { style: { marginBottom: '10px' } }, [
        U.el('div', { class: 'ps2-heading ps2-selectable', style: { marginBottom: '4px' },
                      text: meta.title || currentId }),
        U.el('div', { class: 'ps2-row-gap ps2-wrap' }, [
          C.licenseBadge(report),
          U.el('span', { class: 'ps2-caption', text: meta.channel || meta.uploader || '' }),
          C.btn('Open on YouTube', {
            size: 'sm', variant: 'ghost',
            onclick: function () { CEP.openInBrowser(U.watchUrl(currentId)); }
          }),
          U.el('span', { class: 'ps2-panel__spacer', style: { flex: 1 } }),
          C.btn('Video', {
            size: 'sm', variant: allowed ? 'primary' : null,
            title: 'Queue the video only' + (allowed ? '' : ' — the licence gate will run first'),
            onclick: function () { Acquire.request(currentId, 'video', Video.spec()); }
          }),
          C.btn('Audio', {
            size: 'sm',
            title: 'Queue the audio only' + (allowed ? '' : ' — the licence gate will run first'),
            onclick: function () { Acquire.request(currentId, 'audio', Video.spec()); }
          })
        ]),
        policy !== 'cc' ? U.el('div', { class: 'ps2-caption', style: { marginTop: '6px' }, html:
          'Allowed under your <b>' + U.esc(License.modeLabel()) + '</b> policy — ' +
          (policy === 'claim'
            ? 'a "royalty free" claim is being accepted as evidence.'
            : 'the licence gate is not blocking anything; records are still written.') }) : null
      ]);
    },

    metaBlock: function (meta) {
      var dl = U.el('dl', { class: 'mr-meta-grid' });
      function row(k, v) {
        if (v === null || v === undefined || v === '') return;
        dl.appendChild(U.el('dt', { text: k }));
        dl.appendChild(U.el('dd', { text: String(v) }));
      }
      row('Channel', meta.channel || meta.uploader);
      row('Uploaded', U.ymd(meta.upload_date));
      row('Duration', meta.duration ? U.hhmmss(meta.duration) : null);
      row('Views', meta.view_count ? U.compact(meta.view_count) : null);
      row('Licence field', report.licenseField || '(none reported)');
      row('Resolution', meta.width && meta.height ? meta.width + '×' + meta.height : null);
      row('FPS', meta.fps);
      row('Category', (meta.categories || [])[0]);
      row('Video ID', currentId);
      return U.el('div', { class: 'ps2-panel', style: { marginBottom: '14px' } }, [
        U.el('div', { class: 'ps2-panel__header' }, [U.el('span', { class: 'ps2-panel__title', text: 'Metadata' })]),
        dl
      ]);
    },

    description: function (meta) {
      if (!meta.description) return null;
      return U.el('div', { class: 'ps2-panel', style: { marginBottom: '14px' } }, [
        U.el('div', { class: 'ps2-panel__header' }, [
          U.el('span', { class: 'ps2-panel__title', text: 'Description' }),
          U.el('span', { class: 'ps2-panel__spacer' }),
          U.el('span', { class: 'ps2-caption', text: 'matched phrases highlighted' })
        ]),
        U.el('div', { class: 'mr-desc', html: License.highlight(meta.description, report) })
      ]);
    },

    /** Already-downloaded copies: preview, place, drag. */
    localBlock: function (entries) {
      var rows = entries.map(function (e) {
        var payload = Acquire.payload(e);

        var grip = U.el('div', { class: 'mr-grip', title: 'Drag onto a track lane or persist point in the dock' });
        DnD.source(grip, function () { Dock.open(); return payload; });

        var placeBtn = C.btn('Place', {
          size: 'sm', variant: 'primary',
          title: 'Insert using the dock\'s mode and target — or drag this button straight onto Premiere\'s timeline',
          onclick: function () { Dock.quickPlace(payload); }
        });
        var importBtn = C.btn('Import', {
          size: 'sm',
          title: 'Import to the project bin only — or drag this button onto the project panel',
          onclick: function () {
            Premiere.importFile(e.file, { report: e.report, title: e.title })
              .then(function (d) { e.nodeId = d.nodeId; Library.save(); Toast.ok('Imported', d.name); })
              .catch(function (err) { Toast.err('Import failed', err.message); });
          }
        });
        DnD.native(placeBtn, function () { return payload; });
        DnD.native(importBtn, function () { return payload; });

        return U.el('div', { class: 'ps2-row', style: { cursor: 'default' } }, [
          grip,
          U.el('div', { class: 'ps2-row__main' }, [
            U.el('div', { class: 'ps2-row__title', text: e.name || e.title }),
            U.el('div', { class: 'ps2-row__sub',
              text: e.kind.toUpperCase() + ' · ' + (e.quality || '') + ' · ' + (e.size ? U.bytes(e.size) : '') +
                    (e.clip ? ' · clip ' + U.hhmmss(e.clip.start) + '–' + U.hhmmss(e.clip.end) : '') })
          ]),
          placeBtn,
          importBtn,
          C.btn('⤴', { size: 'sm', title: 'Reveal in Explorer (for an OS-level drag)',
            onclick: function () { CEP.revealInExplorer(e.file); } })
        ]);
      });

      return U.el('div', { class: 'ps2-panel', style: { marginBottom: '14px' } }, [
        U.el('div', { class: 'ps2-panel__header' }, [
          U.el('span', { class: 'ps2-panel__title', text: 'Downloaded' }),
          U.el('span', { class: 'ps2-panel__spacer' }),
          C.badge(entries.length + ' file' + (entries.length > 1 ? 's' : ''), 'ok')
        ]),
        U.el('div', { class: 'ps2-list' }, rows)
      ]);
    },

    /* --- download options + actions ---------------------------------------- */

    acquireBlock: function (meta) {
      var allowed = License.allow(report);
      var strict = Config.get('strictMode');
      var policy = strict ? 'cc' : (Config.get('licenseMode') || 'cc');

      var startIn = U.el('input', { class: 'ps2-input', placeholder: 'start', style: { width: '84px' } });
      var endIn   = U.el('input', { class: 'ps2-input', placeholder: 'end',   style: { width: '84px' } });

      function readRange() {
        var s = U.parseTime(startIn.value), e = U.parseTime(endIn.value);
        opts.sectionStart = (s !== null && e !== null && e > s) ? s : null;
        opts.sectionEnd   = opts.sectionStart !== null ? e : null;
        return opts.sectionStart !== null;
      }
      startIn.addEventListener('input', readRange);
      endIn.addEventListener('input', readRange);

      var grid = U.el('div', { class: 'mr-optgrid', style: { marginBottom: '12px' } }, [
        C.field('Video quality', C.select(
          [{ value: 'best', label: 'Best available' }, { value: '2160', label: '2160p (4K)' },
           { value: '1440', label: '1440p' }, { value: '1080', label: '1080p' },
           { value: '720', label: '720p' }, { value: '480', label: '480p' }],
          opts.quality, function (v) { opts.quality = v; })),
        C.field('Container', C.select(['mp4', 'mkv', 'webm'], opts.container, function (v) { opts.container = v; })),
        C.field('Audio format', C.select(
          [{ value: 'wav', label: 'WAV (edit-friendly)' }, { value: 'flac', label: 'FLAC' },
           { value: 'm4a', label: 'M4A / AAC' }, { value: 'mp3', label: 'MP3' }, { value: 'opus', label: 'Opus' }],
          opts.audioFormat, function (v) { opts.audioFormat = v; }))
      ]);

      var range = U.el('div', { class: 'ps2-col-gap', style: { marginBottom: '12px' } }, [
        U.el('span', { class: 'mr-field__label', text: 'Clip range (optional — downloads only this span)' }),
        U.el('div', { class: 'mr-range' }, [
          startIn,
          U.el('span', { class: 'ps2-caption', text: 'to' }),
          endIn,
          C.btn('From sequence in/out', {
            size: 'sm',
            title: 'Use the in and out points of the active sequence',
            onclick: function () {
              var s = State.sequence;
              if (!s || s.inPoint === null || s.outPoint === null) {
                Toast.warn('No in/out points', 'Set in and out points on the active sequence first.');
                return;
              }
              startIn.value = U.hhmmss(s.inPoint);
              endIn.value = U.hhmmss(s.outPoint);
              readRange();
            }
          }),
          C.btn('Clear', { size: 'sm', variant: 'ghost', onclick: function () {
            startIn.value = ''; endIn.value = ''; readRange();
          } })
        ]),
        U.el('div', { class: 'ps2-row-gap ps2-wrap' }, [
          C.check('Download subtitles', opts.writeSubs, function (on) { opts.writeSubs = on; }),
          C.check('Strip sponsor segments', !!opts.sponsorblock, function (on) {
            opts.sponsorblock = on ? 'sponsor,selfpromo,interaction' : '';
          })
        ])
      ]);

      var actions = U.el('div', { class: 'ps2-row-gap ps2-wrap' }, [
        C.btn('Download video', {
          variant: allowed ? 'primary' : 'danger',
          onclick: function () { Acquire.request(currentId, 'video', Video.spec()); }
        }),
        C.btn('Download audio', {
          onclick: function () { Acquire.request(currentId, 'audio', Video.spec()); }
        }),
        C.btn('Both', {
          onclick: function () { Acquire.request(currentId, 'both', Video.spec()); }
        })
      ]);

      var gateNote;
      if (allowed && report.tier === 'VERIFIED_CC_BY') {
        gateNote = U.el('div', { class: 'mr-claimwarn', style: {
            color: 'var(--ps2-ok)', background: 'rgba(69,214,127,0.07)',
            borderColor: 'rgba(69,214,127,0.3)', borderLeftColor: 'var(--ps2-ok)' } }, [
            U.el('span', { text: '✓' }),
            U.el('span', { html: 'Cleared for download. An <code>attribution.txt</code> and a ' +
              '<code>.license.json</code> record will be written beside the media, and the credit ' +
              'line will be added to <code>Compliance\\CREDITS.md</code>.' })
          ]);
      } else if (allowed) {
        gateNote = U.el('div', { class: 'mr-claimwarn', style: {
            color: 'var(--ps2-warn)', background: 'rgba(255,178,61,0.07)',
            borderColor: 'rgba(255,178,61,0.28)', borderLeftColor: 'var(--ps2-warn)' } }, [
            U.el('span', { text: '⚠' }),
            U.el('span', { html: '<b>Allowed under your ' + U.esc(License.modeLabel()) + ' policy.</b> ' +
              (policy === 'claim'
                ? 'This upload\'s "royalty free" text is being accepted as evidence, not as a licence. ' +
                  'A <code>.license.json</code> record is still written beside the media.'
                : 'The licence gate is not blocking under this policy. A record is still written, ' +
                  'and nothing here is a grant of rights.') })
          ]);
      } else {
        gateNote = U.el('div', { class: 'mr-claimwarn', style: {
            color: 'var(--ps2-crit)', background: 'rgba(255,59,82,0.08)',
            borderColor: 'rgba(255,59,82,0.32)', borderLeftColor: 'var(--ps2-crit)' } }, [
            U.el('span', { text: '⛔' }),
            U.el('span', { html: '<b>' + U.esc(report.tierInfo.title) + '.</b> ' +
              U.esc(report.gate.reasons[0] || '') +
              (strict ? ' Strict mode will refuse this download.' : ' You will be asked to record a written override.') })
          ]);
      }

      return U.el('div', { class: 'ps2-panel' }, [
        U.el('div', { class: 'ps2-panel__header' }, [
          U.el('span', { class: 'ps2-panel__title', text: 'Acquire' }),
          U.el('span', { class: 'ps2-panel__spacer' }),
          C.licenseBadge(report)
        ]),
        gateNote,
        U.el('div', { style: { height: '12px' } }),
        grid,
        range,
        actions
      ]);
    },

    spec: function () {
      return {
        quality: opts.quality,
        container: opts.container,
        audioFormat: opts.audioFormat,
        sectionStart: opts.sectionStart,
        sectionEnd: opts.sectionEnd,
        writeSubs: opts.writeSubs,
        sponsorblock: opts.sponsorblock
      };
    }
  };

  global.Video = Video;
})(window);
