/* =============================================================================
   views/browse.jsx — search, filtering, results
   MediaRade by rad1x
   ========================================================================== */
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import Bus, { state } from '../core/bus.js';
import Config from '../core/config.js';
import Search from '../core/search.js';
import U from '../core/util.js';
import YtDlp from '../core/ytdlp.js';
import Acquire from '../ui/acquire.js';
import Toast from '../ui/toast.js';
import { useConfig } from '../ui/reactive.js';
import { Btn, Chip, Empty, Progress, ResultCard } from '../ui/components.jsx';

export function BrowseView() {
  const [filters, setFilters] = createStore({
    sort: 'relevance',
    uploaded: 'any',
    duration: 'any',
    features: { creativeCommons: false, hd: false, fourK: false, subtitles: false }
  });
  const [open, setOpen] = createSignal(false);
  const [strict] = useConfig('strictMode');
  const [verify, setVerify] = createSignal(null);
  /* 'videos' searches clips; 'channels' searches channels, then drills into one.
     `channelView` holds the channel whose uploads are currently in the grid, so
     the normal result cards (and every licence check) are reused unchanged. */
  const [mode, setMode] = createSignal('videos');
  const [channels, setChannels] = createSignal([]);
  const [channelView, setChannelView] = createSignal(null);
  const [chanBusy, setChanBusy] = createSignal(false);
  const [chanError, setChanError] = createSignal(null);

  let input;

  onMount(function () {
    const last = Config.get('lastQuery');
    if (last && input) input.value = last;
  });

  const off1 = Bus.on('verify:progress', function (done, total) { setVerify({ done: done, total: total }); });
  const off2 = Bus.on('verify:done', function () { setVerify(null); });
  onCleanup(function () { off1(); off2(); });

  const hasCustom = () => filters.sort !== 'relevance' || filters.duration !== 'any' ||
    filters.uploaded !== 'any' || filters.features.hd || filters.features.fourK || filters.features.subtitles;

  /* --- search -------------------------------------------------------------- */

  function doSearch() {
    const q = input.value.trim();
    if (!q) { Toast.info('Nothing to search', 'Type a query, or paste a YouTube URL.'); return; }
    if (!YtDlp.ready()) {
      Toast.err('yt-dlp is missing', 'Open Setup and point MediaRade at yt-dlp.');
      Bus.emit('nav', 'settings');
      return;
    }
    /* A pasted channel address is unambiguous, so honour it in either mode
       rather than running it as a text search that would return nothing. */
    const asChannel = Search.channelUrl(q);
    if (asChannel) { openChannel({ url: q, name: q }); return; }

    if (mode() === 'channels') { searchChannels(q); return; }
    setChannelView(null);
    Search.run(q, filters).catch(function () { /* rendered by the store */ });
  }

  function searchChannels(q) {
    setChanBusy(true); setChanError(null); setChannels([]); setChannelView(null);
    Search.channels(q).then(function (list) {
      setChanBusy(false);
      setChannels(list);
      if (!list.length) setChanError('No channels matched "' + q + '".');
    }).catch(function (e) { setChanBusy(false); setChanError(e.message); });
  }

  /** Load one channel's uploads into the normal results grid. */
  function openChannel(ch) {
    setChanBusy(true); setChanError(null);
    setChannelView(ch);
    Bus.patch({ searching: true, searchError: null, results: [] }, 'search');
    Search.channelVideos(ch).then(function (results) {
      setChanBusy(false);
      Bus.patch({ results: results, searching: false }, 'search');
      if (Config.get('autoVerify')) Search.verifyAll(results, null);
    }).catch(function (e) {
      setChanBusy(false);
      setChannelView(null);
      Bus.patch({ searching: false, searchError: e.message, results: [] }, 'search');
    });
  }

  function leaveChannel() {
    setChannelView(null);
    Bus.patch({ results: [], searching: false, searchError: null }, 'search');
  }

  function setFilter(k, v) {
    setFilters(k, v);
    if (state.results.length) doSearch();
  }

  function setFeature(k, on) {
    setFilters('features', k, on);
    if (state.results.length) doSearch();
  }

  /* --- toolbar -------------------------------------------------------------- */

  const sortChips = [
    { v: 'relevance', l: 'Relevance' }, { v: 'date', l: 'Newest' },
    { v: 'views', l: 'Views' }, { v: 'rating', l: 'Rating' }
  ];
  const durChips = [
    { v: 'any', l: 'Any' }, { v: 'short', l: '< 4 min' },
    { v: 'medium', l: '4–20' }, { v: 'long', l: '> 20 min' }
  ];
  const upChips = [
    { v: 'any', l: 'Any' }, { v: 'week', l: 'Week' },
    { v: 'month', l: 'Month' }, { v: 'year', l: 'Year' }
  ];

  return (
    <>
      <div class="mr-view__toolbar">
        <div class="mr-searchbar">
          <input ref={input} class="ps2-input" type="text"
            placeholder="Search YouTube, or paste a video URL / ID…"
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }} />
          <Btn variant="primary" label="Search" onClick={doSearch} />
        </div>

        <div class="mr-filters__group" style={{ gap: '4px' }}>
          <For each={[['videos', 'Videos'], ['channels', 'Channels']]}>
            {(m) => (
              <Chip label={m[1]} active={mode() === m[0]}
                onClick={() => {
                  if (mode() === m[0]) return;
                  setMode(m[0]);
                  setChannels([]); setChannelView(null); setChanError(null);
                  Bus.patch({ results: [], searchError: null }, 'search');
                }} />
            )}
          </For>
        </div>

        <button class={'mr-filters-toggle' + (hasCustom() ? ' is-active' : '')}
          title="Sort, length, upload date and quality filters"
          onClick={() => setOpen(!open())}>
          <span>Filters</span>
          <span class="mr-filters-toggle__caret">{(open() || hasCustom()) ? '▲' : '▼'}</span>
        </button>

        <div class={'mr-filters mr-filters--collapsible' + ((open() || hasCustom()) ? '' : ' is-hidden')}>
          <div class="mr-filters__group">
            <span class="mr-filters__label">Sort</span>
            <For each={sortChips}>
              {(c) => <Chip label={c.l} on={filters.sort === c.v} onChange={() => setFilter('sort', c.v)} />}
            </For>
          </div>
          <div class="mr-filters__group">
            <span class="mr-filters__label">Length</span>
            <For each={durChips}>
              {(c) => <Chip label={c.l} on={filters.duration === c.v} onChange={() => setFilter('duration', c.v)} />}
            </For>
          </div>
          <div class="mr-filters__group">
            <span class="mr-filters__label">Uploaded</span>
            <For each={upChips}>
              {(c) => <Chip label={c.l} on={filters.uploaded === c.v} onChange={() => setFilter('uploaded', c.v)} />}
            </For>
          </div>
          <div class="mr-filters__group">
            <span class="mr-filters__label">Quality</span>
            <Chip label="HD" on={filters.features.hd} onChange={(on) => setFeature('hd', on)} />
            <Chip label="4K" on={filters.features.fourK} onChange={(on) => setFeature('fourK', on)} />
            <Chip label="Subs" on={filters.features.subtitles} onChange={(on) => setFeature('subtitles', on)} />
          </div>
        </div>

        <div class="mr-claimwarn">
          <span>⚠</span>
          <span innerHTML={
            '<b>"Royalty free" is a search term, not a licence.</b> MediaRade audits every result against ' +
            'YouTube\'s actual licence field, the description and the channel, then rates it ' +
            '<b>LOW / MODERATE / HIGH / CRITICAL</b>. ' +
            (strict()
              ? '<b>Strict mode is on:</b> only LOW-risk verified Creative Commons material can download; ' +
                'HIGH needs a manual override; CRITICAL always blocks.'
              : 'LOW and MODERATE download freely, HIGH offers a "Download anyway" confirm, CRITICAL always blocks.')} />
        </div>
      </div>

      <div class="mr-view__body">
        {/* Channel results: only in Channels mode, and only until one is opened. */}
        <Show when={mode() === 'channels' && !channelView()}>
          <Show when={chanBusy()}>
            <div style={{ padding: '4px 0 14px' }}>
              <Progress indeterminate />
              <div class="ps2-caption" style={{ marginTop: '8px', textAlign: 'center' }}>Searching channels…</div>
            </div>
          </Show>
          <Show when={!chanBusy() && chanError()}>
            <Empty title="No channels found" hint={U.esc(chanError())} />
          </Show>
          <Show when={!chanBusy() && !chanError() && !channels().length}>
            <Empty title="Find a channel"
              hint={'Search by name, or paste a channel URL or @handle.<br>' +
                'Open one to list its uploads — every video is still licence-checked before it can download.'} />
          </Show>
          <Show when={!chanBusy() && channels().length}>
            <div class="mr-results">
              <For each={channels()}>
                {(ch) => (
                  <button class="ps2-panel" style={{
                    display: 'flex', gap: '10px', alignItems: 'center', width: '100%',
                    padding: '10px', textAlign: 'left', cursor: 'pointer'
                  }} title={'Open ' + ch.name + ' and list its uploads'} onClick={() => openChannel(ch)}>
                    <Show when={ch.thumb}>
                      <img src={ch.thumb} alt="" width="48" height="48"
                        style={{ 'border-radius': '50%', 'flex-shrink': 0, 'object-fit': 'cover' }} />
                    </Show>
                    <span style={{ 'min-width': 0 }}>
                      <span style={{ display: 'block', 'font-weight': 600 }}>{ch.name}</span>
                      <span class="ps2-caption" style={{ display: 'block' }}>
                        {(ch.subs ? U.compact(ch.subs) + ' subscribers' : (ch.handle || 'channel'))}
                      </span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>

        {/* Banner while a channel's uploads occupy the results grid. */}
        <Show when={channelView()}>
          <div class="ps2-panel" style={{
            display: 'flex', gap: '10px', 'align-items': 'center',
            'justify-content': 'space-between', padding: '8px 10px', 'margin-bottom': '10px'
          }}>
            <span style={{ 'min-width': 0 }}>
              <span class="ps2-caption">Uploads from</span>{' '}
              <b>{channelView().name || channelView().url}</b>
            </span>
            <Btn size="sm" variant="ghost" label="Back to channels" onClick={leaveChannel} />
          </div>
        </Show>

        <Show when={state.searching}>
          <div style={{ padding: '4px 0 14px' }}>
            <Progress indeterminate />
            <div class="ps2-caption" style={{ marginTop: '8px', textAlign: 'center' }}>Searching YouTube…</div>
          </div>
        </Show>

        <Show when={!state.searching && state.searchError}>
          <Empty title="Search failed" hint={U.esc(state.searchError)}
            action={<Btn variant="primary" label="Try again" onClick={doSearch} />} />
        </Show>

        <Show when={mode() === 'videos' && !state.searching && !state.searchError && !state.results.length}>
          <Empty title="Nothing here yet"
            hint={'Search for footage or music, or paste a YouTube link.<br>' +
              "Every result is checked against YouTube's licence field before it can be downloaded."} />
        </Show>

        <Show when={!state.searching && !state.searchError && state.results.length}>
          <Show when={verify()}>
            <div style={{
              position: 'sticky', top: 0, zIndex: 3, padding: '6px 0 8px',
              background: 'linear-gradient(180deg, rgba(10,2,6,0.95), rgba(10,2,6,0))'
            }}>
              <div class="ps2-caption" style={{ marginBottom: '4px' }}>
                Verifying licences… {verify().done} / {verify().total}
              </div>
              <Progress percent={Math.round((verify().done / verify().total) * 100)} />
            </div>
          </Show>

          <div class="mr-results">
            <For each={state.results}>
              {(r) => (
                <ResultCard r={r} handlers={{
                  onOpen: (res) => Bus.patch({
                    view: 'video', videoId: res.id, autoPlay: false, videoNonce: Date.now() }),
                  onVerify: (res) => Search.verify(res.id),
                  onPlay: (res) => Bus.patch({
                    view: 'video', videoId: res.id, autoPlay: true, videoNonce: Date.now() }),
                  onDownload: (res, kind) => Acquire.request(res.id, kind)
                }} />
              )}
            </For>
          </div>

          <div class="ps2-caption" style={{ padding: '12px 0 4px', textAlign: 'center' }}>
            {state.results.length + ' results · ' +
              state.results.filter((r) => r.report).length + ' licence-checked'}
          </div>
        </Show>
      </div>
    </>
  );
}

export function focusSearch() {
  const input = document.querySelector('.mr-searchbar input');
  if (input) input.focus();
}

export default BrowseView;
