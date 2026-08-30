/* =============================================================================
   views/library.js — everything on disk under Documents\MediaRade
   MediaRade by sgtsilicon
   ========================================================================== */
(function (global) {
  'use strict';

  var root, toolbar, body;
  var filter = { kind: 'all', tier: 'all', text: '', sort: 'date' };

  var LibraryView = {

    init: function () {
      root = U.$('.mr-view[data-view="library"]');
      toolbar = U.el('div', { class: 'mr-view__toolbar' });
      body = U.el('div', { class: 'mr-view__body' });
      U.append(root, [toolbar, body]);

      Bus.on('library', LibraryView.render);
      LibraryView.render();
    },

    render: function () {
      LibraryView.renderToolbar();
      LibraryView.renderGrid();
    },

    renderToolbar: function () {
      U.clear(toolbar);
      var stats = Library.stats();

      var search = U.el('input', {
        class: 'ps2-input', type: 'text', placeholder: 'Filter by title or channel…', value: filter.text
      });
      search.addEventListener('input', U.debounce(function () {
        filter.text = search.value.trim();
        LibraryView.renderGrid();
      }, 200));

      toolbar.appendChild(U.el('div', { class: 'mr-searchbar' }, [
        search,
        C.btn('Folder', {
          title: 'Open Documents\\MediaRade',
          onclick: function () { CEP.openFolder(Paths.dir('root')); }
        })
      ]));

      toolbar.appendChild(U.el('div', { class: 'mr-filters' }, [
        U.el('div', { class: 'mr-filters__group' }, [
          U.el('span', { class: 'mr-filters__label', text: 'Type' }),
          C.chip('All', filter.kind === 'all', function () { LibraryView.set('kind', 'all'); }),
          C.chip('Video', filter.kind === 'video', function () { LibraryView.set('kind', 'video'); }),
          C.chip('Audio', filter.kind === 'audio', function () { LibraryView.set('kind', 'audio'); })
        ]),
        U.el('div', { class: 'mr-filters__group' }, [
          U.el('span', { class: 'mr-filters__label', text: 'Licence' }),
          C.chip('All', filter.tier === 'all', function () { LibraryView.set('tier', 'all'); }),
          C.chip('CC BY', filter.tier === 'VERIFIED_CC_BY', function () { LibraryView.set('tier', 'VERIFIED_CC_BY'); }),
          C.chip('Flagged', filter.tier === 'CONFLICT', function () { LibraryView.set('tier', 'CONFLICT'); })
        ]),
        U.el('div', { class: 'mr-filters__group' }, [
          U.el('span', { class: 'mr-filters__label', text: 'Sort' }),
          C.chip('Newest', filter.sort === 'date', function () { LibraryView.set('sort', 'date'); }),
          C.chip('Name', filter.sort === 'name', function () { LibraryView.set('sort', 'name'); }),
          C.chip('Size', filter.sort === 'size', function () { LibraryView.set('sort', 'size'); })
        ])
      ]));

      toolbar.appendChild(U.el('div', { class: 'ps2-caption', style: { marginTop: '8px' },
        text: stats.count + ' items · ' + U.bytes(stats.bytes) + ' · ' +
              stats.cc + ' verified CC BY' + (stats.overridden ? ' · ' + stats.overridden + ' overridden' : '') }));
    },

    set: function (k, v) { filter[k] = v; LibraryView.render(); },

    renderGrid: function () {
      U.clear(body);
      var items = Library.filter(filter);

      if (!items.length) {
        body.appendChild(C.empty(
          Library.items.length ? 'Nothing matches' : 'Library is empty',
          Library.items.length
            ? 'Loosen the filters above.'
            : 'Downloads land in <code>Documents\\MediaRade\\Downloads</code> and show up here, ' +
              'each with the licence record that was captured at download time.'));
        return;
      }

      var grid = U.el('div', { class: 'mr-lib-grid' });
      items.forEach(function (e) { grid.appendChild(LibraryView.item(e)); });
      body.appendChild(grid);
    },

    item: function (e) {
      var payload = Acquire.payload(e);
      var badge = License.badge(e.report);

      var thumb = U.el('div', {
        class: 'mr-lib-item__thumb',
        style: { backgroundImage: e.thumb ? 'url("' + CEP.toFileUrl(e.thumb) + '"), url("' + U.thumb(e.videoId) + '")' : '' },
        title: 'Drag onto a track lane or persist point in the dock'
      }, [
        U.el('span', { class: 'mr-lib-item__kind', text: e.kind === 'audio' ? '♪ AUDIO' : '▦ VIDEO' })
      ]);
      DnD.source(thumb, function () { Dock.open(); return payload; });

      return U.el('div', { class: 'mr-lib-item' }, [
        thumb,
        U.el('div', { class: 'mr-lib-item__body' }, [
          U.el('div', { class: 'mr-lib-item__name', text: e.title, title: e.title }),
          U.el('div', { class: 'ps2-caption ps2-truncate', text: e.channel || '' }),
          U.el('div', { class: 'ps2-row-gap ps2-wrap' }, [
            C.badge(badge.text, badge.cls),
            e.size ? U.el('span', { class: 'ps2-caption', text: U.bytes(e.size) }) : null
          ])
        ]),
        U.el('div', { class: 'mr-lib-item__foot' }, [
          (function () {
            var b = C.btn('Place', {
              size: 'sm', variant: 'primary',
              title: 'Insert using the dock\'s mode and target — or drag this button straight onto Premiere\'s timeline',
              onclick: function () { Dock.quickPlace(payload); }
            });
            DnD.native(b, function () { return payload; });
            return b;
          })(),
          C.btn('Bin', {
            size: 'sm', title: 'Import to the project bin',
            onclick: function () {
              Premiere.importFile(e.file, { report: e.report, title: e.title })
                .then(function (d) { e.nodeId = d.nodeId; Library.save(); Toast.ok('Imported', d.name); })
                .catch(function (err) { Toast.err('Import failed', err.message); });
            }
          }),
          C.btn('ⓘ', { size: 'sm', title: 'Licence record', onclick: function () { LibraryView.showRecord(e); } }),
          C.btn('⤴', { size: 'sm', title: 'Reveal in Explorer', onclick: function () { CEP.revealInExplorer(e.file); } }),
          C.btn('✕', {
            size: 'sm', title: 'Remove',
            onclick: function () {
              Modal.confirm({
                title: 'Remove from library',
                body: 'Delete <b>' + U.esc(e.name || e.title) + '</b> from disk as well?<br>' +
                      '<span class="ps2-caption">The ledger entry in Compliance\\ is kept either way.</span>',
                okLabel: 'Delete files', cancelLabel: 'Keep files', danger: true
              }).then(function (deleteFiles) {
                Library.remove(e.id, deleteFiles);
                Toast.info('Removed', deleteFiles ? 'Files deleted.' : 'Removed from the library only.');
              });
            }
          })
        ])
      ]);
    },

    showRecord: function (e) {
      var sidecar = Library.sidecar(e);
      var report = e.report;

      Modal.open({
        title: 'Licence record',
        body: U.el('div', { class: 'ps2-col-gap' }, [
          report ? C.licenseReport(report) : U.el('div', { class: 'ps2-caption', text: 'No report was stored for this item.' }),
          U.el('div', { class: 'ps2-hr' }),
          U.el('div', { class: 'mr-meta-grid' }, [
            U.el('dt', { text: 'File' }), U.el('dd', { text: e.file || '' }),
            U.el('dt', { text: 'Sidecar' }), U.el('dd', { text: sidecar ? 'present' : 'missing' }),
            U.el('dt', { text: 'Downloaded' }), U.el('dd', { text: e.downloadedAt ? new Date(e.downloadedAt).toLocaleString() : '' })
          ])
        ]),
        buttons: [
          { label: 'Open folder', run: function () { CEP.revealInExplorer(e.file); } },
          { label: 'Close', variant: 'primary', run: function () { Modal.close(); } }
        ]
      });
    }
  };

  global.LibraryView = LibraryView;
})(window);
