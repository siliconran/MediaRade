/* =============================================================================
   views/video.jsx — the detail view: preview, licence report, acquisition
   MediaRade by rad1x
   ========================================================================== */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import Bus, { state } from '../core/bus.js';
import Config from '../core/config.js';
import Search from '../core/search.js';
import Library from '../core/library.js';
import Premiere from '../core/premiere.js';
import License from '../core/license.js';
import U from '../core/util.js';
import YtDlp from '../core/ytdlp.js';
import { CEP } from '../core/cep.js';
import Acquire from '../ui/acquire.js';
import DnD from '../ui/dragdrop.js';
import Toast from '../ui/toast.js';
import { useConfig } from '../ui/reactive.js';
import Place from '../ui/place.js';
import { Badge, Btn, Check, CopyAttribution, Empty, Field, LicenseBadge, LicenseReport, Progress, Select } from '../ui/components.jsx';

export function VideoView() {
  const [currentId, setCurrentId] = createSignal(null);
  const [info, setInfo] = createSignal(null);
  const [report, setReport] = createSignal(null);
  const [checking, setChecking] = createSignal(false);
  const [loadError, setLoadError] = createSignal(null);
  const [playing, setPlaying] = createSignal(false);

  const [quality, setQuality] = createSignal(Config.get('videoQuality'));
  const [container, setContainer] = createSignal(Config.get('videoContainer'));
  const [audioFormat, setAudioFormat] = createSignal(Config.get('audioFormat'));
  const [sectionStart, setSectionStart] = createSignal(null);
  const [sectionEnd, setSectionEnd] = createSignal(null);
  const [writeSubs, setWriteSubs] = createSignal(false);
  const [sponsorblock, setSponsorblock] = createSignal('');

  const [strict] = useConfig('strictMode');

  const gate = createMemo(function () {
    const r = report();
    if (!r) return null;
    return License.blocked(r);
  });

  /* --- events -------------------------------------------------------------- */

  /* The view is mounted lazily (`<Show when={state.view === 'video'}>`), so a
     Bus event fired from Browse would be lost before the listener exists.
     Instead the "open this video" intent lives in the store: the effect below
     reacts to state.videoId whenever this view mounts or it changes. */
  createEffect(function () {
    const id = state.videoId;
    state.videoNonce;                       // tracked: re-opening the same video re-runs this
    if (!id) return;
    // autoPlay is read untracked, otherwise clearing it below would re-enter
    // this effect and immediately cancel the playback we just asked for.
    const auto = untrack(function () { return state.autoPlay; });
    if (auto) Bus.patch({ autoPlay: false });
    load(id, auto);
  });

  const offVerified = Bus.on('verified', function (id) {
    if (id === currentId()) {
      setInfo(Search.info(id));
      setReport(Search.report(id));
    }
  });

  onCleanup(function () { offVerified(); });

  /* --- load ---------------------------------------------------------------- */

  /* Renders instantly from the in-memory/disk caches; the licence check is a
     deliberate, visible action (the "Check licence" button below) rather than
     something that blocks the whole view on a network round trip. */
  function load(id, autoplay) {
    setCurrentId(id);
    setPlaying(!!autoplay);
    setLoadError(null);
    setChecking(false);
    setInfo(Search.info(id));
    setReport(Search.report(id));
    setQuality(Config.get('videoQuality'));
    setContainer(Config.get('videoContainer'));
    setAudioFormat(Config.get('audioFormat'));
    setSectionStart(null);
    setSectionEnd(null);
  }

  /** Manual "Check licence": fetch full metadata and audit it. */
  function checkLicence() {
    const id = currentId();
    if (!id || checking()) return;
    setChecking(true);
    Search.verify(id).then(function () {
      if (id !== currentId()) return;
      setInfo(Search.info(id));
      setReport(Search.report(id));
      setChecking(false);
    }).catch(function (e) {
      if (id !== currentId()) return;
      setChecking(false);
      setLoadError(e.message);
    });
  }

  function recheck() {
    Toast.info('Re-checking…', 'Fetching fresh metadata.');
    Search.revalidate(currentId()).then(function () { load(currentId()); });
  }

  function retry() {
    Search.revalidate(currentId()).then(function () { load(currentId()); });
  }

  /* --- derived -------------------------------------------------------------- */

  const downloads = createMemo(function () {
    const id = currentId();
    if (!id) return [];
    return state.libraryItems.filter(function (i) { return i.videoId === id; });
  });

  /** The already-downloaded file for a given kind, if there is one. */
  const localFor = function (kind) {
    return downloads().filter(function (i) { return i.kind === kind; })[0] || null;
  };

  const metaRows = createMemo(function () {
    const m = info() || {};
    const rows = [];
    const push = function (k, v) {
      if (v === null || v === undefined || v === '') return;
      rows.push({ k: k, v: String(v) });
    };
    push('Channel', m.channel || m.uploader);
    push('Uploaded', U.ymd(m.upload_date));
    push('Duration', m.duration ? U.hhmmss(m.duration) : null);
    push('Views', m.view_count ? U.compact(m.view_count) : null);
    push('Licence field', report() ? report().licenseField : '(none reported)');
    push('Resolution', m.width && m.height ? m.width + '×' + m.height : null);
    push('FPS', m.fps);
    push('Category', (m.categories || [])[0]);
    push('Video ID', currentId());
    return rows;
  });

  function spec() {
    return {
      quality: quality(), container: container(), audioFormat: audioFormat(),
      sectionStart: sectionStart(), sectionEnd: sectionEnd(),
      writeSubs: writeSubs(), sponsorblock: sponsorblock()
    };
  }

  /* --- clip range ------------------------------------------------------------ */

  let startIn, endIn;

  function readRange() {
    const s = U.parseTime(startIn.value), e = U.parseTime(endIn.value);
    const ss = (s !== null && e !== null && e > s) ? s : null;
    setSectionStart(ss);
    setSectionEnd(ss !== null ? e : null);
  }

  function useSeqInOut() {
    const seq = state.sequence;
    if (!seq || seq.inPoint === null || seq.outPoint === null) {
      Toast.warn('No in/out points', 'Set in and out points on the active sequence first.');
      return;
    }
    startIn.value = U.hhmmss(seq.inPoint);
    endIn.value = U.hhmmss(seq.outPoint);
    readRange();
  }

  function clearRange() {
    startIn.value = ''; endIn.value = '';
    readRange();
  }

  /* --- gate note ------------------------------------------------------------- */

  const gateNote = createMemo(function () {
    const r = report();
    if (!r) {
      return {
        cls: 'mr-claimwarn', style: {
          color: 'var(--ps2-warn)', background: 'rgba(255,178,61,0.07)',
          borderColor: 'rgba(255,178,61,0.28)', borderLeftColor: 'var(--ps2-warn)'
        }, icon: '⏳', html:
          'No licence verdict yet. Run <b>Check licence</b> above — downloads are blocked until ' +
          'the material has been audited.'
      };
    }
    const g = gate();
    if (g && g.blocked) {
      return {
        cls: 'mr-claimwarn', style: {
          color: 'var(--ps2-crit)', background: 'rgba(255,59,82,0.08)',
          borderColor: 'rgba(255,59,82,0.32)', borderLeftColor: 'var(--ps2-crit)'
        }, icon: g.hard ? '⛔' : '⚠', html:
          '<b>' + U.esc(r.levelInfo.title) + ' — risk score ' + r.score + '.</b> ' +
          U.esc((g.reasons[0] || '')) +
          (g.hard
            ? ' This material is tracked by an automated enforcement system and <b>cannot be overridden</b>.'
            : ' You can proceed with a "Download anyway" confirmation.')
      };
    }
    return {
      cls: 'mr-claimwarn', style: {
        color: 'var(--ps2-ok)', background: 'rgba(69,214,127,0.07)',
        borderColor: 'rgba(69,214,127,0.3)', borderLeftColor: 'var(--ps2-ok)'
      }, icon: '✓', html:
        'Cleared for download under your <b>' + U.esc(License.modeLabel()) + '</b> policy. ' +
        'An <code>attribution.txt</code> and a <code>.license.json</code> record are written beside ' +
        'the media, and the credit line is added to <code>Compliance\\CREDITS.md</code>.'
    };
  });

  /* --- render ---------------------------------------------------------------- */

  return (
    <div class="mr-view__body">
      <Show
        when={currentId()}
        fallback={
          <Empty title="No video selected"
            hint="Pick a result in <b>Browse</b> to see its full licence report, preview it and download it." />
        }
      >
        <Show
          when={!loadError()}
          fallback={
            <Empty title="Could not load this video" hint={U.esc(loadError())}
              action={<Btn variant="primary" label="Retry" onClick={retry} />} />
          }
        >
          <Player id={currentId()} playing={playing} setPlaying={setPlaying} />

          <div style={{ marginBottom: '10px' }}>
            <div class="ps2-heading ps2-selectable" style={{ marginBottom: '4px' }}>
              {(info() && info().title) || currentId()}
            </div>
            <div class="ps2-row-gap ps2-wrap">
              <LicenseBadge report={report()} />
              <span class="ps2-caption">{(info() && (info().channel || info().uploader)) || ''}</span>
              <Btn size="sm" variant="ghost" label="Open on YouTube"
                onClick={() => CEP.openInBrowser(U.watchUrl(currentId()))} />
              <span class="ps2-panel__spacer" style={{ flex: 1 }} />
              <Btn size="sm" variant="ghost" label="Play preview"
                title="Play a preview in the panel"
                onClick={() => setPlaying(true)} />
              <Btn size="sm" variant="primary" label="Video"
                title="Queue the video — the risk checker runs first"
                onClick={() => Acquire.request(currentId(), 'video', spec())} />
              <Btn size="sm" label="Audio"
                title="Queue the audio — the risk checker runs first"
                onClick={() => Acquire.request(currentId(), 'audio', spec())} />
              <CopyAttribution report={report()} info={info()} />
            </div>
          </div>

          <div class="ps2-panel" style={{ marginBottom: '14px' }}>
            <div class="ps2-panel__header">
              <span class="ps2-panel__title">Metadata</span>
            </div>
            <dl class="mr-meta-grid">
              <For each={metaRows()}>
                {(r) => (<><dt>{r.k}</dt><dd>{r.v}</dd></>)}
              </For>
            </dl>
          </div>

          <div class="ps2-panel" style={{ marginBottom: '14px' }}>
            <div class="ps2-panel__header">
              <span class="ps2-panel__title">Licence report</span>
              <span class="ps2-panel__spacer" />
              <Show when={report()}>
                <Btn size="sm" label="Re-check"
                  title="Licences can change after upload — re-fetch from YouTube"
                  onClick={recheck} />
              </Show>
            </div>
            <Show when={!report() && !checking()}>
              <div class="mr-claimwarn" style={{
                color: 'var(--ps2-warn)', background: 'rgba(255,178,61,0.07)',
                borderColor: 'rgba(255,178,61,0.28)', borderLeftColor: 'var(--ps2-warn)' }}>
                <span>⏳</span>
                <div class="ps2-grow">
                  <div innerHTML={
                    '<b>This video has not been licence-checked yet.</b> A verdict is impossible without ' +
                    'full metadata, so nothing here can be trusted until you run the checker.'} />
                  <div style={{ marginTop: '10px' }}>
                    <Btn variant="primary" size="sm" label="Check licence"
                      title="Fetch full metadata and audit the licence"
                      onClick={checkLicence} />
                  </div>
                </div>
              </div>
            </Show>
            <Show when={!report() && checking()}>
              <div class="mr-claimwarn" style={{
                color: 'var(--ps2-warn)', background: 'rgba(255,178,61,0.07)',
                borderColor: 'rgba(255,178,61,0.28)', borderLeftColor: 'var(--ps2-warn)' }}>
                <span>⏳</span>
                <div class="ps2-grow">
                  <div>Checking the licence…</div>
                  <div style={{ marginTop: '10px' }}>
                    <Progress indeterminate />
                  </div>
                </div>
              </div>
            </Show>
            <Show when={report()}>
              <LicenseReport report={report()} />
            </Show>
          </div>

          {info() && info().description ? (
            <div class="ps2-panel" style={{ marginBottom: '14px' }}>
              <div class="ps2-panel__header">
                <span class="ps2-panel__title">Description</span>
                <span class="ps2-panel__spacer" />
                <span class="ps2-caption">matched phrases highlighted</span>
              </div>
              <div class="mr-desc" innerHTML={License.highlight(info().description, report())} />
            </div>
          ) : null}

          <Show when={downloads().length > 0}>
            <div class="ps2-panel" style={{ marginBottom: '14px' }}>
              <div class="ps2-panel__header">
                <span class="ps2-panel__title">Downloaded</span>
                <span class="ps2-panel__spacer" />
                <Badge text={downloads().length + ' file' + (downloads().length > 1 ? 's' : '')} kind="ok" />
              </div>
              <div class="ps2-list">
                <For each={downloads()}>
                  {(e) => <LocalRow e={e} />}
                </For>
              </div>
            </div>
          </Show>

          <div class="ps2-panel">
            <div class="ps2-panel__header">
              <span class="ps2-panel__title">Acquire</span>
              <span class="ps2-panel__spacer" />
              <LicenseBadge report={report()} />
            </div>

            <div class={gateNote().cls} style={gateNote().style}>
              <span>{gateNote().icon}</span>
              <span innerHTML={gateNote().html} />
            </div>

            <div style={{ height: '12px' }} />

            <div class="mr-optgrid" style={{ marginBottom: '12px' }}>
              <Field label="Video quality">
                <Select
                  options={[
                    { value: 'best', label: 'Best available' }, { value: '2160', label: '2160p (4K)' },
                    { value: '1440', label: '1440p' }, { value: '1080', label: '1080p' },
                    { value: '720', label: '720p' }, { value: '480', label: '480p' }
                  ]}
                  value={quality()}
                  onChange={(v) => setQuality(v)}
                />
              </Field>
              <Field label="Container">
                <Select options={['mp4', 'mkv', 'webm']} value={container()} onChange={(v) => setContainer(v)} />
              </Field>
              <Field label="Audio format">
                <Select
                  options={[
                    { value: 'wav', label: 'WAV (edit-friendly)' }, { value: 'flac', label: 'FLAC' },
                    { value: 'm4a', label: 'M4A / AAC' }, { value: 'mp3', label: 'MP3' }, { value: 'opus', label: 'Opus' }
                  ]}
                  value={audioFormat()}
                  onChange={(v) => setAudioFormat(v)}
                />
              </Field>
            </div>

            <div class="ps2-col-gap" style={{ marginBottom: '12px' }}>
              <span class="mr-field__label">Clip range (optional — downloads only this span)</span>
              <div class="mr-range">
                <input ref={startIn} class="ps2-input" placeholder="start" style={{ width: '84px' }} onInput={readRange} />
                <span class="ps2-caption">to</span>
                <input ref={endIn} class="ps2-input" placeholder="end" style={{ width: '84px' }} onInput={readRange} />
                <Btn size="sm" label="From sequence in/out"
                  title="Use the in and out points of the active sequence"
                  onClick={useSeqInOut} />
                <Btn size="sm" variant="ghost" label="Clear" onClick={clearRange} />
              </div>
              <div class="ps2-row-gap ps2-wrap">
                <Check label="Download subtitles" on={writeSubs()} onChange={setWriteSubs} />
                <Check label="Strip sponsor segments" on={!!sponsorblock()}
                  onChange={(on) => setSponsorblock(on ? 'sponsor,selfpromo,interaction' : '')} />
              </div>
            </div>

            {/* Each button downloads; once a file for that kind exists the same
                button becomes a drag handle, so the thing you just fetched is
                draggable from where you fetched it. */}
            <div class="ps2-row-gap ps2-wrap">
              <AcquireButton kind="both" label="Video + audio" primary
                title="One file with the picture and sound muxed together"
                spec={spec} id={currentId} local={localFor} />
              <AcquireButton kind="video" label="Video only"
                title="Video stream — silent if the source has a separate audio track"
                spec={spec} id={currentId} local={localFor} />
              <AcquireButton kind="audio" label="Audio only"
                title="Extracted audio in the format chosen above"
                spec={spec} id={currentId} local={localFor} />
              <CopyAttribution report={report()} info={info()} size={null} />
            </div>

            <Show when={downloads().length > 0}>
              <div class="ps2-caption" style={{ 'margin-top': '8px' }}>
                Downloaded items are draggable — drop them straight onto Premiere's timeline, or use
                <b> Place</b> to insert at the playhead. They also live in the <b>Library</b> tab.
              </div>
            </Show>

            <Show when={report() && report().requiresAttribution}>
              <div class="mr-claimwarn" style={{ 'margin-top': '12px' }}>
                <span>✱</span>
                <span innerHTML={
                  '<b>This licence requires you to credit the creator.</b> The exact text is in the licence ' +
                  'report above and on the <b>Copy credit</b> button — paste it into your video description. ' +
                  'MediaRade also writes it to <code>attribution.txt</code> beside the file and appends it to ' +
                  '<code>Compliance\\CREDITS.md</code>.'} />
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

/**
 * A download button that turns into a drag handle once the file exists.
 *
 * Dragging a button that has not downloaded anything cannot work — there is no
 * file to hand the OS — so before the download the button only downloads, and
 * afterwards it carries the file and says so.
 */
function AcquireButton(props) {
  const entry = () => props.local(props.kind);
  const payload = () => {
    const e = entry();
    return e ? Acquire.payload(e) : null;
  };

  return (
    <Show
      when={entry()}
      fallback={
        <Btn
          variant={props.primary ? 'primary' : undefined}
          label={props.label}
          title={props.title + ' — the risk checker runs first'}
          onClick={() => Acquire.request(props.id(), props.kind, props.spec())}
        />
      }
    >
      <Btn
        variant="primary"
        label={'⠿ ' + props.label}
        ref={(el) => DnD.native(el, payload)}
        title={'Downloaded — drag onto Premiere\'s timeline, or click to insert at the playhead'}
        onClick={() => Place.quick(payload())}
      />
    </Show>
  );
}

/**
 * In-panel preview.
 *
 * Not a YouTube iframe: a CEP panel is served from file://, so its origin is
 * "null" and YouTube rejects the embed with "Error 153 — Video player
 * configuration error". Instead yt-dlp resolves a progressive stream URL and a
 * plain <video> element plays it (YtDlp.streamUrl caches the result for the
 * session). The stream is resolved as soon as the video is selected — not when
 * Play is pressed — so playback starts instantly, and re-opening the same video
 * costs nothing.
 */
function Player(props) {
  const id = () => props.id;
  const [mode, setMode] = createSignal('idle');  // idle | resolving | stream | err
  const [src, setSrc] = createSignal(null);
  const [err, setErr] = createSignal(null);
  const [attempt, setAttempt] = createSignal(0);   // bump to re-resolve after a failure

  /* A new video — or a Retry — resets everything and kicks off the stream
     resolution in the background, so pressing Play later needs no waiting. */
  createEffect(function () {
    const vid = id();
    const n = attempt();
    if (!vid) return;
    setMode('idle');
    setSrc(null);
    setErr(null);

    const wanted = vid;
    YtDlp.streamUrl(wanted, 480).then(function (url) {
      if (wanted !== id() || n !== attempt()) return; // user moved on / re-resolved
      setSrc(url);
      if (mode() === 'resolving') setMode('stream');  // play was pressed meanwhile
    }).catch(function (e) {
      if (wanted !== id() || n !== attempt()) return;
      setErr(e.message);
      if (mode() === 'resolving') setMode('err');
    });
  });

  /* Play was requested. If the prefetch already resolved, start immediately. */
  createEffect(function () {
    if (!props.playing()) return;
    if (mode() === 'stream') return;
    if (src()) { setMode('stream'); return; }
    if (err()) { setMode('err'); props.setPlaying(false); return; }
    setMode('resolving');
  });

  function retry() {
    setErr(null);
    setAttempt(attempt() + 1); // re-run the resolution effect: fresh streamUrl call
    props.setPlaying(true);
  }

  return (
    <div class="mr-player" style={{ marginBottom: '12px' }}>
      <Show when={mode() === 'stream' && src()}>
        <video src={src()} controls autoplay preload="auto"
          onError={() => {
            setErr('The panel could not decode this stream. Open it on YouTube instead.');
            setSrc(null);
            setMode('err');
            props.setPlaying(false);
          }} />
      </Show>

      {/* Cover / loading / error states */}
      <Show when={mode() === 'idle' || mode() === 'resolving' || mode() === 'err'}>
        <div class="mr-player__cover"
          style={{ backgroundImage: 'url("' + U.thumb(id(), 'hqdefault') + '")' }}
          onClick={() => { if (mode() === 'resolving') return; if (mode() === 'err') { retry(); return; } setErr(null); props.setPlaying(true); }}>
          <Show when={mode() === 'idle'}>
            <div class="mr-player__play" innerHTML={U.icon('play', 22)} />
          </Show>

          <Show when={mode() === 'resolving'}>
            <div class="mr-player__note">
              <Progress indeterminate />
              <span>Resolving the stream…</span>
            </div>
          </Show>

          <Show when={mode() === 'err'}>
            <div class="mr-player__note mr-player__note--err" onClick={(e) => e.stopPropagation()}>
              <span>{err()}</span>
              <div class="ps2-row-gap" style={{ 'justify-content': 'center', 'margin-top': '6px' }}>
                <Btn size="sm" label="Retry" onClick={retry} />
                <Btn size="sm" variant="primary" label="Open on YouTube"
                  onClick={() => CEP.openInBrowser(U.watchUrl(id()))} />
              </div>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function LocalRow(props) {
  const e = () => props.e;
  const payload = () => Acquire.payload(e());

  function importBin() {
    Premiere.importFile(e().file, { report: e().report, title: e().title })
      .then(function (d) { e().nodeId = d.nodeId; Library.save(); Toast.ok('Imported', d.name); })
      .catch(function (err) { Toast.err('Import failed', err.message); });
  }

  return (
    <div class="ps2-row" style={{ cursor: 'default' }}>
      <div class="mr-grip" title="Drag onto Premiere's timeline or project panel"
        ref={(el) => DnD.native(el, function () { return payload(); })} />
      <div class="ps2-row__main">
        <div class="ps2-row__title">{e().name || e().title}</div>
        <div class="ps2-row__sub">
          {e().kind.toUpperCase() + ' · ' + (e().quality || '') + ' · ' + (e().size ? U.bytes(e().size) : '') +
            (e().clip ? ' · clip ' + U.hhmmss(e().clip.start) + '–' + U.hhmmss(e().clip.end) : '')}
        </div>
      </div>
      <Btn size="sm" variant="primary" label="Place"
        ref={(el) => DnD.native(el, function () { return payload(); })}
        title="Insert at the configured target — or drag this button straight onto Premiere's timeline"
        onClick={() => Place.quick(payload())} />
      <Btn size="sm" label="Import"
        ref={(el) => DnD.native(el, function () { return payload(); })}
        title="Import to the project bin only — or drag this button onto the project panel"
        onClick={importBin} />
      <Btn size="sm" label="⤴" title="Reveal in Explorer (for an OS-level drag)"
        onClick={() => CEP.revealInExplorer(e().file)} />
    </div>
  );
}

export default VideoView;
