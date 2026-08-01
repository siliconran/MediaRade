/* =============================================================================
   views/browse.js — search, filtering, results
   MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var root, toolbar, list, input, verifyBar;

  var filters = {
    sort: 'relevance',
    uploaded: 'any',
    duration: 'any',
    features: { creativeCommons: true, hd: false, fourK: false, subtitles: false }
  };

  var Browse = {
    filters: filters,

    init: function () {
      root = U.$('.mr-view[data-view="browse"]');
      toolbar = U.el('div', { class: 'mr-view__toolbar' });
      list = U.el('div', { class: 'mr-view__body' });
      U.append(root, [toolbar, list]);

      filters.features.creativeCommons = Browse.ccPinned();
      State.filters = filters;

      Bus.on('search', Browse.renderResults);
      Bus.on('verified', Browse.onVerified);
      Bus.on('verify:progress', Browse.onVerifyProgress);
      Bus.on('verify:done', function () { if (verifyBar) { verifyBar.remove(); verifyBar = null; } });
      Bus.on('config', function (p) {
        if ('strictMode' in p || 'licenseMode' in p) { Browse.renderToolbar(); }
      });

      Browse.renderToolbar();
      Browse.renderResults();

      var last = Config.get('lastQuery');
      if (last) input.value = last;
    },

    /* --- toolbar ---------------------------------------------------------- */

    renderToolbar: function () {
      U.clear(toolbar);
      var strict = Config.get('strictMode');
      var mode = Config.get('licenseMode');

      input = U.el('input', {
        class: 'ps2-input',
        type: 'text',
        placeholder: 'Search YouTube, or paste a video URL / ID…',
        value: input ? input.value : ''
      });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') Browse.search(); });

      toolbar.appendChild(U.el('div', { class: 'mr-searchbar' }, [
        input,
        C.btn('Search', { variant: 'primary', onclick: Browse.search })
      ]));

      /* licence preset — one control that drives the search filter + gate */
      var modeSel = C.select([
        { value: 'cc', label: 'Creative Commons only' },
        { value: 'claim', label: 'Royalty free (claims allowed)' },
        { value: 'all', label: 'All licences' }
      ], strict ? 'cc' : mode, function (v) {
        Config.set('licenseMode', v);
        filters.features.creativeCommons = Browse.ccPinned();
        Browse.renderToolbar();
        if (State.results.length) Browse.search();
      }, {
        title: strict
          ? 'Locked by strict mode — Creative Commons only. Turn strict mode off in Setup to pick another preset.'
          : 'Licence preset: sets the search filter and the download gate together.'
      });
      modeSel.disabled = !!strict;

      toolbar.appendChild(U.el('div', { class: 'mr-filters' }, [
        U.el('div', { class: 'mr-filters__group' }, [
          U.el('span', { class: 'mr-filters__label', text: 'Licence' }),
          modeSel,
          strict ? U.el('span', { class: 'ps2-caption', style: { marginLeft: '6px' }, text: '🔒 strict' }) : null
        ])
      ]));

      /* the rest of the filters live behind a disclosure — out of the way */
      var hasCustom = filters.sort !== 'relevance' || filters.duration !== 'any' ||
                      filters.uploaded !== 'any' || filters.features.hd ||
                      filters.features.fourK || filters.features.subtitles;

      var toggle = U.el('button', {
        class: 'mr-filters-toggle' + (hasCustom ? ' is-active' : ''),
        title: 'Sort, length, upload date and quality filters'
      }, [
        U.el('span', { text: 'Filters' }),
        U.el('span', { class: 'mr-filters-toggle__caret', text: hasCustom ? '▲' : '▼' })
      ]);

      var panel = U.el('div', {
        class: 'mr-filters mr-filters--collapsible' + (hasCustom ? '' : ' is-hidden')
      }, [
        U.el('div', { class: 'mr-filters__group' }, [
          U.el('span', { class: 'mr-filters__label', text: 'Sort' }),
          C.chip('Relevance', filters.sort === 'relevance', function () { Browse.setFilter('sort', 'relevance'); }),
          C.chip('Newest', filters.sort === 'date', function () { Browse.setFilter('sort', 'date'); }),
          C.chip('Views', filters.sort === 'views', function () { Browse.setFilter('sort', 'views'); }),
          C.chip('Rating', filters.sort === 'rating', function () { Browse.setFilter('sort', 'rating'); })
        ]),
        U.el('div', { class: 'mr-filters__group' }, [
          U.el('span', { class: 'mr-filters__label', text: 'Length' }),
          C.chip('Any', filters.duration === 'any', function () { Browse.setFilter('duration', 'any'); }),
          C.chip('< 4 min', filters.duration === 'short', function () { Browse.setFilter('duration', 'short'); }),
          C.chip('4–20', filters.duration === 'medium', function () { Browse.setFilter('duration', 'medium'); }),
          C.chip('> 20 min', filters.duration === 'long', function () { Browse.setFilter('duration', 'long'); })
        ]),
        U.el('div', { class: 'mr-filters__group' }, [
          U.el('span', { class: 'mr-filters__label', text: 'Uploaded' }),
          C.chip('Any', filters.uploaded === 'any', function () { Browse.setFilter('uploaded', 'any'); }),
          C.chip('Week', filters.uploaded === 'week', function () { Browse.setFilter('uploaded', 'week'); }),
          C.chip('Month', filters.uploaded === 'month', function () { Browse.setFilter('uploaded', 'month'); }),
          C.chip('Year', filters.uploaded === 'year', function () { Browse.setFilter('uploaded', 'year'); })
        ]),
        U.el('div', { class: 'mr-filters__group' }, [
          U.el('span', { class: 'mr-filters__label', text: 'Quality' }),
          C.chip('HD', filters.features.hd, function (on) { Browse.setFeature('hd', on); }),
          C.chip('4K', filters.features.fourK, function (on) { Browse.setFeature('fourK', on); }),
          C.chip('Subs', filters.features.subtitles, function (on) { Browse.setFeature('subtitles', on); })
        ])
      ]);

      toggle.addEventListener('click', function () {
        var hidden = panel.classList.toggle('is-hidden');
        toggle.classList.toggle('is-open', !hidden);
        U.$('.mr-filters-toggle__caret', toggle).textContent = hidden ? '▼' : '▲';
      });

      toolbar.appendChild(toggle);
      toolbar.appendChild(panel);

      /* preset tag row */
      var presets = U.el('div', { class: 'mr-presets' },
        Config.get('presetTags').map(function (tag) {
          return C.chip(tag, false, function () { input.value = tag; Browse.search(); },
                        { title: 'Search "' + tag + '" — the words are a claim, not a licence' });
        }));
      toolbar.appendChild(presets);

      /* the standing warning about claim language */
      toolbar.appendChild(U.el('div', { class: 'mr-claimwarn' }, [
        U.el('span', { text: '⚠' }),
        U.el('span', { html:
          '<b>"Royalty free" is a search term, not a licence.</b> These tags find uploads that ' +
          '<i>say</i> they are free. MediaRade checks each result against YouTube\'s actual licence ' +
          'field and flags every mismatch. The <b>Creative Commons only</b> preset refuses anything ' +
          'unverified' + (strict ? ' (locked on)' : '') + '; <b>Royalty free</b> accepts a clean claim ' +
          'but still blocks contradictions; <b>All licences</b> never blocks, only warns.' })
      ]));
    },

    /** Whether YouTube's own Creative Commons search filter is pinned. */
    ccPinned: function () {
      return Config.get('strictMode') || (Config.get('licenseMode') || 'cc') === 'cc';
    },

    setFilter: function (k, v) { filters[k] = v; Browse.renderToolbar(); if (State.results.length) Browse.search(); },
    setFeature: function (k, on) { filters.features[k] = on; Browse.renderToolbar(); if (State.results.length) Browse.search(); },

    /* --- search ------------------------------------------------------------ */

    search: function () {
      var q = input.value.trim();
      if (!q) { Toast.info('Nothing to search', 'Type a query, or paste a YouTube URL.'); return; }
      if (!YtDlp.ready()) {
        Toast.err('yt-dlp is missing', 'Open Setup and point MediaRade at yt-dlp.');
        Bus.emit('nav', 'settings');
        return;
      }
      Browse.search_(q);
    },

    search_: function (q) {
      Search.run(q, filters).catch(function (e) { /* rendered by renderResults */ });
    },

    /* --- results ----------------------------------------------------------- */

    renderResults: function () {
      if (!list) return;
      U.clear(list);

      if (State.searching) {
        list.appendChild(U.el('div', { style: { padding: '4px 0 14px' } }, [
          C.progress(0, true),
          U.el('div', { class: 'ps2-caption', style: { marginTop: '8px', textAlign: 'center' },
                        text: 'Searching YouTube…' })
        ]));
        return;
      }

      if (State.searchError) {
        list.appendChild(C.empty('Search failed', U.esc(State.searchError),
          C.btn('Try again', { variant: 'primary', onclick: Browse.search })));
        return;
      }

      if (!State.results.length) {
        list.appendChild(C.empty(
          'Nothing here yet',
          'Search for footage or music, or paste a YouTube link.<br>' +
          'Every result is checked against YouTube\'s licence field before it can be downloaded.',
          null));
        return;
      }

      var wrap = U.el('div', { class: 'mr-results' });
      State.results.forEach(function (r) {
        wrap.appendChild(C.resultCard(r, {
          onOpen: function (res) { Bus.emit('open:video', res.id); },
          onVerify: function (res) { Search.verify(res.id); },
          onDownload: function (res, kind) { Acquire.request(res.id, kind); }
        }));
      });
      list.appendChild(wrap);

      var verified = State.results.filter(function (r) { return r.report; }).length;
      list.appendChild(U.el('div', { class: 'ps2-caption', style: { padding: '12px 0 4px', textAlign: 'center' },
        text: State.results.length + ' results · ' + verified + ' licence-checked' }));
    },

    onVerified: function (id, report) {
      var card = U.$('.mr-card[data-id="' + id + '"]');
      var r = State.results.filter(function (x) { return x.id === id; })[0];
      if (r) { r.report = report; r.verifying = false; }
      if (!card || !r) return;
      var fresh = C.resultCard(r, {
        onOpen: function (res) { Bus.emit('open:video', res.id); },
        onVerify: function (res) { Search.verify(res.id); },
        onDownload: function (res, kind) { Acquire.request(res.id, kind); }
      });
      card.parentNode.replaceChild(fresh, card);
    },

    onVerifyProgress: function (done, total) {
      if (!list) return;
      if (!verifyBar) {
        verifyBar = U.el('div', {
          style: { position: 'sticky', top: 0, zIndex: 3, padding: '6px 0 8px',
                   background: 'linear-gradient(180deg, rgba(10,2,6,0.95), rgba(10,2,6,0))' }
        }, [
          U.el('div', { class: 'ps2-caption', style: { marginBottom: '4px' } }, 'Verifying licences…'),
          C.progress(0)
        ]);
        list.insertBefore(verifyBar, list.firstChild);
      }
      var pct = Math.round((done / total) * 100);
      U.$('.ps2-progress__fill', verifyBar).style.width = pct + '%';
      U.$('.ps2-caption', verifyBar).textContent = 'Verifying licences… ' + done + ' / ' + total;
    },

    focusSearch: function () {
      if (input) input.focus();
    }
  };

  global.Browse = Browse;
})(window);
